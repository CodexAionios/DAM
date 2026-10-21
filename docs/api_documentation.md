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
| `frontend/contracts/addresses.json` | The most recent deployment — network, chain id, deployer, roles, and every contract address |
| `frontend/contracts/deployments/<network>.json` | The same record, kept per network so deploying elsewhere never destroys an earlier one |
| `frontend/contracts/abi/*.json` | one ABI array per contract |

`node_client/chain.py` loads these (`load_deployment()`, `load_abi()`), so a redeploy
requires no code changes anywhere. `load_deployment("sepolia")`, or the `DAM_NETWORK`
environment variable, selects a specific network instead of whichever ran last.

---

## Ownership and administration

Every contract with privileged setters inherits `Ownable2Step`:

| Function | Access | Notes |
| --- | --- | --- |
| `owner()` / `pendingOwner()` | view | Current administrator, and any outstanding nominee |
| `transferOwnership(newOwner)` | owner | Nominates only — ownership does not move yet |
| `acceptOwnership()` | the nominee | Completes the transfer |
| `cancelOwnershipTransfer()` | owner | Withdraws a nomination |

The two-step handshake exists because a single-step transfer to a mistyped or unreachable
address ends administration permanently, and that is exactly the transaction people get
wrong when moving control to a freshly created multisig. Here a wrong nomination is simply
re-nominated. There is deliberately no `renounceOwnership`: every DAM contract needs a live
owner (difficulty bounds, reporter rotation, fraud thresholds), so an owner-less contract
is bricked rather than decentralized.

`PoEGreenNode` is the exception — it keeps a single-step `transferOwnership`, because its
owner is `PoEConsensus`, a contract that could never call `acceptOwnership`.

**Roles are separate on purpose.** The administrator (`ADMIN_ADDRESS`), the energy and
completion attester (`REPORTER_ADDRESS`), and the fraud reporters (`FRAUD_REPORTERS`) are
independent addresses. They all default to the deployer for local convenience; on a public
network the deploy script warns when they collapse into one key, and revokes the fraud
reporter authorization `FraudDetection`'s constructor grants its deployer whenever an
explicit reporter set was configured without it.

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
above the bidder's on-chain efficiency score. That score now comes only from committed
blocks, so a node must have mined at least one block before it can bid any positive
efficiency — attesting energy alone does not count. `maxBidsPerAuction` (default 100) bounds the work
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

The ledger of node efficiency: **verified work per attested joule**.

```
efficiency = expectedHashes / joules        stored 1e18-scaled (1e18 = 1 hash per joule)
           = expectedHashes * 1e21 / milliJoules
```

| Function | Access | Notes |
| --- | --- | --- |
| `reportEnergy(node, milliJoules)` | reporter only | Attests the energy spent producing the node's **next** proof. Overwrites any unused attestation; rejects 0 |
| `recordBlock(node, expectedHashes)` | `consensus` only | Scores a committed block and **consumes** the attestation; reverts `"No attested energy for this block"` without one |
| `deregisterNode(node)` | owner | Removes the node from `nodeList` and clears its score and any pending attestation |
| `selectTopValidator()` | view | Most efficient node at or above `efficiencyThreshold`, else the zero address |
| `setReporter(address)`, `setConsensus(address)`, `setEfficiencyThreshold(value)` | owner | `setConsensus` must point at `PoEConsensus` or no block can be committed |
| `efficiencyScores(node)` | view | Efficiency as of the node's latest committed block; 0 until it commits one |
| `attestedEnergy(node)` | view | Millijoules pending for the node's next block; 0 when none |
| `efficiencyThreshold()`, `nodeList(i)`, `SCORE_SCALE`, `MAX_EXPECTED_HASHES` | view | |

Where each input comes from, and why that matters:

- **`expectedHashes` is not reported by anyone.** `PoEConsensus` derives it from the
  proof-of-work target the block was verified against, so the numerator is exactly as
  trustworthy as the proof itself.
- **Energy is attested by the trusted reporter**, because it is a physical measurement taken
  at the machine and no contract can observe it. This is the one trusted input left, for the
  same reason `reportCompletion` is gated: a node cannot be trusted to grade its own work.

One attestation scores one block. Attestations overwrite rather than accumulate on purpose:
an accumulating counter would let energy from failed attempts pile up until the node could
never reach the threshold again.

