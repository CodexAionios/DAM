# Decentralized AI Marketplace (DAM)

This repository contains the complete code and documentation for the Decentralized AI Marketplace (DAM) project.  It unifies the smart contracts, node client, AI backend, deployment scripts, documentation and tests into a single cohesive structure.

## Directory structure

```plaintext
DAM_Project/
├── contracts/               # Solidity smart contracts for the blockchain layer
├── node_client/             # Node setup and interaction scripts
├── ai_backend/              # AI models and computation logic
├── deployment/              # Deployment and testing scripts
├── docs/                    # Documentation (whitepaper, API references, roadmaps)
├── tests/                   # Unit and integration tests
└── README.md                # Project overview
```

### Contracts
Smart contracts that implement the auction system, proof‑of‑efficiency market, reward distribution and fraud detection.

### Node client
Scripts to set up a node, fetch tasks and submit results to the DAM network.

### AI backend
Backend services that perform task matching, fraud detection, efficiency modelling and reward distribution.  The experimental tensor‑mining module has been merged into this folder as `tensor_miner.py` and serves as a foundation for future proof‑of‑work/efficiency engines.

### Deployment
Scripts to deploy and test the smart contracts, along with a Docker compose file for containerized setups.

### Docs
Markdown versions of the whitepaper, API documentation and a high‑level roadmap.  PDF versions of the whitepaper (`dam.pdf`) and the tensor mining specification (`TENSOR MINING.pdf`) are also included for reference.

### Tests
Unit and integration tests for the contracts and backend components.
