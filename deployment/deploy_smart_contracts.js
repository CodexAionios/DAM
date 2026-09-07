// Deploys the full DAM contract set: PoEEnergyMarket, MLTaskManager,
// DAMAuction, PoEGreenNode, PoEConsensus and FraudDetection (plus a mock
// reward token on local networks), wires them together, and writes the
// resulting addresses/ABIs to frontend/contracts/ so both the (build-step-free)
// frontend and the Python node client can pick them up.
//
// Local vs. public networks differ in three ways, all of them deliberate:
//
//   1. Local networks deploy a mock ERC20 as the reward token. Public networks
//      require REWARD_TOKEN_ADDRESS - there is no sensible way to invent one.
//   2. Public networks run a preflight that validates configuration and
//      balances *before* sending any transaction, because discovering a
//      missing variable halfway through a deployment leaves a half-wired
//      system and burns real gas.
//   3. Public networks hand ownership of every administered contract to
//      ADMIN_ADDRESS. Ownership transfer is two-step, so the deployer stays in
//      control until the admin calls acceptOwnership() on each contract.
//
// See .env.example for every variable this reads.

const path = require("path");
const fs = require("fs");
const hre = require("hardhat");
const { ethers, network, artifacts } = hre;

const FRONTEND_CONTRACTS_DIR = path.join(__dirname, "..", "frontend", "contracts");
const FRONTEND_ABI_DIR = path.join(FRONTEND_CONTRACTS_DIR, "abi");
const DEPLOYMENTS_DIR = path.join(FRONTEND_CONTRACTS_DIR, "deployments");
const LOCAL_NETWORKS = new Set(["localhost", "hardhat"]);
const ABI_EXPORTS = [
  "DAMAuction",
  "MLTaskManager",
  "PoEEnergyMarket",
  "PoEGreenNode",
  "PoEConsensus",
  "FraudDetection",
  "MockERC20",
];

// Contracts whose ownership is handed to ADMIN_ADDRESS. PoEGreenNode is
// absent on purpose: its owner must be PoEConsensus, which is what authorizes
// reward payouts, and it uses a single-step transfer for that reason.
const ADMINISTERED = ["PoEEnergyMarket", "MLTaskManager", "DAMAuction", "PoEConsensus", "FraudDetection"];

// Fixed-point scale PoEConsensus's uint256 difficulty targets are expressed
// in, matching the scaling node_client/mine_and_commit.py applies to the
// tensor miner's floating-point sum/norm outputs.
const TENSOR_SCALE = 1_000_000n;

// Starting proof-of-work target for commitBlock: higher is easier. The
// default gives roughly a 1-in-4096 chance per nonce, so a local miner finds
// one in a few thousand keccak hashes - fast enough for development, while
// still making the proof cost something rather than being free. From here the
// contract retargets it automatically (see setRetargetParams below).
const DEFAULT_HASH_DIFFICULTY = (2n ** 256n - 1n) / 4096n;

const isLocal = () => LOCAL_NETWORKS.has(network.name);

function envAddress(name, { required = false, fallback = null } = {}) {
  const raw = process.env[name];
  if (!raw) {
    if (required) throw new Error(`${name} must be set when deploying to "${network.name}".`);
    return fallback;
  }
  if (!ethers.isAddress(raw)) {
    throw new Error(`${name} is not a valid address: "${raw}"`);
  }
  const address = ethers.getAddress(raw);
  if (address === ethers.ZeroAddress) {
    throw new Error(`${name} must not be the zero address.`);
  }
  return address;
}

function envAddressList(name, fallback) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;

  const addresses = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (!ethers.isAddress(entry)) {
        throw new Error(`${name} contains an invalid address: "${entry}"`);
      }
      return ethers.getAddress(entry);
    });
  return [...new Set(addresses)];
}

/**
 * Validate everything reachable without sending a transaction. On a public
 * network a bad variable should cost nothing but a clear error message.
 */
