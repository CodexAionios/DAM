const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");

const EFFICIENCY_THRESHOLD = 1_000n;
const DIFFICULTY_TARGET = 2_000_000n; // 2.0 at TENSOR_SCALE 1e6
const NORM_TARGET = 1_500_000n; // 1.5 at TENSOR_SCALE 1e6
const MAX_OE = 60n;
const REFERENCE_TIME = 5n;
const BASE_BLOCK_REWARD = 10n * 10n ** 18n;
const REWARD_POOL = 100_000n * 10n ** 18n;

// Easy target so tests find a nonce in a handful of hashes.
const EASY_HASH_DIFFICULTY = (2n ** 256n - 1n) / 64n;

// A tensor that genuinely satisfies both targets: 25 elements of 0.05 →
// sum 1.25 < 2.0, and squared norm 25*(0.05)^2 = 0.0625 < 2.25.
const GOOD_TENSOR = Array.from({ length: 25 }, () => 50_000n);

async function deployConsensusFixture() {
  const [owner, reporter, miner, other] = await ethers.getSigners();

  const PoEEnergyMarket = await ethers.getContractFactory("PoEEnergyMarket");
  const market = await PoEEnergyMarket.deploy(reporter.address, EFFICIENCY_THRESHOLD);
  await market.waitForDeployment();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy("DAM Token", "DAM", REWARD_POOL * 2n);
  await token.waitForDeployment();

  const PoEGreenNode = await ethers.getContractFactory("PoEGreenNode");
  const greenNode = await PoEGreenNode.deploy(await token.getAddress(), BASE_BLOCK_REWARD);
  await greenNode.waitForDeployment();
  await token.transfer(await greenNode.getAddress(), REWARD_POOL);

  const PoEConsensus = await ethers.getContractFactory("PoEConsensus");
  const consensus = await PoEConsensus.deploy(
    await market.getAddress(),
    await greenNode.getAddress(),
    DIFFICULTY_TARGET,
    NORM_TARGET,
    EASY_HASH_DIFFICULTY,
    MAX_OE,
    REFERENCE_TIME
  );
  await consensus.waitForDeployment();
  await greenNode.transferOwnership(await consensus.getAddress());

  await market.connect(reporter).reportNodeMetrics(miner.address, 1, 1);

  return { owner, reporter, miner, other, market, token, greenNode, consensus };
}

/** Mirror the contract's seed + digest derivation, and search for a nonce. */
async function mineProof(consensus, proposer, tensor, { maxAttempts = 100_000 } = {}) {
  const seedBlock = (await ethers.provider.getBlockNumber()) - 1;
  const seed = await consensus.miningSeed(seedBlock, proposer);
  const difficulty = await consensus.hashDifficulty();

  for (let nonce = 0; nonce < maxAttempts; nonce++) {
    const digest = ethers.solidityPackedKeccak256(
      ["bytes32", "uint256", "uint256[]"],
      [seed, nonce, tensor]
    );
    if (BigInt(digest) < difficulty) {
      return { seedBlock, nonce, digest };
    }
  }
  throw new Error("No qualifying nonce found");
}

