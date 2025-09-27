// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

/**
 * @title PoEEnergyMarket
 * @notice Tracks energy usage and latency to compute a node's efficiency score.
 */
contract PoEEnergyMarket {
    AggregatorV3Interface internal energyOracle;
    AggregatorV3Interface internal latencyOracle;
    address public owner;
    uint256 public efficiencyThreshold;

    mapping(address => uint256) public efficiencyScores;

    constructor(
        address _energyOracleAddress,
        address _latencyOracleAddress,
        uint256 _efficiencyThreshold
    ) {
        energyOracle = AggregatorV3Interface(_energyOracleAddress);
        latencyOracle = AggregatorV3Interface(_latencyOracleAddress);
        owner = msg.sender;
        efficiencyThreshold = _efficiencyThreshold;
    }

    function updateEfficiencyScore(address node) public {
        (, int256 energyUsage, , , ) = energyOracle.latestRoundData();
        (, int256 latency, , , ) = latencyOracle.latestRoundData();

        uint256 score = calculateEfficiencyScore(energyUsage, latency);
        efficiencyScores[node] = score;
    }

    function calculateEfficiencyScore(
        int256 energyUsage,
        int256 latency
    ) internal pure returns (uint256) {
        if (energyUsage <= 0 || latency <= 0) return 0;
        return 1 / (uint256(energyUsage) * uint256(latency));
    }
}