> **History:** this contract used to compute `1e18 / (energyUsage × latency)` from a
> `reportNodeMetrics` call, with the node client reporting CPU utilisation as the energy
> figure. Nothing in that formula measured work, so an idle machine scored highest — in a
> reproduction it earned 13.33 tokens per block against 10.03 for a node that was mining.
> See `engineering_log.md`, bug 31.

Events: `EnergyAttested(node, milliJoules)`, `EfficiencyRecorded(node, expectedHashes, milliJoules, score)`, `NodeDeregistered(node)`.

---

## PoEConsensus

Turns a tensor-mining result into a committed block, verifying the proof on chain.

Mining is **two-phase**: open a session, wait for its seed to mature, then commit.

| Function | Access | Notes |
| --- | --- | --- |
| `openSession()` | anyone | Claims a seed drawn from blocks that do not exist yet; emits `SessionOpened(sessionId, miner, seedReadyAtBlock)` |
| `sessionSeed(sessionId)` | view | The exact seed this session must be mined against; reverts until it matures |
| `sessionSeedReadyAt(sessionId)` | view | Block at which the seed becomes readable |
| `sessionExpiresAt(sessionId)` | view | Last block at which the session may be committed |
| `sessionSeedStart(sessionId)` / `sessionCount()` | view | Session bookkeeping |
| `commitBlock(sessionId, tensor, nonce, miningTime, iterations)` | the session's miner, clearing the gates below | Submits the tensor itself so the contract can verify it |
| `committedBlockCount()` / `getCommittedBlock(index)` | view | Stored headers |
| `committedProofs(digest)` | view | Whether that proof was already used |
| `blocksUntilRetarget()` | view | Committed blocks left in the current epoch; 0 when retargeting is off |
| `expectedHashesPerProof()` | view | `type(uint256).max / hashDifficulty` — the work a proof against the current target is credited with |
| `referenceEfficiency()` | view | Efficiency (hashes/J, 1e18-scaled) that earns the full reward bonus; default 10,000 hashes/J |
| `setRetargetParams(interval, targetBlockTime)` | owner | `interval = 0` pins difficulty |
| `setReferenceEfficiency(value)` | owner | Must be in `(0, MAX_REFERENCE_EFFICIENCY]` |
| `setHashDifficulty`, `setDifficultyTargets`, `setFraudDetection` | owner | Manual override and fraud wiring |

### Why mining is two-phase

`openSession()` records the caller and the block they asked in. The seed is then derived
from blocks *after* that:

```
seedStart = openedAt + SEED_DELAY            (SEED_DELAY = 2)
seed      = keccak256(
              fold(blockhash(seedStart) .. blockhash(seedStart + SEED_SPAN - 1)),
              miner, sessionId               (SEED_SPAN = 3)
            )
```

The ordering is the point. When the seed block was a caller-supplied argument, a miner
could pick whichever recent block suited them, and a block producer could look at the hash
it had just produced and decide whether to publish it — one free re-roll per block.
Committing first means the entropy postdates the commitment, so there is nothing left to
select. Folding three consecutive hashes means biasing a seed requires producing every
block in the span, not just one.

Opening many sessions is not a way around this. Sessions opened in the same block share the
same block hashes but get different seeds via `sessionId`, so grinding N sessions × M
nonces searches exactly the same uniform space as one session with N×M nonces.

A commit must clear four independent gates:

1. **Session.** A live, unconsumed, matured session belonging to `msg.sender`. Sessions are
   single-use, and expire `SEED_WINDOW` (128) blocks after `seedStart` so proofs cannot be
   banked indefinitely.
2. **Work.** `keccak256(seed, nonce, tensor)` must fall below `hashDifficulty`. The seed
   binds the proof to one proposer and one session, so a nonce found by one node is
   worthless to another. Finding one requires searching.
3. **Difficulty.** The contract recomputes the element sum and the squared Frobenius norm
   from the submitted tensor and checks both against the targets. Neither is taken on
   trust. The squared norm is compared against `normTargetSquared`, avoiding a square root.
4. **Efficiency.** The block is scored by `PoEEnergyMarket.recordBlock(proposer,
   expectedHashesPerProof())` — verified work over the energy attested for it — and the
   score must reach the market's `efficiencyThreshold`. Mining time must also stay within
   `maxOE` of `referenceTime`, and the proposer must not be blacklisted.