describe("PoEConsensus proof verification", function () {
  describe("work target", function () {
    it("accepts a tensor committed with a nonce that clears the work target", async function () {
      const { consensus, miner, token } = await loadFixture(deployConsensusFixture);
      const { seedBlock, nonce, digest } = await mineProof(consensus, miner.address, GOOD_TENSOR);

      const before = await token.balanceOf(miner.address);
      await consensus.connect(miner).commitBlock(GOOD_TENSOR, nonce, seedBlock, 1n, 100n);

      expect(await consensus.committedBlockCount()).to.equal(1n);
      const header = await consensus.getCommittedBlock(0);
      expect(header.proofDigest).to.equal(digest);
      expect(header.proposer).to.equal(miner.address);
      expect(await token.balanceOf(miner.address)).to.be.greaterThan(before);
    });

    it("rejects a nonce that does not clear the work target", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const { seedBlock, nonce } = await mineProof(consensus, miner.address, GOOD_TENSOR);

      // Any other nonce almost certainly fails the target; find one that does.
      let badNonce = nonce + 1;
      const seed = await consensus.miningSeed(seedBlock, miner.address);
      const difficulty = await consensus.hashDifficulty();
      while (
        BigInt(
          ethers.solidityPackedKeccak256(
            ["bytes32", "uint256", "uint256[]"],
            [seed, badNonce, GOOD_TENSOR]
          )
        ) < difficulty
      ) {
        badNonce += 1;
      }

      await expect(
        consensus.connect(miner).commitBlock(GOOD_TENSOR, badNonce, seedBlock, 1n, 100n)
      ).to.be.revertedWith("Proof does not meet work target");
    });

    it("rejects another node reusing a proof mined for a different address", async function () {
      const { consensus, market, reporter, miner, other } = await loadFixture(deployConsensusFixture);
      await market.connect(reporter).reportNodeMetrics(other.address, 1, 1);

      // Proof mined against `miner`'s seed...
      const { seedBlock, nonce } = await mineProof(consensus, miner.address, GOOD_TENSOR);

      // ...is worthless to `other`, whose seed differs (seed binds msg.sender).
      await expect(
        consensus.connect(other).commitBlock(GOOD_TENSOR, nonce, seedBlock, 1n, 100n)
      ).to.be.revertedWith("Proof does not meet work target");
    });
  });

  describe("tensor metrics are recomputed, not trusted", function () {
    it("rejects a tensor whose real sum exceeds the difficulty target", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      // 25 elements of 0.1 → sum 2.5, over the 2.0 target.
      const heavy = Array.from({ length: 25 }, () => 100_000n);
      const { seedBlock, nonce } = await mineProof(consensus, miner.address, heavy);

      await expect(
        consensus.connect(miner).commitBlock(heavy, nonce, seedBlock, 1n, 100n)
      ).to.be.revertedWith("Tensor sum exceeds difficulty target");
    });

    it("rejects a tensor whose norm is concentrated in one large element", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      // Sum 1.6 < 2.0 passes the sum check, but 1.6^2 = 2.56 > 2.25 fails on norm.
      const spiky = [1_600_000n, ...Array.from({ length: 24 }, () => 0n)];
      const { seedBlock, nonce } = await mineProof(consensus, miner.address, spiky);

      await expect(
        consensus.connect(miner).commitBlock(spiky, nonce, seedBlock, 1n, 100n)
      ).to.be.revertedWith("Tensor norm exceeds difficulty target");
    });

    it("stores the sum and squared norm it computed itself", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const { seedBlock, nonce } = await mineProof(consensus, miner.address, GOOD_TENSOR);

      await consensus.connect(miner).commitBlock(GOOD_TENSOR, nonce, seedBlock, 1n, 100n);

      const header = await consensus.getCommittedBlock(0);
      const expectedSum = GOOD_TENSOR.reduce((acc, v) => acc + v, 0n);
      const expectedNormSq = GOOD_TENSOR.reduce((acc, v) => acc + v * v, 0n);
      expect(header.tensorSum).to.equal(expectedSum);
      expect(header.gradientNormSquared).to.equal(expectedNormSq);
    });

    it("rejects an empty or oversized tensor", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const seedBlock = (await ethers.provider.getBlockNumber()) - 1;

      await expect(
        consensus.connect(miner).commitBlock([], 0n, seedBlock, 1n, 100n)
      ).to.be.revertedWith("Tensor is empty");

      const huge = Array.from({ length: 257 }, () => 1n);
      await expect(
        consensus.connect(miner).commitBlock(huge, 0n, seedBlock, 1n, 100n)
      ).to.be.revertedWith("Tensor too large");
    });
  });

  describe("the forgery that used to work", function () {
    it("no longer lets a caller claim tiny metrics without doing any work", async function () {
      // Before verification existed, commitBlock took the sum and norm as
      // arguments, so this exact shape - assert great numbers, do nothing -
      // collected a full reward. Now the numbers must belong to a real tensor
      // AND that tensor must clear the work target.
      const { consensus, miner, token } = await loadFixture(deployConsensusFixture);
      const seedBlock = (await ethers.provider.getBlockNumber()) - 1;
      const perfectLookingTensor = Array.from({ length: 25 }, () => 0n); // sum 0, norm 0

      const before = await token.balanceOf(miner.address);
      // Nonce 0 is overwhelmingly unlikely to clear the target.
      await expect(
        consensus.connect(miner).commitBlock(perfectLookingTensor, 0n, seedBlock, 1n, 100n)
      ).to.be.revertedWith("Proof does not meet work target");

      expect(await consensus.committedBlockCount()).to.equal(0n);
      expect(await token.balanceOf(miner.address)).to.equal(before);
    });
  });

  describe("seed validity", function () {
    it("rejects a seed block in the future or the current block", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const current = await ethers.provider.getBlockNumber();

      await expect(
        consensus.connect(miner).commitBlock(GOOD_TENSOR, 0n, current + 10, 1n, 100n)
      ).to.be.revertedWith("Seed block is not in the past");
    });

    it("rejects a seed block older than the allowed window", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const stale = await ethers.provider.getBlockNumber();
      await mine(200); // push the seed block outside SEED_WINDOW

      await expect(
        consensus.connect(miner).commitBlock(GOOD_TENSOR, 0n, stale, 1n, 100n)
      ).to.be.revertedWith("Seed block too old");
    });
  });

  describe("replay protection", function () {
    it("refuses to commit the same proof twice", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const { seedBlock, nonce } = await mineProof(consensus, miner.address, GOOD_TENSOR);

      await consensus.connect(miner).commitBlock(GOOD_TENSOR, nonce, seedBlock, 1n, 100n);
      await expect(
        consensus.connect(miner).commitBlock(GOOD_TENSOR, nonce, seedBlock, 1n, 100n)
      ).to.be.revertedWith("Proof already committed");

      expect(await consensus.committedBlockCount()).to.equal(1n);
    });
  });

  describe("efficiency and fraud gates", function () {
    it("rejects a proposer below the PoE threshold", async function () {
      const { consensus, other } = await loadFixture(deployConsensusFixture);
      const { seedBlock, nonce } = await mineProof(consensus, other.address, GOOD_TENSOR);

      await expect(
        consensus.connect(other).commitBlock(GOOD_TENSOR, nonce, seedBlock, 1n, 100n)
      ).to.be.revertedWith("PoE score below required threshold");
    });

    it("rejects a blacklisted proposer once a fraud registry is wired in", async function () {
      const { consensus, owner, miner } = await loadFixture(deployConsensusFixture);

      const FraudDetection = await ethers.getContractFactory("FraudDetection");
      const fraud = await FraudDetection.deploy();
      await fraud.waitForDeployment();
      await consensus.connect(owner).setFraudDetection(await fraud.getAddress());

      for (let i = 0; i < 3; i++) await fraud.reportFraud(miner.address);
      expect(await fraud.isNodeBlacklisted(miner.address)).to.equal(true);

      const { seedBlock, nonce } = await mineProof(consensus, miner.address, GOOD_TENSOR);
      await expect(
        consensus.connect(miner).commitBlock(GOOD_TENSOR, nonce, seedBlock, 1n, 100n)
      ).to.be.revertedWith("Proposer is blacklisted");
    });

    it("rejects mining that overshoots the reference time by more than maxOE", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const { seedBlock, nonce } = await mineProof(consensus, miner.address, GOOD_TENSOR);

      await expect(
        consensus
          .connect(miner)
          .commitBlock(GOOD_TENSOR, nonce, seedBlock, REFERENCE_TIME + MAX_OE + 1n, 100n)
      ).to.be.revertedWith("Node entropy overhead too high");
    });
  });

  describe("difficulty administration", function () {
    it("lets the owner retarget difficulty and rejects non-owners", async function () {
      const { consensus, owner, other } = await loadFixture(deployConsensusFixture);

      await consensus.connect(owner).setHashDifficulty(12345n);
      expect(await consensus.hashDifficulty()).to.equal(12345n);

      await consensus.connect(owner).setDifficultyTargets(3_000_000n, 2_000_000n);
      expect(await consensus.difficultyTarget()).to.equal(3_000_000n);
      expect(await consensus.normTargetSquared()).to.equal(2_000_000n * 2_000_000n);

      await expect(consensus.connect(other).setHashDifficulty(1n)).to.be.revertedWith("Not authorized");
      await expect(consensus.connect(other).setFraudDetection(other.address)).to.be.revertedWith(
        "Not authorized"
      );
    });

    it("refuses a zero hash difficulty, which nothing could ever satisfy", async function () {
      const { consensus, owner } = await loadFixture(deployConsensusFixture);
      await expect(consensus.connect(owner).setHashDifficulty(0n)).to.be.revertedWith(
        "hashDifficulty must be positive"
      );
    });
  });
});
