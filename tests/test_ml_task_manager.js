const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

async function deployStandaloneFixture() {
  const [damAuction, reporter, ...members] = await ethers.getSigners();
  // damAuction doubles as the owner and as the address MLTaskManager treats
  // as "the DAMAuction contract", so tests can call registerHelix directly
  // without routing through a real DAMAuction deployment.
  const MLTaskManager = await ethers.getContractFactory("MLTaskManager");
  const mlTaskManager = await MLTaskManager.connect(damAuction).deploy(
    damAuction.address,
    reporter.address
  );
  await mlTaskManager.waitForDeployment();

  return { mlTaskManager, damAuction, reporter, members };
}

async function registerSampleHelix(
  mlTaskManager,
  damAuction,
  members,
  hashPowers,
  { helixId = 1, auctionId = 1, taskId = 1, poeGoal = 80 } = {}
) {
  const memberAddrs = members.map((m) => m.address);
  await mlTaskManager
    .connect(damAuction)
    .registerHelix(helixId, auctionId, memberAddrs, hashPowers, taskId, poeGoal);
  return helixId;
}

describe("MLTaskManager", function () {
  describe("registerHelix", function () {
    it("reverts when called by anyone other than the linked DAMAuction address", async function () {
      const { mlTaskManager, members } = await loadFixture(deployStandaloneFixture);
      await expect(
        mlTaskManager.connect(members[0]).registerHelix(1, 1, [members[0].address], [100], 1, 80)
      ).to.be.revertedWith("Caller is not the DAMAuction contract");
    });

    it("reverts on empty membership", async function () {
      const { mlTaskManager, damAuction } = await loadFixture(deployStandaloneFixture);
      await expect(
        mlTaskManager.connect(damAuction).registerHelix(1, 1, [], [], 1, 80)
      ).to.be.revertedWith("Helix must have members");
    });

    it("reverts when members and hash power arrays differ in length", async function () {
      const { mlTaskManager, damAuction, members } = await loadFixture(deployStandaloneFixture);
      await expect(
        mlTaskManager
          .connect(damAuction)
          .registerHelix(1, 1, [members[0].address, members[1].address], [100], 1, 80)
      ).to.be.revertedWith("Members/hashPower length mismatch");
    });

    it("reverts when the same helixId is registered twice", async function () {
      const { mlTaskManager, damAuction, members } = await loadFixture(deployStandaloneFixture);
      await registerSampleHelix(mlTaskManager, damAuction, members.slice(0, 2), [100, 200]);
      await expect(
        registerSampleHelix(mlTaskManager, damAuction, members.slice(0, 2), [100, 200])
      ).to.be.revertedWith("Helix already registered");
    });

    it("stores members, total hash power and marks the helix Registered", async function () {
      const { mlTaskManager, damAuction, members } = await loadFixture(deployStandaloneFixture);
      const helixId = await registerSampleHelix(
        mlTaskManager,
        damAuction,
        members.slice(0, 3),
        [100, 200, 300]
      );

      const summary = await mlTaskManager.getHelixSummary(helixId);
      expect(summary.status).to.equal(1n); // Registered
      expect(summary.poeGoal).to.equal(80n);

      const storedMembers = await mlTaskManager.getHelixMembers(helixId);
      expect(storedMembers).to.deep.equal(members.slice(0, 3).map((m) => m.address));
      expect(await mlTaskManager.memberHashPower(helixId, members[0].address)).to.equal(100n);
    });
  });

  describe("reportCompletion", function () {
    it("reverts when called by anyone other than the reporter", async function () {
      const { mlTaskManager, damAuction, members } = await loadFixture(deployStandaloneFixture);
      const helixId = await registerSampleHelix(mlTaskManager, damAuction, members.slice(0, 2), [100, 200]);
      await expect(
        mlTaskManager.connect(damAuction).reportCompletion(helixId, members[0].address, 90)
      ).to.be.revertedWith("Caller is not the authorized reporter");
    });

    it("reverts when the address is not a helix member", async function () {
      const { mlTaskManager, damAuction, reporter, members } = await loadFixture(deployStandaloneFixture);
      const helixId = await registerSampleHelix(mlTaskManager, damAuction, members.slice(0, 2), [100, 200]);
      await expect(
        mlTaskManager.connect(reporter).reportCompletion(helixId, members[5].address, 90)
      ).to.be.revertedWith("Address is not a member of this helix");
    });

    it("records the reported score", async function () {
      const { mlTaskManager, damAuction, reporter, members } = await loadFixture(deployStandaloneFixture);
      const helixId = await registerSampleHelix(mlTaskManager, damAuction, members.slice(0, 2), [100, 200]);
      await mlTaskManager.connect(reporter).reportCompletion(helixId, members[0].address, 90);

      expect(await mlTaskManager.memberScores(helixId, members[0].address)).to.equal(90n);
      expect(await mlTaskManager.memberReported(helixId, members[0].address)).to.equal(true);
    });
  });

  describe("finalizeHelix", function () {
    it("reverts until every member has reported", async function () {
      const { mlTaskManager, damAuction, reporter, members } = await loadFixture(deployStandaloneFixture);
      const helixId = await registerSampleHelix(mlTaskManager, damAuction, members.slice(0, 2), [100, 200]);
      await mlTaskManager.connect(reporter).reportCompletion(helixId, members[0].address, 90);

      await expect(mlTaskManager.finalizeHelix(helixId)).to.be.revertedWith(
        "Not all members have reported"
      );
    });

    it("computes a hash-power-weighted combined score and marks the helix green when it meets the goal", async function () {
      const { mlTaskManager, damAuction, reporter, members } = await loadFixture(deployStandaloneFixture);
      // hashPower 100 & 300, scores 60 & 100 -> weighted = (60*100 + 100*300) / 400 = 90
      const helixId = await registerSampleHelix(
        mlTaskManager,
        damAuction,
        members.slice(0, 2),
        [100, 300],
        { poeGoal: 85 }
      );
      await mlTaskManager.connect(reporter).reportCompletion(helixId, members[0].address, 60);
      await mlTaskManager.connect(reporter).reportCompletion(helixId, members[1].address, 100);

      await mlTaskManager.finalizeHelix(helixId);

      const summary = await mlTaskManager.getHelixSummary(helixId);
      expect(summary.combinedScore).to.equal(90n);
      expect(summary.isGreen).to.equal(true);
      expect(summary.status).to.equal(2n); // Finalized
    });

    it("marks the helix not green when the combined score misses the goal", async function () {
      const { mlTaskManager, damAuction, reporter, members } = await loadFixture(deployStandaloneFixture);
      const helixId = await registerSampleHelix(
        mlTaskManager,
        damAuction,
        members.slice(0, 2),
        [100, 300],
        { poeGoal: 95 }
      );
      await mlTaskManager.connect(reporter).reportCompletion(helixId, members[0].address, 60);
      await mlTaskManager.connect(reporter).reportCompletion(helixId, members[1].address, 100);

      await mlTaskManager.finalizeHelix(helixId);

      const summary = await mlTaskManager.getHelixSummary(helixId);
      expect(summary.combinedScore).to.equal(90n);
      expect(summary.isGreen).to.equal(false);
    });

    it("falls back to an equal-weighted average when no hash power was recorded", async function () {
      const { mlTaskManager, damAuction, reporter, members } = await loadFixture(deployStandaloneFixture);
      const helixId = await registerSampleHelix(
        mlTaskManager,
        damAuction,
        members.slice(0, 3),
        [0, 0, 0],
        { poeGoal: 50 }
      );
      await mlTaskManager.connect(reporter).reportCompletion(helixId, members[0].address, 30);
      await mlTaskManager.connect(reporter).reportCompletion(helixId, members[1].address, 60);
      await mlTaskManager.connect(reporter).reportCompletion(helixId, members[2].address, 90);

      await mlTaskManager.finalizeHelix(helixId);

      const summary = await mlTaskManager.getHelixSummary(helixId);
      expect(summary.combinedScore).to.equal(60n); // (30 + 60 + 90) / 3
    });

    it("reverts when finalizing an already-finalized helix", async function () {
      const { mlTaskManager, damAuction, reporter, members } = await loadFixture(deployStandaloneFixture);
      const helixId = await registerSampleHelix(mlTaskManager, damAuction, members.slice(0, 2), [100, 200]);
      await mlTaskManager.connect(reporter).reportCompletion(helixId, members[0].address, 90);
      await mlTaskManager.connect(reporter).reportCompletion(helixId, members[1].address, 90);
      await mlTaskManager.finalizeHelix(helixId);

      await expect(mlTaskManager.finalizeHelix(helixId)).to.be.revertedWith(
        "Helix not open for finalization"
      );
    });
  });

  describe("end-to-end with DAMAuction", function () {
    it("forms a helix through DAMAuction, then reports and finalizes it through MLTaskManager", async function () {
      const [owner, reporter, ...bidders] = await ethers.getSigners();

      const MLTaskManager = await ethers.getContractFactory("MLTaskManager");
      const mlTaskManager = await MLTaskManager.deploy(owner.address, reporter.address);
      await mlTaskManager.waitForDeployment();

      const DAMAuction = await ethers.getContractFactory("DAMAuction");
      const damAuction = await DAMAuction.deploy(await mlTaskManager.getAddress());
      await damAuction.waitForDeployment();

      await mlTaskManager.setDAMAuction(await damAuction.getAddress());
      await damAuction.setHelixSize(2);

      await damAuction.createAuction(1, 1000, 500, 50);
      await damAuction.connect(bidders[0]).submitBid(1, 80, 50, 100, 5);
      await damAuction.connect(bidders[1]).submitBid(1, 90, 40, 300, 5);

      await damAuction.formHelix(1);
      const helixId = await damAuction.helixCounter();

      const members = await mlTaskManager.getHelixMembers(helixId);
      expect(members.length).to.equal(2);

      for (const memberAddr of members) {
        await mlTaskManager.connect(reporter).reportCompletion(helixId, memberAddr, 100);
      }

      await mlTaskManager.finalizeHelix(helixId);

      const summary = await mlTaskManager.getHelixSummary(helixId);
      expect(summary.combinedScore).to.equal(100n);
      expect(summary.isGreen).to.equal(true);
      expect(summary.status).to.equal(2n);
    });
  });
});
