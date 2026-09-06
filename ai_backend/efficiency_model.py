"""
Efficiency modelling for DAM nodes.

This module predicts energy consumption and latency trends based on
historical data to inform task assignment and reward distribution.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Tuple


@dataclass(frozen=True)
class NodeEfficiencyEstimate:
    """Public facing snapshot with derived efficiency metrics."""

    energy_per_task: float
    latency_ms: float
    efficiency_score: float
    confidence: float
    throughput: float


@dataclass
class _NodeState:
    """Mutable statistics tracked for each node."""

    energy_avg: float
    latency_avg: float
    throughput_avg: float
    samples: float


class EfficiencyModel:
    """Tracks per-node energy and latency to derive fast predictions."""

    __slots__ = ("decay", "min_confidence_samples", "_nodes")

    def __init__(self, decay: float = 0.45, min_confidence_samples: int = 12) -> None:
        if not 0.0 < decay <= 1.0:
            raise ValueError("decay must be within (0, 1]")
        if min_confidence_samples < 1:
            raise ValueError("min_confidence_samples must be >= 1")
        self.decay = decay
        self.min_confidence_samples = min_confidence_samples
        self._nodes: Dict[str, _NodeState] = {}

    def update(
        self,
        node_id: str,
        energy_kwh: float,
        latency_ms: float,
        tasks_processed: int = 1,
    ) -> None:
        """
        Ingest the latest metrics for a node using exponential smoothing.

        The update is O(1) and keeps only the moving averages needed for
        fast inference, making it suitable for tight scheduling loops.
        """

        if tasks_processed <= 0:
            raise ValueError("tasks_processed must be positive")
        if energy_kwh <= 0 or latency_ms <= 0:
            raise ValueError("energy_kwh and latency_ms must be positive")

        state = self._nodes.get(node_id)
        if state is None:
            self._nodes[node_id] = _NodeState(
                energy_avg=energy_kwh,
                latency_avg=latency_ms,
                throughput_avg=float(tasks_processed),
                samples=float(tasks_processed),
            )
            return

        weight = min(1.0, self.decay * tasks_processed)
        inverse = 1.0 - weight

        state.energy_avg = weight * energy_kwh + inverse * state.energy_avg
        state.latency_avg = weight * latency_ms + inverse * state.latency_avg
        state.throughput_avg = weight * tasks_processed + inverse * state.throughput_avg

        # Saturate samples to avoid runaway growth while keeping confidence stable.
        state.samples = min(state.samples + tasks_processed, 1e9)

    def predict(self, node_id: str) -> NodeEfficiencyEstimate:
        """Return the latest estimate for a node."""

        state = self._nodes.get(node_id)
        if state is None:
            raise KeyError(f"node '{node_id}' does not exist in the model")

        return self._to_estimate(node_id, state)

    def bulk_predict(self, node_ids: Iterable[str]) -> List[Tuple[str, NodeEfficiencyEstimate]]:
        """Vectorized helper for callers needing multiple predictions fast."""

        result: List[Tuple[str, NodeEfficiencyEstimate]] = []
        append = result.append
        nodes = self._nodes
        for node_id in node_ids:
            state = nodes.get(node_id)
            if state is not None:
                append((node_id, self._to_estimate(node_id, state)))
        return result

    def ranked_nodes(self, limit: int | None = None) -> List[Tuple[str, NodeEfficiencyEstimate]]:
        """Return nodes sorted by efficiency score (desc)."""

        items = [
            (node_id, self._to_estimate(node_id, state))
            for node_id, state in self._nodes.items()
        ]
        items.sort(key=lambda pair: pair[1].efficiency_score, reverse=True)
        return items[:limit] if limit is not None else items

    def _to_estimate(self, node_id: str, state: _NodeState) -> NodeEfficiencyEstimate:
        del node_id  # Node id unused after lookup but kept for future hooks.
        energy = max(state.energy_avg, 1e-9)
        latency = max(state.latency_avg, 1e-9)
        throughput = max(state.throughput_avg, 1e-9)

        # Deliberately excludes throughput: tasks_processed only records how
        # many tasks a single update() call covers (a batch-size/reporting
        # granularity choice, not a measured rate), so folding it into the
        # score let a node inflate its efficiency purely by reporting in
        # bigger batches for identical real per-task energy/latency.
        # Matches PoEEnergyMarket's on-chain formula shape (1/(energy*latency)).
        efficiency_score = 1.0 / (energy * latency)
        confidence = min(1.0, state.samples / (state.samples + self.min_confidence_samples))

        return NodeEfficiencyEstimate(
            energy_per_task=energy,
            latency_ms=latency,
            efficiency_score=efficiency_score,
            confidence=confidence,
            throughput=throughput,
        )
