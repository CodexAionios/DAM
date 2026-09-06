"""
Helix clustering and task allocation for the DAM AI backend.

Groups nodes into fixed-size "helix" clusters based on hash power, latency
and Proof-of-Efficiency (PoE) score, then splits a task's workload across a
helix proportionally to each member's hash power. A helix that collectively
meets its PoE goal "turns green" and its members become eligible for a
group bonus on top of their individual task rewards.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Dict, List, Sequence, Tuple


__all__ = [
    "NodeCapability",
    "Helix",
    "TaskShare",
    "HelixOutcome",
    "HelixManager",
]


@dataclass(frozen=True, slots=True)
class NodeCapability:
    """Snapshot of a node's capability used for helix formation."""

    node_id: str
    hash_power: float
    latency_ms: float
    efficiency_score: float


@dataclass(frozen=True, slots=True)
class TaskShare:
    """A node's proportional slice of a helix's workload."""

    node_id: str
    workload_units: float


@dataclass(frozen=True, slots=True)
class HelixOutcome:
    """Result of evaluating whether a helix met its PoE goal."""

    helix_id: str
    combined_score: float
    poe_goal: float
    is_green: bool


@dataclass
class Helix:
    """A cluster of nodes collaborating on a shared task."""

    helix_id: str
    members: List[NodeCapability]
    task_id: str
    poe_goal: float

    def total_hash_power(self) -> float:
        return sum(member.hash_power for member in self.members)


class HelixManager:
    """Forms helixes, allocates workload within them, and grades outcomes."""

    __slots__ = ("helix_size", "_rng")

    def __init__(self, helix_size: int = 6, *, seed: int | None = None) -> None:
        if helix_size < 2:
            raise ValueError("helix_size must be at least 2")
        self.helix_size = helix_size
        self._rng = random.Random(seed)

    def form_helixes(
        self,
        nodes: Sequence[NodeCapability],
        task_ids: Sequence[str],
        poe_goal: float,
    ) -> List[Helix]:
        """
        Rank nodes by a blended capability score (hash power, latency,
        PoE score), chunk the ranking into contiguous groups of
        ``helix_size`` so each helix is made of similarly-capable nodes,
        then shuffle membership within each group. The shuffle keeps
        cluster composition unpredictable so nodes can't game which
        helix they land in.
        """

        if not nodes:
            return []
        if not task_ids:
            raise ValueError("task_ids must not be empty")

        ranked = _rank_by_capability(nodes)

        helixes: List[Helix] = []
        for index, start in enumerate(range(0, len(ranked), self.helix_size)):
            group = ranked[start : start + self.helix_size]
            self._rng.shuffle(group)
            helixes.append(
                Helix(
                    helix_id=f"helix_{index}",
                    members=group,
                    task_id=task_ids[index % len(task_ids)],
                    poe_goal=poe_goal,
                )
            )
        return helixes

    def assign_tasks(self, helix: Helix, total_workload: float) -> List[TaskShare]:
        """
        Split ``total_workload`` across helix members proportionally to
        their hash power. Allocations sum exactly to ``total_workload``.
        """

        if total_workload < 0:
            raise ValueError("total_workload cannot be negative")
        if not helix.members:
            return []

        capacity = helix.total_hash_power()
        if capacity <= 0:
            share = total_workload / len(helix.members)
            return [TaskShare(member.node_id, share) for member in helix.members]

        shares: List[TaskShare] = []
        allocated = 0.0
        last_index = len(helix.members) - 1
        for index, member in enumerate(helix.members):
            if index == last_index:
                units = total_workload - allocated
            else:
                units = total_workload * (member.hash_power / capacity)
            shares.append(TaskShare(member.node_id, units))
            allocated += units
        return shares

    def reassign_failed_node(
        self, helix: Helix, failed_node_id: str, remaining_units: float
    ) -> List[TaskShare]:
        """
        Drop a failed node from the helix and redistribute its remaining
        workload across the surviving members, proportionally to hash power.
        """

        survivors = [m for m in helix.members if m.node_id != failed_node_id]
        if not survivors:
            raise ValueError("cannot reassign work: no surviving members in helix")

        helix.members = survivors
        return self.assign_tasks(helix, remaining_units)

    def evaluate_outcome(
        self, helix: Helix, node_scores: Dict[str, float]
    ) -> HelixOutcome:
        """
        Combine each member's reported efficiency score, weighted by hash
        power, and check the result against the helix's PoE goal.
        """

        capacity = helix.total_hash_power()
        if capacity <= 0:
            combined = sum(node_scores.get(m.node_id, 0.0) for m in helix.members)
            combined /= max(len(helix.members), 1)
        else:
            combined = sum(
                node_scores.get(m.node_id, 0.0) * (m.hash_power / capacity)
                for m in helix.members
            )

        return HelixOutcome(
            helix_id=helix.helix_id,
            combined_score=combined,
            poe_goal=helix.poe_goal,
            is_green=combined >= helix.poe_goal,
        )


def _rank_by_capability(nodes: Sequence[NodeCapability]) -> List[NodeCapability]:
    hash_powers = [n.hash_power for n in nodes]
    latencies = [n.latency_ms for n in nodes]
    efficiencies = [n.efficiency_score for n in nodes]

    hash_bounds = (min(hash_powers), max(hash_powers))
    latency_bounds = (min(latencies), max(latencies))
    efficiency_bounds = (min(efficiencies), max(efficiencies))

    def score(node: NodeCapability) -> float:
        hash_norm = _normalized(node.hash_power, hash_bounds)
        latency_norm = 1.0 - _normalized(node.latency_ms, latency_bounds)
        efficiency_norm = _normalized(node.efficiency_score, efficiency_bounds)
        return 0.4 * hash_norm + 0.3 * latency_norm + 0.3 * efficiency_norm

    return sorted(nodes, key=score, reverse=True)


def _normalized(value: float, bounds: Tuple[float, float]) -> float:
    low, high = bounds
    if high - low <= 1e-12:
        return 0.5
    return (value - low) / (high - low)


if __name__ == "__main__":
    # Example usage, mirroring the six-node helix example from the DAM docs.
    example_nodes = [
        NodeCapability("Node_A", hash_power=100, latency_ms=10, efficiency_score=0.8),
        NodeCapability("Node_B", hash_power=200, latency_ms=20, efficiency_score=0.9),
        NodeCapability("Node_C", hash_power=300, latency_ms=15, efficiency_score=0.7),
        NodeCapability("Node_D", hash_power=400, latency_ms=25, efficiency_score=0.85),
        NodeCapability("Node_E", hash_power=500, latency_ms=10, efficiency_score=0.95),
        NodeCapability("Node_F", hash_power=600, latency_ms=30, efficiency_score=0.6),
    ]

    manager = HelixManager(helix_size=6, seed=42)
    helixes = manager.form_helixes(example_nodes, task_ids=["task_001"], poe_goal=0.8)

    for helix in helixes:
        shares = manager.assign_tasks(helix, total_workload=1_000_000)
        print(f"{helix.helix_id} ({helix.task_id}):")
        for share in shares:
            print(f"  {share.node_id}: {share.workload_units:.1f} units")

        scores = {member.node_id: member.efficiency_score for member in helix.members}
        outcome = manager.evaluate_outcome(helix, scores)
        status = "GREEN" if outcome.is_green else "not green"
        print(f"  combined PoE score: {outcome.combined_score:.3f} ({status})")
