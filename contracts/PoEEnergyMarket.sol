// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Ownable2Step.sol";

/**
 * @title PoEEnergyMarket
 * @notice The ledger of node efficiency: verified work per attested joule.
 *
 *  ## What the score measures
 *
 *      efficiency = expectedHashes / joules        (hashes per joule)
 *
 *  stored 1e18-scaled, so a score of 1e18 means one hash per joule.
 *
 *  - `expectedHashes` comes from `PoEConsensus`, which derives it from the
 *    proof-of-work target the block was verified against. Nobody reports it:
 *    a commit only exists if the proof cleared that target, so the numerator
 *    is as trustworthy as the proof-of-work check itself.
 *  - `joules` is the energy spent producing that proof, attested by the
 *    trusted `reporter` via `reportEnergy` before the commit. This is the one
 *    trusted input left, and it is the honest place for trust to sit: energy
 *    is a physical measurement taken at the machine, which no contract can
 *    observe.
 *
 *  ## Why it changed
 *
 *  The score used to be `1e18 / (energyUsage * latency)`, with the node
 *  client reporting CPU utilisation as `energyUsage`. Nothing in that formula
 *  measured work, so a machine doing nothing reported the lowest "energy" and
 *  earned the highest score: in a reproduction, an idle node earned 13.33
 *  tokens per block against 10.03 for a node that was actually mining. Latency
 *  sat in the same denominator, mixing network responsiveness into a number
 *  presented as energy efficiency. Work per joule is what the original design
 *  asked for ("energy consumption per operation"), and an idle node now
 *  scores nothing, because it has committed no work.
 *
 *  ## Attestation lifecycle
 *
 *  One attestation scores one block. `reportEnergy` sets the energy for the
 *  node's next block (overwriting any unused attestation), and `recordBlock`
 *  consumes it. Overwriting rather than accumulating is deliberate: an
 *  accumulating counter would let energy from failed attempts pile up until
 *  a node could never again reach the threshold, locking it out for good.
 */
contract PoEEnergyMarket is Ownable2Step {
    // 1e18 fixed point, times 1000 to convert millijoules to joules.
    uint256 public constant SCORE_SCALE = 1e21;
    // Largest expectedHashes that can be scaled without overflowing. Reaching
    // it would take a proof expected to cost ~2^186 hashes.
    uint256 public constant MAX_EXPECTED_HASHES = type(uint256).max / SCORE_SCALE;

    address public reporter;
    address public consensus;
    // Minimum efficiency (hashes per joule, 1e18-scaled) a block must reach.
    uint256 public efficiencyThreshold;

    // Each node's efficiency as of its most recent committed block.
    mapping(address => uint256) public efficiencyScores;
    // Millijoules attested for each node's next block; 0 = none pending.
    mapping(address => uint256) public attestedEnergy;
    // Nodes that have ever been attested; used for validator selection.
    address[] public nodeList;

    event EnergyAttested(address indexed node, uint256 milliJoules);
    event EfficiencyRecorded(address indexed node, uint256 expectedHashes, uint256 milliJoules, uint256 score);
    event NodeDeregistered(address indexed node);

    modifier onlyReporter() {
        require(msg.sender == reporter, "Caller is not the authorized reporter");
        _;
    }

    modifier onlyConsensus() {
        require(msg.sender == consensus, "Caller is not the consensus contract");
        _;
    }

    constructor(address _reporter, uint256 _efficiencyThreshold) {
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
     * @notice Authorize the PoEConsensus contract that records verified work.
     * @dev Set once at deployment, after PoEConsensus exists. Until it is set
     *      no block can be scored, so no block can be committed.
     */
    function setConsensus(address _consensus) external onlyOwner {
        consensus = _consensus;
    }

    /**
     * @notice Set the minimum efficiency, in hashes per joule (1e18-scaled).
     */
    function setEfficiencyThreshold(uint256 _efficiencyThreshold) external onlyOwner {
        efficiencyThreshold = _efficiencyThreshold;
    }

    /**
     * @notice Attest the energy a node spent producing its next proof.
     * @param node The node the measurement belongs to
     * @param milliJoules Energy measured at the node's machine, in millijoules
     */
    function reportEnergy(address node, uint256 milliJoules) external onlyReporter {
        require(milliJoules > 0, "Energy must be positive");
        attestedEnergy[node] = milliJoules;
        _registerNode(node);
        emit EnergyAttested(node, milliJoules);
    }

    /**
     * @notice Score a committed block from its verified work and the energy
     *         attested for it, consuming that attestation.
     * @param node The block's proposer
     * @param expectedHashes Work the block's proof represents, as computed by
     *        PoEConsensus from the target it verified the proof against
     * @return score Efficiency in hashes per joule, 1e18-scaled
     */
    function recordBlock(address node, uint256 expectedHashes) external onlyConsensus returns (uint256 score) {
        uint256 milliJoules = attestedEnergy[node];
        require(milliJoules > 0, "No attested energy for this block");
        require(expectedHashes <= MAX_EXPECTED_HASHES, "Work too large to score");

        score = (expectedHashes * SCORE_SCALE) / milliJoules;
        attestedEnergy[node] = 0;
        efficiencyScores[node] = score;

        emit EfficiencyRecorded(node, expectedHashes, milliJoules, score);
    }

    /**
     * @notice Drop a node from the tracked validator set and clear its state.
     *
     *  `nodeList` is scanned in full by `selectTopValidator`, so an operator
     *  needs a way to prune nodes that have left the network - otherwise the
     *  list only ever grows. The node's score and any pending attestation are
     *  cleared too: a stale score would let a deregistered node keep clearing
     *  DAMAuction's bid cross-check, and a stale attestation would let it
     *  commit one more block.
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
                attestedEnergy[node] = 0;
                emit NodeDeregistered(node);
                return;
            }
        }
        revert("Node is not registered");
    }

    /**
     * @dev Register a node once. Linear in the size of nodeList; for large
     *      sets a more efficient data structure would be preferable.
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
     *  Returns the address with the highest efficiency score at or above the
     *  threshold, or the zero address if none qualifies.
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
