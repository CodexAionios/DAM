"""
Shared on-chain access layer for the DAM node client.

Reads the same deployment artifacts `deployment/deploy_smart_contracts.js`
writes for the frontend (`frontend/contracts/addresses.json` and
`frontend/contracts/abi/*.json`), so the Python node software and the JS
dashboard always agree on which contracts are live and where.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from eth_account import Account
from eth_account.signers.local import LocalAccount
from web3 import Web3
from web3.contract import Contract

__all__ = [
    "DEFAULT_RPC_URL",
    "HARDHAT_DEV_PRIVATE_KEY",
    "load_deployment",
    "load_abi",
    "get_web3",
    "get_contract",
    "load_account",
    "send_transaction",
]

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_CONTRACTS_DIR = PROJECT_ROOT / "frontend" / "contracts"
ADDRESSES_PATH = FRONTEND_CONTRACTS_DIR / "addresses.json"
DEPLOYMENTS_DIR = FRONTEND_CONTRACTS_DIR / "deployments"
ABI_DIR = FRONTEND_CONTRACTS_DIR / "abi"

DEFAULT_RPC_URL = os.environ.get("DAM_RPC_URL", "http://127.0.0.1:8545")

# Hardhat's account #0. Publicly known, funded only on local Hardhat networks -
# safe as a local-dev default, never usable for real funds. Overridden by
# DAM_NODE_PRIVATE_KEY when set.
HARDHAT_DEV_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

# Chain ids the dev-key fallback is permitted against: Hardhat's default and
# Ganache's traditional default. Anything else is treated as "possibly real."
LOCAL_CHAIN_IDS = frozenset({31337, 1337})


def load_deployment(network: Optional[str] = None) -> Dict[str, Any]:
    """
    Load a deployment record written by deployment/deploy_smart_contracts.js.

    The deploy script writes two things: a per-network record under
    `frontend/contracts/deployments/<network>.json`, and `addresses.json` for
    whichever deployment ran most recently. Passing `network` (or setting
    DAM_NETWORK) selects a specific one, so deploying to a testnet does not
    leave the local client pointed at it.
    """

    selected = network or os.environ.get("DAM_NETWORK")
    if selected:
        path = DEPLOYMENTS_DIR / f"{selected}.json"
        if not path.exists():
            available = (
                ", ".join(sorted(p.stem for p in DEPLOYMENTS_DIR.glob("*.json")))
                if DEPLOYMENTS_DIR.exists()
                else "none"
            )
            raise FileNotFoundError(
                f"No deployment recorded for network '{selected}' at {path}. "
                f"Available: {available}."
            )
        return json.loads(path.read_text(encoding="utf-8"))

    if not ADDRESSES_PATH.exists():
        raise FileNotFoundError(
            f"No deployment found at {ADDRESSES_PATH}. Run "
            "`npx hardhat run deployment/deploy_smart_contracts.js --network localhost` first."
        )
    return json.loads(ADDRESSES_PATH.read_text(encoding="utf-8"))


def load_abi(name: str) -> list:
    """Load a contract's ABI array as written by the deploy script."""

    abi_path = ABI_DIR / f"{name}.json"
    if not abi_path.exists():
        raise FileNotFoundError(f"No ABI found for '{name}' at {abi_path}.")
    return json.loads(abi_path.read_text(encoding="utf-8"))


def get_web3(rpc_url: str = DEFAULT_RPC_URL) -> Web3:
    """Connect to the DAM network's JSON-RPC endpoint."""

    w3 = Web3(Web3.HTTPProvider(rpc_url))
    if not w3.is_connected():
        raise ConnectionError(
            f"Could not reach a node at {rpc_url}. Is `npx hardhat node` running?"
        )
    return w3


def get_contract(w3: Web3, deployment: Dict[str, Any], name: str) -> Contract:
    """Instantiate a deployed contract whose ABI file matches its addresses.json key."""

    address = deployment["contracts"][name]
    return get_contract_at(w3, address, abi_name=name)


def get_contract_at(w3: Web3, address: str, abi_name: str) -> Contract:
    """
    Instantiate a contract at an explicit address using a named ABI - for
    cases where the addresses.json key differs from the ABI file name, such as
    the reward token (key "rewardToken", ABI "MockERC20" on local networks).
    """

    return w3.eth.contract(address=Web3.to_checksum_address(address), abi=load_abi(abi_name))


def load_account(private_key: Optional[str] = None, *, w3: Optional[Web3] = None) -> LocalAccount:
    """
    Resolve the signing account for this node.

    Priority: explicit `private_key` argument, then the DAM_NODE_PRIVATE_KEY
    environment variable, then the well-known Hardhat dev key - but that
    fallback is only ever allowed against a known-local chain id. Pass `w3`
    so this can actually be checked; without it, the fallback still works
    (for now-updated callers) but only prints its warning, same as before.
    """

    # An empty or whitespace-only env var counts as unset, rather than being
    # passed through to Account.from_key() as a confusing malformed key.
    key = private_key or os.environ.get("DAM_NODE_PRIVATE_KEY", "").strip() or None
    if key is not None:
        return Account.from_key(key)

    if w3 is not None and w3.eth.chain_id not in LOCAL_CHAIN_IDS:
        raise RuntimeError(
            f"DAM_NODE_PRIVATE_KEY is not set and chain id {w3.eth.chain_id} is not a "
            "known-local network. Refusing to sign with Hardhat's public dev key against "
            "what looks like a real network - set DAM_NODE_PRIVATE_KEY explicitly."
        )

    print(
        "WARNING: no DAM_NODE_PRIVATE_KEY set - using Hardhat's public dev "
        "account #0. This is only safe against a local Hardhat network."
    )
    return Account.from_key(HARDHAT_DEV_PRIVATE_KEY)


def send_transaction(w3: Web3, account: LocalAccount, contract_function, **overrides) -> dict:
    """
    Build, sign, send and wait for a contract function call.

    `contract_function` is an unbound call like `contract.functions.foo(1, 2)`.
    Returns the transaction receipt (a dict-like AttributeDict).
    """

    tx = contract_function.build_transaction(
        {
            "from": account.address,
            "nonce": w3.eth.get_transaction_count(account.address),
            "chainId": w3.eth.chain_id,
            **overrides,
        }
    )
    signed = account.sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None)
    if raw is None:
        raw = getattr(signed, "rawTransaction")
    tx_hash = w3.eth.send_raw_transaction(raw)
    return w3.eth.wait_for_transaction_receipt(tx_hash)