Why both 2 and 3 are needed: verifying the sum and norm proves the metrics are true of the
submitted data, but data with a small sum is trivial to write down — all zeros would pass.
The work gate is what makes producing a qualifying result cost something. That also means
the tensor part of "tensor mining" contributes no cost of its own; the keccak search does.

### Scoring and reward

The work credited to a block is `expectedHashesPerProof()` **at the target the proof was
verified against**, read before the commit's own retarget can change it. Like Bitcoin's
chainwork, it is an expectation: a lucky search and an unlucky one are credited the same
work, and only their energy differs. That makes the per-block score noisy — in live runs, blocks
at the same target and the same assumed power scored from 1,022 to 32,000 hashes/J,
depending only on how many hashes the search happened to need. Over many blocks the
average converges on the true rate; per block, luck moves the reward more than hardware.

The reward is `baseBlockReward × (1 + f)`, where `f = min(score / referenceEfficiency, 1)`.
The cap is enforced twice — here, and again in `PoEGreenNode` — so no energy reading, however
small or miscalibrated, can push a block above twice the base reward.

### Difficulty retargeting

Every `retargetInterval` committed blocks (default 16), the contract compares how long
those blocks actually took against `retargetInterval × targetBlockTime` and rescales
`hashDifficulty` by that ratio, clamped to `MAX_RETARGET_FACTOR` (4×) in either direction.
Higher target means easier, so blocks arriving faster than intended tighten it. Difficulty
is held within `[MIN_HASH_DIFFICULTY, MAX_HASH_DIFFICULTY]`; the ceiling
(`type(uint256).max / 4`) is what lets a 4× move happen without overflowing.

`setHashDifficulty` remains for bootstrapping and emergencies. It restarts the current
epoch, so a manual change is not immediately undone by stale timing data.

Bounds: at most `MAX_TENSOR_ELEMENTS` (256) elements, each at most `MAX_ELEMENT_VALUE`
(1e18) so squaring cannot overflow.

> **Scope:** this is a working reference mechanism, not production consensus security.
> `block.timestamp` is proposer-nudgeable, which biases retargeting — the 4× clamp bounds
> how far per epoch, it does not eliminate it. And a proposer who produces *every* block in
> a session's seed span can still bias that seed.

---

## PoEGreenNode

Pays block rewards, scaled by efficiency.

| Function | Access | Notes |
| --- | --- | --- |
| `distributeBlockReward(validator, efficiencyScore)` | owner (i.e. `PoEConsensus`) | Pays `baseBlockReward + min(efficiencyScore, 1e18) * baseBlockReward / 1e18`, so at most twice the base; reverts if the token transfer fails |
| `transferOwnership(newOwner)` | owner | How `PoEConsensus` becomes the authorized caller after deployment |

---

## FraudDetection

| Function | Access | Notes |
| --- | --- | --- |
| `reportFraud(node)` | authorized reporter | Records this reporter's accusation; reverts if it already stands |
| `revokeReport(node)` | authorized reporter | Withdraws this reporter's own accusation |
| `clearNode(node)` | owner | Retracts every standing accusation against a node |
| `setReporter(reporter, authorized)` | owner | Grows or shrinks the reporter set |
| `setBlacklistThreshold(n)` | owner | Distinct reporters needed to blacklist |
| `fraudScores(node)` | view | Number of distinct reporters currently accusing |
| `hasReported(reporter, node)` | view | Whether that reporter's accusation stands |
| `isNodeBlacklisted(node)` | view | True at or above `blacklistThreshold` |
| `knownReporterCount()` / `knownReporterAt(i)` | view | What `clearNode` will iterate |

### The score counts reporters, not calls

`fraudScores` is the number of **distinct reporters** accusing a node, so
`blacklistThreshold` means "this many independent parties agree" rather than "somebody
pressed the button this many times". Two consequences worth knowing:

- **Re-reporting is rejected, not counted.** That is what makes automated detection safe
  to run on a schedule. Against a bare counter, any node that stayed anomalous would be
  blacklisted for surviving three polling cycles.
- **The threshold must be reachable.** With one authorized reporter a threshold of 3 can
  never be met and the blacklist is dead code. The deploy script therefore sets it to 1 on
  local networks (one attester is authorized there) and 3 otherwise; override with
  `FRAUD_BLACKLIST_THRESHOLD`.

