"""
AI-powered fraud detection for the DAM network.

This module analyzes aggregated node telemetry and returns risk scores for
potentially fraudulent operators using lightweight heuristics that are fast
enough for live dispatch loops.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Sequence, Tuple


__all__ = ["NodeTelemetry", "FraudAlert", "FraudDetector"]


@dataclass(frozen=True, slots=True)
class NodeTelemetry:
    """Aggregated behavioural metrics for a node within a fixed window."""

    node_id: str
    total_jobs: int
    successful_jobs: int
    avg_latency_ms: float
    duplicate_submissions: int
    disputes: int
    audit_flags: int
    reward_to_stake_ratio: float
    collateralization: float


@dataclass(frozen=True, slots=True)
class FraudAlert:
    """Represents the outcome of a fraud evaluation for a node."""

    node_id: str
    score: float
    reasons: Tuple[str, ...]


class FraudDetector:
    """Lightweight heuristic detector optimised for real-time scoring."""

    __slots__ = ("threshold", "latency_baseline", "reward_baseline", "weights")

    def __init__(
        self,
        *,
        threshold: float = 0.6,
        latency_baseline: float = 120.0,
        reward_baseline: float = 1.2,
        weights: Dict[str, float] | None = None,
    ) -> None:
        if not 0 < threshold <= 1:
            raise ValueError("threshold must be within (0, 1].")
        if latency_baseline <= 0:
            raise ValueError("latency_baseline must be positive.")
        if reward_baseline <= 0:
            raise ValueError("reward_baseline must be positive.")

        self.threshold = threshold
        self.latency_baseline = latency_baseline
        self.reward_baseline = reward_baseline

        default_weights = {
            "completion": 0.3,
            "disputes": 0.2,
            "duplicates": 0.15,
            "latency": 0.1,
            "audit": 0.1,
            "reward": 0.1,
            "collateral": 0.05,
        }
        if weights:
            default_weights.update(weights)

        total_weight = sum(default_weights.values())
        if total_weight <= 0:
            raise ValueError("weights must sum to a positive number.")

        self.weights = {k: v / total_weight for k, v in default_weights.items()}

    def detect(
        self,
        telemetry: Sequence[NodeTelemetry],
        *,
        top_k: int | None = None,
    ) -> List[FraudAlert]:
        alerts: List[FraudAlert] = []
        for sample in telemetry:
            score, reasons = self._score(sample)
            if score >= self.threshold:
                alerts.append(FraudAlert(sample.node_id, score, reasons))

        alerts.sort(key=lambda alert: alert.score, reverse=True)
        if top_k is None or top_k <= 0 or top_k >= len(alerts):
            return alerts
        return alerts[:top_k]

    def _score(self, sample: NodeTelemetry) -> Tuple[float, Tuple[str, ...]]:
        total_jobs = max(sample.total_jobs, 1)
        success_rate = sample.successful_jobs / total_jobs
        dispute_rate = sample.disputes / total_jobs
        duplicate_ratio = sample.duplicate_submissions / total_jobs

        components = []
        reasons: List[str] = []

        completion_gap = _clamp((1.0 - success_rate) / 0.6)
        components.append(self.weights["completion"] * completion_gap)
        if completion_gap > 0.5:
            reasons.append("Completion rate collapse")

        dispute_signal = _clamp(dispute_rate / 0.2)
        components.append(self.weights["disputes"] * dispute_signal)
        if dispute_signal > 0.5:
            reasons.append("Excessive disputes")

        duplicate_signal = _clamp(duplicate_ratio / 0.15)
        components.append(self.weights["duplicates"] * duplicate_signal)
        if duplicate_signal > 0.5:
            reasons.append("Duplicate submissions spike")

        latency_signal = _clamp(
            max(0.0, sample.avg_latency_ms - self.latency_baseline) / self.latency_baseline
        )
        components.append(self.weights["latency"] * latency_signal)
        if latency_signal > 0.5:
            reasons.append("Latency anomaly")

        audit_signal = _clamp(sample.audit_flags / 4.0)
        components.append(self.weights["audit"] * audit_signal)
        if audit_signal > 0.5:
            reasons.append("Audit flags triggered")

        reward_signal = _clamp(
            max(0.0, sample.reward_to_stake_ratio - self.reward_baseline) / self.reward_baseline
        )
        components.append(self.weights["reward"] * reward_signal)
        if reward_signal > 0.5:
            reasons.append("Reward imbalance")

        collateral_signal = _clamp(max(0.0, 1.0 - sample.collateralization))
        components.append(self.weights["collateral"] * collateral_signal)
        if collateral_signal > 0.5:
            reasons.append("Undercollateralized activity")

        score = sum(components)
        return min(score, 1.0), tuple(reasons)


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    if value < low:
        return low
    if value > high:
        return high
    return value
