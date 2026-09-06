const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  loadFixture,
  impersonateAccount,
  stopImpersonatingAccount,
  setBalance,
} = require("@nomicfoundation/hardhat-network-helpers");

async function deployDAMAuctionFixture() {
  const [owner, reporter, ...bidders] = await ethers.getSigners();

  const MLTaskManager = await ethers.getContractFactory("MLTaskManager");
  // MLTaskManager needs DAMAuction's address and vice versa, so it is first
  // deployed pointing at the owner, then re-pointed at the real DAMAuction
  // once that is deployed - mirroring the two-step wiring documented on
  // MLTaskManager.setDAMAuction.
  const mlTaskManager = await MLTaskManager.deploy(owner.address, reporter.address);
  await mlTaskManager.waitForDeployment();

  const DAMAuction = await ethers.getContractFactory("DAMAuction");
  const damAuction = await DAMAuction.deploy(await mlTaskManager.getAddress());
  await damAuction.waitForDeployment();

  await mlTaskManager.connect(owner).setDAMAuction(await damAuction.getAddress());

  return { damAuction, mlTaskManager, owner, reporter, bidders };
}

async function createAuctionAndBid(
  damAuction,
  bidders,
  bids,
  { efficiencyReq = 0, timeLimit = 1000, dataHash = 1, budget = 1000 } = {}
) {
  await damAuction.createAuction(dataHash, budget, timeLimit, efficiencyReq);
  const auctionId = await damAuction.auctionCounter();

  for (let i = 0; i < bids.length; i++) {
    const { efficiency, latency, hashPower, price } = bids[i];
    await damAuction.connect(bidders[i]).submitBid(auctionId, efficiency, latency, hashPower, price);
  }
  return auctionId;
}

