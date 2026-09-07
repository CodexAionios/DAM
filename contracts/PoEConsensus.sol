// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Ownable2Step.sol";

/**
 * @title PoEConsensus
 * @notice Tensor-based block commitment for the DAM network, with the mining
 *         proof verified on chain and the work target retargeted automatically.
 *
 *  ## Mining is two-phase, because of the seed
 *
 *  A miner first calls `openSession()`, which records who they are and which
 *  block they asked in. The seed they must then work against is drawn from
 *  blocks that did not exist yet at that moment:
 *
 *      seedStart = openedAt + SEED_DELAY
 *      seed      = keccak256(
 *                    fold(blockhash(seedStart) .. blockhash(seedStart+SEED_SPAN-1)),
 *                    miner,
 *                    sessionId
 *                  )
 *
 *  That ordering is the whole point. When the seed block was a free argument,
 *  a miner could pick whichever recent block suited them, and a block producer
 *  could look at the hash they had just produced and decide whether to publish
 *  it - one free re-roll per block. Committing first means the entropy
 *  postdates the commitment, so there is nothing left to select. Folding
 *  SEED_SPAN consecutive hashes means biasing a seed requires producing every
 *  block in the span, not just one.
 *
 *  Opening many sessions is not a way around this. Sessions opened in the same
 *  block share the same block hashes but get different seeds via `sessionId`,
 *  so grinding N sessions x M nonces searches exactly the same uniform space
 *  as one session with N*M nonces. It buys no advantage, only gas.
 *
 *  ## A commit must clear four gates
 *
 *  1. **Session** - a live, unconsumed, matured session belonging to the
 *     caller, whose seed is fixed by blocks the caller never chose.
 *  2. **Work** - `keccak256(seed, nonce, tensor)` must fall below
 *     `hashDifficulty`. Hash outputs are unpredictable, so the only way to
 *     satisfy this is to search nonces. This is what makes a commit cost
 *     something; the tensor targets below cannot provide that on their own.
 *  3. **Difficulty** - the contract recomputes the tensor's element sum and
 *     its squared Frobenius norm from the submitted tensor and checks both
 *     against the network targets. Neither is taken on trust.
 *  4. **Efficiency** - the proposer's PoE score must clear the market's
 *     threshold, the mining time must be within `maxOE` of the reference, and
 *     the proposer must not be blacklisted.
 *
 *  Why gate 2 is necessary alongside gate 3: verifying the sum and norm proves
 *  the claimed metrics are true of the submitted data, but producing data with
 *  a small sum is trivial - all zeros would do. Binding the result to an
 *  unpredictable seed via a hash target is what turns "these numbers are
 *  genuine" into "finding these numbers cost something".
 *
 *  ## Difficulty retargets itself
 *
 *  Every `retargetInterval` committed blocks, the contract compares how long
 *  those blocks actually took against `retargetInterval * targetBlockTime` and
 *  scales `hashDifficulty` by the ratio, clamped to MAX_RETARGET_FACTOR in
 *  either direction. Higher target means easier, so blocks arriving too fast
 *  lower it. The owner keeps a manual override for bootstrapping, but the
 *  network no longer depends on the owner being awake.
 *
 *  Scope, honestly: this is a working reference mechanism, not production
 *  consensus security. `block.timestamp` is proposer-nudgeable, which biases
 *  retargeting - the clamp bounds how far per epoch, it does not eliminate it.
 *  And a proposer who produces every block in a session's seed span can still
 *  bias that seed.
 */
interface IPoEEnergyMarket {
    function efficiencyScores(address node) external view returns (uint256);
    function efficiencyThreshold() external view returns (uint256);
}

interface IPoEGreenNode {
    function distributeBlockReward(address validator, uint256 efficiencyScore) external;
}

interface IFraudDetection {
    function isNodeBlacklisted(address node) external view returns (bool);
}

