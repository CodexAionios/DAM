"""
Python client for interacting with the DAM network.

Earlier versions of this client talked to a REST backend (`GET /tasks`,
`POST /submit`) that was never actually built anywhere in this repo. The DAM
architecture that exists today is entirely on-chain - the same contracts the
frontend dashboard talks to - so this client now talks to those contracts
directly via web3.py instead.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from web3 import Web3

from chain import DEFAULT_RPC_URL, get_contract, get_web3, load_account, load_deployment, send_transaction

__all__ = ["AuctionTask", "HelixMembership", "DAMNodeClient"]


@dataclass(frozen=True)
class AuctionTask:
    """A snapshot of an on-chain auction task."""

    auction_id: int
    data_hash: int
    budget: int
    time_limit: int
    efficiency_req: int
    is_active: bool
    provider: str


@dataclass(frozen=True)
class HelixMembership:
    """This node's status within a helix it belongs to."""

    helix_id: int
    auction_id: int
    task_id: int
    poe_goal: int
    status: int  # 0=Unknown, 1=Registered, 2=Finalized
    combined_score: int
    is_green: bool


class DAMNodeClient:
    """Talks to the deployed DAM contracts on behalf of a single node."""

    def __init__(self, w3: Web3 | None = None, account=None, rpc_url: str = DEFAULT_RPC_URL) -> None:
        self.w3 = w3 or get_web3(rpc_url)
        self.deployment = load_deployment()
        self.account = account or load_account(w3=self.w3)
        self.dam_auction = get_contract(self.w3, self.deployment, "DAMAuction")
        self.ml_task_manager = get_contract(self.w3, self.deployment, "MLTaskManager")
        self.poe_energy_market = get_contract(self.w3, self.deployment, "PoEEnergyMarket")

    def list_auctions(self, *, active_only: bool = True) -> List[AuctionTask]:
        """Return known auction tasks, optionally filtered to still-active ones."""

        count = self.dam_auction.functions.auctionCounter().call()
        tasks = []
        for auction_id in range(1, count + 1):
            raw = self.dam_auction.functions.dataTasks(auction_id).call()
            task = AuctionTask(
                auction_id=auction_id,
                data_hash=raw[1],
                budget=raw[2],
                time_limit=raw[3],
                efficiency_req=raw[4],
                is_active=raw[5],
                provider=raw[6],
            )
            if not active_only or task.is_active:
                tasks.append(task)
        return tasks

    def my_efficiency_score(self) -> int:
        """This node's latest on-chain PoE score (0 if it has never reported)."""

        return self.poe_energy_market.functions.efficiencyScores(self.account.address).call()

    def submit_bid(self, auction_id: int, efficiency: int, latency: int, hash_power: int, price: int) -> dict:
        """
        Bid on an auction. Reverts on-chain if `efficiency` exceeds this
        node's real PoE score (when a PoEEnergyMarket is configured on the
        auction contract) - see DAMAuction.submitBid.
        """

        return send_transaction(
            self.w3,
            self.account,
            self.dam_auction.functions.submitBid(auction_id, efficiency, latency, hash_power, price),
        )

    def find_my_helixes(self) -> List[HelixMembership]:
        """Return every helix this node currently belongs to, with its PoE status."""

        count = self.dam_auction.functions.helixCounter().call()
        memberships = []
        for helix_id in range(1, count + 1):
            members = self.dam_auction.functions.getHelixMembers(helix_id).call()
            if self.account.address not in members:
                continue
            summary = self.ml_task_manager.functions.getHelixSummary(helix_id).call()
            memberships.append(
                HelixMembership(
                    helix_id=helix_id,
                    auction_id=summary[0],
                    task_id=summary[1],
                    poe_goal=summary[2],
                    status=summary[3],
                    combined_score=summary[4],
                    is_green=summary[5],
                )
            )
        return memberships


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="List DAM auctions and this node's helix memberships.")
    parser.add_argument("--rpc-url", default=DEFAULT_RPC_URL, help="JSON-RPC endpoint of the DAM network")
    args = parser.parse_args()

    client = DAMNodeClient(rpc_url=args.rpc_url)
    print(f"Node address: {client.account.address}")
    print(f"On-chain PoE score: {client.my_efficiency_score()}")

    print("Active auctions:")
    for auction in client.list_auctions():
        print(f"  #{auction.auction_id}: efficiencyReq={auction.efficiency_req} timeLimit={auction.time_limit}")

    print("My helixes:")
    for membership in client.find_my_helixes():
        status_name = ["Unknown", "Registered", "Finalized"][membership.status]
        print(f"  helix #{membership.helix_id}: {status_name}, green={membership.is_green}")
