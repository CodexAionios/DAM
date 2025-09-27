// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title DAMAuction
 * @notice Handles the auctioning of AI computation tasks and matches the most efficient nodes.
 */
contract DAMAuction {
    struct DataTask {
        uint256 taskId;
        uint256 dataHash;
        uint256 budget;
        uint256 timeLimit;
        uint256 efficiencyReq;
        bool isActive;
        address provider;
    }

    struct NodeBid {
        address nodeAddress;
        uint256 efficiency;
        uint256 latency;
        uint256 price;
    }

    mapping(uint256 => DataTask) public dataTasks;
    mapping(uint256 => NodeBid[]) public nodeBids;
    uint256 public auctionCounter;
    address public owner;

    constructor() {
        owner = msg.sender;
        auctionCounter = 0;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only the owner can call this function.");
        _;
    }

    function createAuction(
        uint256 dataHash,
        uint256 budget,
        uint256 timeLimit,
        uint256 efficiencyReq
    ) public {
        auctionCounter++;
        dataTasks[auctionCounter] = DataTask(
            auctionCounter,
            dataHash,
            budget,
            timeLimit,
            efficiencyReq,
            true,
            msg.sender
        );
    }

    function submitBid(
        uint256 auctionId,
        uint256 efficiency,
        uint256 latency,
        uint256 price
    ) public {
        require(dataTasks[auctionId].isActive, "Auction not active");
        nodeBids[auctionId].push(
            NodeBid(msg.sender, efficiency, latency, price)
        );
    }

    function selectWinningNode(uint256 auctionId) public onlyOwner {
        DataTask storage task = dataTasks[auctionId];
        require(task.isActive, "Auction not active");

        NodeBid memory bestBid;
        bool hasBest = false;

        for (uint256 i = 0; i < nodeBids[auctionId].length; i++) {
            NodeBid memory currentBid = nodeBids[auctionId][i];
            if (
                currentBid.efficiency >= task.efficiencyReq &&
                currentBid.latency <= task.timeLimit
            ) {
                if (!hasBest || currentBid.price < bestBid.price) {
                    bestBid = currentBid;
                    hasBest = true;
                }
            }
        }

        require(hasBest, "No suitable bids");
        task.isActive = false;
        processMLTask(auctionId, bestBid.nodeAddress);
    }

    function processMLTask(uint256 auctionId, address winningNode) internal {
        // Integration with AI backend will happen here.
    }
}