Accusations are retractable — by the reporter (`revokeReport`) or the owner
(`clearNode`) — because automated detection produces false positives, and an accusation
that could not be withdrawn would be worse than the problem it catches.

Enforcement points — a blacklisted node is refused at all three:

| Where | Effect |
| --- | --- |
| `DAMAuction.submitBid` | The bid is rejected outright |
| `DAMAuction.formHelix` | Skipped during selection, catching nodes blacklisted *after* they bid |
| `PoEConsensus.commitBlock` | Cannot commit a block or earn a reward |

Both consumers hold the registry address behind `setFraudDetection`, and `address(0)`
disables the check, so a deployment that doesn't want blacklisting simply leaves it unset.
Enforcement reads the registry live, so clearing a node restores its access immediately.

> **Scope:** attestations carry no stake and no penalty for being wrong, so the registry is
> only as trustworthy as the reporter set the owner authorizes.

---

## Python node client

All entry points accept `--rpc-url` and honor the `DAM_RPC_URL` environment variable.
Signing uses `DAM_NODE_PRIVATE_KEY`; without it the client falls back to Hardhat's public
dev key and refuses to run against any chain id that is not known-local.

| Command | Purpose |
| --- | --- |
| `python node_client/monitor.py` | Local check, nothing sent on chain: which energy source is available, power at idle and under a keccak load, and the resulting hashes/J |
| `python node_client/mine_and_commit.py` | Open a session, mine against its seed while measuring energy, attest it, commit, and verify the on-chain score |
| `python node_client/client.py` | Show this node's efficiency, active auctions, and helix memberships |
| `python node_client/fraud_reporter.py telemetry.json` | Score nodes with `ai_backend.fraud_detector` and reconcile this reporter's attestations |

`monitor.py` and `mine_and_commit.py` accept `--assume-watts W` (see below).
`DAMNodeClient` (in `client.py`) exposes `list_auctions()`, `my_efficiency_score()`,
`submit_bid(...)` and `find_my_helixes()`.

### Energy measurement (`node_client/energy.py`)

| Source | When | Reading |
| --- | --- | --- |
| RAPL (`/sys/class/powercap/intel-rapl:N`) | The machine exposes readable package counters | Measured: sum of `package-*` domains only — sub-domains and `psys` would double count |
| `--assume-watts W` | No RAPL, and the flag was passed | `W × wall-clock seconds`, labelled **ESTIMATED** everywhere it is printed |
| Neither | — | `EnergyUnavailable`: the script stops instead of guessing |

Every rounding choice errs against the node: millijoules round up, a counter that did not
advance is an error rather than zero, and whole-package readings include anything else
running on the machine. Since Linux 5.10 `energy_uj` is root-only; the error says so.

`mine_and_commit.py` checks both preconditions **before opening a session**: that energy can
be measured, and that its key is `PoEEnergyMarket`'s reporter. Only the reporter may attest
energy, so in a deployment with separated roles the script stops rather than mine a block
that could never be scored, and the measurement has to be relayed to that attester — a
service this repository does not include. After committing, it recomputes
`expectedHashes × 1e21 / mJ` locally and fails loudly if the chain recorded anything else.

`fraud_reporter.py` is the bridge from detection to enforcement. It is a **dry run unless
given `--submit`**, since an attestation can get a node blacklisted; `--revoke-cleared`
withdraws accusations against nodes that no longer alert, so a scheduled run reconciles in
both directions rather than only ratcheting. Telemetry is a JSON list matching
`NodeTelemetry`, whose `node_id` must be the node's address — most of those signals
(disputes, audit flags, stake ratios) are not recorded on chain by this project, so they
come from whatever monitoring the operator runs. A node with `total_jobs == 0` is skipped
rather than scored: the detector reads an empty record as a total completion collapse,
which is an absence of evidence, not a finding.

`mine_and_commit.py` has to wait between opening a session and committing, because the
seed deliberately depends on blocks mined afterwards. On a real network those arrive on
their own; an idle local Hardhat node only mines when a transaction does, so on a
known-local chain id the script requests blocks with `evm_mine`. Pass `--no-dev-mine` to
disable that and simply wait.
