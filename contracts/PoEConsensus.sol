// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title PoEConsensus
 * @notice Tensor-based block commitment for the DAM network, with the mining
 *         proof actually verified on chain.
 *
 *  A commit must clear three independent gates:
 *
 *  1. **Work** - `keccak256(seed, nonce, tensor)` must fall below
 *     `hashDifficulty`, where `seed` is derived from a recent block hash the
 *     miner does not choose. Hash outputs are unpredictable, so the only way
 *     to satisfy this is to search nonces. This is what makes the commit cost
 *     something; the tensor targets below cannot provide that on their own.
 *  2. **Difficulty** - the contract recomputes the tensor's element sum and
 *     its squared Frobenius norm from the submitted tensor and checks both
 *     against the network targets. These are no longer taken on trust.
 *  3. **Efficiency** - the proposer's PoE score must clear the market's
 *     threshold, and the mining time must be within `maxOE` of the reference.
 *
 *  Why the work gate is necessary: verifying the sum and norm proves the
 *  claimed metrics are true of the submitted data, but producing data with a
 *  small sum is trivial (all zeros would do). Binding the result to an
 *  unpredictable seed via a hash target is what turns "these numbers are
 *  genuine" into "finding these numbers cost something".
 *
 *  Scope, honestly: this is a working reference mechanism, not production
 *  consensus security. `seed` derives from `blockhash`, which a real network's
 *  block producer can influence at the margin, and difficulty is set by the
 *  owner rather than retargeted automatically.
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

contract PoEConsensus {
    // Largest tensor accepted, bounding calldata and verification gas.
    uint256 public constant MAX_TENSOR_ELEMENTS = 256;
    // Sanity bound per element so squaring can never overflow.
    uint256 public constant MAX_ELEMENT_VALUE = 1e18;
    // How many blocks back a mining seed may be drawn from. `blockhash` only
    // resolves for the last 256 blocks, so this cannot exceed that.
    uint256 public constant SEED_WINDOW = 128;

    address public owner;
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

    // Maximum allowable entropy overhead in seconds beyond reference time
    uint256 public maxOE;
    // Reference time (in seconds) used to calculate entropy overhead
    uint256 public referenceTime;

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
    }

    // Array of committed block headers
    BlockHeader[] public committedBlocks;

    // Proof digests already used to commit a block. Without this, a single
    // valid mining result could be resubmitted indefinitely, collecting a
    // full block reward every time.
    mapping(bytes32 => bool) public committedProofs;

    event BlockCommitted(
        address indexed proposer,
        bytes32 indexed proofDigest,
        uint256 tensorSum,
        uint256 gradientNormSquared,
        uint256 poeScore
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "Not authorized");
        _;
    }

    /**
     * @param _energyMarket Address of the PoEEnergyMarket contract
     * @param _greenNode Address of the PoEGreenNode contract
     * @param _difficultyTarget Sum difficulty threshold for the tensor
     * @param _normTarget Norm difficulty threshold (squared internally)
     * @param _hashDifficulty Proof-of-work target; higher is easier
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
        owner = msg.sender;
        energyMarket = _energyMarket;
        greenNode = _greenNode;
        difficultyTarget = _difficultyTarget;
        normTargetSquared = _normTarget * _normTarget;
        hashDifficulty = _hashDifficulty;
        maxOE = _maxOE;
        referenceTime = _referenceTime;
    }

    /**
     * @notice Retarget the proof-of-work difficulty. Higher is easier.
     */
    function setHashDifficulty(uint256 _hashDifficulty) external onlyOwner {
        require(_hashDifficulty > 0, "hashDifficulty must be positive");
        hashDifficulty = _hashDifficulty;
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

    /**
     * @notice Derive the mining seed a given proposer must work against.
     * @dev Exposed so miners compute exactly the same seed the contract will.
     */
    function miningSeed(uint256 seedBlock, address proposer) public view returns (bytes32) {
        bytes32 seedHash = blockhash(seedBlock);
        require(seedHash != bytes32(0), "Seed block out of range");
        return keccak256(abi.encodePacked(seedHash, proposer));
    }

    /**
     * @notice Commit a block by submitting the tensor and the nonce that
     *         satisfies the work target for it.
     *
     * @param tensor Flattened tensor, fixed-point scaled (see TENSOR_SCALE
     *        in deployment/deploy_smart_contracts.js and mine_and_commit.py)
     * @param nonce Value found by the miner so the proof digest clears hashDifficulty
     * @param seedBlock Recent block whose hash seeds this proof
     * @param miningTime Duration of mining in seconds
     * @param iterations Number of iterations used (informational)
     */
    function commitBlock(
        uint256[] calldata tensor,
        uint256 nonce,
        uint256 seedBlock,
        uint256 miningTime,
        uint256 iterations
    ) external {
        require(tensor.length > 0, "Tensor is empty");
        require(tensor.length <= MAX_TENSOR_ELEMENTS, "Tensor too large");

        // 1. The seed must come from a recent block the miner did not choose.
        require(seedBlock < block.number, "Seed block is not in the past");
        require(block.number - seedBlock <= SEED_WINDOW, "Seed block too old");
        bytes32 seed = miningSeed(seedBlock, msg.sender);

        // 2. Proof of work: the digest over (seed, nonce, tensor) must clear
        //    the target. This is the gate that actually costs the miner.
        bytes32 proofDigest = keccak256(abi.encodePacked(seed, nonce, tensor));
        require(uint256(proofDigest) < hashDifficulty, "Proof does not meet work target");

        // 3. Each proof may only be committed once.
        require(!committedProofs[proofDigest], "Proof already committed");

        // 4. Proposer must be efficient enough, and not blacklisted.
        uint256 nodeScore = IPoEEnergyMarket(energyMarket).efficiencyScores(msg.sender);
        uint256 threshold = IPoEEnergyMarket(energyMarket).efficiencyThreshold();
        require(nodeScore >= threshold, "PoE score below required threshold");
        if (fraudDetection != address(0)) {
            require(
                !IFraudDetection(fraudDetection).isNodeBlacklisted(msg.sender),
                "Proposer is blacklisted"
            );
        }

        // 5. Recompute the difficulty metrics from the tensor itself rather
        //    than trusting numbers the caller supplied.
        (uint256 tensorSum, uint256 normSquared) = _tensorMetrics(tensor);
        require(tensorSum < difficultyTarget, "Tensor sum exceeds difficulty target");
        require(normSquared < normTargetSquared, "Tensor norm exceeds difficulty target");

        // 6. Compute entropic overhead (avoid underflow)
        uint256 entropicOverhead = 0;
        if (miningTime > referenceTime) {
            entropicOverhead = miningTime - referenceTime;
        }
        require(entropicOverhead <= maxOE, "Node entropy overhead too high");

        // 7. Record the block header
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
                timestamp: block.timestamp
            })
        );
        committedProofs[proofDigest] = true;

        emit BlockCommitted(msg.sender, proofDigest, tensorSum, normSquared, nodeScore);

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
