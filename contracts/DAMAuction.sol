// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title IMLTaskManager
 * @notice Interface exposed by MLTaskManager for helix task orchestration.
 */
interface IMLTaskManager {
    function registerHelix(
        uint256 helixId,
        uint256 auctionId,
        address[] calldata members,
        uint256[] calldata memberHashPower,
        uint256 taskId,
        uint256 poeGoal
    ) external;
}

/**
 * @title IPoEEnergyMarket
 * @notice Minimal interface used to cross-check a bidder's self-reported
 *         efficiency against their on-chain Proof-of-Efficiency score.
 */
interface IPoEEnergyMarket {
    function efficiencyScores(address node) external view returns (uint256);
}

/**
 * @title IFraudDetection
 * @notice Minimal interface used to keep blacklisted nodes out of auctions.
 */
interface IFraudDetection {
    function isNodeBlacklisted(address node) external view returns (bool);
}

/**
 * @title DAMAuction
 * @notice Handles the auctioning of AI computation tasks and forms "helix"
 *         clusters of the most capable nodes to process each task.
 *
 *  A task is no longer assigned to a single winning bid. Instead, once bidding
 *  closes, `formHelix` ranks all qualifying bids by a blended hash power /
 *  latency / efficiency score (mirroring the off-chain clustering in
 *  `ai_backend/helix_manager.py`) and selects the top `helixSize` bidders to
 *  collaborate on the task as a helix. The resulting cluster is handed off to
 *  `MLTaskManager` for task orchestration and PoE-goal verification.
 */
