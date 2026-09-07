// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Ownable2Step.sol";

/**
 * @title FraudDetection
 * @notice Registry of fraud attestations against nodes, read by `DAMAuction`
 *         (bid submission and helix selection) and `PoEConsensus` (block
 *         commitment).
 *
 *  ## One attestation per reporter
 *
 *  The score is a count of *distinct reporters* who have flagged a node, not a
 *  count of calls. That distinction is the whole design:
 *
 *  - It makes `blacklistThreshold` mean "this many independent parties agree",
 *    which is a trust statement. A bare call counter only means "somebody
 *    pressed the button this many times".
 *  - It makes automated reporting safe. `ai_backend/fraud_detector.py` scores
 *    nodes on a loop; against a bare counter, any node that stayed anomalous
 *    would be blacklisted purely for surviving three polling cycles, and the
 *    count would grow without bound. Here a reporter's standing opinion is
 *    recorded once, and re-reporting is rejected rather than compounded.
 *
 *  A reporter can withdraw its own attestation with `revokeReport`, and the
 *  owner can clear a node outright with `clearNode`. Automated detection
 *  produces false positives, so an accusation that cannot be retracted would
 *  be a worse bug than the one this registry is trying to catch.
 *
 *  Deliberately kept out of scope: attestations carry no stake and no penalty
 *  for being wrong, so this is only as trustworthy as the reporter set the
 *  owner authorizes.
 */
contract FraudDetection is Ownable2Step {

    // Distinct reporters required before a node counts as blacklisted. Set
    // this relative to how many reporters are actually authorized - with a
    // single reporter a threshold of 3 can never be reached.
    uint256 public blacklistThreshold = 3;

    // node => number of distinct reporters currently accusing it
    mapping(address => uint256) public fraudScores;

    // reporter => authorized to attest
    mapping(address => bool) public isReporter;

    // reporter => node => this reporter's attestation currently stands
    mapping(address => mapping(address => bool)) public hasReported;

    // Every address ever authorized, so `clearNode` can retract all standing
    // attestations. Bounded by the reporter set, which only the owner grows.
    address[] private knownReporters;

    event ReporterAuthorized(address indexed reporter, bool authorized);
    event FraudReported(address indexed node, address indexed reporter, uint256 fraudScore);
    event FraudReportRevoked(address indexed node, address indexed reporter, uint256 fraudScore);
    event NodeCleared(address indexed node);
    event BlacklistThresholdUpdated(uint256 threshold);

    modifier onlyReporter() {
        require(isReporter[msg.sender], "Caller is not an authorized reporter");
        _;
    }

    constructor() {
        _setReporter(msg.sender, true);
    }

    // ---------------------------------------------------------------------
    // Attestations
    // ---------------------------------------------------------------------

    /**
     * @notice Record this reporter's accusation against `node`.
     * @dev Idempotent by design: a reporter that already accuses this node is
     *      rejected rather than counted twice, so a monitoring loop can call
     *      this every cycle without inflating anybody's score.
     */
    function reportFraud(address node) public onlyReporter {
        require(node != address(0), "Cannot report the zero address");
        require(!hasReported[msg.sender][node], "Reporter already flagged this node");

        hasReported[msg.sender][node] = true;
        fraudScores[node] += 1;

        emit FraudReported(node, msg.sender, fraudScores[node]);
    }

    /**
     * @notice Withdraw this reporter's own accusation against `node`.
     */
    function revokeReport(address node) external onlyReporter {
        require(hasReported[msg.sender][node], "Reporter has not flagged this node");

        hasReported[msg.sender][node] = false;
        fraudScores[node] -= 1;

        emit FraudReportRevoked(node, msg.sender, fraudScores[node]);
    }

    /**
     * @notice Retract every standing accusation against `node`.
     * @dev The escape hatch for a false positive that several reporters agreed
     *      on. Iterates the authorized-reporter set, which the owner controls.
     */
    function clearNode(address node) external onlyOwner {
        for (uint256 i = 0; i < knownReporters.length; i++) {
            address reporter = knownReporters[i];
            if (hasReported[reporter][node]) {
                hasReported[reporter][node] = false;
            }
        }
        fraudScores[node] = 0;

        emit NodeCleared(node);
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /**
     * @notice Authorize or revoke a fraud reporter.
     * @dev Revoking does not retract that reporter's standing accusations;
     *      use `clearNode`, or have the reporter revoke before losing access.
     */
    function setReporter(address reporter, bool authorized) external onlyOwner {
        require(reporter != address(0), "Cannot authorize the zero address");
        _setReporter(reporter, authorized);
    }

    function _setReporter(address reporter, bool authorized) internal {
        if (authorized && !isReporter[reporter]) {
            bool known = false;
            for (uint256 i = 0; i < knownReporters.length; i++) {
                if (knownReporters[i] == reporter) {
                    known = true;
                    break;
                }
            }
            if (!known) {
                knownReporters.push(reporter);
            }
        }
        isReporter[reporter] = authorized;
        emit ReporterAuthorized(reporter, authorized);
    }

    /**
     * @notice Set how many distinct reporters are needed to blacklist a node.
     */
    function setBlacklistThreshold(uint256 threshold) external onlyOwner {
        require(threshold > 0, "Threshold must be positive");
        blacklistThreshold = threshold;
        emit BlacklistThresholdUpdated(threshold);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function isNodeBlacklisted(address node) public view returns (bool) {
        return fraudScores[node] >= blacklistThreshold;
    }

    /**
     * @notice Addresses ever authorized as reporters, including revoked ones.
     * @dev Exposed so an operator can see what `clearNode` will iterate.
     */
    function knownReporterCount() external view returns (uint256) {
        return knownReporters.length;
    }

    function knownReporterAt(uint256 index) external view returns (address) {
        require(index < knownReporters.length, "Index out of bounds");
        return knownReporters[index];
    }
}
