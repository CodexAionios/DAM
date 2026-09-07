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

Local deployments need no configuration: the Hardhat node supplies funded
accounts, and a mock ERC20 is deployed as the reward token.

### 3b. Deploy to a public network

```bash
cp .env.example .env       # then fill it in; .env is gitignored
npx hardhat run deployment/deploy_smart_contracts.js --network sepolia
```

`sepolia`, `baseSepolia` and a generic `custom` network are preconfigured, each
reading its RPC URL and `DEPLOYER_PRIVATE_KEY` from the environment.

Public deployments differ from local ones in three deliberate ways:

- **`REWARD_TOKEN_ADDRESS` is required.** There is no sensible way to invent a
  real reward token, so the deploy refuses rather than guessing.
- **A preflight runs before any transaction is sent** — it checks the signer,
  native balance, that the reward token exists and answers `balanceOf`, that the
  deployer can cover `REWARD_POOL_AMOUNT`, and that the fraud threshold is
  reachable by the reporter set. Finding a missing variable halfway through
  costs real gas and leaves a half-wired system.
- **Ownership is handed to `ADMIN_ADDRESS`.** The transfer is two-step: the
  deploy nominates, and that address must then call `acceptOwnership()` on
  `PoEEnergyMarket`, `MLTaskManager`, `DAMAuction`, `PoEConsensus` and
  `FraudDetection`. Until it does, the deployer stays in control — so a wrong
  address is recoverable rather than permanent.

**Separate the roles.** `ADMIN_ADDRESS` (use a multisig), `REPORTER_ADDRESS`
(the trusted attester) and `FRAUD_REPORTERS` all default to the deployer, which
is fine locally and wrong anywhere else: one leaked key would otherwise control
telemetry, fraud accusations and consensus difficulty at once.

Each deploy writes `frontend/contracts/deployments/<network>.json` alongside the
`addresses.json` that the frontend and Python client read by default, so
deploying elsewhere never destroys an earlier record. Set `DAM_NETWORK` to point
the Python client at a specific one.

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