contract DAMAuction {
    struct DataTask {
        uint256 taskId;
        uint256 dataHash;
        uint256 budget;
        uint256 timeLimit;
        // Minimum NodeBid.efficiency to qualify for helix selection, and the
        // poeGoal a helix formed from this task must reach to turn green.
        // This is an independent, provider-chosen unit - NOT the same scale
        // as PoEEnergyMarket.efficiencyScores (1e18-based) or MLTaskManager's
        // reported completion scores, even though submitBid()'s cross-check
        // compares NodeBid.efficiency against the PoE-market scale directly.
        // Setting this using the PoE-market's 1e18 scale would make it
        // effectively unreachable by ordinary completion scores.
        uint256 efficiencyReq;
        bool isActive;
        address provider;
    }

    struct NodeBid {
        address nodeAddress;
        uint256 efficiency;
        uint256 latency;
        uint256 hashPower;
        uint256 price;
    }

    struct Helix {
        uint256 helixId;
        uint256 auctionId;
        address[] members;
        uint256 taskId;
        uint256 poeGoal;
    }

    mapping(uint256 => DataTask) public dataTasks;
    mapping(uint256 => NodeBid[]) public nodeBids;
    mapping(uint256 => Helix) public helixes;
    // 1-based index of a bidder's existing bid on an auction (0 = has not bid).
    // Stored 1-based so the default zero value cleanly means "no bid yet".
    mapping(uint256 => mapping(address => uint256)) public bidIndexOf;
    uint256 public auctionCounter;
    uint256 public helixCounter;
    uint256 public helixSize = 6;
    // Upper bound on bids per auction. formHelix() scans every bid (O(n) for
    // bounds, O(n*helixSize) for selection), so without a cap an attacker
    // could flood one auction until formHelix exceeds the block gas limit and
    // the task could never be assigned. Paired with one-bid-per-address
    // below, filling the cap requires that many distinct funded accounts.
    uint256 public maxBidsPerAuction = 100;
    address public owner;
    address public mlTaskManager;
    address public poeEnergyMarket;
    // Optional fraud registry; address(0) disables the blacklist checks
    address public fraudDetection;

    event HelixFormed(
        uint256 indexed helixId,
        uint256 indexed auctionId,
        address[] members,
        uint256 taskId
    );
    event BidSubmitted(uint256 indexed auctionId, address indexed node, bool replacedPrevious);

    constructor(address _mlTaskManager) {
        owner = msg.sender;
        mlTaskManager = _mlTaskManager;
        auctionCounter = 0;
        helixCounter = 0;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only the owner can call this function.");
        _;
    }

    /**
     * @notice Update the target helix size (default 6, per the DAM helix model).
     */
    function setHelixSize(uint256 _helixSize) external onlyOwner {
        require(_helixSize >= 2, "Helix must have at least 2 members");
        require(_helixSize <= maxBidsPerAuction, "helixSize must be <= maxBidsPerAuction");
        helixSize = _helixSize;
    }

    /**
     * @notice Update the per-auction bid cap that bounds formHelix()'s scan.
     * @dev Kept at or above helixSize, since a cap below it would make a full
     *      helix impossible to assemble no matter how many nodes bid.
     */
    function setMaxBidsPerAuction(uint256 _maxBidsPerAuction) external onlyOwner {
        require(_maxBidsPerAuction >= helixSize, "maxBidsPerAuction must be >= helixSize");
        maxBidsPerAuction = _maxBidsPerAuction;
    }

    /**
     * @notice Point this auction contract at a (possibly redeployed) MLTaskManager.
     */
    function setMLTaskManager(address _mlTaskManager) external onlyOwner {
        mlTaskManager = _mlTaskManager;
    }

    /**
     * @notice Point this auction contract at a PoEEnergyMarket so bids can be
     *         cross-checked against on-chain efficiency scores. Passing
     *         address(0) disables the check (useful for auctions run before
     *         any node has reported metrics).
     */
    function setPoEEnergyMarket(address _poeEnergyMarket) external onlyOwner {
        poeEnergyMarket = _poeEnergyMarket;
    }

    /**
     * @notice Point this auction contract at a FraudDetection registry so
     *         blacklisted nodes are refused at bid time and skipped during
     *         helix selection. Passing address(0) disables both checks.
     */
    function setFraudDetection(address _fraudDetection) external onlyOwner {
        fraudDetection = _fraudDetection;
    }

    /**
     * @dev True when a fraud registry is configured and has blacklisted `node`.
     */
    function _isBlacklisted(address node) internal view returns (bool) {
        if (fraudDetection == address(0)) return false;
        return IFraudDetection(fraudDetection).isNodeBlacklisted(node);
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

    /**
     * @notice Submit a bid for an active auction, or replace your existing one.
     * @dev If a `poeEnergyMarket` is configured, the bidder's self-reported
     *      `efficiency` must not exceed their latest on-chain PoE score, so
     *      nodes cannot inflate their standing to win a helix slot.
     *
     *  Each address holds at most one bid per auction: bidding again revises
     *  that bid in place rather than consuming another slot. Together with
     *  `maxBidsPerAuction` this bounds formHelix()'s work and stops a single
     *  account from crowding out honest bidders.
     */
    function submitBid(
        uint256 auctionId,
        uint256 efficiency,
        uint256 latency,
        uint256 hashPower,
        uint256 price
    ) public {
        require(dataTasks[auctionId].isActive, "Auction not active");
        require(!_isBlacklisted(msg.sender), "Node is blacklisted");
        if (poeEnergyMarket != address(0)) {
            uint256 onChainScore = IPoEEnergyMarket(poeEnergyMarket).efficiencyScores(msg.sender);
            require(efficiency <= onChainScore, "Reported efficiency exceeds on-chain PoE score");
        }

        NodeBid[] storage bids = nodeBids[auctionId];
        NodeBid memory bid = NodeBid(msg.sender, efficiency, latency, hashPower, price);
        uint256 existingIndex = bidIndexOf[auctionId][msg.sender];

        if (existingIndex == 0) {
            require(bids.length < maxBidsPerAuction, "Auction bid limit reached");
            bids.push(bid);
            bidIndexOf[auctionId][msg.sender] = bids.length; // 1-based
            emit BidSubmitted(auctionId, msg.sender, false);
        } else {
            bids[existingIndex - 1] = bid;
            emit BidSubmitted(auctionId, msg.sender, true);
        }
    }

    /**
     * @notice Number of bids placed on an auction.
     * @dev Solidity generates no length getter for a mapping-of-array, so
     *      off-chain callers need this to enumerate `nodeBids` safely.
     */
    function bidCount(uint256 auctionId) external view returns (uint256) {
        return nodeBids[auctionId].length;
    }

    /**
     * @notice Form a helix of up to `helixSize` qualifying bids for an auction
     *         and hand the cluster off to the ML task manager.
     *
     *  Bids are first filtered against the task's minimum efficiency and
     *  maximum latency requirements. Surviving bids are scored on a blended,
     *  basis-point-normalized combination of hash power (40%), inverted
     *  latency (30%) and efficiency (30%) - the same weighting used by
     *  `_rank_by_capability` in `ai_backend/helix_manager.py` - and the
     *  top-scoring bidders become the helix.
     */
    function formHelix(uint256 auctionId) public onlyOwner returns (uint256) {
        DataTask storage task = dataTasks[auctionId];
        require(task.isActive, "Auction not active");

        NodeBid[] storage bids = nodeBids[auctionId];
        require(bids.length > 0, "No bids submitted");

        uint256[] memory qualifying = new uint256[](bids.length);
        uint256 qualifyingCount = 0;
        for (uint256 i = 0; i < bids.length; i++) {
            // Re-checked here, not just at bid time: a node can be
            // blacklisted after its bid was already accepted.
            if (
                bids[i].efficiency >= task.efficiencyReq &&
                bids[i].latency <= task.timeLimit &&
                !_isBlacklisted(bids[i].nodeAddress)
            ) {
                qualifying[qualifyingCount] = i;
                qualifyingCount++;
            }
        }
        require(qualifyingCount > 0, "No suitable bids");

        (
            uint256 minHash,
            uint256 maxHash,
            uint256 minLatency,
            uint256 maxLatency,
            uint256 minEff,
            uint256 maxEff
        ) = _bidBounds(bids, qualifying, qualifyingCount);

        uint256[] memory scores = new uint256[](qualifyingCount);
        for (uint256 i = 0; i < qualifyingCount; i++) {
            NodeBid storage bid = bids[qualifying[i]];
            uint256 hashScore = _normalizedBps(bid.hashPower, minHash, maxHash);
            uint256 latencyScore = 10000 - _normalizedBps(bid.latency, minLatency, maxLatency);
            uint256 effScore = _normalizedBps(bid.efficiency, minEff, maxEff);
            scores[i] = (hashScore * 4 + latencyScore * 3 + effScore * 3) / 10;
        }

        uint256 selectedCount = qualifyingCount < helixSize ? qualifyingCount : helixSize;
        uint256[] memory selectedBidIdx = _topK(scores, qualifying, selectedCount);

        address[] memory members = new address[](selectedCount);
        uint256[] memory memberHashPower = new uint256[](selectedCount);
        for (uint256 i = 0; i < selectedCount; i++) {
            members[i] = bids[selectedBidIdx[i]].nodeAddress;
            memberHashPower[i] = bids[selectedBidIdx[i]].hashPower;
        }

        helixCounter++;
        helixes[helixCounter] = Helix(helixCounter, auctionId, members, task.taskId, task.efficiencyReq);
        task.isActive = false;

        emit HelixFormed(helixCounter, auctionId, members, task.taskId);
        _dispatchToTaskManager(helixCounter, memberHashPower);
        return helixCounter;
    }

    function getHelixMembers(uint256 helixId) external view returns (address[] memory) {
        return helixes[helixId].members;
    }

    function _dispatchToTaskManager(uint256 helixId, uint256[] memory memberHashPower) internal {
        if (mlTaskManager == address(0)) return;
        Helix storage helix = helixes[helixId];
        IMLTaskManager(mlTaskManager).registerHelix(
            helix.helixId,
            helix.auctionId,
            helix.members,
            memberHashPower,
            helix.taskId,
            helix.poeGoal
        );
    }

    function _bidBounds(
        NodeBid[] storage bids,
        uint256[] memory qualifying,
        uint256 qualifyingCount
    )
        internal
        view
        returns (
            uint256 minHash,
            uint256 maxHash,
            uint256 minLatency,
            uint256 maxLatency,
            uint256 minEff,
            uint256 maxEff
        )
    {
        minHash = type(uint256).max;
        minLatency = type(uint256).max;
        minEff = type(uint256).max;

        for (uint256 i = 0; i < qualifyingCount; i++) {
            NodeBid storage bid = bids[qualifying[i]];
            if (bid.hashPower < minHash) minHash = bid.hashPower;
            if (bid.hashPower > maxHash) maxHash = bid.hashPower;
            if (bid.latency < minLatency) minLatency = bid.latency;
            if (bid.latency > maxLatency) maxLatency = bid.latency;
            if (bid.efficiency < minEff) minEff = bid.efficiency;
            if (bid.efficiency > maxEff) maxEff = bid.efficiency;
        }
    }

    function _normalizedBps(uint256 value, uint256 low, uint256 high) internal pure returns (uint256) {
        if (high <= low) return 5000;
        return ((value - low) * 10000) / (high - low);
    }

    /**
     * @dev Returns the indices (into `bids`, via `qualifying`) of the `k`
     *      highest scores using a partial selection sort. Auctions are
     *      expected to receive a modest number of bids, keeping this O(n*k)
     *      approach affordable for a reference implementation.
     */
    function _topK(
        uint256[] memory scores,
        uint256[] memory qualifying,
        uint256 k
    ) internal pure returns (uint256[] memory) {
        uint256 n = scores.length;
        bool[] memory taken = new bool[](n);
        uint256[] memory result = new uint256[](k);

        for (uint256 s = 0; s < k; s++) {
            uint256 bestIdx = 0;
            uint256 bestScore = 0;
            bool found = false;
            for (uint256 i = 0; i < n; i++) {
                if (!taken[i] && (!found || scores[i] > bestScore)) {
                    bestScore = scores[i];
                    bestIdx = i;
                    found = true;
                }
            }
            taken[bestIdx] = true;
            result[s] = qualifying[bestIdx];
        }
        return result;
    }
}
