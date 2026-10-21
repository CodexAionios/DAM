const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Scores are hashes per joule, 1e18-scaled. Energy is attested in millijoules.
const ONE_HASH_PER_JOULE = 10n ** 18n;
const SCORE_SCALE = 10n ** 21n; // 1e18 fixed point x 1000 mJ per J
const EFFICIENCY_THRESHOLD = 1_000n * ONE_HASH_PER_JOULE; // 1,000 hashes per joule

/** The score the market must compute: expectedHashes / joules, 1e18-scaled. */
const scoreFor = (expectedHashes, milliJoules) => (expectedHashes * SCORE_SCALE) / milliJoules;

async function deployMarketFixture() {
  // `consensus` is a plain signer standing in for the PoEConsensus contract,
  // so the market's scoring can be driven directly.
  const [reporter, consensus, nodeA, nodeB, nodeC, outsider] = await ethers.getSigners();

  const PoEEnergyMarket = await ethers.getContractFactory("PoEEnergyMarket");
  const market = await PoEEnergyMarket.connect(reporter).deploy(reporter.address, EFFICIENCY_THRESHOLD);
  await market.waitForDeployment();
  await market.connect(reporter).setConsensus(consensus.address);

  /** Attest energy, then score a block of `expectedHashes` work for `node`. */
  const scoreBlock = async (node, expectedHashes, milliJoules) => {
    await market.connect(reporter).reportEnergy(node.address, milliJoules);
    await market.connect(consensus).recordBlock(node.address, expectedHashes);
    return market.efficiencyScores(node.address);
  };

  return { reporter, consensus, nodeA, nodeB, nodeC, outsider, market, scoreBlock };
}

