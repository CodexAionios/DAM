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
5. Attests the energy steps 3-4 consumed, measured by `energy.py`, via
   `PoEEnergyMarket.reportEnergy`.
6. Commits, spending the session. The contract scores the block as
   expectedHashes / joules, and this script recomputes that score locally and
   checks it matches what the chain recorded.

The contract recomputes the sum and norm from the submitted tensor, so neither
can be fabricated, and it derives the work from its own target, so that cannot
be either. The energy is the one input taken on trust, which is why only the
market's `reporter` may attest it. This script attests directly when it holds
that key (the local-dev setup) and otherwise stops before spending any gas.

Energy: RAPL counters when the machine exposes them. Without them the script
refuses to run unless given `--assume-watts`, in which case every reading is
labelled an estimate.

Waiting for blocks: on a real network blocks arrive on their own. An idle local
Hardhat node only mines when a transaction arrives, so nothing would ever
advance the chain to the session's maturity block. On a known dev chain this
script nudges it with `evm_mine`; see `--no-dev-mine`.
"""

from __future__ import annotations

import argparse
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
from web3 import Web3
from web3.logs import DISCARD

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
from energy import EnergyReading, resolve_meter

# Mirrors PoEEnergyMarket.SCORE_SCALE: 1e18 fixed point x 1000 mJ per J.
SCORE_SCALE = 10**21
ONE_HASH_PER_JOULE = 10**18

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
    "expected_score",
    "open_session",
    "wait_for_block",
    "CommitResult",
    "mine_and_commit",
]


@dataclass(frozen=True)
class CommitResult:
    """What one mining round produced, as measured here and as recorded on chain."""

    receipt: dict
    energy: EnergyReading
    expected_hashes: int
    hashes_searched: int
    onchain_score: int
    local_score: int

    @property
    def hashes_per_joule(self) -> float:
        return self.onchain_score / ONE_HASH_PER_JOULE


def expected_score(expected_hashes: int, milli_joules: int) -> int:
    """Mirror PoEEnergyMarket.recordBlock: hashes per joule, 1e18-scaled."""

    return (expected_hashes * SCORE_SCALE) // milli_joules


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
    assume_watts: Optional[float] = None,
) -> CommitResult:
    """Open a session, mine against its seed, attest the energy, and commit."""

    poe_consensus = get_contract(w3, deployment, "PoEConsensus")
    poe_energy_market = get_contract(w3, deployment, "PoEEnergyMarket")

    # 0. Fail before spending gas: there must be a way to measure the energy,
    #    and this key must be allowed to attest it.
    meter = resolve_meter(assume_watts)
    if meter.estimated:
        print(f"WARNING: no energy counters on this machine; using {meter.source} as an ESTIMATE.")
    reporter = poe_energy_market.functions.reporter().call()
    if reporter.lower() != account.address.lower():
        raise RuntimeError(
            f"This key ({account.address}) is not PoEEnergyMarket's reporter ({reporter}). "
            "Energy must be attested by the reporter, so in a deployment with separated roles "
            "the measurement printed by a mining run has to be relayed to that attester. "
            "Refusing to open a session whose block could never be scored."
        )

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

    # The work this proof will be credited with, from the same target the
    # nonce search uses. Read before mining, so a retarget triggered by this
    # very commit cannot change what we expect.
    hash_difficulty = poe_consensus.functions.hashDifficulty().call()
    expected_hashes = poe_consensus.functions.expectedHashesPerProof().call()

    # 3-4. Mine a tensor that satisfies the difficulty targets, then search for
    #      a nonce that clears the work target - measuring the energy of both.
    start_time = time.time()
    with meter.measure() as measurement:
        result_tensor = tensor_mine_block(
            node_id=account.address,
            tensor=initialize_block_tensor(size),
            target_sum=difficulty_sum,
            target_norm=difficulty_norm,
        )
        if result_tensor is None:
            raise RuntimeError("Mining failed to find a valid tensor within the iteration limit.")
        scaled = scale_tensor(result_tensor)
        nonce, digest, attempts = find_nonce(seed, scaled, hash_difficulty)
    mining_time_seconds = time.time() - start_time
    reading = measurement.reading

    print(
        f"Mined a valid tensor and proof in {mining_time_seconds:.3f}s "
        f"(sum={float(np.sum(result_tensor)):.4f}, "
        f"norm={float(np.linalg.norm(result_tensor, ord='fro')):.4f}, "
        f"nonce={nonce} after {attempts} hashes, digest={digest.hex()[:18]}...)"
    )
    print(f"Energy for this proof: {reading.describe()}")

    # 5. Attest the energy for this block.
    send_transaction(
        w3, account, poe_energy_market.functions.reportEnergy(account.address, reading.milli_joules)
    )

    # 6. Commit, spending the session.
    receipt = send_transaction(
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
    if receipt["status"] != 1:
        raise RuntimeError(f"commitBlock reverted (tx {receipt['transactionHash'].hex()}).")

    # The receipt also carries the market's and the token's logs; skip those.
    events = poe_consensus.events.BlockCommitted().process_receipt(receipt, errors=DISCARD)
    if not events:
        raise RuntimeError("commitBlock succeeded but emitted no BlockCommitted event; wrong ABI?")
    onchain_score = int(events[0]["args"]["poeScore"])
    local_score = expected_score(expected_hashes, reading.milli_joules)
    if onchain_score != local_score:
        raise RuntimeError(
            f"On-chain efficiency {onchain_score} does not match the locally computed {local_score} "
            f"for {expected_hashes} expected hashes over {reading.milli_joules} mJ."
        )

    return CommitResult(
        receipt=receipt,
        energy=reading,
        expected_hashes=expected_hashes,
        hashes_searched=attempts,
        onchain_score=onchain_score,
        local_score=local_score,
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
    parser.add_argument(
        "--assume-watts",
        type=float,
        default=None,
        help="Machine power draw to assume when RAPL counters are unavailable. Readings become estimates.",
    )
    args = parser.parse_args()

    w3 = get_web3(args.rpc_url)
    deployment = load_deployment()
    account = load_account(w3=w3)

    result = mine_and_commit(
        w3,
        deployment,
        account,
        difficulty_sum=args.difficulty_sum,
        difficulty_norm=args.difficulty_norm,
        size=args.size,
        dev_mine=not args.no_dev_mine,
        assume_watts=args.assume_watts,
    )
    receipt = result.receipt
    print(f"Block committed in tx {receipt['transactionHash'].hex()} (status={receipt['status']})")
    print(
        f"Verified efficiency: {result.hashes_per_joule:,.2f} hashes/J "
        f"({result.expected_hashes} expected hashes / {result.energy.joules:.3f} J"
        f"{', ESTIMATED energy' if result.energy.estimated else ''}); "
        f"on-chain score matches the local computation."
    )


if __name__ == "__main__":
    main()
