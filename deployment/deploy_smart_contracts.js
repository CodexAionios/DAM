// Deploys the full DAM contract set: PoEEnergyMarket, MLTaskManager,
// DAMAuction, PoEGreenNode and PoEConsensus (plus a mock reward token on
// local networks), wires them together, and writes the resulting
// addresses/ABIs to frontend/contracts/ so both the (build-step-free)
// frontend and the Python node client can pick them up.
//
// FraudDetection is deployed and wired into DAMAuction (bid submission and
// helix selection) and PoEConsensus (block commitment), so a blacklisted node
// is refused at each of those points.

const path = require("path");
const fs = require("fs");
const hre = require("hardhat");
const { ethers, network, artifacts } = hre;

const FRONTEND_CONTRACTS_DIR = path.join(__dirname, "..", "frontend", "contracts");
const FRONTEND_ABI_DIR = path.join(FRONTEND_CONTRACTS_DIR, "abi");
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

// Fixed-point scale PoEConsensus's uint256 difficulty targets are expressed
// in, matching the scaling node_client/mine_and_commit.py applies to the
// tensor miner's floating-point sum/norm outputs.
const TENSOR_SCALE = 1_000_000n;

// Proof-of-work target for commitBlock: higher is easier. The default gives
// roughly a 1-in-4096 chance per nonce, so a local miner finds one in a few
// thousand keccak hashes - fast enough for development, while still making
// the proof cost something rather than being free.
const DEFAULT_HASH_DIFFICULTY = (2n ** 256n - 1n) / 4096n;

async function resolveRewardTokenAddress(deployer) {
  if (LOCAL_NETWORKS.has(network.name)) {
    console.log("Local network detected - deploying a mock ERC20 as the PoEGreenNode reward token.");
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("DAM Token", "DAM", ethers.parseEther("1000000"));
    await token.waitForDeployment();
    console.log(`  MockERC20 (DAM) deployed to ${await token.getAddress()}`);
    return token;
  }

  const rewardTokenAddress = process.env.REWARD_TOKEN_ADDRESS;
  if (!rewardTokenAddress) {
    throw new Error(`Set REWARD_TOKEN_ADDRESS before deploying to "${network.name}".`);
  }
  return await ethers.getContractAt("MockERC20", rewardTokenAddress, deployer);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying DAM contracts to "${network.name}" as ${deployer.address}`);

  const efficiencyThreshold = process.env.EFFICIENCY_THRESHOLD
    ? BigInt(process.env.EFFICIENCY_THRESHOLD)
    : 100n;

  // The reporter is a trusted off-chain attester (the DAM AI backend) that
  // submits per-node PoE telemetry (PoEEnergyMarket.reportNodeMetrics) and
  // task-completion scores (MLTaskManager.reportCompletion) - one account
  // plays both roles here. Override with REPORTER_ADDRESS on real networks.
  const reporterAddress = process.env.REPORTER_ADDRESS || deployer.address;

  const PoEEnergyMarket = await ethers.getContractFactory("PoEEnergyMarket");
  const poeEnergyMarket = await PoEEnergyMarket.deploy(reporterAddress, efficiencyThreshold);
  await poeEnergyMarket.waitForDeployment();
  console.log(`PoEEnergyMarket deployed to ${await poeEnergyMarket.getAddress()}`);

  // MLTaskManager and DAMAuction each need the other's address at
  // construction time, so MLTaskManager is first pointed at the deployer
  // and re-wired once DAMAuction exists (mirrors the test fixtures).
  const MLTaskManager = await ethers.getContractFactory("MLTaskManager");
  const mlTaskManager = await MLTaskManager.deploy(deployer.address, reporterAddress);
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
  const rewardToken = await resolveRewardTokenAddress(deployer);
  const baseBlockReward = process.env.BASE_BLOCK_REWARD
    ? BigInt(process.env.BASE_BLOCK_REWARD)
    : ethers.parseEther("10");

  const PoEGreenNode = await ethers.getContractFactory("PoEGreenNode");
  const poeGreenNode = await PoEGreenNode.deploy(await rewardToken.getAddress(), baseBlockReward);
  await poeGreenNode.waitForDeployment();
  console.log(`PoEGreenNode deployed to ${await poeGreenNode.getAddress()}`);

  // Fund PoEGreenNode so it can actually pay out block rewards.
  const rewardPoolAmount = process.env.REWARD_POOL_AMOUNT
    ? BigInt(process.env.REWARD_POOL_AMOUNT)
    : ethers.parseEther("100000");
  await (await rewardToken.transfer(await poeGreenNode.getAddress(), rewardPoolAmount)).wait();
  console.log(`Funded PoEGreenNode with ${rewardPoolAmount} reward token units.`);

  // Matches tensor_miner.py's own __main__ example (difficulty_sum=2.0,
  // difficulty_norm=1.5), scaled to fixed-point integers for Solidity.
  const difficultyTarget = process.env.DIFFICULTY_TARGET
    ? BigInt(process.env.DIFFICULTY_TARGET)
    : 2n * TENSOR_SCALE;
  const normTarget = process.env.NORM_TARGET ? BigInt(process.env.NORM_TARGET) : (15n * TENSOR_SCALE) / 10n;
  const maxOE = process.env.MAX_ENTROPIC_OVERHEAD ? BigInt(process.env.MAX_ENTROPIC_OVERHEAD) : 60n; // seconds
  const referenceTime = process.env.REFERENCE_TIME ? BigInt(process.env.REFERENCE_TIME) : 5n; // seconds

  const hashDifficulty = process.env.HASH_DIFFICULTY
    ? BigInt(process.env.HASH_DIFFICULTY)
    : DEFAULT_HASH_DIFFICULTY;

  const PoEConsensus = await ethers.getContractFactory("PoEConsensus");
  const poeConsensus = await PoEConsensus.deploy(
    await poeEnergyMarket.getAddress(),
    await poeGreenNode.getAddress(),
    difficultyTarget,
    normTarget,
    hashDifficulty,
    maxOE,
    referenceTime
  );
  await poeConsensus.waitForDeployment();
  console.log(`PoEConsensus deployed to ${await poeConsensus.getAddress()}`);

  // Authorize PoEConsensus (not the deployer) to trigger reward payouts.
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

  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  const deployment = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    reporter: reporterAddress,
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
  fs.writeFileSync(
    path.join(FRONTEND_CONTRACTS_DIR, "addresses.json"),
    JSON.stringify(deployment, null, 2)
  );

  for (const name of ABI_EXPORTS) {
    const artifact = await artifacts.readArtifact(name);
    fs.writeFileSync(path.join(FRONTEND_ABI_DIR, `${name}.json`), JSON.stringify(artifact.abi, null, 2));
  }

  console.log(`Wrote frontend contract config to ${FRONTEND_CONTRACTS_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
