const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Every administered DAM contract shares Ownable2Step. Before it, each declared
// its own `owner` with no way to change it, so the deploying key was the
// permanent administrator of a deployed system - no multisig handover, no
// rotation after a leak. These tests cover the base once, then assert every
// contract that inherits it really is transferable, because "the deploy script
// hands ownership to the admin" is only true if each of them can.

const EFFICIENCY_THRESHOLD = 1_000n;
const BASE_BLOCK_REWARD = 10n * 10n ** 18n;

async function deployAllFixture() {
  const [deployer, admin, outsider] = await ethers.getSigners();

  const PoEEnergyMarket = await ethers.getContractFactory("PoEEnergyMarket");
  const market = await PoEEnergyMarket.deploy(deployer.address, EFFICIENCY_THRESHOLD);

  const MLTaskManager = await ethers.getContractFactory("MLTaskManager");
  const taskManager = await MLTaskManager.deploy(deployer.address, deployer.address);

  const DAMAuction = await ethers.getContractFactory("DAMAuction");
  const auction = await DAMAuction.deploy(await taskManager.getAddress());

  const FraudDetection = await ethers.getContractFactory("FraudDetection");
  const fraud = await FraudDetection.deploy();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy("DAM Token", "DAM", BASE_BLOCK_REWARD * 100n);

  const PoEGreenNode = await ethers.getContractFactory("PoEGreenNode");
  const greenNode = await PoEGreenNode.deploy(await token.getAddress(), BASE_BLOCK_REWARD);

  const PoEConsensus = await ethers.getContractFactory("PoEConsensus");
  const consensus = await PoEConsensus.deploy(
    await market.getAddress(),
    await greenNode.getAddress(),
    2_000_000n,
    1_500_000n,
    (2n ** 256n - 1n) / 64n,
    60n,
    5n
  );

  return { deployer, admin, outsider, market, taskManager, auction, fraud, consensus, greenNode };
}

describe("Ownable2Step", function () {
  describe("the transfer handshake", function () {
    it("does not move ownership on nomination alone", async function () {
      const { deployer, admin, auction } = await loadFixture(deployAllFixture);

      await auction.connect(deployer).transferOwnership(admin.address);

      expect(await auction.owner()).to.equal(deployer.address);
      expect(await auction.pendingOwner()).to.equal(admin.address);
      // The outgoing owner still governs until the handshake completes.
      await auction.connect(deployer).setHelixSize(4n);
      await expect(auction.connect(admin).setHelixSize(5n)).to.be.revertedWith("Not authorized");
    });

    it("moves ownership only when the nominee accepts", async function () {
      const { deployer, admin, auction } = await loadFixture(deployAllFixture);

      await auction.connect(deployer).transferOwnership(admin.address);
      await expect(auction.connect(admin).acceptOwnership())
        .to.emit(auction, "OwnershipTransferred")
        .withArgs(deployer.address, admin.address);

      expect(await auction.owner()).to.equal(admin.address);
      expect(await auction.pendingOwner()).to.equal(ethers.ZeroAddress);

      await auction.connect(admin).setHelixSize(5n);
      await expect(auction.connect(deployer).setHelixSize(6n)).to.be.revertedWith("Not authorized");
    });

    it("emits the nomination so a handover can be watched for", async function () {
      const { deployer, admin, auction } = await loadFixture(deployAllFixture);
      await expect(auction.connect(deployer).transferOwnership(admin.address))
        .to.emit(auction, "OwnershipTransferStarted")
        .withArgs(deployer.address, admin.address);
    });

    it("lets only the nominee accept", async function () {
      const { deployer, admin, outsider, auction } = await loadFixture(deployAllFixture);
      await auction.connect(deployer).transferOwnership(admin.address);

      await expect(auction.connect(outsider).acceptOwnership()).to.be.revertedWith(
        "Not the pending owner"
      );
      await expect(auction.connect(deployer).acceptOwnership()).to.be.revertedWith(
        "Not the pending owner"
      );
      expect(await auction.owner()).to.equal(deployer.address);
    });

    it("lets only the owner nominate", async function () {
      const { admin, outsider, auction } = await loadFixture(deployAllFixture);
      await expect(
        auction.connect(outsider).transferOwnership(admin.address)
      ).to.be.revertedWith("Not authorized");
    });

    it("rejects the zero address", async function () {
      const { deployer, auction } = await loadFixture(deployAllFixture);
      await expect(
        auction.connect(deployer).transferOwnership(ethers.ZeroAddress)
      ).to.be.revertedWith("New owner is the zero address");
    });

    it("lets the owner withdraw a nomination", async function () {
      const { deployer, admin, auction } = await loadFixture(deployAllFixture);
      await auction.connect(deployer).transferOwnership(admin.address);
      await auction.connect(deployer).cancelOwnershipTransfer();

      expect(await auction.pendingOwner()).to.equal(ethers.ZeroAddress);
      await expect(auction.connect(admin).acceptOwnership()).to.be.revertedWith(
        "Not the pending owner"
      );
      expect(await auction.owner()).to.equal(deployer.address);
    });

    it("is recoverable after nominating an address that cannot accept", async function () {
      // The whole reason the transfer is two-step: a single-step send to a
      // wrong address would have ended administration permanently.
      const { deployer, admin, auction, greenNode } = await loadFixture(deployAllFixture);
      const unreachable = await greenNode.getAddress(); // a contract with no acceptOwnership

      await auction.connect(deployer).transferOwnership(unreachable);
      expect(await auction.owner()).to.equal(deployer.address);

      await auction.connect(deployer).transferOwnership(admin.address);
      await auction.connect(admin).acceptOwnership();
      expect(await auction.owner()).to.equal(admin.address);
    });

    it("has no way to renounce, because an owner-less contract is bricked", async function () {
      const { auction } = await loadFixture(deployAllFixture);
      const names = auction.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      expect(names).to.not.include("renounceOwnership");
    });
  });

  describe("every administered contract is transferable", function () {
    const cases = [
      ["DAMAuction", "auction"],
      ["FraudDetection", "fraud"],
      ["MLTaskManager", "taskManager"],
      ["PoEConsensus", "consensus"],
      ["PoEEnergyMarket", "market"],
    ];

    for (const [label, key] of cases) {
      it(`${label} can hand ownership to a new administrator`, async function () {
        const fixture = await loadFixture(deployAllFixture);
        const { deployer, admin } = fixture;
        const contract = fixture[key];

        expect(await contract.owner()).to.equal(deployer.address);

        await contract.connect(deployer).transferOwnership(admin.address);
        await contract.connect(admin).acceptOwnership();

        expect(await contract.owner()).to.equal(admin.address);
        expect(await contract.pendingOwner()).to.equal(ethers.ZeroAddress);
      });
    }

    it("PoEGreenNode keeps its single-step transfer, which is deliberate", async function () {
      // Its ownership goes to PoEConsensus, a contract that cannot call
      // acceptOwnership - a two-step handshake there would be unusable.
      const { greenNode, consensus } = await loadFixture(deployAllFixture);

      await greenNode.transferOwnership(await consensus.getAddress());
      expect(await greenNode.owner()).to.equal(await consensus.getAddress());

      const names = greenNode.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      expect(names).to.include("transferOwnership");
      expect(names).to.not.include("acceptOwnership");
    });
  });
});
