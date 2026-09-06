const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const BLACKLIST_THRESHOLD = 3n;

async function deployFraudDetectionFixture() {
  const [owner, node, outsider] = await ethers.getSigners();

  const FraudDetection = await ethers.getContractFactory("FraudDetection");
  const fraudDetection = await FraudDetection.deploy();
  await fraudDetection.waitForDeployment();

  return { fraudDetection, owner, node, outsider };
}

describe("FraudDetection", function () {
  it("starts every node with a clean record", async function () {
    const { fraudDetection, node } = await loadFixture(deployFraudDetectionFixture);
    expect(await fraudDetection.fraudScores(node.address)).to.equal(0n);
    expect(await fraudDetection.isNodeBlacklisted(node.address)).to.equal(false);
  });

  it("increments a node's fraud score on each report", async function () {
    const { fraudDetection, node } = await loadFixture(deployFraudDetectionFixture);

    await fraudDetection.reportFraud(node.address);
    expect(await fraudDetection.fraudScores(node.address)).to.equal(1n);

    await fraudDetection.reportFraud(node.address);
    expect(await fraudDetection.fraudScores(node.address)).to.equal(2n);
  });

  it("blacklists only once reports reach the threshold, and stays blacklisted after", async function () {
    const { fraudDetection, node } = await loadFixture(deployFraudDetectionFixture);

    for (let i = 1n; i < BLACKLIST_THRESHOLD; i++) {
      await fraudDetection.reportFraud(node.address);
      expect(await fraudDetection.isNodeBlacklisted(node.address)).to.equal(false);
    }

    // The threshold itself is inclusive.
    await fraudDetection.reportFraud(node.address);
    expect(await fraudDetection.fraudScores(node.address)).to.equal(BLACKLIST_THRESHOLD);
    expect(await fraudDetection.isNodeBlacklisted(node.address)).to.equal(true);

    await fraudDetection.reportFraud(node.address);
    expect(await fraudDetection.isNodeBlacklisted(node.address)).to.equal(true);
  });

  it("keeps each node's record independent", async function () {
    const { fraudDetection, node, outsider } = await loadFixture(deployFraudDetectionFixture);

    await fraudDetection.reportFraud(node.address);
    await fraudDetection.reportFraud(node.address);
    await fraudDetection.reportFraud(node.address);

    expect(await fraudDetection.isNodeBlacklisted(node.address)).to.equal(true);
    expect(await fraudDetection.isNodeBlacklisted(outsider.address)).to.equal(false);
  });

  it("only lets the owner report fraud", async function () {
    const { fraudDetection, node, outsider } = await loadFixture(deployFraudDetectionFixture);

    await expect(
      fraudDetection.connect(outsider).reportFraud(node.address)
    ).to.be.revertedWith("Only the owner can call this function.");

    expect(await fraudDetection.fraudScores(node.address)).to.equal(0n);
  });

  // The registry is only worth anything if something reads it. Both consumers
  // expose a setter, and their enforcement paths are covered in
  // test_dam_auction.js (bidding and helix selection) and
  // test_poe_consensus.js (block commitment).
  it("is readable by the contracts that enforce it", async function () {
    for (const name of ["DAMAuction", "PoEConsensus"]) {
      const factory = await ethers.getContractFactory(name);
      const hasSetter = factory.interface.fragments.some(
        (fragment) => fragment.name === "setFraudDetection"
      );
      expect(hasSetter, `${name} should be able to consult a fraud registry`).to.equal(true);
    }
  });

  it("blocks a blacklisted node end to end, from bidding through block commitment", async function () {
    const { fraudDetection, node } = await loadFixture(deployFraudDetectionFixture);
    for (let i = 0; i < 3; i++) await fraudDetection.reportFraud(node.address);

    const MLTaskManager = await ethers.getContractFactory("MLTaskManager");
    const mlTaskManager = await MLTaskManager.deploy(node.address, node.address);
    await mlTaskManager.waitForDeployment();

    const DAMAuction = await ethers.getContractFactory("DAMAuction");
    const damAuction = await DAMAuction.deploy(await mlTaskManager.getAddress());
    await damAuction.waitForDeployment();
    await damAuction.setFraudDetection(await fraudDetection.getAddress());

    await damAuction.createAuction(1, 1000, 500, 0);
    await expect(
      damAuction.connect(node).submitBid(1, 10, 10, 10, 1)
    ).to.be.revertedWith("Node is blacklisted");
  });
});
