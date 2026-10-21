# DAM Whitepaper (Markdown)

A condensed rendering of the DAM design. This is a summary, not the full
whitepaper — for the concrete interfaces and their caveats, see
[`api_documentation.md`](api_documentation.md).

> **Status: closed (October 2026).** The project is kept as a reference
> implementation and case study; the README explains what was found and why it
> stopped.

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
met its efficiency goal. `PoEEnergyMarket` holds each node's efficiency:
verified work per attested joule, where the work is the number of hashes the
block's proof costs on average and is derived on chain, never reported.
`PoEConsensus` turns a tensor-mining
result into a committed block: it recomputes the tensor's difficulty metrics on
chain and requires a proof-of-work nonce bound to a seed the miner does not
choose, so a result can be neither fabricated nor replayed. Mining is two-phase
for that reason — a miner claims a session first, and the seed is then drawn
from blocks that did not exist yet, leaving nothing to select. The work target
retargets itself on a Bitcoin-style schedule. `PoEGreenNode` pays
a reward scaled by that same efficiency, relative to a reference and capped at
twice the base. `FraudDetection` blacklists nodes, and is consulted at bidding,
helix selection and block commitment.

**Node client.** Each node measures the energy its mining consumes (RAPL
counters, or an explicitly declared wattage labelled as an estimate), bids on
auctions, and mines and commits blocks. Energy and task-completion scores
reach the chain through a trusted reporter rather than being self-reported, so
a node does not grade its own work.

**AI backend.** Tensor mining, fraud heuristics (with the reporter that carries
them on chain), and the off-chain twin of the helix clustering that `DAMAuction`
mirrors — extended with workload allocation and failed-node reassignment, which
the chain does not do. Efficiency scoring, reward payout and task matching are
on-chain concerns and are not duplicated here.

## Status and limitations

This is a working reference implementation, not a production system. Every
limitation is documented alongside the interface it affects in
[`api_documentation.md`](api_documentation.md). The ones worth knowing up front:

- Mining proofs are verified on chain, against a seed the miner commits to
  before the entropy exists and which folds several block hashes. A proposer
  who produces *every* block in a session's seed span can still bias it, and
  `block.timestamp` nudging biases difficulty retargeting within its 4× clamp.
- Energy and task-completion scores are attested by a trusted reporter. That
  keeps a node from grading its own work, at the cost of a trusted party — and
  in an open network nobody can verify a stranger's joules remotely, which is
  the main reason the project closed.
- Work is credited at its expectation, so per-block efficiency is noisy: a
  lucky search looks efficient (a 31× spread was observed at identical
  settings). Averages converge; individual blocks do not.
- There is no emission cap. Rewards are bounded per block, not per node or per
  epoch, so the pool drains as fast as blocks are found.
- Fraud attestations are submitted by an authorized reporter set, and
  `ai_backend/fraud_detector.py` feeds them through `node_client/fraud_reporter.py`.
  Attestations carry no stake and no penalty for being wrong, so the registry
  is only as trustworthy as the reporters the owner authorizes.
