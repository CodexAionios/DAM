const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture, mine, time } = require("@nomicfoundation/hardhat-network-helpers");

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

/** Open a mining session and return its id. */
async function openSession(consensus, signer) {
  const receipt = await (await consensus.connect(signer).openSession()).wait();
  const event = receipt.logs
    .map((log) => {
      try {
        return consensus.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === "SessionOpened");
  return event.args.sessionId;
}

/** Advance the chain until a session's seed is readable. */
async function matureSession(consensus, sessionId) {
  const readyAt = Number(await consensus.sessionSeedReadyAt(sessionId));
  const current = await ethers.provider.getBlockNumber();
  if (readyAt > current) {
    await mine(readyAt - current);
  }
}

/**
 * Open a session, wait for its seed, and search for a qualifying nonce.
 *
 * `difficultyOverride` mines against a deliberately harder target than the
 * chain currently requires, so the proof survives a retarget that tightens
 * difficulty before it is committed.
 */
async function mineProof(
  consensus,
  signer,
  tensor,
  { maxAttempts = 200_000, difficultyOverride } = {}
) {
  const sessionId = await openSession(consensus, signer);
  await matureSession(consensus, sessionId);

  const seed = await consensus.sessionSeed(sessionId);
  const difficulty = difficultyOverride ?? (await consensus.hashDifficulty());

  for (let nonce = 0; nonce < maxAttempts; nonce++) {
    const digest = ethers.solidityPackedKeccak256(
      ["bytes32", "uint256", "uint256[]"],
      [seed, nonce, tensor]
    );
    if (BigInt(digest) < difficulty) {
      return { sessionId, seed, nonce, digest };
    }
  }
  throw new Error("No qualifying nonce found");
}

describe("PoEConsensus proof verification", function () {
  describe("work target", function () {
    it("accepts a tensor committed with a nonce that clears the work target", async function () {
      const { consensus, miner, token } = await loadFixture(deployConsensusFixture);
      const { sessionId, nonce, digest } = await mineProof(consensus, miner, GOOD_TENSOR);

      const before = await token.balanceOf(miner.address);
      await consensus.connect(miner).commitBlock(sessionId, GOOD_TENSOR, nonce, 1n, 100n);

      expect(await consensus.committedBlockCount()).to.equal(1n);
      const header = await consensus.getCommittedBlock(0);
      expect(header.proofDigest).to.equal(digest);
      expect(header.proposer).to.equal(miner.address);
      expect(header.sessionId).to.equal(sessionId);
      expect(await token.balanceOf(miner.address)).to.be.greaterThan(before);
    });

    it("rejects a nonce that does not clear the work target", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const { sessionId, seed, nonce } = await mineProof(consensus, miner, GOOD_TENSOR);

      // Any other nonce almost certainly fails the target; find one that does.
      let badNonce = nonce + 1;
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
        consensus.connect(miner).commitBlock(sessionId, GOOD_TENSOR, badNonce, 1n, 100n)
      ).to.be.revertedWith("Proof does not meet work target");
    });

    it("rejects a proof mined for another node's seed", async function () {
      const { consensus, market, reporter, miner, other } = await loadFixture(deployConsensusFixture);
      await market.connect(reporter).reportNodeMetrics(other.address, 1, 1);

      const minerSession = await openSession(consensus, miner);
      const otherSession = await openSession(consensus, other);
      await matureSession(consensus, otherSession);

      const minerSeed = await consensus.sessionSeed(minerSession);
      const otherSeed = await consensus.sessionSeed(otherSession);
      const difficulty = await consensus.hashDifficulty();
      expect(minerSeed).to.not.equal(otherSeed);

      // Find a nonce that is genuinely valid for `miner` and genuinely invalid
      // for `other`. Picking any valid-for-miner nonce would be flaky: at this
      // artificially easy test difficulty it also clears `other`'s target about
      // 1 time in 64, which says nothing about transferability either way.
      const digest = (seed, nonce) =>
        BigInt(
          ethers.solidityPackedKeccak256(["bytes32", "uint256", "uint256[]"], [seed, nonce, GOOD_TENSOR])
        );
      let nonce = 0;
      while (!(digest(minerSeed, nonce) < difficulty && digest(otherSeed, nonce) >= difficulty)) {
        nonce += 1;
      }

      // It really is a valid proof - for its own miner.
      await consensus.connect(miner).commitBlock(minerSession, GOOD_TENSOR, nonce, 1n, 100n);
      expect(await consensus.committedBlockCount()).to.equal(1n);

      // And worthless to anyone else: the seed binds the miner and session.
      await expect(
        consensus.connect(other).commitBlock(otherSession, GOOD_TENSOR, nonce, 1n, 100n)
      ).to.be.revertedWith("Proof does not meet work target");
    });
  });

  describe("tensor metrics are recomputed, not trusted", function () {
    it("rejects a tensor whose real sum exceeds the difficulty target", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      // 25 elements of 0.1 → sum 2.5, over the 2.0 target.
      const heavy = Array.from({ length: 25 }, () => 100_000n);
      const { sessionId, nonce } = await mineProof(consensus, miner, heavy);

      await expect(
        consensus.connect(miner).commitBlock(sessionId, heavy, nonce, 1n, 100n)
      ).to.be.revertedWith("Tensor sum exceeds difficulty target");
    });

    it("rejects a tensor whose norm is concentrated in one large element", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      // Sum 1.6 < 2.0 passes the sum check, but 1.6^2 = 2.56 > 2.25 fails on norm.
      const spiky = [1_600_000n, ...Array.from({ length: 24 }, () => 0n)];
      const { sessionId, nonce } = await mineProof(consensus, miner, spiky);

      await expect(
        consensus.connect(miner).commitBlock(sessionId, spiky, nonce, 1n, 100n)
      ).to.be.revertedWith("Tensor norm exceeds difficulty target");
    });

    it("stores the sum and squared norm it computed itself", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const { sessionId, nonce } = await mineProof(consensus, miner, GOOD_TENSOR);

      await consensus.connect(miner).commitBlock(sessionId, GOOD_TENSOR, nonce, 1n, 100n);

      const header = await consensus.getCommittedBlock(0);
      const expectedSum = GOOD_TENSOR.reduce((acc, v) => acc + v, 0n);
      const expectedNormSq = GOOD_TENSOR.reduce((acc, v) => acc + v * v, 0n);
      expect(header.tensorSum).to.equal(expectedSum);
      expect(header.gradientNormSquared).to.equal(expectedNormSq);
    });

    it("rejects an empty or oversized tensor", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const sessionId = await openSession(consensus, miner);
      await matureSession(consensus, sessionId);

      await expect(
        consensus.connect(miner).commitBlock(sessionId, [], 0n, 1n, 100n)
      ).to.be.revertedWith("Tensor is empty");

      const huge = Array.from({ length: 257 }, () => 1n);
      await expect(
        consensus.connect(miner).commitBlock(sessionId, huge, 0n, 1n, 100n)
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
      const sessionId = await openSession(consensus, miner);
      await matureSession(consensus, sessionId);
      const perfectLookingTensor = Array.from({ length: 25 }, () => 0n); // sum 0, norm 0

      const before = await token.balanceOf(miner.address);
      // Pick a nonce that provably fails the target rather than assuming an
      // arbitrary one does: at this test difficulty nonce 0 clears it about
      // 1 run in 64, which is exactly the kind of flake that erodes trust in
      // a suite. Submitting *no* work is the forgery being reproduced.
      const seed = await consensus.sessionSeed(sessionId);
      const difficulty = await consensus.hashDifficulty();
      let lazyNonce = 0;
      while (
        BigInt(
          ethers.solidityPackedKeccak256(
            ["bytes32", "uint256", "uint256[]"],
            [seed, lazyNonce, perfectLookingTensor]
          )
        ) < difficulty
      ) {
        lazyNonce += 1;
      }

      await expect(
        consensus.connect(miner).commitBlock(sessionId, perfectLookingTensor, lazyNonce, 1n, 100n)
      ).to.be.revertedWith("Proof does not meet work target");

      expect(await consensus.committedBlockCount()).to.equal(0n);
      expect(await token.balanceOf(miner.address)).to.equal(before);
    });
  });

  describe("mining sessions fix the seed before the entropy exists", function () {
    it("draws the seed from blocks mined after the session was opened", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const openedAtBlock = await ethers.provider.getBlockNumber();
      const sessionId = await openSession(consensus, miner);

      // The session was opened in the block right after `openedAtBlock`, and
      // its seed starts SEED_DELAY blocks later still - so every block the
      // seed depends on was mined after the miner committed to the session.
      const seedStart = await consensus.sessionSeedStart(sessionId);
      expect(seedStart).to.be.greaterThan(openedAtBlock + 1);
      expect(seedStart).to.equal(BigInt(openedAtBlock + 1) + (await consensus.SEED_DELAY()));
    });

    it("refuses to reveal a seed before every block in its span exists", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const sessionId = await openSession(consensus, miner);

      await expect(consensus.sessionSeed(sessionId)).to.be.revertedWith("Seed not ready");
      await expect(
        consensus.connect(miner).commitBlock(sessionId, GOOD_TENSOR, 0n, 1n, 100n)
      ).to.be.revertedWith("Seed not ready");
    });

    it("folds several consecutive block hashes, so one producer cannot fix the seed", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const sessionId = await openSession(consensus, miner);
      await matureSession(consensus, sessionId);

      const seedStart = Number(await consensus.sessionSeedStart(sessionId));
      const span = Number(await consensus.SEED_SPAN());
      expect(span).to.be.greaterThan(1);

      // Recompute the seed the way the contract does, from the real hashes.
      let entropy = ethers.ZeroHash;
      for (let i = 0; i < span; i++) {
        const block = await ethers.provider.getBlock(seedStart + i);
        entropy = ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [entropy, block.hash]);
      }
      const expected = ethers.solidityPackedKeccak256(
        ["bytes32", "address", "uint256"],
        [entropy, miner.address, sessionId]
      );
      expect(await consensus.sessionSeed(sessionId)).to.equal(expected);
    });

    it("gives two sessions opened in the same block different seeds", async function () {
      // Same block hashes, different sessionId - so grinding sessions searches
      // the same uniform space as grinding nonces, and buys nothing.
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const first = await openSession(consensus, miner);
      const second = await openSession(consensus, miner);
      await matureSession(consensus, second);

      expect(await consensus.sessionSeed(first)).to.not.equal(await consensus.sessionSeed(second));
    });

    it("gives two miners different seeds for the same blocks", async function () {
      const { consensus, miner, other } = await loadFixture(deployConsensusFixture);
      const mine1 = await openSession(consensus, miner);
      const other1 = await openSession(consensus, other);
      await matureSession(consensus, other1);

      expect(await consensus.sessionSeed(mine1)).to.not.equal(await consensus.sessionSeed(other1));
    });

    it("refuses a session belonging to somebody else", async function () {
      const { consensus, miner, other } = await loadFixture(deployConsensusFixture);
      const sessionId = await openSession(consensus, miner);
      await matureSession(consensus, sessionId);

      await expect(
        consensus.connect(other).commitBlock(sessionId, GOOD_TENSOR, 0n, 1n, 100n)
      ).to.be.revertedWith("Session belongs to another miner");
    });

    it("spends a session on commit, so one session cannot yield two blocks", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const { sessionId, nonce } = await mineProof(consensus, miner, GOOD_TENSOR);

      await consensus.connect(miner).commitBlock(sessionId, GOOD_TENSOR, nonce, 1n, 100n);
      await expect(
        consensus.connect(miner).commitBlock(sessionId, GOOD_TENSOR, nonce, 1n, 100n)
      ).to.be.revertedWith("Session already used");

      expect(await consensus.committedBlockCount()).to.equal(1n);
    });

    it("expires a session that is never committed, so proofs cannot be banked", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const { sessionId, nonce } = await mineProof(consensus, miner, GOOD_TENSOR);

      await mine(Number(await consensus.SEED_WINDOW()) + 1);

      await expect(
        consensus.connect(miner).commitBlock(sessionId, GOOD_TENSOR, nonce, 1n, 100n)
      ).to.be.revertedWith("Session expired");
    });

    it("rejects an unknown session id", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      await expect(
        consensus.connect(miner).commitBlock(999n, GOOD_TENSOR, 0n, 1n, 100n)
      ).to.be.revertedWith("Unknown session");
      await expect(consensus.sessionSeed(999n)).to.be.revertedWith("Unknown session");
    });

    it("reports session bookkeeping", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      expect(await consensus.sessionCount()).to.equal(0n);

      const sessionId = await openSession(consensus, miner);
      expect(await consensus.sessionCount()).to.equal(1n);

      const seedStart = await consensus.sessionSeedStart(sessionId);
      expect(await consensus.sessionSeedReadyAt(sessionId)).to.equal(
        seedStart + (await consensus.SEED_SPAN())
      );
      expect(await consensus.sessionExpiresAt(sessionId)).to.equal(
        seedStart + (await consensus.SEED_WINDOW())
      );
    });
  });

  describe("replay protection", function () {
    // Single-use sessions are what actually stop replay now: resubmitting a
    // proof hits "Session already used" before the digest is ever consulted
    // (covered above). Reaching the `committedProofs` guard itself would need
    // two distinct sessions to yield the same digest, i.e. a keccak collision,
    // so it is unreachable belt-and-braces rather than the live defence - and
    // this test says so instead of pretending to exercise it.
    it("records the digest of every committed proof, and blocks resubmission", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const { sessionId, nonce, digest } = await mineProof(consensus, miner, GOOD_TENSOR);

      expect(await consensus.committedProofs(digest)).to.equal(false);
      await consensus.connect(miner).commitBlock(sessionId, GOOD_TENSOR, nonce, 1n, 100n);
      expect(await consensus.committedProofs(digest)).to.equal(true);

      // The same proof, resubmitted verbatim, earns nothing a second time.
      await expect(
        consensus.connect(miner).commitBlock(sessionId, GOOD_TENSOR, nonce, 1n, 100n)
      ).to.be.revertedWith("Session already used");
      expect(await consensus.committedBlockCount()).to.equal(1n);
    });
  });

  describe("efficiency and fraud gates", function () {
    it("rejects a proposer below the PoE threshold", async function () {
      const { consensus, other } = await loadFixture(deployConsensusFixture);
      const { sessionId, nonce } = await mineProof(consensus, other, GOOD_TENSOR);

      await expect(
        consensus.connect(other).commitBlock(sessionId, GOOD_TENSOR, nonce, 1n, 100n)
      ).to.be.revertedWith("PoE score below required threshold");
    });

    it("rejects a blacklisted proposer once a fraud registry is wired in", async function () {
      const { consensus, owner, miner } = await loadFixture(deployConsensusFixture);

      const FraudDetection = await ethers.getContractFactory("FraudDetection");
      const fraud = await FraudDetection.deploy();
      await fraud.waitForDeployment();
      await consensus.connect(owner).setFraudDetection(await fraud.getAddress());

      // One attestation per reporter, so drop the threshold rather than
      // calling three times from the same signer (which the registry rejects).
      await fraud.setBlacklistThreshold(1);
      await fraud.reportFraud(miner.address);
      expect(await fraud.isNodeBlacklisted(miner.address)).to.equal(true);

      const { sessionId, nonce } = await mineProof(consensus, miner, GOOD_TENSOR);
      await expect(
        consensus.connect(miner).commitBlock(sessionId, GOOD_TENSOR, nonce, 1n, 100n)
      ).to.be.revertedWith("Proposer is blacklisted");
    });

    it("rejects mining that overshoots the reference time by more than maxOE", async function () {
      const { consensus, miner } = await loadFixture(deployConsensusFixture);
      const { sessionId, nonce } = await mineProof(consensus, miner, GOOD_TENSOR);

      await expect(
        consensus
          .connect(miner)
          .commitBlock(sessionId, GOOD_TENSOR, nonce, REFERENCE_TIME + MAX_OE + 1n, 100n)
      ).to.be.revertedWith("Node entropy overhead too high");
    });
  });

  describe("automatic difficulty retargeting", function () {
    /** Commit `count` blocks, optionally advancing time before each. */
    async function commitBlocks(consensus, miner, count, { secondsBetween = 0 } = {}) {
      const receipts = [];
      for (let i = 0; i < count; i++) {
        if (secondsBetween > 0) {
          await time.increase(secondsBetween);
        }
        const { sessionId, nonce } = await mineProof(consensus, miner, GOOD_TENSOR);
        receipts.push(await (await consensus.connect(miner).commitBlock(sessionId, GOOD_TENSOR, nonce, 1n, 100n)).wait());
      }
      return receipts;
    }

    it("makes mining harder when blocks arrive faster than the target", async function () {
      const { consensus, owner, miner } = await loadFixture(deployConsensusFixture);
      // Two blocks per epoch, nominally 60s each: 120s expected per epoch.
      await consensus.connect(owner).setRetargetParams(2n, 60n);
      const before = await consensus.hashDifficulty();

      await commitBlocks(consensus, miner, 2);

      // Blocks arrived in seconds, far under the 120s expectation, so the
      // adjustment is clamped to the maximum 4x in the harder direction.
      const after = await consensus.hashDifficulty();
      expect(after).to.equal((before / 10_000n) * 2_500n);
      expect(after).to.be.lessThan(before);
    });

    it("makes mining easier when blocks arrive slower than the target", async function () {
      const { consensus, owner, miner } = await loadFixture(deployConsensusFixture);
      await consensus.connect(owner).setRetargetParams(2n, 60n);
      const before = await consensus.hashDifficulty();

      await commitBlocks(consensus, miner, 1);
      await time.increase(100_000); // far past the 120s epoch expectation
      await commitBlocks(consensus, miner, 1);

      const after = await consensus.hashDifficulty();
      expect(after).to.equal((before / 10_000n) * 40_000n);
      expect(after).to.be.greaterThan(before);
    });

    it("scales proportionally when timing lands inside the clamp", async function () {
      const { consensus, owner, miner } = await loadFixture(deployConsensusFixture);
      // 2 blocks x 10s = 20s expected, so the clamp only bites outside [5s, 80s].
      await consensus.connect(owner).setRetargetParams(2n, 10n);
      const before = await consensus.hashDifficulty();

      await commitBlocks(consensus, miner, 1);
      await time.increase(30); // total elapsed lands strictly inside the clamp
      const receipts = await commitBlocks(consensus, miner, 1);

      const event = receipts[0].logs
        .map((log) => {
          try {
            return consensus.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed && parsed.name === "DifficultyRetargeted");

      const { actualTimespan, expectedTimespan, previousDifficulty, newDifficulty } = event.args;
      expect(expectedTimespan).to.equal(20n);
      // Proof the clamp did not engage: actual is strictly within [1/4x, 4x].
      expect(actualTimespan).to.be.greaterThan(expectedTimespan / 4n);
      expect(actualTimespan).to.be.lessThan(expectedTimespan * 4n);
      expect(previousDifficulty).to.equal(before);
      expect(newDifficulty).to.equal(
        (before / 10_000n) * ((actualTimespan * 10_000n) / expectedTimespan)
      );
      expect(await consensus.hashDifficulty()).to.equal(newDifficulty);
    });

    it("never moves difficulty by more than the clamp, however long the gap", async function () {
      const { consensus, owner, miner } = await loadFixture(deployConsensusFixture);
      await consensus.connect(owner).setRetargetParams(2n, 60n);
      const before = await consensus.hashDifficulty();

      await commitBlocks(consensus, miner, 1);
      await time.increase(10n ** 9n); // ~30 years
      await commitBlocks(consensus, miner, 1);

      const factor = await consensus.MAX_RETARGET_FACTOR();
      expect(await consensus.hashDifficulty()).to.be.lessThanOrEqual(before * factor);
    });

    it("leaves difficulty alone until an epoch closes", async function () {
      const { consensus, owner, miner } = await loadFixture(deployConsensusFixture);
      await consensus.connect(owner).setRetargetParams(3n, 60n);
      const before = await consensus.hashDifficulty();

      expect(await consensus.blocksUntilRetarget()).to.equal(3n);
      await commitBlocks(consensus, miner, 2);

      expect(await consensus.hashDifficulty()).to.equal(before);
      expect(await consensus.blocksUntilRetarget()).to.equal(1n);

      await commitBlocks(consensus, miner, 1);
      expect(await consensus.hashDifficulty()).to.not.equal(before);
      expect(await consensus.blocksUntilRetarget()).to.equal(3n);
    });

    it("pins difficulty when the interval is zero", async function () {
      const { consensus, owner, miner } = await loadFixture(deployConsensusFixture);
      await consensus.connect(owner).setRetargetParams(0n, 60n);
      const before = await consensus.hashDifficulty();

      await commitBlocks(consensus, miner, 3);

      expect(await consensus.hashDifficulty()).to.equal(before);
      expect(await consensus.blocksUntilRetarget()).to.equal(0n);
    });

    it("does not compound retargets when several commits land in one block", async function () {
      // Two epochs can close inside a single block. The second one sees zero
      // elapsed time - not "blocks came fast", but "no timing information at
      // all" - and must not be read as a maximum-speed epoch, or difficulty
      // compounds 4x per extra in-block commit on no evidence.
      const { consensus, market, reporter, owner, miner, other } = await loadFixture(
        deployConsensusFixture
      );
      await market.connect(reporter).reportNodeMetrics(other.address, 1, 1);
      await consensus.connect(owner).setRetargetParams(1n, 60n);

      // Mine both proofs against a much harder target than the chain asks for,
      // so the first commit's retarget cannot invalidate the second proof and
      // the in-block path is actually reached.
      const before = await consensus.hashDifficulty();
      const hardened = before / 64n;
      const first = await mineProof(consensus, miner, GOOD_TENSOR, { difficultyOverride: hardened });
      const second = await mineProof(consensus, other, GOOD_TENSOR, { difficultyOverride: hardened });

      await network.provider.send("evm_setAutomine", [false]);
      const txA = await consensus
        .connect(miner)
        .commitBlock(first.sessionId, GOOD_TENSOR, first.nonce, 1n, 100n);
      const txB = await consensus
        .connect(other)
        .commitBlock(second.sessionId, GOOD_TENSOR, second.nonce, 1n, 100n);
      await mine();
      await network.provider.send("evm_setAutomine", [true]);

      const receiptA = await ethers.provider.getTransactionReceipt(txA.hash);
      const receiptB = await ethers.provider.getTransactionReceipt(txB.hash);
      expect(receiptA.blockNumber).to.equal(receiptB.blockNumber);
      expect(await consensus.committedBlockCount()).to.equal(2n);

      const retargets = [...receiptA.logs, ...receiptB.logs]
        .map((log) => {
          try {
            return consensus.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .filter((parsed) => parsed && parsed.name === "DifficultyRetargeted");

      // Exactly one adjustment for the block, and it measured real elapsed
      // time. Before the fix a second fired here with actualTimespan clamped
      // up from zero, tightening difficulty a further 4x on no evidence.
      expect(retargets.length).to.equal(1);
      expect(retargets[0].args.actualTimespan).to.be.greaterThan(0n);
      expect(await consensus.hashDifficulty()).to.equal(retargets[0].args.newDifficulty);
      expect(before).to.equal(retargets[0].args.previousDifficulty);
    });

    describe("the scaling arithmetic itself", function () {
      // The floor and ceiling cannot be reached through a real commitBlock -
      // at the floor no nonce is findable in a sane search - so the bounds and
      // the overflow-safety claim are checked directly on the internal helper.
      async function deployHarnessFixture() {
        const { market, greenNode } = await loadFixture(deployConsensusFixture);
        const Harness = await ethers.getContractFactory("PoEConsensusHarness");
        const harness = await Harness.deploy(
          await market.getAddress(),
          await greenNode.getAddress(),
          DIFFICULTY_TARGET,
          NORM_TARGET,
          EASY_HASH_DIFFICULTY,
          MAX_OE,
          REFERENCE_TIME
        );
        await harness.waitForDeployment();
        return harness;
      }

      it("clamps to the floor instead of walking difficulty to zero", async function () {
        const harness = await deployHarnessFixture();
        const floor = await harness.MIN_HASH_DIFFICULTY();

        // A quarter of the floor would land below it; the floor wins.
        expect(await harness.scaleTarget(floor, 1n, 4n)).to.equal(floor);
        expect(await harness.scaleTarget(1n, 1n, 1_000_000n)).to.equal(floor);
      });

      it("clamps to the ceiling and never overflows at the maximum", async function () {
        const harness = await deployHarnessFixture();
        const ceiling = await harness.MAX_HASH_DIFFICULTY();
        const factor = await harness.MAX_RETARGET_FACTOR();

        // The widest legal move from the largest legal target: the reason the
        // ceiling is type(uint256).max / MAX_RETARGET_FACTOR in the first place.
        expect(await harness.scaleTarget(ceiling, factor, 1n)).to.equal(ceiling);
        expect(ceiling * factor).to.be.lessThanOrEqual(2n ** 256n - 1n);
      });

      it("survives the widest legal retarget schedule without overflowing", async function () {
        // The bounds on the schedule exist to keep this arithmetic in range.
        // Run it at the extremes: an overflow would panic rather than return.
        const harness = await deployHarnessFixture();
        const expected =
          (await harness.MAX_RETARGET_INTERVAL()) * (await harness.MAX_TARGET_BLOCK_TIME());
        const factor = await harness.MAX_RETARGET_FACTOR();
        const ceiling = await harness.MAX_HASH_DIFFICULTY();

        expect(await harness.scaleTarget(ceiling, expected * factor, expected)).to.equal(ceiling);
        expect(await harness.scaleTarget(ceiling, expected / factor, expected)).to.equal(
          (ceiling / 10_000n) * 2_500n
        );
      });

      it("scales proportionally between the bounds", async function () {
        const harness = await deployHarnessFixture();
        const target = EASY_HASH_DIFFICULTY;

        expect(await harness.scaleTarget(target, 1n, 1n)).to.equal((target / 10_000n) * 10_000n);
        expect(await harness.scaleTarget(target, 2n, 1n)).to.equal((target / 10_000n) * 20_000n);
        expect(await harness.scaleTarget(target, 1n, 2n)).to.equal((target / 10_000n) * 5_000n);
      });
    });
  });

  describe("difficulty administration", function () {
    it("lets the owner retarget difficulty and rejects non-owners", async function () {
      const { consensus, owner, other } = await loadFixture(deployConsensusFixture);

      const manual = EASY_HASH_DIFFICULTY / 2n;
      await consensus.connect(owner).setHashDifficulty(manual);
      expect(await consensus.hashDifficulty()).to.equal(manual);

      await consensus.connect(owner).setDifficultyTargets(3_000_000n, 2_000_000n);
      expect(await consensus.difficultyTarget()).to.equal(3_000_000n);
      expect(await consensus.normTargetSquared()).to.equal(2_000_000n * 2_000_000n);

      await expect(consensus.connect(other).setHashDifficulty(manual)).to.be.revertedWith(
        "Not authorized"
      );
      await expect(consensus.connect(other).setRetargetParams(4n, 30n)).to.be.revertedWith(
        "Not authorized"
      );
      await expect(consensus.connect(other).setFraudDetection(other.address)).to.be.revertedWith(
        "Not authorized"
      );
    });

    it("refuses a difficulty outside the retargeting bounds", async function () {
      const { consensus, owner } = await loadFixture(deployConsensusFixture);
      // Zero would make the target unsatisfiable; the ceiling exists so a 4x
      // retarget cannot overflow.
      await expect(consensus.connect(owner).setHashDifficulty(0n)).to.be.revertedWith(
        "hashDifficulty out of range"
      );
      await expect(
        consensus.connect(owner).setHashDifficulty(2n ** 256n - 1n)
      ).to.be.revertedWith("hashDifficulty out of range");
    });

    it("refuses to deploy with a difficulty outside those bounds", async function () {
      const { market, greenNode } = await loadFixture(deployConsensusFixture);
      const PoEConsensus = await ethers.getContractFactory("PoEConsensus");

      await expect(
        PoEConsensus.deploy(
          await market.getAddress(),
          await greenNode.getAddress(),
          DIFFICULTY_TARGET,
          NORM_TARGET,
          0n,
          MAX_OE,
          REFERENCE_TIME
        )
      ).to.be.revertedWith("hashDifficulty out of range");
    });

    it("refuses a retarget schedule that would break the retarget arithmetic", async function () {
      const { consensus, owner } = await loadFixture(deployConsensusFixture);

      // Zero would divide by zero...
      await expect(consensus.connect(owner).setRetargetParams(4n, 0n)).to.be.revertedWith(
        "targetBlockTime out of range"
      );

      // ...and an absurd one would overflow `expected * MAX_RETARGET_FACTOR`
      // inside _maybeRetarget. That runs on every commit, so accepting it
      // would brick block production rather than merely misconfigure it.
      await expect(
        consensus.connect(owner).setRetargetParams(4n, (await consensus.MAX_TARGET_BLOCK_TIME()) + 1n)
      ).to.be.revertedWith("targetBlockTime out of range");
      await expect(
        consensus.connect(owner).setRetargetParams((await consensus.MAX_RETARGET_INTERVAL()) + 1n, 60n)
      ).to.be.revertedWith("retargetInterval too large");

      // The extremes of the accepted range must themselves survive a retarget.
      await consensus
        .connect(owner)
        .setRetargetParams(
          await consensus.MAX_RETARGET_INTERVAL(),
          await consensus.MAX_TARGET_BLOCK_TIME()
        );
      expect(await consensus.targetBlockTime()).to.equal(await consensus.MAX_TARGET_BLOCK_TIME());
    });

    it("restarts the epoch on a manual change, so stale timing is not applied", async function () {
      const { consensus, owner, miner } = await loadFixture(deployConsensusFixture);
      await consensus.connect(owner).setRetargetParams(2n, 60n);

      const { sessionId, nonce } = await mineProof(consensus, miner, GOOD_TENSOR);
      await consensus.connect(miner).commitBlock(sessionId, GOOD_TENSOR, nonce, 1n, 100n);
      expect(await consensus.blocksUntilRetarget()).to.equal(1n);

      await consensus.connect(owner).setHashDifficulty(EASY_HASH_DIFFICULTY / 2n);
      expect(await consensus.blocksUntilRetarget()).to.equal(2n);
      expect(await consensus.lastRetargetBlockCount()).to.equal(1n);
    });
  });
});
