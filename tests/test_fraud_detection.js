const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const DEFAULT_THRESHOLD = 3n;

async function deployFraudDetectionFixture() {
  const [owner, node, outsider, second, third] = await ethers.getSigners();

  const FraudDetection = await ethers.getContractFactory("FraudDetection");
  const fraudDetection = await FraudDetection.deploy();
  await fraudDetection.waitForDeployment();

  return { fraudDetection, owner, node, outsider, second, third };
}

/** Authorize `signers` and have each attest against `node`. */
async function attestAll(fraudDetection, signers, node) {
  for (const signer of signers) {
    await fraudDetection.setReporter(signer.address, true);
    await fraudDetection.connect(signer).reportFraud(node.address);
  }
}

describe("FraudDetection", function () {
  it("starts every node with a clean record", async function () {
    const { fraudDetection, node } = await loadFixture(deployFraudDetectionFixture);
    expect(await fraudDetection.fraudScores(node.address)).to.equal(0n);
    expect(await fraudDetection.isNodeBlacklisted(node.address)).to.equal(false);
    expect(await fraudDetection.blacklistThreshold()).to.equal(DEFAULT_THRESHOLD);
  });

  it("authorizes the deployer as the first reporter", async function () {
    const { fraudDetection, owner, outsider } = await loadFixture(deployFraudDetectionFixture);
    expect(await fraudDetection.isReporter(owner.address)).to.equal(true);
    expect(await fraudDetection.isReporter(outsider.address)).to.equal(false);
  });

  describe("one attestation per reporter", function () {
    it("counts distinct reporters rather than repeated calls", async function () {
      const { fraudDetection, owner, node, second, third } = await loadFixture(
        deployFraudDetectionFixture
      );

      await fraudDetection.connect(owner).reportFraud(node.address);
      expect(await fraudDetection.fraudScores(node.address)).to.equal(1n);

      // The same reporter saying it again changes nothing. This is what makes
      // an automated detection loop safe to run on a schedule.
      await expect(
        fraudDetection.connect(owner).reportFraud(node.address)
      ).to.be.revertedWith("Reporter already flagged this node");
      expect(await fraudDetection.fraudScores(node.address)).to.equal(1n);

      await attestAll(fraudDetection, [second, third], node);
      expect(await fraudDetection.fraudScores(node.address)).to.equal(3n);
    });

    it("blacklists only once enough distinct reporters agree", async function () {
      const { fraudDetection, owner, node, second, third } = await loadFixture(
        deployFraudDetectionFixture
      );

      await fraudDetection.connect(owner).reportFraud(node.address);
      expect(await fraudDetection.isNodeBlacklisted(node.address)).to.equal(false);

      await attestAll(fraudDetection, [second], node);
      expect(await fraudDetection.isNodeBlacklisted(node.address)).to.equal(false);

      await attestAll(fraudDetection, [third], node);
      expect(await fraudDetection.isNodeBlacklisted(node.address)).to.equal(true);
    });

    it("cannot be blacklisted by one reporter looping, however many times it tries", async function () {
      // The bug this design exists to prevent: a monitoring loop re-reporting
      // an anomalous node every cycle used to blacklist it on the third pass,
      // regardless of how many independent parties actually agreed.
      const { fraudDetection, owner, node } = await loadFixture(deployFraudDetectionFixture);

      await fraudDetection.connect(owner).reportFraud(node.address);
      for (let i = 0; i < 5; i++) {
        await expect(
          fraudDetection.connect(owner).reportFraud(node.address)
        ).to.be.revertedWith("Reporter already flagged this node");
      }

      expect(await fraudDetection.fraudScores(node.address)).to.equal(1n);
      expect(await fraudDetection.isNodeBlacklisted(node.address)).to.equal(false);
    });

    it("keeps each node's record independent", async function () {
      const { fraudDetection, owner, node, outsider, second, third } = await loadFixture(
        deployFraudDetectionFixture
      );

      await fraudDetection.connect(owner).reportFraud(node.address);
      await attestAll(fraudDetection, [second, third], node);

      expect(await fraudDetection.isNodeBlacklisted(node.address)).to.equal(true);
      expect(await fraudDetection.isNodeBlacklisted(outsider.address)).to.equal(false);
      expect(await fraudDetection.fraudScores(outsider.address)).to.equal(0n);
    });

    it("refuses to attest against the zero address", async function () {
      const { fraudDetection, owner } = await loadFixture(deployFraudDetectionFixture);
      await expect(
        fraudDetection.connect(owner).reportFraud(ethers.ZeroAddress)
      ).to.be.revertedWith("Cannot report the zero address");
    });
  });

  describe("withdrawing an accusation", function () {
    it("lets a reporter revoke its own attestation and un-blacklist a node", async function () {
      // Automated detection produces false positives, so an accusation that
      // could not be retracted would be worse than the problem it catches.
      const { fraudDetection, owner, node, second, third } = await loadFixture(
        deployFraudDetectionFixture
      );

      await fraudDetection.connect(owner).reportFraud(node.address);
      await attestAll(fraudDetection, [second, third], node);
      expect(await fraudDetection.isNodeBlacklisted(node.address)).to.equal(true);

      await fraudDetection.connect(third).revokeReport(node.address);
      expect(await fraudDetection.fraudScores(node.address)).to.equal(2n);
      expect(await fraudDetection.isNodeBlacklisted(node.address)).to.equal(false);
      expect(await fraudDetection.hasReported(third.address, node.address)).to.equal(false);
    });

    it("lets a reporter re-attest after revoking, without double counting", async function () {
      const { fraudDetection, owner, node } = await loadFixture(deployFraudDetectionFixture);

      await fraudDetection.connect(owner).reportFraud(node.address);
      await fraudDetection.connect(owner).revokeReport(node.address);
      expect(await fraudDetection.fraudScores(node.address)).to.equal(0n);

      await fraudDetection.connect(owner).reportFraud(node.address);
      expect(await fraudDetection.fraudScores(node.address)).to.equal(1n);
    });

    it("refuses to revoke an attestation that was never made", async function () {
      const { fraudDetection, owner, node } = await loadFixture(deployFraudDetectionFixture);
      await expect(
        fraudDetection.connect(owner).revokeReport(node.address)
      ).to.be.revertedWith("Reporter has not flagged this node");
    });

    it("lets the owner clear a node that several reporters agreed on", async function () {
      const { fraudDetection, owner, node, second, third } = await loadFixture(
        deployFraudDetectionFixture
      );

      await fraudDetection.connect(owner).reportFraud(node.address);
      await attestAll(fraudDetection, [second, third], node);
      expect(await fraudDetection.isNodeBlacklisted(node.address)).to.equal(true);

      await fraudDetection.connect(owner).clearNode(node.address);
      expect(await fraudDetection.fraudScores(node.address)).to.equal(0n);
      expect(await fraudDetection.isNodeBlacklisted(node.address)).to.equal(false);

      // Every reporter's flag really is cleared, so they can attest afresh
      // rather than being stuck holding a retracted accusation.
      for (const signer of [owner, second, third]) {
        expect(await fraudDetection.hasReported(signer.address, node.address)).to.equal(false);
      }
      await fraudDetection.connect(second).reportFraud(node.address);
      expect(await fraudDetection.fraudScores(node.address)).to.equal(1n);
    });
  });

  describe("administration", function () {
    it("only lets authorized reporters attest", async function () {
      const { fraudDetection, node, outsider } = await loadFixture(deployFraudDetectionFixture);

      await expect(
        fraudDetection.connect(outsider).reportFraud(node.address)
      ).to.be.revertedWith("Caller is not an authorized reporter");
      expect(await fraudDetection.fraudScores(node.address)).to.equal(0n);
    });

    it("lets the owner authorize and revoke reporters", async function () {
      const { fraudDetection, owner, node, outsider } = await loadFixture(
        deployFraudDetectionFixture
      );

      await fraudDetection.connect(owner).setReporter(outsider.address, true);
      await fraudDetection.connect(outsider).reportFraud(node.address);
      expect(await fraudDetection.fraudScores(node.address)).to.equal(1n);

      await fraudDetection.connect(owner).setReporter(outsider.address, false);
      await expect(
        fraudDetection.connect(outsider).revokeReport(node.address)
      ).to.be.revertedWith("Caller is not an authorized reporter");
    });

    it("rejects reporter and threshold changes from non-owners", async function () {
      const { fraudDetection, outsider } = await loadFixture(deployFraudDetectionFixture);

      await expect(
        fraudDetection.connect(outsider).setReporter(outsider.address, true)
      ).to.be.revertedWith("Only the owner can call this function.");
      await expect(
        fraudDetection.connect(outsider).setBlacklistThreshold(1)
      ).to.be.revertedWith("Only the owner can call this function.");
      await expect(
        fraudDetection.connect(outsider).clearNode(outsider.address)
      ).to.be.revertedWith("Only the owner can call this function.");
      await expect(
        fraudDetection.connect(outsider).setReporter(ethers.ZeroAddress, true)
      ).to.be.revertedWith("Only the owner can call this function.");
    });

    it("refuses a zero threshold, which would blacklist every node", async function () {
      const { fraudDetection, owner, outsider } = await loadFixture(deployFraudDetectionFixture);

      await expect(
        fraudDetection.connect(owner).setBlacklistThreshold(0)
      ).to.be.revertedWith("Threshold must be positive");
      // A zero threshold would make this true for an untouched node.
      expect(await fraudDetection.isNodeBlacklisted(outsider.address)).to.equal(false);
    });

    it("refuses to authorize the zero address", async function () {
      const { fraudDetection, owner } = await loadFixture(deployFraudDetectionFixture);
      await expect(
        fraudDetection.connect(owner).setReporter(ethers.ZeroAddress, true)
      ).to.be.revertedWith("Cannot authorize the zero address");
    });

    it("tracks reporters once, even when re-authorized repeatedly", async function () {
      const { fraudDetection, owner, outsider } = await loadFixture(deployFraudDetectionFixture);
      const before = await fraudDetection.knownReporterCount();

      await fraudDetection.connect(owner).setReporter(outsider.address, true);
      await fraudDetection.connect(owner).setReporter(outsider.address, false);
      await fraudDetection.connect(owner).setReporter(outsider.address, true);

      expect(await fraudDetection.knownReporterCount()).to.equal(before + 1n);
      await expect(fraudDetection.knownReporterAt(99)).to.be.revertedWith("Index out of bounds");
    });

    it("applies a lowered threshold to accusations already on record", async function () {
      const { fraudDetection, owner, node } = await loadFixture(deployFraudDetectionFixture);

      await fraudDetection.connect(owner).reportFraud(node.address);
      expect(await fraudDetection.isNodeBlacklisted(node.address)).to.equal(false);

      await fraudDetection.connect(owner).setBlacklistThreshold(1);
      expect(await fraudDetection.isNodeBlacklisted(node.address)).to.equal(true);
    });
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
    const { fraudDetection, owner, node, second, third } = await loadFixture(
      deployFraudDetectionFixture
    );
    await fraudDetection.connect(owner).reportFraud(node.address);
    await attestAll(fraudDetection, [second, third], node);

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

    // And clearing the accusation lets the node back in - enforcement follows
    // the registry rather than latching.
    await fraudDetection.connect(owner).clearNode(node.address);
    await damAuction.connect(node).submitBid(1, 10, 10, 10, 1);
    expect(await damAuction.bidCount(1)).to.equal(1n);
  });
});