async function preflight(config, deployer) {
  console.log("Preflight:");

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`  deployer ${deployer.address} holds ${ethers.formatEther(balance)} native`);
  if (balance === 0n) {
    throw new Error(`Deployer ${deployer.address} has no native balance to pay for gas.`);
  }

  const code = await ethers.provider.getCode(config.rewardTokenAddress);
  if (code === "0x") {
    throw new Error(
      `REWARD_TOKEN_ADDRESS ${config.rewardTokenAddress} has no contract code on "${network.name}".`
    );
  }

  const token = await ethers.getContractAt("MockERC20", config.rewardTokenAddress, deployer);
  let tokenBalance;
  try {
    tokenBalance = await token.balanceOf(deployer.address);
  } catch (error) {
    throw new Error(
      `REWARD_TOKEN_ADDRESS ${config.rewardTokenAddress} does not answer balanceOf() - ` +
        `is it an ERC20? (${error.shortMessage || error.message})`
    );
  }
  console.log(`  reward token ${config.rewardTokenAddress}, deployer holds ${tokenBalance}`);
  if (tokenBalance < config.rewardPoolAmount) {
    throw new Error(
      `Deployer holds ${tokenBalance} reward tokens but REWARD_POOL_AMOUNT is ` +
        `${config.rewardPoolAmount}. Lower the pool or fund the deployer first.`
    );
  }

  if (config.fraudThreshold > BigInt(config.fraudReporters.length)) {
    throw new Error(
      `FRAUD_BLACKLIST_THRESHOLD is ${config.fraudThreshold} but only ` +
        `${config.fraudReporters.length} reporter(s) are authorized, so no node could ever ` +
        `be blacklisted. Add reporters via FRAUD_REPORTERS or lower the threshold.`
    );
  }

  console.log(`  admin ${config.adminAddress}`);
  console.log(`  reporter ${config.reporterAddress}`);
  console.log(`  fraud reporters ${config.fraudReporters.join(", ")} (threshold ${config.fraudThreshold})`);

  if (config.adminAddress === deployer.address) {
    console.log("  WARNING: ADMIN_ADDRESS is the deployer - one key will control everything.");
  }
  if (config.reporterAddress === deployer.address) {
    console.log("  WARNING: REPORTER_ADDRESS is the deployer - the attester is also the admin.");
  }
  console.log("  ok");
}

async function resolveRewardToken(deployer, rewardTokenAddress) {
  if (isLocal()) {
    console.log("Local network detected - deploying a mock ERC20 as the PoEGreenNode reward token.");
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("DAM Token", "DAM", ethers.parseEther("1000000"));
    await token.waitForDeployment();
    console.log(`  MockERC20 (DAM) deployed to ${await token.getAddress()}`);
    return token;
  }
  return await ethers.getContractAt("MockERC20", rewardTokenAddress, deployer);
}

function resolveConfig(deployer) {
  const rewardPoolAmount = process.env.REWARD_POOL_AMOUNT
    ? BigInt(process.env.REWARD_POOL_AMOUNT)
    : ethers.parseEther("100000");

  // Every role defaults to the deployer, which is workable locally and wrong
  // anywhere else - one leaked key would control telemetry, fraud accusations
  // and consensus difficulty at once. Public deployments are warned about it
  // in preflight.
  const reporterAddress = envAddress("REPORTER_ADDRESS", { fallback: deployer.address });
  const adminAddress = envAddress("ADMIN_ADDRESS", { fallback: deployer.address });
  const fraudReporters = envAddressList("FRAUD_REPORTERS", [reporterAddress]);

  // The registry counts *distinct* reporters, so the threshold has to be
  // reachable given how many are authorized - otherwise nothing can ever be
  // blacklisted and the enforcement paths are dead code.
  const fraudThreshold = process.env.FRAUD_BLACKLIST_THRESHOLD
    ? BigInt(process.env.FRAUD_BLACKLIST_THRESHOLD)
    : BigInt(Math.min(fraudReporters.length, isLocal() ? 1 : 3));

  return {
    efficiencyThreshold: process.env.EFFICIENCY_THRESHOLD
      ? BigInt(process.env.EFFICIENCY_THRESHOLD)
      : 100n,
    reporterAddress,
    adminAddress,
    fraudReporters,
    fraudThreshold,
    rewardTokenAddress: isLocal()
      ? null
      : envAddress("REWARD_TOKEN_ADDRESS", { required: true }),
    rewardPoolAmount,
    baseBlockReward: process.env.BASE_BLOCK_REWARD
      ? BigInt(process.env.BASE_BLOCK_REWARD)
      : ethers.parseEther("10"),
    // Matches tensor_miner.py's own __main__ example (difficulty_sum=2.0,
    // difficulty_norm=1.5), scaled to fixed-point integers for Solidity.
    difficultyTarget: process.env.DIFFICULTY_TARGET
      ? BigInt(process.env.DIFFICULTY_TARGET)
      : 2n * TENSOR_SCALE,
    normTarget: process.env.NORM_TARGET ? BigInt(process.env.NORM_TARGET) : (15n * TENSOR_SCALE) / 10n,
    maxOE: process.env.MAX_ENTROPIC_OVERHEAD ? BigInt(process.env.MAX_ENTROPIC_OVERHEAD) : 60n,
    referenceTime: process.env.REFERENCE_TIME ? BigInt(process.env.REFERENCE_TIME) : 5n,
    hashDifficulty: process.env.HASH_DIFFICULTY
      ? BigInt(process.env.HASH_DIFFICULTY)
      : DEFAULT_HASH_DIFFICULTY,
    // Every `retargetInterval` committed blocks PoEConsensus rescales
    // hashDifficulty toward `targetBlockTime` seconds per block, so difficulty
    // no longer depends on the owner being awake. 0 pins it.
    retargetInterval:
      process.env.RETARGET_INTERVAL !== undefined ? BigInt(process.env.RETARGET_INTERVAL) : 16n,
    targetBlockTime: process.env.TARGET_BLOCK_TIME ? BigInt(process.env.TARGET_BLOCK_TIME) : 60n,
  };
}

