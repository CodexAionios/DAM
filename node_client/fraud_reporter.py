"""
Bridge `ai_backend.fraud_detector`'s risk scores onto the FraudDetection registry.

The detector produces alerts off chain; this submits them as attestations that
`DAMAuction` and `PoEConsensus` actually enforce. Because an attestation can
get a node blacklisted, the defaults here are deliberately cautious:

- **Dry run unless told otherwise.** Nothing is submitted without `--submit`.
- **A node with no jobs is never accused.** With `total_jobs == 0` the
  detector's completion term reads a 0/1 success rate as a total collapse and
  scores the node at maximum. That is an artefact of having no evidence, not a
  finding, so those entries are skipped.
- **Attestations are withdrawn as well as raised.** `--revoke-cleared` retracts
  this reporter's standing accusations against nodes that no longer alert.
  Without it a loop only ever ratchets one way, and a node that cleaned up its
  behaviour would stay accused forever.

The registry records one attestation per reporter, so running this repeatedly
is safe: a standing accusation is left alone rather than counted again.

Telemetry comes from a JSON file - a list of objects matching
`ai_backend.fraud_detector.NodeTelemetry`, whose `node_id` must be the node's
Ethereum address:

    [
      {
        "node_id": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        "total_jobs": 40, "successful_jobs": 9, "avg_latency_ms": 900.0,
        "duplicate_submissions": 12, "disputes": 14, "audit_flags": 4,
        "reward_to_stake_ratio": 4.0, "collateralization": 0.1
      }
    ]

Most of those signals - disputes, audit flags, stake ratios - are not recorded
on chain by this project, so they come from whatever monitoring the operator
runs. The chain is the enforcement surface, not the evidence store.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable

from web3 import Web3

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "ai_backend"))
from fraud_detector import FraudDetector, NodeTelemetry  # noqa: E402

from chain import DEFAULT_RPC_URL, get_contract, get_web3, load_account, load_deployment, send_transaction

__all__ = ["load_telemetry", "resolve_node_address", "plan_reports", "run"]

# Neutral values for signals a given operator may not collect. Each is the
# value that contributes nothing to the risk score, so an absent signal never
# pushes a node toward being accused.
TELEMETRY_DEFAULTS: dict[str, Any] = {
    "avg_latency_ms": 0.0,
    "duplicate_submissions": 0,
    "disputes": 0,
    "audit_flags": 0,
    "reward_to_stake_ratio": 0.0,
    "collateralization": 1.0,
}


def load_telemetry(path: Path) -> list[NodeTelemetry]:
    """Read a telemetry JSON file into NodeTelemetry records."""

    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError(f"{path} must contain a JSON list of telemetry objects.")

    samples: list[NodeTelemetry] = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise ValueError(f"{path}[{index}] is not an object.")
        for required in ("node_id", "total_jobs", "successful_jobs"):
            if required not in entry:
                raise ValueError(f"{path}[{index}] is missing required field {required!r}.")

        fields = {**TELEMETRY_DEFAULTS, **entry}
        samples.append(
            NodeTelemetry(
                node_id=str(fields["node_id"]),
                total_jobs=int(fields["total_jobs"]),
                successful_jobs=int(fields["successful_jobs"]),
                avg_latency_ms=float(fields["avg_latency_ms"]),
                duplicate_submissions=int(fields["duplicate_submissions"]),
                disputes=int(fields["disputes"]),
                audit_flags=int(fields["audit_flags"]),
                reward_to_stake_ratio=float(fields["reward_to_stake_ratio"]),
                collateralization=float(fields["collateralization"]),
            )
        )
    return samples


def resolve_node_address(node_id: str) -> str | None:
    """Checksum a node id, or None when it is not an Ethereum address."""

    try:
        return Web3.to_checksum_address(node_id)
    except (ValueError, TypeError):
        return None


def plan_reports(
    detector: FraudDetector,
    telemetry: Iterable[NodeTelemetry],
) -> tuple[dict[str, float], list[str], list[str]]:
    """
    Score telemetry and split it into what should be accused and what should not.

    Returns (alerting {address: score}, cleared addresses, skipped descriptions).
    Nodes with no completed jobs are skipped rather than scored: the detector
    reads an empty record as a total completion collapse, which is an absence
    of evidence rather than a finding.
    """

    scored: list[NodeTelemetry] = []
    skipped: list[str] = []

    for sample in telemetry:
        address = resolve_node_address(sample.node_id)
        if address is None:
            skipped.append(f"{sample.node_id}: not an Ethereum address")
            continue
        if sample.total_jobs <= 0:
            skipped.append(f"{address}: no jobs recorded, nothing to judge")
            continue
        scored.append(sample)

    alerts = {alert.node_id: alert for alert in detector.detect(scored)}
    alerting: dict[str, float] = {}
    cleared: list[str] = []

    for sample in scored:
        address = resolve_node_address(sample.node_id)
        alert = alerts.get(sample.node_id)
        if alert is not None:
            alerting[address] = alert.score
        else:
            cleared.append(address)

    return alerting, cleared, skipped


def run(
    w3: Web3,
    deployment: dict,
    account,
    telemetry_path: Path,
    *,
    detector: FraudDetector | None = None,
    submit: bool = False,
    revoke_cleared: bool = False,
) -> dict:
    """Score telemetry and reconcile this reporter's on-chain attestations."""

    registry = get_contract(w3, deployment, "FraudDetection")
    detector = detector or FraudDetector()

    telemetry = load_telemetry(telemetry_path)
    alerting, cleared, skipped = plan_reports(detector, telemetry)

    authorized = registry.functions.isReporter(account.address).call()
    threshold = registry.functions.blacklistThreshold().call()
    print(f"Reporter {account.address}: authorized={authorized}, blacklistThreshold={threshold}")
    if not authorized:
        print("  This account cannot attest. The registry owner must call setReporter first.")

    reporter_count = sum(
        1
        for i in range(registry.functions.knownReporterCount().call())
        if registry.functions.isReporter(registry.functions.knownReporterAt(i).call()).call()
    )
    if threshold > reporter_count:
        print(
            f"  WARNING: {reporter_count} authorized reporter(s) but a threshold of {threshold}"
            " - no node can ever reach it. Authorize more reporters or lower the threshold."
        )

    for description in skipped:
        print(f"  skipped {description}")

    reported: list[str] = []
    revoked: list[str] = []
    unchanged: list[str] = []

    for address, score in sorted(alerting.items(), key=lambda item: item[1], reverse=True):
        already = registry.functions.hasReported(account.address, address).call()
        if already:
            unchanged.append(address)
            print(f"  {address} risk={score:.3f} - attestation already stands")
            continue
        print(f"  {address} risk={score:.3f} - {'reporting' if submit else 'WOULD report'}")
        if submit:
            send_transaction(w3, account, registry.functions.reportFraud(address))
            reported.append(address)

    if revoke_cleared:
        for address in cleared:
            if not registry.functions.hasReported(account.address, address).call():
                continue
            print(f"  {address} no longer alerts - {'revoking' if submit else 'WOULD revoke'}")
            if submit:
                send_transaction(w3, account, registry.functions.revokeReport(address))
                revoked.append(address)

    summary = {
        "alerting": alerting,
        "cleared": cleared,
        "skipped": skipped,
        "reported": reported,
        "revoked": revoked,
        "unchanged": unchanged,
        "submitted": submit,
    }

    if not submit:
        print("\nDry run - nothing was submitted. Re-run with --submit to attest on chain.")
    else:
        print(f"\nSubmitted {len(reported)} report(s) and {len(revoked)} revocation(s).")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("telemetry", type=Path, help="JSON file of node telemetry")
    parser.add_argument("--rpc-url", default=DEFAULT_RPC_URL, help="JSON-RPC endpoint of the DAM network")
    parser.add_argument(
        "--submit",
        action="store_true",
        help="Actually attest on chain. Without this the run is a dry run.",
    )
    parser.add_argument(
        "--revoke-cleared",
        action="store_true",
        help="Withdraw this reporter's accusations against nodes that no longer alert.",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=None,
        help="Override the detector's alert threshold (0, 1].",
    )
    args = parser.parse_args()

    detector = FraudDetector(threshold=args.threshold) if args.threshold else FraudDetector()

    w3 = get_web3(args.rpc_url)
    deployment = load_deployment()
    account = load_account(w3=w3)

    run(
        w3,
        deployment,
        account,
        args.telemetry,
        detector=detector,
        submit=args.submit,
        revoke_cleared=args.revoke_cleared,
    )


if __name__ == "__main__":
    main()
