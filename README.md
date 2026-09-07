# Decentralized AI Marketplace (DAM)

This repository contains the complete code and documentation for the Decentralized AI Marketplace (DAM) project.  It unifies the smart contracts, node client, AI backend, deployment scripts, documentation and tests into a single cohesive structure.

## Directory structure

```plaintext
DAM_Project/
├── contracts/               # Solidity smart contracts for the blockchain layer
├── node_client/             # Node setup and interaction scripts
├── ai_backend/              # AI models and computation logic
├── frontend/                # Web dashboard (plain HTML/CSS/JS, no build step)
├── deployment/              # Deployment and testing scripts
├── docs/                    # Documentation (whitepaper, API references, roadmaps)
├── tests/                   # Unit and integration tests
├── package.json             # Node/Hardhat dependencies and scripts
├── hardhat.config.js        # Hardhat compiler and network configuration
├── requirements.txt         # Python dependencies
├── Dockerfile               # Container image for the node client
└── README.md                # Project overview
```

## Getting Started

### 1. Install dependencies

```bash
npm install
pip install -r requirements.txt
```

### 2. Compile and test the smart contracts

```bash
npx hardhat compile
npx hardhat test
```

### 3. Deploy to a local network

```bash
npx hardhat node
npx hardhat run deployment/deploy_smart_contracts.js --network localhost
```

### 4. Report this node's PoE metrics and explore the network

```bash
python node_client/monitor.py --once
python node_client/client.py
```

> **Note:** `npx hardhat test` runs the suites under `tests/`, which is the only directory
> `hardhat.config.js` scans.

### 5. Run the dashboard (optional)

```bash
cd frontend && python -m http.server 8080
```

Then open `http://127.0.0.1:8080` with a wallet pointed at the local Hardhat network
(chain id `31337`, RPC `http://127.0.0.1:8545`).

### Contracts
Smart contracts that implement the auction system, proof‑of‑efficiency tracking, reward
distribution and fraud detection. `DAMAuction.sol` forms a "helix" of the top-scoring
bidders for each task (instead of picking a single winner) and hands the cluster off to
`MLTaskManager.sol`, which tracks per-member completion and finalizes whether the helix
collectively hit its PoE goal — the on-chain counterpart of `ai_backend/helix_manager.py`.
`PoEEnergyMarket.sol` tracks each node's efficiency score from telemetry a trusted
reporter submits per-node. `PoEConsensus.sol` gates tensor-mining block commitment on that
score, a recomputed difficulty check and a proof of work — mining is two-phase, so the
seed is drawn from blocks that did not exist when the miner claimed it, and the work
target retargets itself. It delegates payouts to `PoEGreenNode.sol`, which scales each
reward by the validator's efficiency score.

### Node client
`chain.py` is the shared web3.py connection layer; `monitor.py` reports a node's energy/
latency telemetry on-chain; `client.py` discovers auctions, submits bids and reports on
this node's helix memberships; `mine_and_commit.py` opens a mining session, waits for its
seed to mature, runs the tensor miner and commits a valid result via `PoEConsensus`;
`fraud_reporter.py` scores node telemetry with the AI backend's fraud detector and
reconciles the resulting attestations on `FraudDetection` (dry run unless `--submit`).

### AI backend
Backend services that perform task matching, fraud detection, efficiency modelling and
reward distribution. The experimental tensor‑mining module has been merged into this
folder as `tensor_miner.py` and serves as a foundation for future proof‑of‑work/efficiency
engines. `helix_manager.py` groups nodes into fixed‑size "helix" clusters (by hash power,
latency and PoE score) and allocates a task's workload across each cluster proportionally
to hash power, per the helix model described in the project design notes.

### Frontend
A plain HTML/CSS/JS dashboard (no build step, no framework) for interacting with the
deployed contracts directly from a browser wallet: create auctions, submit bids, form
helixes, report node metrics and completion scores, and finalize helixes.

### Deployment
Scripts to deploy and test the smart contracts, along with a Docker compose file for
containerized setups.

### Docs
`api_documentation.md` documents the real contract and CLI interfaces, with each
function's access control and the known caveats. `whitepaper.md` is a condensed design
summary; `roadmap.md` sketches the phases. `engineering_log.md` records what was built and
fixed, every bug found and how it was proven, and what remains open — start there if
you're picking the project up.

### Tests
Unit and integration tests for the contracts and backend components.
