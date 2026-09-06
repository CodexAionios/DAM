const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const BASE_BLOCK_REWARD = 10n * 10n ** 18n;
const REWARD_POOL = 1_000n * 10n ** 18n;

async function deployGreenNodeFixture() {
  const [owner, consensus, validator, outsider] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy("DAM Token", "DAM", REWARD_POOL * 2n);
  await token.waitForDeployment();

  const PoEGreenNode = await ethers.getContractFactory("PoEGreenNode");
  // `consensus` stands in for the PoEConsensus contract as the authorized caller.
  const greenNode = await PoEGreenNode.deploy(await token.getAddress(), BASE_BLOCK_REWARD);
  await greenNode.waitForDeployment();
  await token.transfer(await greenNode.getAddress(), REWARD_POOL);

  return { owner, consensus, validator, outsider, token, greenNode };
}

describe("PoEGreenNode", function () {
  it("scales the reward by the validator's efficiency score", async function () {
    const { greenNode, owner, validator, token } = await loadFixture(deployGreenNodeFixture);

    // A score of 0.5e18 should add half a base reward on top of the base.
    const score = 5n * 10n ** 17n;
    const before = await token.balanceOf(validator.address);
    await greenNode.connect(owner).distributeBlockReward(validator.address, score);

    const expected = BASE_BLOCK_REWARD + (score * BASE_BLOCK_REWARD) / 10n ** 18n;
    expect((await token.balanceOf(validator.address)) - before).to.equal(expected);
  });

  it("pays only the base reward when the score is zero", async function () {
    const { greenNode, owner, validator, token } = await loadFixture(deployGreenNodeFixture);
    const before = await token.balanceOf(validator.address);

    await greenNode.connect(owner).distributeBlockReward(validator.address, 0n);

    expect((await token.balanceOf(validator.address)) - before).to.equal(BASE_BLOCK_REWARD);
  });

  it("only lets the owner distribute rewards", async function () {
    const { greenNode, outsider, validator } = await loadFixture(deployGreenNodeFixture);
    await expect(
      greenNode.connect(outsider).distributeBlockReward(validator.address, 1n)
    ).to.be.revertedWith("Not authorized");
  });

  describe("transferOwnership", function () {
    it("hands the reward authority to the new owner and revokes the old one", async function () {
      const { greenNode, owner, consensus, validator } = await loadFixture(deployGreenNodeFixture);

      await greenNode.connect(owner).transferOwnership(consensus.address);
      expect(await greenNode.owner()).to.equal(consensus.address);

      await expect(
        greenNode.connect(owner).distributeBlockReward(validator.address, 0n)
      ).to.be.revertedWith("Not authorized");
      await greenNode.connect(consensus).distributeBlockReward(validator.address, 0n);
    });

    it("rejects the zero address and non-owners", async function () {
      const { greenNode, owner, outsider } = await loadFixture(deployGreenNodeFixture);

      await expect(
        greenNode.connect(owner).transferOwnership(ethers.ZeroAddress)
      ).to.be.revertedWith("New owner cannot be the zero address");

      await expect(
        greenNode.connect(outsider).transferOwnership(outsider.address)
      ).to.be.revertedWith("Not authorized");
    });
  });

  it("reverts when the reward token reports a failed transfer", async function () {
    const [owner, validator] = await ethers.getSigners();

    // Returns false instead of reverting - the case an unchecked transfer()
    // return value would silently swallow, leaving a block paid for nothing.
    const FailingERC20 = await ethers.getContractFactory("MockFailingERC20");
    const badToken = await FailingERC20.deploy();
    await badToken.waitForDeployment();

    const PoEGreenNode = await ethers.getContractFactory("PoEGreenNode");
    const greenNode = await PoEGreenNode.deploy(await badToken.getAddress(), BASE_BLOCK_REWARD);
    await greenNode.waitForDeployment();

    await expect(
      greenNode.connect(owner).distributeBlockReward(validator.address, 0n)
    ).to.be.revertedWith("Reward transfer failed");
  });

  it("reverts when the reward pool is empty rather than recording an unpaid block", async function () {
    const [owner, validator] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("DAM", "DAM", BASE_BLOCK_REWARD);
    await token.waitForDeployment();

    const PoEGreenNode = await ethers.getContractFactory("PoEGreenNode");
    const greenNode = await PoEGreenNode.deploy(await token.getAddress(), BASE_BLOCK_REWARD);
    await greenNode.waitForDeployment();
    // Deliberately unfunded.

    await expect(
      greenNode.connect(owner).distributeBlockReward(validator.address, 0n)
    ).to.be.revertedWith("Insufficient balance");
  });
});