describe("PoEEnergyMarket", function () {
  describe("the metric measures work per joule", function () {
    it("scores a block as expectedHashes / joules, 1e18-scaled", async function () {
      const { market, scoreBlock, nodeA } = await loadFixture(deployMarketFixture);

      // 4,096 hashes for 1.5 J -> 2,730.67 hashes per joule.
      const score = await scoreBlock(nodeA, 4_096n, 1_500n);

      expect(score).to.equal(scoreFor(4_096n, 1_500n));
      expect(score).to.equal(2_730_666_666_666_666_666_666n);
      expect(await market.attestedEnergy(nodeA.address)).to.equal(0n);
    });

    it("gives an idle node nothing, where the old formula gave it the top score", async function () {
      // The bug this contract was rewritten for: with energy reported as CPU
      // load, an idle machine reported the least "energy" and earned the most.
      // Attesting energy is not work. Until a node commits a verified block,
      // its score is zero however little energy it reports.
      const { market, reporter, scoreBlock, nodeA, nodeB } = await loadFixture(deployMarketFixture);

      await market.connect(reporter).reportEnergy(nodeA.address, 1n); // "idle": 1 mJ, no work
      const busy = await scoreBlock(nodeB, 4_096n, 1_500n); // mined a real block

      expect(await market.efficiencyScores(nodeA.address)).to.equal(0n);
      expect(busy).to.be.greaterThan(0n);
      expect(await market.selectTopValidator()).to.equal(nodeB.address);
    });

    it("halves the score when the same work costs twice the energy", async function () {
      const { scoreBlock, nodeA, nodeB } = await loadFixture(deployMarketFixture);

      const frugal = await scoreBlock(nodeA, 8_192n, 1_000n);
      const wasteful = await scoreBlock(nodeB, 8_192n, 2_000n);

      expect(frugal).to.equal(wasteful * 2n);
    });

    it("doubles the score when the same energy buys twice the work", async function () {
      const { scoreBlock, nodeA, nodeB } = await loadFixture(deployMarketFixture);

      const slow = await scoreBlock(nodeA, 4_096n, 1_000n);
      const fast = await scoreBlock(nodeB, 8_192n, 1_000n);

      expect(fast).to.equal(slow * 2n);
    });

    it("no longer depends on latency at all", async function () {
      // Latency used to sit in the same denominator as energy. It is a
      // property of the network path, not of how efficiently a node works.
      const { market } = await loadFixture(deployMarketFixture);
      const names = market.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);

      expect(names).to.not.include("reportNodeMetrics");
      expect(names).to.include("reportEnergy");
    });
  });

  describe("reportEnergy", function () {
    it("reverts when called by anyone other than the reporter", async function () {
      const { market, nodeA, outsider } = await loadFixture(deployMarketFixture);

      await expect(market.connect(outsider).reportEnergy(nodeA.address, 1_000n)).to.be.revertedWith(
        "Caller is not the authorized reporter"
      );
    });

    it("does not let a node attest its own energy", async function () {
      const { market, nodeA } = await loadFixture(deployMarketFixture);

      await expect(market.connect(nodeA).reportEnergy(nodeA.address, 1n)).to.be.revertedWith(
        "Caller is not the authorized reporter"
      );
      expect(await market.attestedEnergy(nodeA.address)).to.equal(0n);
    });

    it("rejects a zero reading, which would make the score infinite", async function () {
      const { market, reporter, nodeA } = await loadFixture(deployMarketFixture);

      await expect(market.connect(reporter).reportEnergy(nodeA.address, 0n)).to.be.revertedWith(
        "Energy must be positive"
      );
    });

    it("overwrites an unused attestation instead of accumulating it", async function () {
      // Accumulating would let energy from failed attempts pile up until the
      // node could never reach the threshold again.
      const { market, reporter, consensus, nodeA } = await loadFixture(deployMarketFixture);

      await market.connect(reporter).reportEnergy(nodeA.address, 5_000n);
      await market.connect(reporter).reportEnergy(nodeA.address, 1_000n);
      expect(await market.attestedEnergy(nodeA.address)).to.equal(1_000n);

      await market.connect(consensus).recordBlock(nodeA.address, 4_096n);
      expect(await market.efficiencyScores(nodeA.address)).to.equal(scoreFor(4_096n, 1_000n));
    });

    it("registers a node once, even across repeated reports", async function () {
      const { market, reporter, nodeA } = await loadFixture(deployMarketFixture);

      await market.connect(reporter).reportEnergy(nodeA.address, 1_000n);
      await market.connect(reporter).reportEnergy(nodeA.address, 1_000n);

      expect(await market.nodeList(0)).to.equal(nodeA.address);
      await expect(market.nodeList(1)).to.be.reverted; // only one entry
    });

    it("emits the attestation", async function () {
      const { market, reporter, nodeA } = await loadFixture(deployMarketFixture);

      await expect(market.connect(reporter).reportEnergy(nodeA.address, 1_234n))
        .to.emit(market, "EnergyAttested")
        .withArgs(nodeA.address, 1_234n);
    });
  });

  describe("recordBlock", function () {
    it("is callable only by the consensus contract", async function () {
      const { market, reporter, nodeA, outsider } = await loadFixture(deployMarketFixture);
      await market.connect(reporter).reportEnergy(nodeA.address, 1_000n);

      await expect(market.connect(outsider).recordBlock(nodeA.address, 4_096n)).to.be.revertedWith(
        "Caller is not the consensus contract"
      );
      await expect(market.connect(reporter).recordBlock(nodeA.address, 4_096n)).to.be.revertedWith(
        "Caller is not the consensus contract"
      );
      await expect(market.connect(nodeA).recordBlock(nodeA.address, 4_096n)).to.be.revertedWith(
        "Caller is not the consensus contract"
      );
    });

    it("refuses to score a block with no attested energy", async function () {
      const { market, consensus, nodeA } = await loadFixture(deployMarketFixture);

      await expect(market.connect(consensus).recordBlock(nodeA.address, 4_096n)).to.be.revertedWith(
        "No attested energy for this block"
      );
    });

    it("consumes the attestation, so one energy report scores one block", async function () {
      const { market, reporter, consensus, nodeA } = await loadFixture(deployMarketFixture);
      await market.connect(reporter).reportEnergy(nodeA.address, 1_000n);

      await market.connect(consensus).recordBlock(nodeA.address, 4_096n);
      await expect(market.connect(consensus).recordBlock(nodeA.address, 4_096n)).to.be.revertedWith(
        "No attested energy for this block"
      );
    });

    it("emits the inputs and the score", async function () {
      const { market, reporter, consensus, nodeA } = await loadFixture(deployMarketFixture);
      await market.connect(reporter).reportEnergy(nodeA.address, 1_500n);

      await expect(market.connect(consensus).recordBlock(nodeA.address, 4_096n))
        .to.emit(market, "EfficiencyRecorded")
        .withArgs(nodeA.address, 4_096n, 1_500n, scoreFor(4_096n, 1_500n));
    });

    it("refuses work too large to scale rather than overflowing", async function () {
      const { market, reporter, consensus, nodeA } = await loadFixture(deployMarketFixture);
      await market.connect(reporter).reportEnergy(nodeA.address, 1n);
      const max = await market.MAX_EXPECTED_HASHES();

      await expect(market.connect(consensus).recordBlock(nodeA.address, max + 1n)).to.be.revertedWith(
        "Work too large to score"
      );
      // The bound itself still scores exactly.
      await market.connect(consensus).recordBlock(nodeA.address, max);
      expect(await market.efficiencyScores(nodeA.address)).to.equal(max * SCORE_SCALE);
    });
  });

  describe("administration", function () {
    it("lets the owner rotate the reporter", async function () {
      const { market, reporter, nodeA, outsider } = await loadFixture(deployMarketFixture);

      await market.connect(reporter).setReporter(outsider.address);

      await expect(market.connect(reporter).reportEnergy(nodeA.address, 1_000n)).to.be.revertedWith(
        "Caller is not the authorized reporter"
      );
      await market.connect(outsider).reportEnergy(nodeA.address, 1_000n);
      expect(await market.attestedEnergy(nodeA.address)).to.equal(1_000n);
    });

    it("lets the owner point at a new consensus contract", async function () {
      const { market, reporter, consensus, nodeA, outsider } = await loadFixture(deployMarketFixture);
      await market.connect(reporter).reportEnergy(nodeA.address, 1_000n);

      await market.connect(reporter).setConsensus(outsider.address);

      await expect(market.connect(consensus).recordBlock(nodeA.address, 4_096n)).to.be.revertedWith(
        "Caller is not the consensus contract"
      );
      await market.connect(outsider).recordBlock(nodeA.address, 4_096n);
    });

    it("lets the owner retune the threshold", async function () {
      const { market, reporter } = await loadFixture(deployMarketFixture);

      await market.connect(reporter).setEfficiencyThreshold(5n * ONE_HASH_PER_JOULE);
      expect(await market.efficiencyThreshold()).to.equal(5n * ONE_HASH_PER_JOULE);
    });

    it("reverts every setter for non-owners", async function () {
      const { market, outsider } = await loadFixture(deployMarketFixture);

      await expect(market.connect(outsider).setReporter(outsider.address)).to.be.revertedWith("Not authorized");
      await expect(market.connect(outsider).setConsensus(outsider.address)).to.be.revertedWith("Not authorized");
      await expect(market.connect(outsider).setEfficiencyThreshold(0n)).to.be.revertedWith("Not authorized");
    });
  });

  describe("deregisterNode", function () {
    it("removes the node, clears its score, and keeps the rest of the list intact", async function () {
      const { market, reporter, scoreBlock, nodeA, nodeB, nodeC } = await loadFixture(deployMarketFixture);
      await scoreBlock(nodeA, 4_096n, 1_000n);
      await scoreBlock(nodeB, 4_096n, 2_000n);
      await scoreBlock(nodeC, 4_096n, 4_000n);

      // Remove the middle entry - the swap-and-pop path.
      await market.connect(reporter).deregisterNode(nodeB.address);

      expect(await market.efficiencyScores(nodeB.address)).to.equal(0n);
      const remaining = [await market.nodeList(0), await market.nodeList(1)];
      expect(remaining).to.have.members([nodeA.address, nodeC.address]);
      await expect(market.nodeList(2)).to.be.reverted; // list actually shrank
      expect(await market.efficiencyScores(nodeA.address)).to.be.greaterThan(0n);
      expect(await market.efficiencyScores(nodeC.address)).to.be.greaterThan(0n);
    });

    it("clears a pending attestation, so a deregistered node cannot commit one more block", async function () {
      const { market, reporter, consensus, nodeA } = await loadFixture(deployMarketFixture);
      await market.connect(reporter).reportEnergy(nodeA.address, 1_000n);

      await market.connect(reporter).deregisterNode(nodeA.address);

      expect(await market.attestedEnergy(nodeA.address)).to.equal(0n);
      await expect(market.connect(consensus).recordBlock(nodeA.address, 4_096n)).to.be.revertedWith(
        "No attested energy for this block"
      );
    });

    it("handles removing the last remaining node", async function () {
      const { market, reporter, scoreBlock, nodeA } = await loadFixture(deployMarketFixture);
      await scoreBlock(nodeA, 4_096n, 1_000n);

      await market.connect(reporter).deregisterNode(nodeA.address);

      await expect(market.nodeList(0)).to.be.reverted;
      expect(await market.selectTopValidator()).to.equal(ethers.ZeroAddress);
    });

    it("lets a deregistered node be re-registered later without duplicating it", async function () {
      const { market, reporter, nodeA } = await loadFixture(deployMarketFixture);
      await market.connect(reporter).reportEnergy(nodeA.address, 1_000n);
      await market.connect(reporter).deregisterNode(nodeA.address);
      await market.connect(reporter).reportEnergy(nodeA.address, 1_000n);

      expect(await market.nodeList(0)).to.equal(nodeA.address);
      await expect(market.nodeList(1)).to.be.reverted;
    });

    it("reverts for an unregistered node and for non-owners", async function () {
      const { market, reporter, nodeA, outsider } = await loadFixture(deployMarketFixture);
      await expect(market.connect(reporter).deregisterNode(nodeA.address)).to.be.revertedWith(
        "Node is not registered"
      );

      await market.connect(reporter).reportEnergy(nodeA.address, 1_000n);
      await expect(market.connect(outsider).deregisterNode(nodeA.address)).to.be.revertedWith(
        "Not authorized"
      );
    });
  });

  describe("selectTopValidator", function () {
    it("returns the most efficient node that meets the threshold", async function () {
      const { market, scoreBlock, nodeA, nodeB } = await loadFixture(deployMarketFixture);

      await scoreBlock(nodeA, 4_096n, 1_000n); // 4,096 hashes per joule
      await scoreBlock(nodeB, 4_096n, 2_000n); // 2,048 hashes per joule

      expect(await market.selectTopValidator()).to.equal(nodeA.address);
    });

    it("ignores nodes below the efficiency threshold", async function () {
      const { market, scoreBlock, nodeA } = await loadFixture(deployMarketFixture);

      // 4,096 hashes for 8.192 kJ -> 0.5 hashes per joule, far below 1,000.
      await scoreBlock(nodeA, 4_096n, 8_192_000n);

      expect(await market.selectTopValidator()).to.equal(ethers.ZeroAddress);
    });

    it("selects a node whose score is exactly at the threshold (boundary fix)", async function () {
      const { market, scoreBlock, nodeA } = await loadFixture(deployMarketFixture);

      // 4,096 hashes for 4.096 J -> exactly 1,000 hashes per joule.
      const score = await scoreBlock(nodeA, 4_096n, 4_096n);
      expect(score).to.equal(EFFICIENCY_THRESHOLD);

      expect(await market.selectTopValidator()).to.equal(nodeA.address);
    });
  });
});

