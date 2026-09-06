"""
Mine a tensor block and commit it on-chain via PoEConsensus.commitBlock.

Two things have to be true before a commit is accepted, and this script has to
produce both:

1. A tensor whose element sum and Frobenius norm fall under the network's
   difficulty targets - produced by `ai_backend.tensor_miner`, then scaled to
   fixed-point integers so the contract can recompute those metrics itself.
2. A nonce such that keccak256(seed, nonce, tensor) falls under the contract's
   `hashDifficulty`, where `seed` is derived from a recent block hash and this
   node's address. This is the part that actually costs work: hash outputs are
   unpredictable, so the nonce can only be found by searching.

The contract recomputes the sum and norm from the submitted tensor, so neither
can be fabricated. PoEConsensus also gates on this node's on-chain PoE score,
so run monitor.py first.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
from web3 import Web3

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "ai_backend"))
from tensor_miner import initialize_block_tensor, tensor_mine_block  # noqa: E402

from chain import DEFAULT_RPC_URL, get_contract, get_web3, load_account, load_deployment, send_transaction

# Fixed-point scale matching the difficultyTarget/normTarget PoEConsensus was
# deployed with (see deployment/deploy_smart_contracts.js: TENSOR_SCALE).
TENSOR_SCALE = 1_000_000

__all__ = ["scale_tensor", "compute_seed", "find_nonce", "mine_and_commit"]


def scale_tensor(tensor: np.ndarray) -> list[int]:
    """Flatten a float tensor into the fixed-point integers the contract verifies."""

    scaled = [int(round(float(value) * TENSOR_SCALE)) for value in tensor.flatten()]
    if any(value < 0 for value in scaled):
        raise ValueError("Tensor contains negative values; cannot encode as uint256.")
    return scaled


def compute_seed(block_hash: bytes, proposer: str) -> bytes:
    """
    Mirror PoEConsensus.miningSeed: keccak256(abi.encodePacked(blockhash, proposer)).
    """

    return Web3.keccak(bytes(block_hash) + bytes.fromhex(proposer[2:]))


def _proof_digest(seed: bytes, nonce: int, scaled: list[int]) -> bytes:
    """Mirror keccak256(abi.encodePacked(seed, nonce, tensor)) exactly."""

    packed = bytes(seed) + nonce.to_bytes(32, "big")
    packed += b"".join(value.to_bytes(32, "big") for value in scaled)
    return Web3.keccak(packed)


def find_nonce(seed: bytes, scaled: list[int], hash_difficulty: int, max_attempts: int = 5_000_000):
    """
    Search for a nonce whose proof digest clears the work target.

    Returns (nonce, digest, attempts). Raises if the search budget runs out.
    """

    for nonce in range(max_attempts):
        digest = _proof_digest(seed, nonce, scaled)
        if int.from_bytes(digest, "big") < hash_difficulty:
            return nonce, digest, nonce + 1
    raise RuntimeError(f"No qualifying nonce found in {max_attempts} attempts.")


def mine_and_commit(
    w3: Web3,
    deployment: dict,
    account,
    *,
    difficulty_sum: float = 2.0,
    difficulty_norm: float = 1.5,
    size: int = 5,
) -> dict:
    """Mine a valid tensor, find its proof nonce, and commit it on-chain."""

    poe_consensus = get_contract(w3, deployment, "PoEConsensus")

    start_time = time.time()
    result_tensor = tensor_mine_block(
        node_id=account.address,
        tensor=initialize_block_tensor(size),
        target_sum=difficulty_sum,
        target_norm=difficulty_norm,
    )
    if result_tensor is None:
        raise RuntimeError("Mining failed to find a valid tensor within the iteration limit.")

    scaled = scale_tensor(result_tensor)

    # Seed from a recent block, exactly as the contract will recompute it.
    seed_block = w3.eth.block_number - 1
    block_hash = w3.eth.get_block(seed_block)["hash"]
    seed = compute_seed(block_hash, account.address)

    hash_difficulty = poe_consensus.functions.hashDifficulty().call()
    nonce, digest, attempts = find_nonce(seed, scaled, hash_difficulty)
    mining_time_seconds = time.time() - start_time

    print(
        f"Mined a valid tensor and proof in {mining_time_seconds:.3f}s "
        f"(sum={float(np.sum(result_tensor)):.4f}, "
        f"norm={float(np.linalg.norm(result_tensor, ord='fro')):.4f}, "
        f"nonce={nonce} after {attempts} hashes, digest={digest.hex()[:18]}...)"
    )

    return send_transaction(
        w3,
        account,
        poe_consensus.functions.commitBlock(
            scaled,
            nonce,
            seed_block,
            max(1, round(mining_time_seconds)),
            attempts,
        ),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc-url", default=DEFAULT_RPC_URL, help="JSON-RPC endpoint of the DAM network")
    parser.add_argument("--difficulty-sum", type=float, default=2.0)
    parser.add_argument("--difficulty-norm", type=float, default=1.5)
    parser.add_argument("--size", type=int, default=5, help="Tensor dimension (size x size)")
    args = parser.parse_args()

    w3 = get_web3(args.rpc_url)
    deployment = load_deployment()
    account = load_account(w3=w3)

    receipt = mine_and_commit(
        w3,
        deployment,
        account,
        difficulty_sum=args.difficulty_sum,
        difficulty_norm=args.difficulty_norm,
        size=args.size,
    )
    print(f"Block committed in tx {receipt['transactionHash'].hex()} (status={receipt['status']})")


if __name__ == "__main__":
    main()