function findEvent(receipt, iface, name) {
  return receipt.logs
    .map((log) => {
      try {
        return iface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === name);
}

describe("DAMAuction", function () {
  describe("createAuction", function () {
    it("stores a new active task and increments the auction counter", async function () {
      const { damAuction } = await loadFixture(deployDAMAuctionFixture);
      await damAuction.createAuction(123, 1000, 500, 50);

      expect(await damAuction.auctionCounter()).to.equal(1n);

      const task = await damAuction.dataTasks(1);
      expect(task.dataHash).to.equal(123n);
      expect(task.budget).to.equal(1000n);
      expect(task.timeLimit).to.equal(500n);
      expect(task.efficiencyReq).to.equal(50n);
      expect(task.isActive).to.equal(true);
    });
  });

  describe("submitBid", function () {
    it("records a bid against an active auction", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      await damAuction.createAuction(1, 1000, 500, 50);
      await damAuction.connect(bidders[0]).submitBid(1, 80, 100, 200, 10);

      const bid = await damAuction.nodeBids(1, 0);
      expect(bid.nodeAddress).to.equal(bidders[0].address);
      expect(bid.efficiency).to.equal(80n);
      expect(bid.latency).to.equal(100n);
      expect(bid.hashPower).to.equal(200n);
      expect(bid.price).to.equal(10n);
    });

    it("reverts when the auction is not active", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      await expect(
        damAuction.connect(bidders[0]).submitBid(1, 80, 100, 200, 10)
      ).to.be.revertedWith("Auction not active");
    });

    it("replaces a bidder's existing bid instead of consuming another slot", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      await damAuction.createAuction(1, 1000, 500, 50);

      await damAuction.connect(bidders[0]).submitBid(1, 80, 100, 200, 10);
      await damAuction.connect(bidders[0]).submitBid(1, 90, 50, 300, 7);

      expect(await damAuction.bidCount(1)).to.equal(1n);
      const bid = await damAuction.nodeBids(1, 0);
      expect(bid.nodeAddress).to.equal(bidders[0].address);
      expect(bid.efficiency).to.equal(90n);
      expect(bid.latency).to.equal(50n);
      expect(bid.hashPower).to.equal(300n);
      expect(bid.price).to.equal(7n);
    });

    it("keeps separate slots for distinct bidders", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      await damAuction.createAuction(1, 1000, 500, 50);

      await damAuction.connect(bidders[0]).submitBid(1, 80, 100, 200, 10);
      await damAuction.connect(bidders[1]).submitBid(1, 80, 100, 200, 10);

      expect(await damAuction.bidCount(1)).to.equal(2n);
      expect(await damAuction.bidIndexOf(1, bidders[0].address)).to.equal(1n);
      expect(await damAuction.bidIndexOf(1, bidders[1].address)).to.equal(2n);
    });

    it("enforces maxBidsPerAuction once the cap is reached", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      await damAuction.setHelixSize(2); // cap can't go below helixSize
      await damAuction.setMaxBidsPerAuction(2);
      await damAuction.createAuction(1, 1000, 500, 50);

      await damAuction.connect(bidders[0]).submitBid(1, 80, 100, 200, 10);
      await damAuction.connect(bidders[1]).submitBid(1, 80, 100, 200, 10);

      await expect(
        damAuction.connect(bidders[2]).submitBid(1, 80, 100, 200, 10)
      ).to.be.revertedWith("Auction bid limit reached");

      // A bidder already holding a slot can still revise their bid at the cap.
      await damAuction.connect(bidders[0]).submitBid(1, 85, 90, 250, 9);
      expect(await damAuction.bidCount(1)).to.equal(2n);
    });

    it("keeps formHelix affordable at a completely full auction (the DoS bound)", async function () {
      // The cap only prevents a gas DoS if the chosen value is itself
      // affordable, so fill an auction to maxBidsPerAuction from that many
      // distinct addresses and confirm formHelix still fits comfortably in a
      // block rather than just asserting a cap exists.
      const { damAuction, owner } = await loadFixture(deployDAMAuctionFixture);

      // Measure the configuration that actually ships: deploy_smart_contracts.js
      // wires a fraud registry in, which costs an external call per qualifying
      // bid during selection. Measuring without it would understate the bound.
      const FraudDetection = await ethers.getContractFactory("FraudDetection");
      const fraud = await FraudDetection.deploy();
      await fraud.waitForDeployment();
      await damAuction.setFraudDetection(await fraud.getAddress());

      const cap = Number(await damAuction.maxBidsPerAuction());
      await damAuction.createAuction(1, 1000, 500, 0);

      for (let i = 0; i < cap; i++) {
        const bidder = ethers.Wallet.createRandom().address;
        await setBalance(bidder, 10n ** 18n);
        await impersonateAccount(bidder);
        const signer = await ethers.getSigner(bidder);
        await damAuction.connect(signer).submitBid(1, 50 + i, 10, 100 + i, 5);
        await stopImpersonatingAccount(bidder);
      }

      expect(await damAuction.bidCount(1)).to.equal(BigInt(cap));

      const tx = await damAuction.connect(owner).formHelix(1);
      const receipt = await tx.wait();
      const blockGasLimit = (await ethers.provider.getBlock("latest")).gasLimit;

      // Comfortably inside a block: assert real headroom, not just success.
      console.log(
        `        formHelix at ${cap} bids: ${receipt.gasUsed} gas ` +
          `(${((Number(receipt.gasUsed) / Number(blockGasLimit)) * 100).toFixed(1)}% of the block limit)`
      );
      expect(receipt.gasUsed).to.be.lessThan(blockGasLimit / 4n);
      expect((await damAuction.getHelixMembers(1)).length).to.equal(6);
    });

    it("bounds formHelix's work: a single spammer cannot fill the cap alone", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      await damAuction.setHelixSize(2); // cap can't go below helixSize
      await damAuction.setMaxBidsPerAuction(3);
      await damAuction.createAuction(1, 1000, 500, 50);

      // 20 attempts from one address still occupy exactly one slot.
      for (let i = 0; i < 20; i++) {
        await damAuction.connect(bidders[0]).submitBid(1, 80, 100, 200, 10);
      }

      expect(await damAuction.bidCount(1)).to.equal(1n);
    });
  });

  describe("formHelix", function () {
    it("reverts for non-owner callers", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      await damAuction.createAuction(1, 1000, 500, 50);
      await expect(damAuction.connect(bidders[0]).formHelix(1)).to.be.revertedWith(
        "Only the owner can call this function."
      );
    });

    it("reverts when there are no bids", async function () {
      const { damAuction } = await loadFixture(deployDAMAuctionFixture);
      await damAuction.createAuction(1, 1000, 500, 50);
      await expect(damAuction.formHelix(1)).to.be.revertedWith("No bids submitted");
    });

    it("reverts when no bids meet the task requirements", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      await createAuctionAndBid(
        damAuction,
        bidders,
        [{ efficiency: 10, latency: 9999, hashPower: 100, price: 5 }],
        { efficiencyReq: 50, timeLimit: 500 }
      );

      await expect(damAuction.formHelix(1)).to.be.revertedWith("No suitable bids");
    });

    it("forms a helix capped at helixSize, deactivates the task, and emits HelixFormed", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      const bids = [
        { efficiency: 80, latency: 50, hashPower: 100, price: 5 },
        { efficiency: 82, latency: 40, hashPower: 200, price: 5 },
        { efficiency: 85, latency: 30, hashPower: 300, price: 5 },
        { efficiency: 88, latency: 20, hashPower: 400, price: 5 },
        { efficiency: 90, latency: 60, hashPower: 500, price: 5 },
        { efficiency: 95, latency: 45, hashPower: 600, price: 5 },
        { efficiency: 70, latency: 55, hashPower: 700, price: 5 },
        { efficiency: 60, latency: 35, hashPower: 800, price: 5 },
        { efficiency: 10, latency: 9999, hashPower: 50, price: 5 }, // disqualified: latency too high
      ];
      const auctionId = await createAuctionAndBid(damAuction, bidders, bids, {
        efficiencyReq: 50,
        timeLimit: 100,
      });

      const tx = await damAuction.formHelix(auctionId);
      const receipt = await tx.wait();
      const event = findEvent(receipt, damAuction.interface, "HelixFormed");

      expect(event).to.not.be.undefined;
      expect(event.args.auctionId).to.equal(auctionId);
      expect(event.args.members.length).to.equal(6);
      expect(event.args.members).to.not.include(bidders[8].address);

      const task = await damAuction.dataTasks(auctionId);
      expect(task.isActive).to.equal(false);

      const members = await damAuction.getHelixMembers(event.args.helixId);
      expect(members.length).to.equal(6);
    });

    it("selects fewer than helixSize members when fewer bids qualify", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      const bids = [
        { efficiency: 80, latency: 50, hashPower: 100, price: 5 },
        { efficiency: 82, latency: 40, hashPower: 200, price: 5 },
        { efficiency: 85, latency: 30, hashPower: 300, price: 5 },
      ];
      const auctionId = await createAuctionAndBid(damAuction, bidders, bids, {
        efficiencyReq: 50,
        timeLimit: 100,
      });

      const tx = await damAuction.formHelix(auctionId);
      const receipt = await tx.wait();
      const event = findEvent(receipt, damAuction.interface, "HelixFormed");

      expect(event.args.members.length).to.equal(3);
    });

    it("ranks bidders by the blended hash power / latency / efficiency score", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      // Latency and efficiency are held constant so hash power alone drives
      // the ranking - the top 6 of 8 by hash power must be selected.
      const bids = [100, 200, 300, 400, 500, 600, 700, 800].map((hashPower) => ({
        efficiency: 80,
        latency: 50,
        hashPower,
        price: 5,
      }));
      const auctionId = await createAuctionAndBid(damAuction, bidders, bids, {
        efficiencyReq: 50,
        timeLimit: 100,
      });

      await damAuction.formHelix(auctionId);
      const helixId = await damAuction.helixCounter();
      const members = await damAuction.getHelixMembers(helixId);

      expect(members).to.not.include(bidders[0].address); // hashPower 100
      expect(members).to.not.include(bidders[1].address); // hashPower 200
      for (let i = 2; i < 8; i++) {
        expect(members).to.include(bidders[i].address);
      }
    });

    it("registers the helix with MLTaskManager, including each member's hash power", async function () {
      const { damAuction, mlTaskManager, bidders } = await loadFixture(deployDAMAuctionFixture);
      const bids = [
        { efficiency: 80, latency: 50, hashPower: 100, price: 5 },
        { efficiency: 82, latency: 40, hashPower: 200, price: 5 },
      ];
      const auctionId = await createAuctionAndBid(damAuction, bidders, bids, {
        efficiencyReq: 50,
        timeLimit: 100,
      });

      await damAuction.formHelix(auctionId);
      const helixId = await damAuction.helixCounter();

      const summary = await mlTaskManager.getHelixSummary(helixId);
      expect(summary.auctionId).to.equal(auctionId);
      expect(summary.status).to.equal(1n); // HelixStatus.Registered

      expect(await mlTaskManager.memberHashPower(helixId, bidders[0].address)).to.equal(100n);
      expect(await mlTaskManager.memberHashPower(helixId, bidders[1].address)).to.equal(200n);
    });
  });

  describe("fraud blacklist enforcement", function () {
    async function blacklist(fraud, address) {
      for (let i = 0; i < 3; i++) await fraud.reportFraud(address);
      expect(await fraud.isNodeBlacklisted(address)).to.equal(true);
    }

    it("refuses bids from a blacklisted node once a registry is wired in", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      const FraudDetection = await ethers.getContractFactory("FraudDetection");
      const fraud = await FraudDetection.deploy();
      await fraud.waitForDeployment();
      await damAuction.setFraudDetection(await fraud.getAddress());

      await damAuction.createAuction(1, 1000, 500, 0);
      await blacklist(fraud, bidders[0].address);

      await expect(
        damAuction.connect(bidders[0]).submitBid(1, 80, 100, 200, 10)
      ).to.be.revertedWith("Node is blacklisted");

      // An honest node is unaffected.
      await damAuction.connect(bidders[1]).submitBid(1, 80, 100, 200, 10);
      expect(await damAuction.bidCount(1)).to.equal(1n);
    });

    it("skips a node blacklisted after it already bid, during helix selection", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      const FraudDetection = await ethers.getContractFactory("FraudDetection");
      const fraud = await FraudDetection.deploy();
      await fraud.waitForDeployment();
      await damAuction.setFraudDetection(await fraud.getAddress());
      await damAuction.setHelixSize(2);

      await damAuction.createAuction(1, 1000, 500, 0);
      for (let i = 0; i < 3; i++) {
        await damAuction.connect(bidders[i]).submitBid(1, 80, 100, 200 + i, 10);
      }

      // Blacklisted only after bidding - the bid is already recorded.
      await blacklist(fraud, bidders[2].address);
      expect(await damAuction.bidCount(1)).to.equal(3n);

      await damAuction.formHelix(1);
      const members = await damAuction.getHelixMembers(1);
      expect(members).to.not.include(bidders[2].address);
      expect(members.length).to.equal(2);
    });

    it("reverts helix formation when every remaining bidder is blacklisted", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      const FraudDetection = await ethers.getContractFactory("FraudDetection");
      const fraud = await FraudDetection.deploy();
      await fraud.waitForDeployment();
      await damAuction.setFraudDetection(await fraud.getAddress());

      await damAuction.createAuction(1, 1000, 500, 0);
      await damAuction.connect(bidders[0]).submitBid(1, 80, 100, 200, 10);
      await blacklist(fraud, bidders[0].address);

      await expect(damAuction.formHelix(1)).to.be.revertedWith("No suitable bids");
    });

    it("leaves behavior unchanged while no registry is configured", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      expect(await damAuction.fraudDetection()).to.equal(ethers.ZeroAddress);

      await damAuction.createAuction(1, 1000, 500, 0);
      await damAuction.connect(bidders[0]).submitBid(1, 80, 100, 200, 10);
      expect(await damAuction.bidCount(1)).to.equal(1n);
    });

    it("reverts setFraudDetection for non-owners", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      await expect(
        damAuction.connect(bidders[0]).setFraudDetection(bidders[0].address)
      ).to.be.revertedWith("Only the owner can call this function.");
    });
  });

  describe("setHelixSize / setMLTaskManager", function () {
    it("lets the owner update helixSize", async function () {
      const { damAuction } = await loadFixture(deployDAMAuctionFixture);
      await damAuction.setHelixSize(3);
      expect(await damAuction.helixSize()).to.equal(3n);
    });

    it("reverts helixSize below 2", async function () {
      const { damAuction } = await loadFixture(deployDAMAuctionFixture);
      await expect(damAuction.setHelixSize(1)).to.be.revertedWith(
        "Helix must have at least 2 members"
      );
    });

    it("keeps helixSize and maxBidsPerAuction consistent in both directions", async function () {
      const { damAuction } = await loadFixture(deployDAMAuctionFixture);

      // A helix larger than the bid cap could never be filled.
      await expect(damAuction.setHelixSize(101)).to.be.revertedWith(
        "helixSize must be <= maxBidsPerAuction"
      );

      // ...and the cap can't be lowered under the current helix size either.
      await expect(damAuction.setMaxBidsPerAuction(5)).to.be.revertedWith(
        "maxBidsPerAuction must be >= helixSize"
      );

      await damAuction.setMaxBidsPerAuction(6);
      expect(await damAuction.maxBidsPerAuction()).to.equal(6n);
    });

    it("reverts setMaxBidsPerAuction for non-owners", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      await expect(
        damAuction.connect(bidders[0]).setMaxBidsPerAuction(50)
      ).to.be.revertedWith("Only the owner can call this function.");
    });

    it("reverts setHelixSize / setMLTaskManager for non-owners", async function () {
      const { damAuction, bidders } = await loadFixture(deployDAMAuctionFixture);
      await expect(damAuction.connect(bidders[0]).setHelixSize(3)).to.be.revertedWith(
        "Only the owner can call this function."
      );
      await expect(
        damAuction.connect(bidders[0]).setMLTaskManager(bidders[0].address)
      ).to.be.revertedWith("Only the owner can call this function.");
    });
  });
});
