import requests


class DAMNodeClient:
    """
    Python client for interacting with the DAM network.
    """

    def __init__(self, node_id: str, api_url: str) -> None:
        self.node_id = node_id
        self.api_url = api_url

    def fetch_tasks(self):
        """
        Retrieve available tasks from the DAM backend.
        """
        response = requests.get(f"{self.api_url}/tasks")
        response.raise_for_status()
        return response.json()

    def submit_result(self, task_id: int, result_hash: str) -> None:
        """
        Submit a result hash for a completed task.
        """
        payload = {"task_id": task_id, "result_hash": result_hash}
        response = requests.post(f"{self.api_url}/submit", json=payload)
        response.raise_for_status()


if __name__ == "__main__":
    node = DAMNodeClient(node_id="node_001", api_url="http://localhost:5000")
    tasks = node.fetch_tasks()
    print("Available Tasks:", tasks)
