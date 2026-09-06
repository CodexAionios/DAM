// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title IERC20
 * @notice Minimal ERC20 interface for reward distribution.
 */
interface IERC20 {
    function transfer(address recipient, uint256 amount) external returns (bool);
}

/**
 * @title PoEGreenNode
 * @notice Distributes rewards to validators based on efficiency scores.
 *
 *  In the DAM network, validators who successfully commit blocks are rewarded
 *  according to their Proof‑of‑Efficiency (PoE) scores. This contract
 *  calculates a bonus relative to the base reward using the efficiency
 *  score provided by the PoE consensus logic. For simplicity, the caller
 *  must be the owner (e.g. the consensus contract), ensuring only
 *  authorized distribution occurs.
 */
contract PoEGreenNode {
    address public owner;
    address public rewardToken;
    uint256 public baseBlockReward;

    constructor(address _rewardToken, uint256 _baseBlockReward) {
        owner = msg.sender;
        rewardToken = _rewardToken;
        baseBlockReward = _baseBlockReward;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not authorized");
        _;
    }

    /**
     * @notice Hand off authorization to distribute rewards to another address.
     * @dev Deployment order requires this: PoEConsensus needs PoEGreenNode's
     *      address to be constructed, but PoEGreenNode also needs to trust
     *      PoEConsensus as its caller. PoEGreenNode is deployed first (owner
     *      = deployer), PoEConsensus is deployed pointing at it, then
     *      ownership is transferred to the PoEConsensus address.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "New owner cannot be the zero address");
        owner = newOwner;
    }

    /**
     * @notice Distribute block rewards to a validator.
     *
     *  The total reward consists of a base portion plus a bonus scaled by the
     *  validator's efficiency score. The efficiency score is expected to be
     *  1e18‑scaled, matching the calculation in PoEEnergyMarket. The bonus
     *  formula is linear; more sophisticated reward curves can be used in
     *  future revisions.
     *
     * @param validator Address of the validator to reward
     * @param efficiencyScore The validator's PoE score (1e18‑scaled)
     */
    function distributeBlockReward(address validator, uint256 efficiencyScore) external onlyOwner {
        // Compute bonus proportional to efficiency
        uint256 bonus = (efficiencyScore * baseBlockReward) / 1e18;
        uint256 totalReward = baseBlockReward + bonus;
        require(IERC20(rewardToken).transfer(validator, totalReward), "Reward transfer failed");
    }
}