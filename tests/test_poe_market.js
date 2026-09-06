const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const EFFICIENCY_THRESHOLD = 1_000_000_000n; // 1e9, arbitrary but comfortably below typical scores below

async function deployMarketFixture() {
  const [reporter, nodeA, nodeB, nodeC, outsider] = await ethers.getSigners();

  const PoEEnergyMarket = await ethers.getContractFactory("PoEEnergyMarket");
  const market = await PoEEnergyMarket.connect(reporter).deploy(reporter.address, EFFICIENCY_THRESHOLD);
  await market.waitForDeployment();

  return { reporter, nodeA, nodeB, nodeC, outsider, market };
}

describe("PoEEnergyMarket", function () {
  describe("reportNodeMetrics", function () {
    it("computes score as 1e18 / (energy * latency) for the reported node", async function () {
      const { market, reporter, nodeA } = await loadFixture(deployMarketFixture);

      await market.connect(reporter).reportNodeMetrics(nodeA.address, 100, 5);

      const expected = 10n ** 18n / (100n * 5n);
      expect(await market.efficiencyScores(nodeA.address)).to.equal(expected);
    });

    it("reverts when called by anyone other than the reporter", async function () {
      const { market, nodeA, outsider } = await loadFixture(deployMarketFixture);

      await expect(
        market.connect(outsider).reportNodeMetrics(nodeA.address, 100, 5)
      ).to.be.revertedWith("Caller is not the authorized reporter");
    });

    it("closes the original exploit: a node cannot inherit another node's score by self-reporting", async function () {
      const { market, reporter, nodeA, nodeB } = await loadFixture(deployMarketFixture);

      // nodeA gets a real, good score via the trusted reporter.
      await market.connect(reporter).reportNodeMetrics(nodeA.address, 1, 1);
      expect(await market.efficiencyScores(nodeA.address)).to.equal(10n ** 18n);

      // nodeB - the "attacker" - cannot call reportNodeMetrics for itself or
      // anyone else; only the reporter can, and nodeB's own score is
      // untouched (still zero, never set).
      await expect(
        market.connect(nodeB).reportNodeMetrics(nodeB.address, 1, 1)
      ).to.be.revertedWith("Caller is not the authorized reporter");
      expect(await market.efficiencyScores(nodeB.address)).to.equal(0n);
    });

    it("scores zero when energy usage is zero", async function () {
      const { market, reporter, nodeA } = await loadFixture(deployMarketFixture);

      await market.connect(reporter).reportNodeMetrics(nodeA.address, 0, 5);

      expect(await market.efficiencyScores(nodeA.address)).to.equal(0n);
    });

    it("scores zero when latency is zero", async function () {
      const { market, reporter, nodeA } = await loadFixture(deployMarketFixture);

      await market.connect(reporter).reportNodeMetrics(nodeA.address, 100, 0);

      expect(await market.efficiencyScores(nodeA.address)).to.equal(0n);
    });

    it("registers a node once, even across repeated reports", async function () {
      const { market, reporter, nodeA } = await loadFixture(deployMarketFixture);

      await market.connect(reporter).reportNodeMetrics(nodeA.address, 100, 5);
      await market.connect(reporter).reportNodeMetrics(nodeA.address, 100, 5);

      expect(await market.nodeList(0)).to.equal(nodeA.address);
      await expect(market.nodeList(1)).to.be.reverted; // only one entry
    });
  });

  describe("setReporter", function () {
    it("lets the owner rotate the reporter", async function () {
      const { market, reporter, nodeA, outsider } = await loadFixture(deployMarketFixture);

      await market.connect(reporter).setReporter(outsider.address);

      await expect(
        market.connect(reporter).reportNodeMetrics(nodeA.address, 100, 5)
      ).to.be.revertedWith("Caller is not the authorized reporter");
      await market.connect(outsider).reportNodeMetrics(nodeA.address, 100, 5);
      expect(await market.efficiencyScores(nodeA.address)).to.be.greaterThan(0n);
    });

    it("reverts for non-owners", async function () {
      const { market, outsider } = await loadFixture(deployMarketFixture);

      await expect(market.connect(outsider).setReporter(outsider.address)).to.be.revertedWith(
        "Not authorized"
      );
    });
  });

  describe("deregisterNode", function () {
    it("removes the node, clears its score, and keeps the rest of the list intact", async function () {
      const { market, reporter, nodeA, nodeB, nodeC } = await loadFixture(deployMarketFixture);
      await market.connect(reporter).reportNodeMetrics(nodeA.address, 1, 1);
      await market.connect(reporter).reportNodeMetrics(nodeB.address, 2, 1);
      await market.connect(reporter).reportNodeMetrics(nodeC.address, 4, 1);

      // Remove the middle entry - the swap-and-pop path.
      await market.connect(reporter).deregisterNode(nodeB.address);

      expect(await market.efficiencyScores(nodeB.address)).to.equal(0n);
      const remaining = [await market.nodeList(0), await market.nodeList(1)];
      expect(remaining).to.have.members([nodeA.address, nodeC.address]);
      await expect(market.nodeList(2)).to.be.reverted; // list actually shrank
      // The surviving nodes keep their scores.
      expect(await market.efficiencyScores(nodeA.address)).to.be.greaterThan(0n);
      expect(await market.efficiencyScores(nodeC.address)).to.be.greaterThan(0n);
    });

    it("handles removing the last remaining node", async function () {
      const { market, reporter, nodeA } = await loadFixture(deployMarketFixture);
      await market.connect(reporter).reportNodeMetrics(nodeA.address, 1, 1);

      await market.connect(reporter).deregisterNode(nodeA.address);

      await expect(market.nodeList(0)).to.be.reverted;
      expect(await market.selectTopValidator()).to.equal(ethers.ZeroAddress);
    });

    it("lets a deregistered node be re-registered later without duplicating it", async function () {
      const { market, reporter, nodeA } = await loadFixture(deployMarketFixture);
      await market.connect(reporter).reportNodeMetrics(nodeA.address, 1, 1);
      await market.connect(reporter).deregisterNode(nodeA.address);
      await market.connect(reporter).reportNodeMetrics(nodeA.address, 1, 1);

      expect(await market.nodeList(0)).to.equal(nodeA.address);
      await expect(market.nodeList(1)).to.be.reverted;
    });

    it("reverts for an unregistered node and for non-owners", async function () {
      const { market, reporter, nodeA, outsider } = await loadFixture(deployMarketFixture);
      await expect(market.connect(reporter).deregisterNode(nodeA.address)).to.be.revertedWith(
        "Node is not registered"
      );

      await market.connect(reporter).reportNodeMetrics(nodeA.address, 1, 1);
      await expect(market.connect(outsider).deregisterNode(nodeA.address)).to.be.revertedWith(
        "Not authorized"
      );
    });
  });

  describe("selectTopValidator", function () {
    it("returns the highest-scoring node that meets the threshold", async function () {
      const { market, reporter, nodeA, nodeB } = await loadFixture(deployMarketFixture);

      // nodeA: energy=1, latency=1 -> score = 1e18 (well above threshold)
      await market.connect(reporter).reportNodeMetrics(nodeA.address, 1, 1);

      // nodeB: energy=10, latency=10 -> score = 1e16 (still above threshold, but lower than nodeA)
      await market.connect(reporter).reportNodeMetrics(nodeB.address, 10, 10);

      expect(await market.selectTopValidator()).to.equal(nodeA.address);
    });

    it("ignores nodes below the efficiency threshold", async function () {
      const { market, reporter, nodeA } = await loadFixture(deployMarketFixture);

      // energy=1e6, latency=1e6 -> score = 1e18 / 1e12 = 1e6, far below EFFICIENCY_THRESHOLD
      await market.connect(reporter).reportNodeMetrics(nodeA.address, 1_000_000, 1_000_000);

      expect(await market.selectTopValidator()).to.equal(ethers.ZeroAddress);
    });

    it("selects a node whose score is exactly at the threshold (boundary fix)", async function () {
      const { market, reporter, nodeA } = await loadFixture(deployMarketFixture);

      // Choose energy/latency so the score lands exactly on EFFICIENCY_THRESHOLD.
      const energy = 10n ** 18n / EFFICIENCY_THRESHOLD;
      await market.connect(reporter).reportNodeMetrics(nodeA.address, energy, 1);
      expect(await market.efficiencyScores(nodeA.address)).to.equal(EFFICIENCY_THRESHOLD);

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

  it("rejects a bid that overstates the bidder's on-chain PoE score", async function () {
    const { damAuction, market, reporter, nodeA } = await loadFixture(deployWiredFixture);
    await damAuction.setPoEEnergyMarket(await market.getAddress());

    // energy=100, latency=5 -> on-chain score = 1e18/500 = 2e15
    await market.connect(reporter).reportNodeMetrics(nodeA.address, 100, 5);
    const onChainScore = await market.efficiencyScores(nodeA.address);

    await damAuction.createAuction(1, 1000, 500, 0);

    await expect(
      damAuction.connect(nodeA).submitBid(1, onChainScore + 1n, 50, 100, 5)
    ).to.be.revertedWith("Reported efficiency exceeds on-chain PoE score");
  });

  it("accepts a bid that is at or below the bidder's on-chain PoE score", async function () {
    const { damAuction, market, reporter, nodeA } = await loadFixture(deployWiredFixture);
    await damAuction.setPoEEnergyMarket(await market.getAddress());

    await market.connect(reporter).reportNodeMetrics(nodeA.address, 100, 5);
    const onChainScore = await market.efficiencyScores(nodeA.address);

    await damAuction.createAuction(1, 1000, 500, 0);
    await damAuction.connect(nodeA).submitBid(1, onChainScore, 50, 100, 5);

    const bid = await damAuction.nodeBids(1, 0);
    expect(bid.efficiency).to.equal(onChainScore);
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