describe("DAMAuction + PoEEnergyMarket integration", function () {
  async function deployWiredFixture() {
    const base = await deployMarketFixture();

    const MLTaskManager = await ethers.getContractFactory("MLTaskManager");
    const mlTaskManager = await MLTaskManager.deploy(base.reporter.address, base.reporter.address);
    await mlTaskManager.waitForDeployment();

    const DAMAuction = await ethers.getContractFactory("DAMAuction");
    const damAuction = await DAMAuction.deploy(await mlTaskManager.getAddress());
    await damAuction.waitForDeployment();
    await mlTaskManager.setDAMAuction(await damAuction.getAddress());

    return { ...base, mlTaskManager, damAuction };
  }

  it("rejects a bid that overstates the bidder's verified efficiency", async function () {
    const { damAuction, market, scoreBlock, nodeA } = await loadFixture(deployWiredFixture);
    await damAuction.setPoEEnergyMarket(await market.getAddress());
    const onChainScore = await scoreBlock(nodeA, 4_096n, 1_500n);

    await damAuction.createAuction(1, 1000, 500, 0);

    await expect(
      damAuction.connect(nodeA).submitBid(1, onChainScore + 1n, 50, 100, 5)
    ).to.be.revertedWith("Reported efficiency exceeds on-chain PoE score");
  });

  it("accepts a bid that is at or below the bidder's verified efficiency", async function () {
    const { damAuction, market, scoreBlock, nodeA } = await loadFixture(deployWiredFixture);
    await damAuction.setPoEEnergyMarket(await market.getAddress());
    const onChainScore = await scoreBlock(nodeA, 4_096n, 1_500n);

    await damAuction.createAuction(1, 1000, 500, 0);
    await damAuction.connect(nodeA).submitBid(1, onChainScore, 50, 100, 5);

    const bid = await damAuction.nodeBids(1, 0);
    expect(bid.efficiency).to.equal(onChainScore);
  });

  it("refuses any positive efficiency from a node that has never committed a block", async function () {
    const { damAuction, market, reporter, nodeA } = await loadFixture(deployWiredFixture);
    await damAuction.setPoEEnergyMarket(await market.getAddress());
    await market.connect(reporter).reportEnergy(nodeA.address, 1n); // energy alone is not a score

    await damAuction.createAuction(1, 1000, 500, 0);

    await expect(damAuction.connect(nodeA).submitBid(1, 1n, 50, 100, 5)).to.be.revertedWith(
      "Reported efficiency exceeds on-chain PoE score"
    );
  });

  it("skips the cross-check entirely when no PoEEnergyMarket is configured", async function () {
    const { damAuction, nodeA } = await loadFixture(deployWiredFixture);
    // poeEnergyMarket defaults to address(0) - no setPoEEnergyMarket call.
    await damAuction.createAuction(1, 1000, 500, 0);

    await damAuction.connect(nodeA).submitBid(1, 999_999_999_999n, 50, 100, 5);

    const bid = await damAuction.nodeBids(1, 0);
    expect(bid.efficiency).to.equal(999_999_999_999n);
  });
});
