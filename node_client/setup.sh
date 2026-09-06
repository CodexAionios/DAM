#!/bin/bash
# Node setup script.
#
# Installs the Python and Node.js dependencies a DAM node needs, and prints
# the commands to actually run one. Safe to re-run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$PROJECT_ROOT/.venv"

cd "$PROJECT_ROOT"

echo "== Checking prerequisites =="
for cmd in python3 npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

echo "== Setting up Python environment ($VENV_DIR) =="
if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate" 2>/dev/null || source "$VENV_DIR/Scripts/activate"
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
deactivate

echo "== Installing Node.js dependencies =="
npm install

if [ -z "${DAM_NODE_PRIVATE_KEY:-}" ]; then
  echo
  echo "NOTE: DAM_NODE_PRIVATE_KEY is not set. node_client/chain.py will fall"
  echo "back to Hardhat's public dev account #0, which only works against a"
  echo "local Hardhat network. Export a real private key before pointing this"
  echo "node at any other network."
fi

cat <<'EOF'

== Setup complete. Next steps: ==
  1. Start a local chain:     npx hardhat node
  2. Deploy the contracts:    npx hardhat run deployment/deploy_smart_contracts.js --network localhost
  3. Activate the Python env: source .venv/bin/activate   (or .venv\Scripts\activate on Windows)
  4. Report this node's PoE:  python node_client/monitor.py --once
  5. List auctions / bid:     python node_client/client.py
EOF