async function main() {
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      `No signer available for "${network.name}". Set DEPLOYER_PRIVATE_KEY (see .env.example).`
    );
  }
  const [deployer] = signers;
  console.log(`Deploying DAM contracts to "${network.name}" as ${deployer.address}`);

  const config = resolveConfig(deployer);
  if (!isLocal()) {
    await preflight(config, deployer);
  }

  const PoEEnergyMarket = await ethers.getContractFactory("PoEEnergyMarket");
  const poeEnergyMarket = await PoEEnergyMarket.deploy(config.reporterAddress, config.efficiencyThreshold);
  await poeEnergyMarket.waitForDeployment();
  console.log(`PoEEnergyMarket deployed to ${await poeEnergyMarket.getAddress()}`);

  // MLTaskManager and DAMAuction each need the other's address at
  // construction time, so MLTaskManager is first pointed at the deployer
  // and re-wired once DAMAuction exists (mirrors the test fixtures).
  const MLTaskManager = await ethers.getContractFactory("MLTaskManager");
  const mlTaskManager = await MLTaskManager.deploy(deployer.address, config.reporterAddress);
  await mlTaskManager.waitForDeployment();
  console.log(`MLTaskManager deployed to ${await mlTaskManager.getAddress()}`);

  const DAMAuction = await ethers.getContractFactory("DAMAuction");
  const damAuction = await DAMAuction.deploy(await mlTaskManager.getAddress());
  await damAuction.waitForDeployment();
  console.log(`DAMAuction deployed to ${await damAuction.getAddress()}`);

  await (await mlTaskManager.setDAMAuction(await damAuction.getAddress())).wait();
  await (await damAuction.setPoEEnergyMarket(await poeEnergyMarket.getAddress())).wait();
  console.log("Wired MLTaskManager <-> DAMAuction <-> PoEEnergyMarket.");

  // --- PoEGreenNode / PoEConsensus: tensor-mining block commitment ---
  const rewardToken = await resolveRewardToken(deployer, config.rewardTokenAddress);

  const PoEGreenNode = await ethers.getContractFactory("PoEGreenNode");
  const poeGreenNode = await PoEGreenNode.deploy(await rewardToken.getAddress(), config.baseBlockReward);
  await poeGreenNode.waitForDeployment();
  console.log(`PoEGreenNode deployed to ${await poeGreenNode.getAddress()}`);

  // Fund PoEGreenNode so it can actually pay out block rewards.
  await (await rewardToken.transfer(await poeGreenNode.getAddress(), config.rewardPoolAmount)).wait();
  console.log(`Funded PoEGreenNode with ${config.rewardPoolAmount} reward token units.`);

  const PoEConsensus = await ethers.getContractFactory("PoEConsensus");
  const poeConsensus = await PoEConsensus.deploy(
    await poeEnergyMarket.getAddress(),
    await poeGreenNode.getAddress(),
    config.difficultyTarget,
    config.normTarget,
    config.hashDifficulty,
    config.maxOE,
    config.referenceTime
  );
  await poeConsensus.waitForDeployment();
  console.log(`PoEConsensus deployed to ${await poeConsensus.getAddress()}`);

  await (await poeConsensus.setRetargetParams(config.retargetInterval, config.targetBlockTime)).wait();
  console.log(
    config.retargetInterval === 0n
      ? "Difficulty retargeting disabled; hashDifficulty is pinned."
      : `Difficulty retargets every ${config.retargetInterval} blocks toward ${config.targetBlockTime}s per block.`
  );

  // Authorize PoEConsensus (not the deployer) to trigger reward payouts. This
  // is a single-step transfer on purpose: the new owner is a contract, which
  // could never complete a two-step handshake.
  await (await poeGreenNode.transferOwnership(await poeConsensus.getAddress())).wait();
  console.log("Transferred PoEGreenNode ownership to PoEConsensus.");

  // --- FraudDetection: blacklist enforcement ---
  const FraudDetection = await ethers.getContractFactory("FraudDetection");
  const fraudDetection = await FraudDetection.deploy();
  await fraudDetection.waitForDeployment();
  console.log(`FraudDetection deployed to ${await fraudDetection.getAddress()}`);

  await (await damAuction.setFraudDetection(await fraudDetection.getAddress())).wait();
  await (await poeConsensus.setFraudDetection(await fraudDetection.getAddress())).wait();
  console.log("Wired FraudDetection into DAMAuction and PoEConsensus.");

  for (const reporter of config.fraudReporters) {
    if (reporter === deployer.address) continue; // the constructor already authorized it
    await (await fraudDetection.setReporter(reporter, true)).wait();
  }

  // FraudDetection's constructor authorizes its own deployer, so the registry
  // is never born inert. When an explicit reporter set was configured and the
  // deployer is not in it, leaving that in place would quietly let the
  // deploying key blacklist nodes long after ownership moved to the admin -
  // which defeats the point of separating the roles at all.
  if (!config.fraudReporters.includes(deployer.address)) {
    await (await fraudDetection.setReporter(deployer.address, false)).wait();
    console.log("Revoked the deployer's automatic fraud-reporter authorization.");
  }

  await (await fraudDetection.setBlacklistThreshold(config.fraudThreshold)).wait();
  console.log(
    `Authorized ${config.fraudReporters.length} fraud reporter(s); blacklist threshold ` +
      `${config.fraudThreshold}` +
      (config.fraudThreshold === 1n ? " (single-attester dev setting - not a production posture)." : ".")
  );

  const contracts = {
    DAMAuction: damAuction,
    MLTaskManager: mlTaskManager,
    PoEEnergyMarket: poeEnergyMarket,
    PoEGreenNode: poeGreenNode,
    PoEConsensus: poeConsensus,
    FraudDetection: fraudDetection,
  };

  // --- Hand administration over ---
  // Two-step, so the deployer keeps working control until the admin proves it
  // can transact. Nothing is lost if ADMIN_ADDRESS is wrong; it can be
  // re-nominated. A single-step transfer to a wrong address could not.
  let pendingAdmin = false;
  if (config.adminAddress !== deployer.address) {
    for (const name of ADMINISTERED) {
      await (await contracts[name].transferOwnership(config.adminAddress)).wait();
    }
    pendingAdmin = true;
    console.log(
      `Nominated ${config.adminAddress} as owner of ${ADMINISTERED.join(", ")}.\n` +
        "  ACTION REQUIRED: that address must call acceptOwnership() on each of them.\n" +
        "  Until it does, the deployer remains the owner."
    );
  }

  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  const deployment = {
    network: network.name,
    chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    reporter: config.reporterAddress,
    admin: config.adminAddress,
    adminAcceptancePending: pendingAdmin,
    fraudReporters: config.fraudReporters,
    contracts: {
      DAMAuction: await damAuction.getAddress(),
      MLTaskManager: await mlTaskManager.getAddress(),
      PoEEnergyMarket: await poeEnergyMarket.getAddress(),
      PoEGreenNode: await poeGreenNode.getAddress(),
      PoEConsensus: await poeConsensus.getAddress(),
      FraudDetection: await fraudDetection.getAddress(),
      rewardToken: await rewardToken.getAddress(),
    },
    tensorScale: TENSOR_SCALE.toString(),
  };

  fs.mkdirSync(FRONTEND_ABI_DIR, { recursive: true });
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });

  // Per-network record, kept so deploying elsewhere never loses this one...
  const perNetworkPath = path.join(DEPLOYMENTS_DIR, `${network.name}.json`);
  fs.writeFileSync(perNetworkPath, JSON.stringify(deployment, null, 2));

  // ...and addresses.json as the "active" deployment the frontend and Python
  // client read by default. The most recent deploy wins; older ones stay
  // recoverable from deployments/ (DAM_NETWORK selects one explicitly).
  fs.writeFileSync(
    path.join(FRONTEND_CONTRACTS_DIR, "addresses.json"),
    JSON.stringify(deployment, null, 2)
  );

  for (const name of ABI_EXPORTS) {
    const artifact = await artifacts.readArtifact(name);
    fs.writeFileSync(path.join(FRONTEND_ABI_DIR, `${name}.json`), JSON.stringify(artifact.abi, null, 2));
  }

  console.log(`Wrote ${perNetworkPath}`);
  console.log(`Wrote frontend contract config to ${FRONTEND_CONTRACTS_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
