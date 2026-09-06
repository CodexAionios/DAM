# DAM API Documentation

DAM has no REST API. Earlier drafts of this document described one (`GET /tasks`,
`POST /submit`, `POST /match`, `POST /report`), but no such service was ever built and
`node_client/client.py` was reworked to talk to the contracts directly. The interfaces
below are the real ones: the deployed smart contracts, and the Python helpers that wrap
them.

Access control is called out per function, because most write paths are gated.

---

## Deployment artifacts

`deployment/deploy_smart_contracts.js` writes two things that everything else reads, so
both the browser dashboard and the Python client always agree on what is deployed:

| File | Contents |
| --- | --- |
| `frontend/contracts/addresses.json` | network, chain id, deployer, reporter, and every contract address |
| `frontend/contracts/abi/*.json` | one ABI array per contract |

`node_client/chain.py` loads both (`load_deployment()`, `load_abi()`), so a redeploy
requires no code changes anywhere.

---

## DAMAuction

Auctions AI tasks and forms a "helix" of the top-scoring bidders.

| Function | Access | Notes |
| --- | --- | --- |
| `createAuction(dataHash, budget, timeLimit, efficiencyReq)` | anyone | `efficiencyReq` is a provider-chosen unit, not the PoE-market scale |
| `submitBid(auctionId, efficiency, latency, hashPower, price)` | anyone not blacklisted | One bid per address per auction; bidding again **replaces** your bid |
| `formHelix(auctionId)` | owner | Ranks qualifying bids 40/30/30 on hash power / inverted latency / efficiency, takes the top `helixSize`, closes the auction, registers the helix with `MLTaskManager` |
| `bidCount(auctionId)` | view | Bids placed so far |
| `getHelixMembers(helixId)` | view | Member addresses |
| `setHelixSize`, `setMaxBidsPerAuction`, `setMLTaskManager`, `setPoEEnergyMarket` | owner | `helixSize <= maxBidsPerAuction` is enforced in both directions |

Bid validity: if a `PoEEnergyMarket` is configured, `submitBid` rejects any `efficiency`
above the bidder's on-chain PoE score. `maxBidsPerAuction` (default 100) bounds the work
`formHelix` does, so one auction cannot be flooded until helix formation runs out of gas.

Events: `BidSubmitted(auctionId, node, replacedPrevious)`, `HelixFormed(helixId, auctionId, members, taskId)`.

---

## MLTaskManager

Tracks a helix's work and decides whether it "turned green".

| Function | Access | Notes |
| --- | --- | --- |
| `registerHelix(helixId, auctionId, members, memberHashPower, taskId, poeGoal)` | DAMAuction only | Called automatically by `formHelix` |
| `reportCompletion(helixId, member, score)` | reporter only | Nodes cannot report their own completion |
| `finalizeHelix(helixId)` | anyone | Pure computation over already-committed data; requires every member to have reported |
| `getHelixSummary(helixId)` | view | `(auctionId, taskId, poeGoal, status, combinedScore, isGreen)` |
| `getHelixMembers(helixId)` | view | Member addresses |
| `setDAMAuction`, `setReporter` | owner | |

`finalizeHelix` combines member scores weighted by hash power, falling back to an
equal-weighted average when no hash power was recorded, then sets `isGreen` if the result
meets `poeGoal`. Status is `0 = Unknown`, `1 = Registered`, `2 = Finalized`.

Events: `HelixRegistered`, `MemberScoreReported`, `HelixFinalized`.

---

## PoEEnergyMarket

The source of truth for node efficiency.

| Function | Access | Notes |
| --- | --- | --- |
| `reportNodeMetrics(node, energyUsage, latency)` | reporter only | Sets `efficiencyScores[node] = 1e18 / (energyUsage * latency)`; zero if either input is zero |
| `deregisterNode(node)` | owner | Removes the node from `nodeList` and clears its score |
| `selectTopValidator()` | view | Highest scorer at or above `efficiencyThreshold`, else the zero address |
| `setReporter(address)` | owner | |
| `efficiencyScores(node)`, `efficiencyThreshold()`, `nodeList(i)` | view | |

Telemetry is attested by a trusted reporter rather than self-reported, for the same reason
`reportCompletion` is: a node cannot be trusted to grade its own efficiency.

Events: `NodeMetricsReported`, `NodeDeregistered`.

---

## PoEConsensus

Turns a tensor-mining result into a committed block, verifying the proof on chain.

