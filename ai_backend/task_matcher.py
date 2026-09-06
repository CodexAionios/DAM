"""
Task matcher for the DAM AI backend.

This module matches incoming tasks to the most appropriate nodes
based on their efficiency, latency and available resources.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Sequence


@dataclass(frozen=True)
class TaskRequest:
    """Describes the requirements and urgency of a task."""

    id: str
    min_memory_gb: float = 0.0
    min_vram_gb: float = 0.0
    min_cores: int = 0
    min_throughput: float = 0.0
    # NOTE: not currently used by TaskMatcher.match() - a uniform multiplier
    # applied to every candidate node within one match() call can never
    # change their relative ranking, so this field had no real effect.
    # Reserved for a future cross-task prioritization scheme.
    priority: float = 1.0


@dataclass(frozen=True)
class NodeStats:
    """Current capabilities of a compute node."""

    id: str
    efficiency: float
    latency_ms: float
    free_memory_gb: float
    free_vram_gb: float
    free_cores: int
    throughput: float = 0.0


class TaskMatcher:
    """
    Scores available nodes for a given task and returns the highest ranked ones.

    The scoring algorithm normalizes each metric so that the resulting score stays
    within a tight range and can therefore be compared quickly without heavy
    allocations. It operates on simple arithmetic, making it fast enough for
    real-time matchmaking in busy marketplaces.
    """

    __slots__ = ("weights", "latency_baseline", "resource_bonus_cap")

    def __init__(
        self,
        weights: Dict[str, float] | None = None,
        *,
        latency_baseline: float = 50.0,
        resource_bonus_cap: float = 1.5,
    ) -> None:
        default_weights = {"efficiency": 0.5, "latency": 0.3, "resources": 0.2}
        if weights:
            default_weights.update(weights)

        total_weight = sum(default_weights.values())
        if total_weight <= 0:
            raise ValueError("TaskMatcher weights must sum to a positive number.")

        self.weights = {k: v / total_weight for k, v in default_weights.items()}
        self.latency_baseline = max(latency_baseline, 1e-3)
        self.resource_bonus_cap = max(resource_bonus_cap, 1.0)

    def match(
        self,
        task: TaskRequest,
        nodes: Sequence[NodeStats],
        *,
        top_k: int = 1,
    ) -> List[NodeStats]:
        """Return the top_k nodes sorted by suitability for the task."""

        if not nodes:
            return []

        scored: List[tuple[float, NodeStats]] = []

        for node in nodes:
            resource_score = self._resource_score(task, node)
            if resource_score == 0.0:
                continue

            score = (
                self.weights["efficiency"] * self._efficiency_score(node.efficiency)
                + self.weights["latency"] * self._latency_score(node.latency_ms)
                + self.weights["resources"] * resource_score
            )
            scored.append((score, node))

        if not scored:
            return []

        scored.sort(key=lambda item: item[0], reverse=True)

        if top_k <= 0 or top_k >= len(scored):
            return [node for _, node in scored]

        return [node for _, node in scored[:top_k]]

    def _efficiency_score(self, efficiency: float) -> float:
        # Efficient nodes tend to have values >= 0. Higher values saturate near 1.
        return efficiency / (abs(efficiency) + 1.0)

    def _latency_score(self, latency_ms: float) -> float:
        # Lower latency is better, with 0ms mapped to the maximum score.
        if latency_ms <= 0:
            return 1.0
        return self.latency_baseline / (self.latency_baseline + latency_ms)

    def _resource_score(self, task: TaskRequest, node: NodeStats) -> float:
        """
        Calculate how well the node satisfies the resource requirements.
        Returns 0.0 if mandatory resources are missing.
        """

        requirements: Iterable[tuple[float, float]] = (
            (task.min_memory_gb, node.free_memory_gb),
            (task.min_vram_gb, node.free_vram_gb),
            (float(task.min_cores), float(node.free_cores)),
            (task.min_throughput, node.throughput),
        )

        score = 0.0
        metrics = 0

        for required, available in requirements:
            metrics += 1
            if required <= 0:
                score += 1.0
                continue

            if available <= 0:
                return 0.0

            coverage = available / required
            if coverage < 1.0:
                return 0.0

            score += min(coverage, self.resource_bonus_cap)

        return score / metrics if metrics else 0.0
