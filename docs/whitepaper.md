# DAM Whitepaper (Markdown)

A condensed rendering of the DAM design. This is a summary, not the full
whitepaper — for the concrete interfaces and their caveats, see
[`api_documentation.md`](api_documentation.md).

> **Note:** The whitepaper describes the design and economic model of the
> Decentralized AI Marketplace, including its proof‑of‑efficiency consensus,
> auction mechanism, reward distribution and sustainability goals.

## Introduction

DAM aims to create a global marketplace where idle compute resources can
be used to perform useful AI tasks and where providers are rewarded based
on energy efficiency and performance.

## Architecture Overview

Three layers: smart contracts on chain, a network of node clients, and an
off-chain AI backend.

**On chain.** `DAMAuction` auctions a task and forms a *helix* — a cluster of
the top-ranked bidders, scored on a blend of hash power, latency and
efficiency — instead of awarding the work to one winner. `MLTaskManager`
tracks that helix's per-member completion and decides whether it collectively
met its efficiency goal. `PoEEnergyMarket` holds each node's efficiency score,
computed as `1e18 / (energy × latency)`. `PoEConsensus` turns a tensor-mining
result into a committed block: it recomputes the tensor's difficulty metrics on
chain and requires a proof-of-work nonce bound to a seed the miner does not
choose, so a result can be neither fabricated nor replayed. `PoEGreenNode` pays
a reward scaled by that same efficiency score. `FraudDetection` blacklists
nodes, and is consulted at bidding, helix selection and block commitment.

**Node client.** Each node measures its own energy proxy and latency, bids on
auctions, and can mine and commit blocks. Telemetry and task-completion scores
reach the chain through a trusted reporter rather than being self-reported, so
a node does not grade its own work.

**AI backend.** Task matching, fraud heuristics, efficiency modelling, reward
splitting, tensor mining, and the off-chain twin of the helix clustering that
`DAMAuction` mirrors on chain.

## Status and limitations

This is a working reference implementation, not a production system. Every
limitation is documented alongside the interface it affects in
[`api_documentation.md`](api_documentation.md). The ones worth knowing up front:

- Mining proofs are verified on chain, but the seed derives from `blockhash`,
  which a real network's block producer can influence at the margin, and
  difficulty is set by the owner rather than retargeted automatically.
- Node telemetry and task-completion scores are attested by a trusted reporter.
  That keeps a node from grading its own work, at the cost of a trusted party.
- Fraud reports are submitted by the registry owner; the automated analysis in
  `ai_backend/fraud_detector.py` is not yet connected to it.
