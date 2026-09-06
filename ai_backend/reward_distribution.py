"""
Reward distribution logic for the DAM AI backend.

This module computes and distributes rewards to nodes based on their
efficiency scores and completed tasks.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Sequence


@dataclass(frozen=True)
class NodeRewardProfile:
    """Minimal snapshot of a node's performance."""

    node_id: str
    efficiency_score: float
    completed_tasks: int


def _normalize(values: Sequence[float]) -> List[float]:
    """Fast normalization that falls back to a uniform split."""

    length = len(values)
    if length == 0:
        return []

    total = sum(values)
    if total <= 0.0:
        uniform = 1.0 / length
        return [uniform] * length

    inv_total = 1.0 / total
    return [value * inv_total for value in values]


def distribute_rewards(
    profiles: Sequence[NodeRewardProfile],
    total_reward: float,
    *,
    efficiency_bias: float = 0.65,
    min_efficiency: float = 0.0,
) -> Dict[str, float]:
    """
    Allocate ``total_reward`` across ``profiles``.

    Rewards are split between two factors: normalized efficiency scores and
    completed tasks. ``efficiency_bias`` controls how much weight the
    efficiency share receives (0..1). ``min_efficiency`` can be used to remove
    a baseline noise level from the scores. The function returns a mapping from
    node id to reward amount and guarantees that the sum equals the input pool.
    """

    if total_reward < 0:
        raise ValueError("total_reward cannot be negative")
    if not 0.0 <= efficiency_bias <= 1.0:
        raise ValueError("efficiency_bias must be within [0, 1]")
    if not profiles:
        return {}
    if total_reward == 0:
        return {profile.node_id: 0.0 for profile in profiles}

    eff_values: List[float] = []
    task_values: List[float] = []
    for profile in profiles:
        eff = profile.efficiency_score - min_efficiency
        eff_values.append(eff if eff > 0.0 else 0.0)
        tasks = float(profile.completed_tasks)
        task_values.append(tasks if tasks > 0.0 else 0.0)

    efficiency_weights = _normalize(eff_values)
    task_weights = _normalize(task_values)

    rewards: Dict[str, float] = {}
    payout_total = 0.0
    remaining_bias = 1.0 - efficiency_bias
    last_index = len(profiles) - 1

    for index, profile in enumerate(profiles):
        share = efficiency_bias * efficiency_weights[index] + remaining_bias * task_weights[index]
        reward = total_reward * share
        if index == last_index:
            reward = total_reward - payout_total
        rewards[profile.node_id] = reward
        payout_total += reward

    return rewards
