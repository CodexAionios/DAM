"""
Experimental tensor mining engine for the DAM backend.

This module provides a prototype proof-of-efficiency engine that evolves
a tensor using gradient descent until it meets predefined difficulty targets.
It can run concurrently across multiple nodes and tracks energy consumption.

Future versions will integrate cryptographic commitments and useful-work
objectives to convert the miner into a verifiable proof-of-work/efficiency
mechanism.
"""

import numpy as np
import concurrent.futures
import time
from typing import List, Dict, Optional

def initialize_block_tensor(size: int = 15) -> np.ndarray:
    """
    Initialize a random tensor with the given size.
    """
    return np.random.rand(size, size)


def check_difficulty(tensor: np.ndarray, target_sum: float, target_norm: float) -> bool:
    """
    Check if both the sum and Frobenius norm of the tensor are below the targets.
    """
    tensor_sum = np.sum(tensor)
    tensor_norm = np.linalg.norm(tensor, ord="fro")
    return tensor_sum < target_sum and tensor_norm < target_norm


def evolve_tensor_with_constraints(
    tensor: np.ndarray, learning_rate: float = 0.001
) -> np.ndarray:
    """
    Evolve the tensor using gradient descent while preserving its structure.
    """
    gradient = np.random.rand(*tensor.shape) * learning_rate
    evolved_tensor = tensor - gradient
    return np.clip(evolved_tensor, 0, 1)


def calculate_energy_consumption(iteration: int, base_energy: int = 1) -> int:
    """
    Calculate energy consumption based on the number of iterations.
    """
    return iteration * base_energy


def tensor_mine_block(
    node_id: str,
    tensor: np.ndarray,
    target_sum: float,
    target_norm: float,
    learning_rate: float = 0.001,
    latency: float = 0.1,
    max_iter: int = 1000,
) -> Optional[np.ndarray]:
    """
    Run the mining loop, evolving the tensor until it meets the difficulty target.
    """
    iteration = 0
    start_time = time.time()

    while iteration < max_iter:
        iteration += 1
        tensor = evolve_tensor_with_constraints(tensor, learning_rate)
        adjusted_learning_rate = learning_rate / max(latency, 1e-6)
        tensor -= np.random.rand(*tensor.shape) * adjusted_learning_rate
        # Re-clip after this second, unclipped nudge - without it, a tensor
        # can dip below 0 right before the difficulty check passes and get
        # returned violating the documented [0, 1] domain (confirmed: every
        # trial under the default parameters produced negative entries).
        tensor = np.clip(tensor, 0, 1)

        if check_difficulty(tensor, target_sum, target_norm):
            energy_used = calculate_energy_consumption(iteration)
            mining_time = time.time() - start_time
            print(
                f"[{node_id}] Valid block found after {iteration} iterations "
                f"with {energy_used} energy! Time: {mining_time:.2f} seconds"
            )
            return tensor

    print(f"[{node_id}] Mining failed after {max_iter} iterations.")
    return None


def run_tensor_mining_concurrently(
    nodes: List[Dict[str, float]], difficulty_sum: float, difficulty_norm: float, size: int = 15
) -> None:
    """
    Run the tensor mining process concurrently for multiple nodes.
    """
    with concurrent.futures.ThreadPoolExecutor() as executor:
        futures = []
        for node in nodes:
            initial_tensor = initialize_block_tensor(size)
            futures.append(
                executor.submit(
                    tensor_mine_block,
                    node["node_id"],
                    initial_tensor,
                    difficulty_sum,
                    difficulty_norm,
                    0.001,
                    node["latency"],
                )
            )

        for future in concurrent.futures.as_completed(futures):
            future.result()


if __name__ == "__main__":
    # Example usage
    nodes = [
        {"node_id": "Node_A", "latency": 0.1},
        {"node_id": "Node_B", "latency": 0.2},
        {"node_id": "Node_C", "latency": 0.05},
    ]
    run_tensor_mining_concurrently(nodes, difficulty_sum=2.0, difficulty_norm=1.5, size=5)
