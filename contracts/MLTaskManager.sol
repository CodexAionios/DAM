// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Ownable2Step.sol";

/**
 * @title MLTaskManager
 * @notice Orchestrates ML tasks assigned to a helix of nodes formed by
 *         `DAMAuction`. Tracks per-member completion reports and determines
 *         whether the helix collectively met its PoE goal ("turned green"),
 *         mirroring `HelixManager.evaluate_outcome` in
 *         `ai_backend/helix_manager.py`.
 *
 *  Verification is intentionally lightweight: completion scores are
 *  reported by a trusted off-chain reporter (the DAM AI backend) rather
 *  than computed on-chain. A production deployment would replace
 *  `reportCompletion` with a verifiable proof submission.
 */
contract MLTaskManager is Ownable2Step {
    enum HelixStatus {
        Unknown,
        Registered,
        Finalized
    }

    struct HelixTask {
        uint256 helixId;
        uint256 auctionId;
        address[] members;
        uint256 taskId;
        uint256 poeGoal;
        uint256 totalHashPower;
        HelixStatus status;
        uint256 combinedScore;
        bool isGreen;
    }

    address public damAuction;
    address public reporter;

    mapping(uint256 => HelixTask) private helixTasks;
    mapping(uint256 => mapping(address => uint256)) public memberHashPower;
    mapping(uint256 => mapping(address => uint256)) public memberScores;
    mapping(uint256 => mapping(address => bool)) public memberReported;

    event HelixRegistered(
        uint256 indexed helixId,
        uint256 indexed auctionId,
        address[] members,
        uint256 taskId
    );
    event MemberScoreReported(uint256 indexed helixId, address indexed member, uint256 score);
    event HelixFinalized(uint256 indexed helixId, uint256 combinedScore, bool isGreen);

    modifier onlyDAMAuction() {
        require(msg.sender == damAuction, "Caller is not the DAMAuction contract");
        _;
    }

    modifier onlyReporter() {
        require(msg.sender == reporter, "Caller is not the authorized reporter");
        _;
    }

    constructor(address _damAuction, address _reporter) {
        damAuction = _damAuction;
        reporter = _reporter;
    }

    function setDAMAuction(address _damAuction) external onlyOwner {
        damAuction = _damAuction;
    }

    function setReporter(address _reporter) external onlyOwner {
        reporter = _reporter;
    }

    /**
     * @notice Register a newly formed helix and its task assignment.
     * @dev Called by `DAMAuction.formHelix` immediately after a helix is formed.
     */
    function registerHelix(
        uint256 helixId,
        uint256 auctionId,
        address[] calldata members,
        uint256[] calldata memberHashPowerValues,
        uint256 taskId,
        uint256 poeGoal
    ) external onlyDAMAuction {
        require(helixTasks[helixId].status == HelixStatus.Unknown, "Helix already registered");
        require(members.length > 0, "Helix must have members");
        require(members.length == memberHashPowerValues.length, "Members/hashPower length mismatch");

        HelixTask storage helixTask = helixTasks[helixId];
        helixTask.helixId = helixId;
        helixTask.auctionId = auctionId;
        helixTask.members = members;
        helixTask.taskId = taskId;
        helixTask.poeGoal = poeGoal;
        helixTask.status = HelixStatus.Registered;

        uint256 totalHashPower = 0;
        for (uint256 i = 0; i < members.length; i++) {
            memberHashPower[helixId][members[i]] = memberHashPowerValues[i];
            totalHashPower += memberHashPowerValues[i];
        }
        helixTask.totalHashPower = totalHashPower;

        emit HelixRegistered(helixId, auctionId, members, taskId);
    }

    /**
     * @notice Report a member's efficiency score for a registered helix.
     * @dev Reported by the trusted off-chain reporter, which computes scores
     *      the same way `ai_backend/efficiency_model.py` does.
     */
    function reportCompletion(uint256 helixId, address member, uint256 score) external onlyReporter {
        HelixTask storage helixTask = helixTasks[helixId];
        require(helixTask.status == HelixStatus.Registered, "Helix not open for reporting");
        require(_isMember(helixTask, member), "Address is not a member of this helix");

        memberScores[helixId][member] = score;
        memberReported[helixId][member] = true;

        emit MemberScoreReported(helixId, member, score);
    }

    /**
     * @notice Finalize a helix once all members have reported, combining
     *         scores weighted by each member's hash power (falling back to
     *         an equal-weighted average if no hash power was recorded), and
     *         checking the result against the helix's PoE goal.
     */
    function finalizeHelix(uint256 helixId) external {
        HelixTask storage helixTask = helixTasks[helixId];
        require(helixTask.status == HelixStatus.Registered, "Helix not open for finalization");

        uint256 combined;
        if (helixTask.totalHashPower > 0) {
            uint256 weightedTotal = 0;
            for (uint256 i = 0; i < helixTask.members.length; i++) {
                address member = helixTask.members[i];
                require(memberReported[helixId][member], "Not all members have reported");
                weightedTotal += memberScores[helixId][member] * memberHashPower[helixId][member];
            }
            combined = weightedTotal / helixTask.totalHashPower;
        } else {
            uint256 total = 0;
            for (uint256 i = 0; i < helixTask.members.length; i++) {
                address member = helixTask.members[i];
                require(memberReported[helixId][member], "Not all members have reported");
                total += memberScores[helixId][member];
            }
            combined = total / helixTask.members.length;
        }

        helixTask.combinedScore = combined;
        helixTask.isGreen = combined >= helixTask.poeGoal;
        helixTask.status = HelixStatus.Finalized;

        emit HelixFinalized(helixId, combined, helixTask.isGreen);
    }

    function getHelixMembers(uint256 helixId) external view returns (address[] memory) {
        return helixTasks[helixId].members;
    }

    function getHelixSummary(uint256 helixId)
        external
        view
        returns (
            uint256 auctionId,
            uint256 taskId,
            uint256 poeGoal,
            HelixStatus status,
            uint256 combinedScore,
            bool isGreen
        )
    {
        HelixTask storage helixTask = helixTasks[helixId];
        return (
            helixTask.auctionId,
            helixTask.taskId,
            helixTask.poeGoal,
            helixTask.status,
            helixTask.combinedScore,
            helixTask.isGreen
        );
    }

    function _isMember(HelixTask storage helixTask, address candidate) internal view returns (bool) {
        for (uint256 i = 0; i < helixTask.members.length; i++) {
            if (helixTask.members[i] == candidate) {
                return true;
            }
        }
        return false;
    }
}
