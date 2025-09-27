// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title FraudDetection
 * @notice Simple fraud detection contract that tracks reports against nodes.
 */
contract FraudDetection {
    mapping(address => uint256) public fraudScores;
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only the owner can call this function.");
        _;
    }

    function reportFraud(address node) public onlyOwner {
        fraudScores[node] += 1;
    }

    function isNodeBlacklisted(address node) public view returns (bool) {
        return fraudScores[node] >= 3;
    }
}