| Function | Access | Notes |
| --- | --- | --- |
| `commitBlock(tensor, nonce, seedBlock, miningTime, iterations)` | anyone clearing the gates below | Submits the tensor itself so the contract can verify it |
| `miningSeed(seedBlock, proposer)` | view | The exact seed a miner must work against |
| `committedBlockCount()` / `getCommittedBlock(index)` | view | Stored headers |
| `committedProofs(digest)` | view | Whether that proof was already used |
| `setHashDifficulty`, `setDifficultyTargets`, `setFraudDetection` | owner | Retargeting and fraud wiring |

A commit must clear four independent gates:

1. **Work.** `keccak256(seed, nonce, tensor)` must fall below `hashDifficulty`, where
   `seed = keccak256(blockhash(seedBlock), msg.sender)`. The seed is not the miner's to
   choose and binds the proof to that specific proposer, so a nonce found by one node is
   worthless to another. Finding one requires searching.
2. **Difficulty.** The contract recomputes the element sum and the squared Frobenius norm
   from the submitted tensor and checks both against the targets. Neither is taken on
   trust. The squared norm is compared against `normTargetSquared`, avoiding a square root.
3. **Efficiency.** The proposer's PoE score must clear the market threshold, and mining
   time must stay within `maxOE` of `referenceTime`.
4. **Freshness.** The proof digest must not have been committed before, and `seedBlock`
   must be in the past and within `SEED_WINDOW` (128) blocks.

Why both 1 and 2 are needed: verifying the sum and norm proves the metrics are true of the
submitted data, but data with a small sum is trivial to write down — all zeros would pass.
The work gate is what makes producing a qualifying result cost something.

Bounds: at most `MAX_TENSOR_ELEMENTS` (256) elements, each at most `MAX_ELEMENT_VALUE`
(1e18) so squaring cannot overflow.

> **Scope:** this is a working reference mechanism, not production consensus security.
> `seed` derives from `blockhash`, which a real network's block producer can influence at
> the margin, and difficulty is set by the owner rather than retargeted automatically.

---

## PoEGreenNode

Pays block rewards, scaled by efficiency.

| Function | Access | Notes |
| --- | --- | --- |
| `distributeBlockReward(validator, efficiencyScore)` | owner (i.e. `PoEConsensus`) | Pays `baseBlockReward + efficiencyScore * baseBlockReward / 1e18`; reverts if the token transfer fails |
| `transferOwnership(newOwner)` | owner | How `PoEConsensus` becomes the authorized caller after deployment |

---

## FraudDetection

| Function | Access | Notes |
| --- | --- | --- |
| `reportFraud(node)` | owner | Increments the node's counter |
| `isNodeBlacklisted(node)` | view | True at 3 or more reports |

Enforcement points — a blacklisted node is refused at all three:

| Where | Effect |
| --- | --- |
| `DAMAuction.submitBid` | The bid is rejected outright |
| `DAMAuction.formHelix` | Skipped during selection, catching nodes blacklisted *after* they bid |
| `PoEConsensus.commitBlock` | Cannot commit a block or earn a reward |

Both consumers hold the registry address behind `setFraudDetection`, and `address(0)`
disables the check, so a deployment that doesn't want blacklisting simply leaves it unset.

> **Note:** reports are owner-submitted; the registry has no opinion about what counts as
> fraud. Detecting it is the AI backend's job (`ai_backend/fraud_detector.py`), and
> connecting that analysis to `reportFraud` is not yet automated.

---

## Python node client

All entry points accept `--rpc-url` and honor the `DAM_RPC_URL` environment variable.
Signing uses `DAM_NODE_PRIVATE_KEY`; without it the client falls back to Hardhat's public
dev key and refuses to run against any chain id that is not known-local.

| Command | Purpose |
| --- | --- |
| `python node_client/monitor.py --once` | Measure this node's energy proxy and latency, report them on-chain |
| `python node_client/monitor.py` | Same, on a loop (`--interval-seconds`) |
| `python node_client/client.py` | Show this node's PoE score, active auctions, and helix memberships |
| `python node_client/mine_and_commit.py` | Mine a tensor and commit it via `PoEConsensus` |

`DAMNodeClient` (in `client.py`) exposes `list_auctions()`, `my_efficiency_score()`,
`submit_bid(...)` and `find_my_helixes()`.

`monitor.py` requires the reporter key to actually submit metrics. In production that key
belongs to a separate attestation service, not to the node being measured.
