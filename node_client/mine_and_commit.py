"""
Mine a tensor block and commit it on-chain via PoEConsensus.

Mining is two-phase, and the reason is the seed. This script:

1. Calls `openSession()`, which records this node and the block it asked in.
   The seed is then drawn from blocks *after* that - so at the moment of
   asking, the entropy does not exist yet and there is nothing to select. A
   miner cannot shop for a favourable seed, and a block producer cannot look
   at the hash it just produced and decide whether to publish.
2. Waits for the session's seed to mature (SEED_SPAN block hashes must exist),
   then reads it back with `sessionSeed()`.
3. Mines a tensor whose element sum and Frobenius norm fall under the
   network's difficulty targets - produced by `ai_backend.tensor_miner`, then
   scaled to fixed-point integers so the contract can recompute those metrics.
4. Searches for a nonce such that keccak256(seed, nonce, tensor) falls under
   the contract's `hashDifficulty`. This is the part that actually costs work:
   hash outputs are unpredictable, so the nonce can only be found by searching.
5. Commits, spending the session.

The contract recomputes the sum and norm from the submitted tensor, so neither
can be fabricated. PoEConsensus also gates on this node's on-chain PoE score,
so run monitor.py first.

Waiting for blocks: on a real network blocks arrive on their own. An idle local
Hardhat node only mines when a transaction arrives, so nothing would ever
advance the chain to the session's maturity block. On a known dev chain this
script nudges it with `evm_mine`; see `--no-dev-mine`.
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

from chain import (
    DEFAULT_RPC_URL,
    LOCAL_CHAIN_IDS,
    get_contract,
    get_web3,
    load_account,
    load_deployment,
    send_transaction,
)

# Fixed-point scale matching the difficultyTarget/normTarget PoEConsensus was
# deployed with (see deployment/deploy_smart_contracts.js: TENSOR_SCALE).
TENSOR_SCALE = 1_000_000

# Chain ids whose nodes support the `evm_mine` test RPC. Shared with chain.py
# rather than redeclared, so the two modules cannot disagree about which chains
# count as local dev nodes (Hardhat 31337, Ganache 1337).
DEV_CHAIN_IDS = LOCAL_CHAIN_IDS

__all__ = [
    "scale_tensor",
    "compute_seed",
    "find_nonce",
    "open_session",
    "wait_for_block",
    "mine_and_commit",
]


def scale_tensor(tensor: np.ndarray) -> list[int]:
    """Flatten a float tensor into the fixed-point integers the contract verifies."""

    scaled = [int(round(float(value) * TENSOR_SCALE)) for value in tensor.flatten()]
    if any(value < 0 for value in scaled):
        raise ValueError("Tensor contains negative values; cannot encode as uint256.")
    return scaled


def compute_seed(block_hashes: list[bytes], miner: str, session_id: int) -> bytes:
    """
    Mirror PoEConsensus.sessionSeed exactly.

    The contract folds SEED_SPAN consecutive block hashes into one accumulator,
    then binds the result to the session's miner and id:

        entropy = 0
        for h in hashes: entropy = keccak256(entropy, h)
        seed = keccak256(entropy, miner, sessionId)

    Recomputing this locally is a cross-check that Python's byte packing still
    matches Solidity's abi.encodePacked; mine_and_commit asserts the two agree
    before spending any time searching for a nonce.
    """

    entropy = b"\x00" * 32
    for block_hash in block_hashes:
        entropy = Web3.keccak(entropy + bytes(block_hash))
    return Web3.keccak(entropy + bytes.fromhex(miner[2:]) + session_id.to_bytes(32, "big"))


def _pack_tensor(scaled: list[int]) -> bytes:
    """The tensor half of abi.encodePacked(seed, nonce, tensor)."""

    return b"".join(value.to_bytes(32, "big") for value in scaled)


def _proof_digest(seed_bytes: bytes, nonce: int, tensor_bytes: bytes) -> bytes:
    """Mirror keccak256(abi.encodePacked(seed, nonce, tensor)) exactly."""

    return Web3.keccak(seed_bytes + nonce.to_bytes(32, "big") + tensor_bytes)


def find_nonce(seed: bytes, scaled: list[int], hash_difficulty: int, max_attempts: int = 5_000_000):
    """
    Search for a nonce whose proof digest clears the work target.

    Returns (nonce, digest, attempts). Raises if the search budget runs out.

    Only the nonce varies across the search, so the seed and the packed tensor
    are serialized once up front rather than per attempt - at the default
    budget that is millions of avoided int-to-bytes conversions, leaving the
    loop spending its time on keccak instead of on repacking constants.
    """

    seed_bytes = bytes(seed)
    tensor_bytes = _pack_tensor(scaled)

    for nonce in range(max_attempts):
        digest = _proof_digest(seed_bytes, nonce, tensor_bytes)
        if int.from_bytes(digest, "big") < hash_difficulty:
            return nonce, digest, nonce + 1
    raise RuntimeError(f"No qualifying nonce found in {max_attempts} attempts.")


def open_session(w3: Web3, poe_consensus, account) -> int:
    """Open a mining session and return its id, read back from the event."""

    receipt = send_transaction(w3, account, poe_consensus.functions.openSession())
    events = poe_consensus.events.SessionOpened().process_receipt(receipt)
    if not events:
        raise RuntimeError("openSession did not emit SessionOpened; wrong ABI or failed tx?")
    return int(events[0]["args"]["sessionId"])


def wait_for_block(w3: Web3, target_block: int, *, dev_mine: bool = True, timeout: float = 180.0) -> None:
    """
    Block until the chain reaches `target_block`.

    On a dev chain (see DEV_CHAIN_IDS) an idle node never advances on its own,
    so blocks are requested explicitly. On any other network this just waits.
    """

    if w3.eth.block_number >= target_block:
        return

    can_dev_mine = dev_mine and w3.eth.chain_id in DEV_CHAIN_IDS
    deadline = time.time() + timeout
    while w3.eth.block_number < target_block:
        if time.time() > deadline:
            raise TimeoutError(
                f"Chain did not reach block {target_block} within {timeout:.0f}s "
                f"(currently at {w3.eth.block_number})."
            )
        if can_dev_mine:
            w3.provider.make_request("evm_mine", [])
        else:
            time.sleep(1.0)


def mine_and_commit(
    w3: Web3,
    deployment: dict,
    account,
    *,
    difficulty_sum: float = 2.0,
    difficulty_norm: float = 1.5,
    size: int = 5,
    dev_mine: bool = True,
) -> dict:
    """Open a session, mine against its seed, and commit the result on-chain."""

    poe_consensus = get_contract(w3, deployment, "PoEConsensus")

    # 1. Claim a seed drawn from blocks that do not exist yet.
    session_id = open_session(w3, poe_consensus, account)
    ready_at = poe_consensus.functions.sessionSeedReadyAt(session_id).call()
    expires_at = poe_consensus.functions.sessionExpiresAt(session_id).call()
    print(f"Opened mining session {session_id}; seed matures at block {ready_at}, expires at {expires_at}.")

    # 2. Wait for the entropy to exist, then read the seed the contract will use.
    wait_for_block(w3, ready_at, dev_mine=dev_mine)
    seed = poe_consensus.functions.sessionSeed(session_id).call()

    # Cross-check that our local packing still matches the contract's. If these
    # ever diverge, the nonce search below would be searching for nothing.
    seed_start = poe_consensus.functions.sessionSeedStart(session_id).call()
    seed_span = poe_consensus.functions.SEED_SPAN().call()
    block_hashes = [w3.eth.get_block(seed_start + i)["hash"] for i in range(seed_span)]
    local_seed = compute_seed(block_hashes, account.address, session_id)
    if bytes(local_seed) != bytes(seed):
        raise RuntimeError(
            "Locally derived seed does not match the contract's - "
            f"local={local_seed.hex()} chain={bytes(seed).hex()}"
        )

    # 3. Mine a tensor that satisfies the network's difficulty targets.
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

    # 4. Search for a nonce that clears the work target.
    hash_difficulty = poe_consensus.functions.hashDifficulty().call()
    nonce, digest, attempts = find_nonce(seed, scaled, hash_difficulty)
    mining_time_seconds = time.time() - start_time

    print(
        f"Mined a valid tensor and proof in {mining_time_seconds:.3f}s "
        f"(sum={float(np.sum(result_tensor)):.4f}, "
        f"norm={float(np.linalg.norm(result_tensor, ord='fro')):.4f}, "
        f"nonce={nonce} after {attempts} hashes, digest={digest.hex()[:18]}...)"
    )

    # 5. Commit, spending the session.
    return send_transaction(
        w3,
        account,
        poe_consensus.functions.commitBlock(
            session_id,
            scaled,
            nonce,
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
    parser.add_argument(
        "--no-dev-mine",
        action="store_true",
        help="Never request blocks via evm_mine; wait for the chain to advance on its own.",
    )
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
        dev_mine=not args.no_dev_mine,
    )
    print(f"Block committed in tx {receipt['transactionHash'].hex()} (status={receipt['status']})")


if __name__ == "__main__":
    main()
