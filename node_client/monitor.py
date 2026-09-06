"""
Energy and latency monitor for DAM nodes.

Collects lightweight, real (not simulated) proxy metrics for a node's energy
usage and network latency, and reports them on-chain via
PoEEnergyMarket.reportNodeMetrics so the network has an up-to-date efficiency
score for this node.

There is no portable, vendor-neutral way to read real GPU/CPU wattage without
extra tooling (nvidia-smi, RAPL, etc. depending on hardware), so this monitor
uses CPU utilization as an energy-usage *proxy*: sustained CPU load is
strongly correlated with real power draw, even though it isn't a wattage
reading. Latency is measured for real, as the round-trip time of a JSON-RPC
call to the node's chain connection.

Note on the reporter role: `reportNodeMetrics` is gated to PoEEnergyMarket's
trusted `reporter` address, the same trust model `MLTaskManager.reportCompletion`
already uses - a node shouldn't be able to grade its own efficiency. In
production, the reporter key belongs to a separate, independent attestation
service, not the node being measured. This script lets a node self-report
only because, for local development, it's commonly run with the reporter key
configured (see deployment/deploy_smart_contracts.js, which assigns the
deployer as both MLTaskManager's and PoEEnergyMarket's reporter).
"""

from __future__ import annotations

import argparse
import time
from dataclasses import dataclass

import psutil
import requests
from web3 import Web3

from chain import DEFAULT_RPC_URL, get_contract, get_web3, load_account, load_deployment, send_transaction

__all__ = ["NodeMetrics", "measure_energy_proxy", "measure_latency_ms", "collect_metrics", "report_metrics"]

# Exceptions treated as transient/retryable in loop mode: network-transport
# problems, not programming bugs. Anything else (a corrupted addresses.json,
# a bad ABI, a real AttributeError/TypeError) is allowed to surface and stop
# the loop, rather than being silently retried forever.
TRANSIENT_ERRORS = (ConnectionError, requests.exceptions.RequestException, TimeoutError)


@dataclass(frozen=True)
class NodeMetrics:
    """A single energy/latency reading for this node."""

    energy_proxy: int  # CPU-load-derived proxy, in arbitrary reporting units
    latency_ms: int


def measure_energy_proxy(sample_seconds: float = 1.0) -> int:
    """
    Sample CPU utilization over `sample_seconds` and turn it into a positive
    integer reading. PoEEnergyMarket scores energy==0 as zero, so the result
    is always clamped to at least 1.
    """

    cpu_percent = psutil.cpu_percent(interval=sample_seconds)
    return max(1, round(cpu_percent))


def measure_latency_ms(w3: Web3) -> int:
    """Round-trip time of a real JSON-RPC call, in whole milliseconds."""

    start = time.perf_counter()
    w3.eth.block_number  # a cheap, real round trip to the node
    elapsed_ms = (time.perf_counter() - start) * 1000
    return max(1, round(elapsed_ms))


def collect_metrics(w3: Web3, sample_seconds: float = 1.0) -> NodeMetrics:
    return NodeMetrics(
        energy_proxy=measure_energy_proxy(sample_seconds),
        latency_ms=measure_latency_ms(w3),
    )


def report_metrics(w3: Web3, deployment: dict, account, metrics: NodeMetrics) -> int:
    """
    Report a metrics reading directly to PoEEnergyMarket and return the
    resulting on-chain efficiency score. Requires `account` to hold
    PoEEnergyMarket's `reporter` key (see module docstring).
    """

    poe_energy_market = get_contract(w3, deployment, "PoEEnergyMarket")

    send_transaction(
        w3,
        account,
        poe_energy_market.functions.reportNodeMetrics(
            account.address, metrics.energy_proxy, metrics.latency_ms
        ),
    )

    return poe_energy_market.functions.efficiencyScores(account.address).call()


def run_once(w3: Web3, deployment: dict, account, sample_seconds: float) -> None:
    metrics = collect_metrics(w3, sample_seconds)
    print(f"[{account.address}] energy_proxy={metrics.energy_proxy} latency_ms={metrics.latency_ms}")

    score = report_metrics(w3, deployment, account, metrics)
    print(f"[{account.address}] on-chain efficiency score updated to {score}")


def run_loop(w3: Web3, deployment: dict, account, sample_seconds: float, interval_seconds: float) -> None:
    print(f"Monitoring every {interval_seconds}s. Press Ctrl+C to stop.")
    while True:
        try:
            run_once(w3, deployment, account, sample_seconds)
        except TRANSIENT_ERRORS as error:
            print(f"Monitor iteration failed (transient, will retry): {error}")
        time.sleep(interval_seconds)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc-url", default=DEFAULT_RPC_URL, help="JSON-RPC endpoint of the DAM network")
    parser.add_argument(
        "--sample-seconds", type=float, default=1.0, help="CPU sampling window per reading"
    )
    parser.add_argument("--once", action="store_true", help="Report a single reading and exit")
    parser.add_argument(
        "--interval-seconds", type=float, default=60.0, help="Seconds between readings in loop mode"
    )
    args = parser.parse_args()

    w3 = get_web3(args.rpc_url)
    deployment = load_deployment()
    account = load_account(w3=w3)

    if args.once:
        run_once(w3, deployment, account, args.sample_seconds)
    else:
        run_loop(w3, deployment, account, args.sample_seconds, args.interval_seconds)


if __name__ == "__main__":
    main()
