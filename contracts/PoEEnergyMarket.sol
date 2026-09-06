// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title PoEEnergyMarket
 * @notice Tracks energy usage and latency to compute each node's efficiency score.
 *
 *  A trusted off-chain reporter (the DAM AI backend, mirroring
 *  `MLTaskManager.reportCompletion`'s trust model) submits one specific node's
 *  measured energy usage and latency at a time via `reportNodeMetrics`, and the
 *  contract computes a precision-scaled efficiency score for that node.
 *
 *  This contract previously read two *shared* Chainlink-style oracle feeds and
 *  let anyone call `updateEfficiencyScore(node)` for any `node` - meaning the
 *  score had no real binding to the node it was stored under, and an attacker
 *  could simply inherit another node's just-reported reading. Reporting is now
 *  gated and tied to a specific node for the same reason `reportCompletion` is
 *  gated in `MLTaskManager`: a node cannot be trusted to grade its own
 *  efficiency, so a trusted third party attests to it instead.
 */
contract PoEEnergyMarket {
    address public owner;
    address public reporter;
    uint256 public efficiencyThreshold;

    // Maps node addresses to their latest efficiency score
    mapping(address => uint256) public efficiencyScores;
    // List of nodes that have reported metrics; used for validator selection
    address[] public nodeList;

    event NodeMetricsReported(address indexed node, uint256 energyUsage, uint256 latency, uint256 score);
    event NodeDeregistered(address indexed node);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not authorized");
        _;
    }

    modifier onlyReporter() {
        require(msg.sender == reporter, "Caller is not the authorized reporter");
        _;
    }

    constructor(address _reporter, uint256 _efficiencyThreshold) {
        owner = msg.sender;
        reporter = _reporter;
        efficiencyThreshold = _efficiencyThreshold;
    }

    /**
     * @notice Point this market at a (possibly rotated) trusted reporter.
     */
    function setReporter(address _reporter) external onlyOwner {
        reporter = _reporter;
    }

    /**
     * @notice Report one node's measured energy usage and latency, and refresh
     *         its on-chain efficiency score.
     *
     *  Computes a 1e18-scaled efficiency score and stores it for `node`.
     *  Nodes are registered in `nodeList` the first time they're reported.
     *
     * @param node Address of the node this reading describes
     * @param energyUsage Measured energy usage for this node
     * @param latency Measured latency for this node
     */
    function reportNodeMetrics(
        address node,
        uint256 energyUsage,
        uint256 latency
    ) external onlyReporter {
        uint256 score = calculateEfficiencyScore(energyUsage, latency);
        efficiencyScores[node] = score;

        _registerNode(node);

        emit NodeMetricsReported(node, energyUsage, latency, score);
    }

    /**
     * @notice Compute an efficiency score from energy usage and latency.
     *
     *  The score is scaled by 1e18 to preserve precision. If either
     *  measurement is zero, the score is zero.
     *
     * @param energyUsage Measured energy usage
     * @param latency Measured latency
     * @return The computed efficiency score
     */
    function calculateEfficiencyScore(
        uint256 energyUsage,
        uint256 latency
    ) internal pure returns (uint256) {
        if (energyUsage == 0 || latency == 0) return 0;
        return 1e18 / (energyUsage * latency);
    }

    /**
     * @notice Drop a node from the tracked validator set and clear its score.
     *
     *  `nodeList` is scanned in full by `selectTopValidator`, so an operator
     *  needs a way to prune nodes that have left the network - otherwise the
     *  list only ever grows. The node's efficiency score is cleared too:
     *  leaving a stale score behind would let a deregistered node keep using
     *  it to clear DAMAuction's bid cross-check.
     *
     * @param node Address of the node to deregister
     */
    function deregisterNode(address node) external onlyOwner {
        uint256 length = nodeList.length;
        for (uint256 i = 0; i < length; i++) {
            if (nodeList[i] == node) {
                nodeList[i] = nodeList[length - 1];
                nodeList.pop();
                efficiencyScores[node] = 0;
                emit NodeDeregistered(node);
                return;
            }
        }
        revert("Node is not registered");
    }

    /**
     * @notice Internal helper to register a node in the nodeList.
     *
     *  Ensures nodes are only added once to avoid duplicates. This is
     *  intentionally linear in the size of nodeList; for large sets a more
     *  efficient data structure would be preferable.
     *
     * @param node Address of the node to register
     */
    function _registerNode(address node) internal {
        for (uint256 i = 0; i < nodeList.length; i++) {
            if (nodeList[i] == node) {
                return;
            }
        }
        nodeList.push(node);
    }

    /**
     * @notice Select the most efficient validator currently tracked.
     *
     *  Iterates through the list of registered nodes and returns the address
     *  with the highest efficiency score that meets or exceeds the global
     *  efficiency threshold. If no such node is found, returns the zero
     *  address.
     *
     * @return selected Address of the selected validator or address(0)
     */
    function selectTopValidator() external view returns (address selected) {
        uint256 bestScore = efficiencyThreshold;
        address bestNode = address(0);
        for (uint256 i = 0; i < nodeList.length; i++) {
            address current = nodeList[i];
            uint256 score = efficiencyScores[current];
            if (score >= efficiencyThreshold && score >= bestScore) {
                bestScore = score;
                bestNode = current;
            }
        }
        return bestNode;
    }
}