contract PoEConsensus is Ownable2Step {
    // Largest tensor accepted, bounding calldata and verification gas.
    uint256 public constant MAX_TENSOR_ELEMENTS = 256;
    // Sanity bound per element so squaring can never overflow.
    uint256 public constant MAX_ELEMENT_VALUE = 1e18;

    // Blocks between opening a session and the first block its seed draws on.
    // Must be at least 1 so the entropy postdates the session.
    uint256 public constant SEED_DELAY = 2;
    // How many consecutive block hashes are folded into one seed. Biasing a
    // seed means producing all of them, not just one.
    uint256 public constant SEED_SPAN = 3;
    // How long a matured session stays usable, measured from seedStart.
    // SEED_DELAY + SEED_WINDOW must stay under 256, since `blockhash` only
    // resolves that far back.
    uint256 public constant SEED_WINDOW = 128;

    // Difficulty may move by at most this factor per retarget epoch, in either
    // direction. Bounds what timestamp manipulation can achieve.
    uint256 public constant MAX_RETARGET_FACTOR = 4;
    // Floor and ceiling for the work target. The floor keeps retargeting from
    // walking difficulty down to something unsatisfiable; the ceiling leaves
    // room to multiply by MAX_RETARGET_FACTOR without overflowing.
    uint256 public constant MIN_HASH_DIFFICULTY = 2 ** 16;
    uint256 public constant MAX_HASH_DIFFICULTY = type(uint256).max / MAX_RETARGET_FACTOR;

    // Sanity bounds on the retarget schedule. Without them a fat-fingered
    // `targetBlockTime` would overflow `expected * MAX_RETARGET_FACTOR` inside
    // _maybeRetarget, and since that runs on every commit it would brick block
    // production permanently rather than just misconfigure it.
    uint256 public constant MAX_TARGET_BLOCK_TIME = 365 days;
    uint256 public constant MAX_RETARGET_INTERVAL = 1_000_000;

    // Address of the PoE energy market that tracks node efficiency
    address public energyMarket;
    // Address of the green node contract responsible for rewards
    address public greenNode;
    // Optional fraud registry; address(0) disables the blacklist check
    address public fraudDetection;

    // Difficulty targets for the tensor mining problem
    uint256 public difficultyTarget;
    // Compared against the tensor's *squared* norm, avoiding a square root on
    // chain. Callers configure the plain norm target; it is squared here.
    uint256 public normTargetSquared;
    // keccak256(seed, nonce, tensor) must be strictly below this. Higher is
    // easier: type(uint256).max would accept any nonce on the first try.
    uint256 public hashDifficulty;

    // Committed blocks per retarget epoch. Zero disables retargeting.
    uint256 public retargetInterval = 16;
    // Seconds a single committed block is meant to take.
    uint256 public targetBlockTime = 60;
    // Committed-block count and timestamp as of the last retarget.
    uint256 public lastRetargetBlockCount;
    uint256 public lastRetargetTimestamp;

    // Maximum allowable entropy overhead in seconds beyond reference time
    uint256 public maxOE;
    // Reference time (in seconds) used to calculate entropy overhead
    uint256 public referenceTime;

    // A miner's claim on a future seed. Packed into a single storage slot.
    struct MiningSession {
        address miner;
        uint64 openedAt;
        bool consumed;
    }

    // Represents a committed block header stored on chain for auditability
    struct BlockHeader {
        bytes32 proofDigest;
        uint256 tensorSum;
        uint256 gradientNormSquared;
        uint256 poeScore;
        uint256 miningTime;
        uint256 iterations;
        uint256 entropicOverhead;
        address proposer;
        uint256 timestamp;
        uint256 sessionId;
    }

    // Open and spent mining sessions, indexed by sessionId
    MiningSession[] public sessions;

    // Array of committed block headers
    BlockHeader[] public committedBlocks;

    // Proof digests already used to commit a block. Single-use sessions make
    // replay impossible on their own; this is kept as a cheap second lock and
    // as a public record of what has been claimed.
    mapping(bytes32 => bool) public committedProofs;

    event SessionOpened(uint256 indexed sessionId, address indexed miner, uint256 seedReadyAtBlock);

    event BlockCommitted(
        address indexed proposer,
        bytes32 indexed proofDigest,
        uint256 tensorSum,
        uint256 gradientNormSquared,
        uint256 poeScore
    );

    event DifficultyRetargeted(
        uint256 previousDifficulty,
        uint256 newDifficulty,
        uint256 actualTimespan,
        uint256 expectedTimespan
    );

    /**
     * @param _energyMarket Address of the PoEEnergyMarket contract
     * @param _greenNode Address of the PoEGreenNode contract
     * @param _difficultyTarget Sum difficulty threshold for the tensor
     * @param _normTarget Norm difficulty threshold (squared internally)
     * @param _hashDifficulty Initial proof-of-work target; higher is easier
     * @param _maxOE Maximum entropic overhead allowed
     * @param _referenceTime Baseline mining time for overhead calculations
     */
    constructor(
        address _energyMarket,
        address _greenNode,
        uint256 _difficultyTarget,
        uint256 _normTarget,
        uint256 _hashDifficulty,
        uint256 _maxOE,
        uint256 _referenceTime
    ) {
        require(
            _hashDifficulty >= MIN_HASH_DIFFICULTY && _hashDifficulty <= MAX_HASH_DIFFICULTY,
            "hashDifficulty out of range"
        );
        energyMarket = _energyMarket;
        greenNode = _greenNode;
        difficultyTarget = _difficultyTarget;
        normTargetSquared = _normTarget * _normTarget;
        hashDifficulty = _hashDifficulty;
        maxOE = _maxOE;
        referenceTime = _referenceTime;
        lastRetargetTimestamp = block.timestamp;
    }

    // ---------------------------------------------------------------------
    // Mining sessions
    // ---------------------------------------------------------------------

    /**
     * @notice Claim a mining seed drawn from blocks that do not exist yet.
     * @dev Deliberately open to anyone: the efficiency and fraud gates are
     *      enforced at commit time, where they decide whether a reward is
     *      paid. Gating here would only let a node waste work it could not
     *      redeem. A session costs one storage slot, which is what bounds
     *      spamming; nothing on chain ever iterates `sessions`.
     * @return sessionId Identifier to mine against and later commit with.
     */
    function openSession() external returns (uint256 sessionId) {
        sessionId = sessions.length;
        sessions.push(MiningSession({miner: msg.sender, openedAt: uint64(block.number), consumed: false}));
        emit SessionOpened(sessionId, msg.sender, block.number + SEED_DELAY + SEED_SPAN);
    }

    /**
     * @notice First block whose hash a session's seed draws on.
     */
    function sessionSeedStart(uint256 sessionId) public view returns (uint256) {
        require(sessionId < sessions.length, "Unknown session");
        return uint256(sessions[sessionId].openedAt) + SEED_DELAY;
    }

    /**
     * @notice Block number at which a session's seed becomes readable.
     * @dev Miners poll this; the seed needs every hash in its span to exist.
     */
    function sessionSeedReadyAt(uint256 sessionId) external view returns (uint256) {
        return sessionSeedStart(sessionId) + SEED_SPAN;
    }

    /**
     * @notice Last block at which a session may still be committed.
     */
    function sessionExpiresAt(uint256 sessionId) external view returns (uint256) {
        return sessionSeedStart(sessionId) + SEED_WINDOW;
    }

    /**
     * @notice Derive the seed a session must be mined against.
     * @dev Exposed so miners compute exactly the seed the contract will. Folds
     *      SEED_SPAN consecutive block hashes, then binds the result to the
     *      session's miner and id - so a proof is worthless to anyone else and
     *      unique per session.
     */
    function sessionSeed(uint256 sessionId) public view returns (bytes32) {
        require(sessionId < sessions.length, "Unknown session");
        MiningSession storage session = sessions[sessionId];

        uint256 seedStart = uint256(session.openedAt) + SEED_DELAY;
        require(block.number >= seedStart + SEED_SPAN, "Seed not ready");
        require(block.number - seedStart <= SEED_WINDOW, "Session expired");

        bytes32 entropy;
        for (uint256 i = 0; i < SEED_SPAN; i++) {
            bytes32 blockHash = blockhash(seedStart + i);
            require(blockHash != bytes32(0), "Seed block out of range");
            entropy = keccak256(abi.encodePacked(entropy, blockHash));
        }
        return keccak256(abi.encodePacked(entropy, session.miner, sessionId));
    }

    /**
     * @notice Number of mining sessions ever opened.
     */
    function sessionCount() external view returns (uint256) {
        return sessions.length;
    }

    // ---------------------------------------------------------------------
    // Block commitment
    // ---------------------------------------------------------------------

    /**
     * @notice Commit a block by submitting the tensor and the nonce that
     *         satisfies the work target for this session's seed.
     *
     * @param sessionId Session opened earlier by this caller
     * @param tensor Flattened tensor, fixed-point scaled (see TENSOR_SCALE
     *        in deployment/deploy_smart_contracts.js and mine_and_commit.py)
     * @param nonce Value found by the miner so the proof digest clears hashDifficulty
     * @param miningTime Duration of mining in seconds
     * @param iterations Number of iterations used (informational)
     */
    function commitBlock(
        uint256 sessionId,
        uint256[] calldata tensor,
        uint256 nonce,
        uint256 miningTime,
        uint256 iterations
    ) external {
        require(tensor.length > 0, "Tensor is empty");
        require(tensor.length <= MAX_TENSOR_ELEMENTS, "Tensor too large");

        // 1. The session must be the caller's, unspent, and matured. Its seed
        //    was fixed by blocks that postdate the session, so there was
        //    nothing for the caller to select.
        require(sessionId < sessions.length, "Unknown session");
        MiningSession storage session = sessions[sessionId];
        require(session.miner == msg.sender, "Session belongs to another miner");
        require(!session.consumed, "Session already used");
        bytes32 seed = sessionSeed(sessionId);

        // 2. Proof of work: the digest over (seed, nonce, tensor) must clear
        //    the target. This is the gate that actually costs the miner.
        bytes32 proofDigest = keccak256(abi.encodePacked(seed, nonce, tensor));
        require(uint256(proofDigest) < hashDifficulty, "Proof does not meet work target");
        require(!committedProofs[proofDigest], "Proof already committed");

        // 3. Proposer must be efficient enough, and not blacklisted.
        uint256 nodeScore = IPoEEnergyMarket(energyMarket).efficiencyScores(msg.sender);
        uint256 threshold = IPoEEnergyMarket(energyMarket).efficiencyThreshold();
        require(nodeScore >= threshold, "PoE score below required threshold");
        if (fraudDetection != address(0)) {
            require(
                !IFraudDetection(fraudDetection).isNodeBlacklisted(msg.sender),
                "Proposer is blacklisted"
            );
        }

        // 4. Recompute the difficulty metrics from the tensor itself rather
        //    than trusting numbers the caller supplied.
        (uint256 tensorSum, uint256 normSquared) = _tensorMetrics(tensor);
        require(tensorSum < difficultyTarget, "Tensor sum exceeds difficulty target");
        require(normSquared < normTargetSquared, "Tensor norm exceeds difficulty target");

        // 5. Compute entropic overhead (avoid underflow)
        uint256 entropicOverhead = 0;
        if (miningTime > referenceTime) {
            entropicOverhead = miningTime - referenceTime;
        }
        require(entropicOverhead <= maxOE, "Node entropy overhead too high");

        // 6. Spend the session and record the block header.
        session.consumed = true;
        committedBlocks.push(
            BlockHeader({
                proofDigest: proofDigest,
                tensorSum: tensorSum,
                gradientNormSquared: normSquared,
                poeScore: nodeScore,
                miningTime: miningTime,
                iterations: iterations,
                entropicOverhead: entropicOverhead,
                proposer: msg.sender,
                timestamp: block.timestamp,
                sessionId: sessionId
            })
        );
        committedProofs[proofDigest] = true;

        emit BlockCommitted(msg.sender, proofDigest, tensorSum, normSquared, nodeScore);

        // 7. Retarget difficulty if this block closed an epoch.
        _maybeRetarget();

        // 8. Delegate reward distribution to the green node
        IPoEGreenNode(greenNode).distributeBlockReward(msg.sender, nodeScore);
    }

    /**
     * @dev Sum of the tensor's elements and sum of their squares. The squared
     *      norm is returned directly so the caller can compare against
     *      `normTargetSquared` without a square root.
     */
    function _tensorMetrics(uint256[] calldata tensor)
        internal
        pure
        returns (uint256 tensorSum, uint256 normSquared)
    {
        for (uint256 i = 0; i < tensor.length; i++) {
            uint256 value = tensor[i];
            require(value <= MAX_ELEMENT_VALUE, "Tensor element out of range");
            tensorSum += value;
            normSquared += value * value;
        }
    }

    // ---------------------------------------------------------------------
    // Difficulty retargeting
    // ---------------------------------------------------------------------

    /**
     * @notice Committed blocks still needed to close the current epoch.
     * @return 0 when retargeting is disabled.
     */
    function blocksUntilRetarget() external view returns (uint256) {
        if (retargetInterval == 0) {
            return 0;
        }
        uint256 produced = committedBlocks.length - lastRetargetBlockCount;
        return produced >= retargetInterval ? 0 : retargetInterval - produced;
    }

    /**
     * @dev Bitcoin-style retarget on committed-block count. Scales the work
     *      target by (actual elapsed / expected elapsed), so blocks arriving
     *      faster than `targetBlockTime` shrink the target and make the next
     *      epoch harder. The MAX_RETARGET_FACTOR clamp is what keeps a
     *      proposer nudging `block.timestamp` from moving difficulty far.
     */
    function _maybeRetarget() internal {
        if (retargetInterval == 0) {
            return;
        }
        uint256 produced = committedBlocks.length - lastRetargetBlockCount;
        if (produced < retargetInterval) {
            return;
        }

        uint256 expected = produced * targetBlockTime;
        uint256 actual = block.timestamp - lastRetargetTimestamp;

        // Several commits can close epochs inside a single block. From the
        // second onwards no time has passed, and zero elapsed time is an
        // absence of evidence, not evidence of maximum speed: the clamp below
        // would read it as a maximally fast epoch and tighten difficulty by
        // MAX_RETARGET_FACTOR again, compounding once per extra in-block
        // commit on no data at all. Leave the epoch open instead - the
        // counters keep accumulating, so the next retarget measures a real
        // interval over a correspondingly longer expected span.
        if (actual == 0) {
            return;
        }

        uint256 lowerBound = expected / MAX_RETARGET_FACTOR;
        uint256 upperBound = expected * MAX_RETARGET_FACTOR;
        if (actual < lowerBound) {
            actual = lowerBound;
        } else if (actual > upperBound) {
            actual = upperBound;
        }

        uint256 previous = hashDifficulty;
        uint256 next = _scaleTarget(previous, actual, expected);
        hashDifficulty = next;
        lastRetargetBlockCount = committedBlocks.length;
        lastRetargetTimestamp = block.timestamp;

        emit DifficultyRetargeted(previous, next, actual, expected);
    }

    /**
     * @dev target * numerator / denominator, clamped to the difficulty bounds.
     *      The ratio is reduced to basis points first so the multiplication
     *      cannot overflow: the clamp in `_maybeRetarget` keeps it within
     *      [1/MAX_RETARGET_FACTOR, MAX_RETARGET_FACTOR], and `hashDifficulty`
     *      never exceeds MAX_HASH_DIFFICULTY, so `target/1e4 * ratioBps` stays
     *      below type(uint256).max.
     */
    function _scaleTarget(uint256 target, uint256 numerator, uint256 denominator)
        internal
        pure
        returns (uint256)
    {
        uint256 ratioBps = (numerator * 10_000) / denominator;
        uint256 next = (target / 10_000) * ratioBps;
        if (next < MIN_HASH_DIFFICULTY) {
            return MIN_HASH_DIFFICULTY;
        }
        if (next > MAX_HASH_DIFFICULTY) {
            return MAX_HASH_DIFFICULTY;
        }
        return next;
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /**
     * @notice Manually set the proof-of-work target. Higher is easier.
     * @dev Retargeting handles this automatically; this remains for
     *      bootstrapping and emergencies, and restarts the current epoch so a
     *      manual change is not immediately undone by stale timing data.
     */
    function setHashDifficulty(uint256 _hashDifficulty) external onlyOwner {
        require(
            _hashDifficulty >= MIN_HASH_DIFFICULTY && _hashDifficulty <= MAX_HASH_DIFFICULTY,
            "hashDifficulty out of range"
        );
        hashDifficulty = _hashDifficulty;
        lastRetargetBlockCount = committedBlocks.length;
        lastRetargetTimestamp = block.timestamp;
    }

    /**
     * @notice Configure automatic retargeting.
     * @param _retargetInterval Committed blocks per epoch; 0 disables retargeting.
     * @param _targetBlockTime Seconds each committed block should take.
     */
    function setRetargetParams(uint256 _retargetInterval, uint256 _targetBlockTime) external onlyOwner {
        require(
            _targetBlockTime > 0 && _targetBlockTime <= MAX_TARGET_BLOCK_TIME,
            "targetBlockTime out of range"
        );
        require(_retargetInterval <= MAX_RETARGET_INTERVAL, "retargetInterval too large");
        retargetInterval = _retargetInterval;
        targetBlockTime = _targetBlockTime;
        lastRetargetBlockCount = committedBlocks.length;
        lastRetargetTimestamp = block.timestamp;
    }

    /**
     * @notice Retarget the tensor difficulty thresholds.
     */
    function setDifficultyTargets(uint256 _difficultyTarget, uint256 _normTarget) external onlyOwner {
        difficultyTarget = _difficultyTarget;
        normTargetSquared = _normTarget * _normTarget;
    }

    /**
     * @notice Point the consensus at a fraud registry, or address(0) to disable.
     */
    function setFraudDetection(address _fraudDetection) external onlyOwner {
        fraudDetection = _fraudDetection;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /**
     * @notice Returns the number of committed blocks stored on chain.
     */
    function committedBlockCount() external view returns (uint256) {
        return committedBlocks.length;
    }

    /**
     * @notice Retrieve a committed block header by index.
     * @param index Index of the block in the committedBlocks array
     * @return BlockHeader The stored block header
     */
    function getCommittedBlock(uint256 index) external view returns (BlockHeader memory) {
        require(index < committedBlocks.length, "Index out of bounds");
        return committedBlocks[index];
    }
}
