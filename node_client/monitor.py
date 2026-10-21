"""
Energy meter check for DAM nodes.

Answers the question to settle before mining: can this machine measure what a
proof costs in energy, and what efficiency does it reach? It reports which
energy source `energy.py` would use, the machine's power at idle and under a
keccak hashing load, and the resulting hashes per joule - the same unit
PoEEnergyMarket scores blocks in, so the number is directly comparable to an
on-chain score and to PoEConsensus's `referenceEfficiency`.

Nothing is sent to the chain. This script used to report CPU utilisation as an
energy proxy, together with RPC latency, via `reportNodeMetrics`. That proxy
made an idle machine look like the most efficient one on the network, and the
on-chain function it fed no longer exists: energy is now attested per block,
for the proof it paid for, by `mine_and_commit.py`.
"""

from __future__ import annotations

import argparse
import os
import time

from web3 import Web3

from energy import EnergyUnavailable, describe_sources, resolve_meter

__all__ = ["measure_idle", "measure_hashing"]


def measure_idle(meter, seconds: float):
    """Energy over `seconds` of doing nothing in this process."""

    with meter.measure() as measurement:
        time.sleep(seconds)
    return measurement.reading


def measure_hashing(meter, seconds: float):
    """Energy over `seconds` of keccak hashing, and how many hashes it bought."""

    payload = os.urandom(32 * 27)  # seed + nonce + a 25-element tensor, as mined
    hashes = 0
    with meter.measure() as measurement:
        deadline = time.perf_counter() + seconds
        while time.perf_counter() < deadline:
            for _ in range(1000):
                Web3.keccak(payload + hashes.to_bytes(32, "big"))
                hashes += 1
    return measurement.reading, hashes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sample-seconds", type=float, default=2.0, help="Length of each measured window")
    parser.add_argument(
        "--assume-watts",
        type=float,
        default=None,
        help="Power draw to assume when RAPL counters are unavailable. Readings become estimates.",
    )
    args = parser.parse_args()

    available, detail = describe_sources()
    print(f"RAPL counters: {'available (' + detail + ')' if available else 'unavailable - ' + detail}")

    try:
        meter = resolve_meter(args.assume_watts)
    except EnergyUnavailable as error:
        raise SystemExit(f"ERROR: {error}")

    idle = measure_idle(meter, args.sample_seconds)
    print(f"Idle:    {idle.describe()}")

    loaded, hashes = measure_hashing(meter, args.sample_seconds)
    print(f"Hashing: {loaded.describe()}")
    print(f"         {hashes:,} keccak hashes = {hashes / loaded.seconds:,.0f} hashes/s")
    print(f"Efficiency: {hashes / loaded.joules:,.1f} hashes/J (single Python process)")
    if meter.estimated:
        print(
            "NOTE: with an assumed wattage, idle and load draw the same power by construction, "
            "so this efficiency is just the hash rate divided by the number you supplied."
        )


if __name__ == "__main__":
    main()
