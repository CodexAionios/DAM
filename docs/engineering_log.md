# Engineering Log

A record of the work that took DAM_Project from a partially-stubbed prototype to a
tested, self-consistent reference implementation. Written for whoever picks this up
next: what changed, what was broken, how each fix was proven, and what is still open.

---

## Where the project started

The repository held a mix of finished modules and convincing-looking placeholders, with
no way to tell them apart without reading every file:

- **No build or dependency setup at all.** No `package.json`, no `requirements.txt`, no
  Hardhat config. Nothing could be compiled, installed or run. Node.js was not even
  installed on the machine.
- **No real tests.** Three test files existed; all three asserted `true` and verified
  nothing.
- **`MLTaskManager.sol` was an empty contract** with a `TODO`, and `DAMAuction`'s
  `processMLTask()` was an empty function body — the two were supposed to connect.
- **No frontend**, despite the README describing one.
- **`node_client/monitor.py` was a one-line stub**, and `client.py` pointed at a REST API
  that existed nowhere in the repository.
- **Documentation described things that did not exist** — a PDF whitepaper, a REST API,
  a placeholder deploy script that was actually real.

---

## What exists now

| Area | State |
| --- | --- |
| Contracts | 6 production contracts, all with real test coverage |
| Tests | **137 passing** Hardhat tests (from 0 real ones) |
| Node client | 4 modules on web3.py, live-verified against a running chain |
| Frontend | Working dashboard, no build step, driven end-to-end by an automated harness |
| Deployment | One script deploys and wires the whole system, emitting config both the frontend and Python client read |
| Docs | `api_documentation.md` describes the real interfaces with their access control and caveats |

---

## Work by area

### Smart contracts

- **`MLTaskManager.sol`** — implemented from an empty stub: helix registration, per-member
  completion reporting, and finalization on a hash-power-weighted combined score.
- **`DAMAuction.sol`** — replaced single-winner selection with **helix formation**: bids
  are ranked on a blended 40/30/30 score (hash power, inverted latency, efficiency) and
  the top `helixSize` form a cluster. Later gained a bid cap, one-bid-per-address, a
  `bidCount()` view, and fraud-blacklist enforcement.
- **`PoEEnergyMarket.sol`** — redesigned around **per-node, reporter-attested telemetry**
  after a review found its score could be stolen (below). Gained `deregisterNode` so the
  validator list can shrink.
- **`PoEConsensus.sol`** — mining proofs are now **verified on chain** rather than taken
  on trust, against a seed the miner cannot choose (below). Difficulty **retargets itself**
  on a Bitcoin-style schedule; fraud enforcement added.
- **`PoEGreenNode.sol`** — gained `transferOwnership`, without which `PoEConsensus` could
  never have become its authorized caller, and a checked token transfer.
- **`FraudDetection.sol`** — consulted by two contracts, then rebuilt around **one
  attestation per reporter** so automated detection could drive it safely (below).
- **`Ownable2Step.sol`** — new shared base giving every administered contract a two-step
  ownership transfer, so a deployment can hand control to a multisig instead of being
  stuck with its deploying key forever.

### AI backend

`tensor_miner.py` and `fraud_detector.py` were already written; the work here was
correcting them (see the bug table) and finally connecting `fraud_detector.py` to the
chain. Three further modules that shipped with the original repo — `task_matcher.py`,
`efficiency_model.py`, `reward_distribution.py` — were reviewed and fixed too, then
**removed in a later cleanup pass**: nothing imported them, nothing tested them, and each
duplicated logic the chain performs authoritatively (`DAMAuction.formHelix`,
`PoEEnergyMarket`, `PoEGreenNode`). Their bug-table rows stay as history. `helix_manager.py`
was added as the off-chain twin of `DAMAuction.formHelix`.

### Node client

`chain.py` (shared web3.py access layer, reading the same deployment artifacts the
frontend uses), `monitor.py` (psutil energy proxy + real RPC latency, reported on chain),
`client.py` (auctions, bids, helix membership — rewritten off the imaginary REST API),
`mine_and_commit.py` (opens a mining session, waits for its seed to mature, mines a tensor,
searches for a proof nonce, commits it), and `fraud_reporter.py` (scores telemetry with the
AI backend's detector and reconciles the resulting attestations on chain).

### Frontend

A dashboard in plain HTML/CSS/JS with a vendored `ethers.js` and no build step: wallet
connection, PoE reporting, auction creation, bidding, helix formation, completion
reporting and finalization. `scripts/verify_frontend.mjs` drives the *real* `app.js`
through Node's ES module loader with a minimal EIP-1193 wallet shim, signing genuine
transactions against a local chain.

### Deployment and tooling

`deploy_smart_contracts.js` deploys the full set, wires every cross-contract reference in
the required order, funds the reward pool, and writes `addresses.json` plus ABIs that both
the browser and Python read — so a redeploy needs no code changes. Added `package.json`,
`hardhat.config.js`, `requirements.txt`, `Dockerfile`, `.dockerignore`.

---

## Bugs found and fixed

Ordered roughly by severity. "How found" matters: most were caught by running things,
not by reading them.

| # | Bug | Impact | How it was found |
| --- | --- | --- | --- |
| 1 | `PoEConsensus` never verified mining proofs — sum and norm were caller-supplied | Anyone could claim a perfect result and collect rewards without mining | Design review |
| 2 | `PoEEnergyMarket.updateEfficiencyScore` read a *shared* oracle and was callable by anyone for any address | An attacker could inherit another node's score with no hardware, then win helixes and commit blocks | Code review |
| 3 | `PoEConsensus` allowed unlimited replay of one mining result | **One** mining effort produced 5 blocks and 100 tokens in a demo, and would have drained the pool | Writing the first tests for untested code |
| 4 | `DAMAuction` had no bid cap | Flooding one auction could push `formHelix` past the block gas limit, freezing that task | Review, then fixed on request |
| 5 | `PoEGreenNode` had no `transferOwnership` | `PoEConsensus` could never satisfy its `onlyOwner` gate — the reward path was unreachable | Trying to deploy the two together |
| 6 | Unchecked ERC20 `transfer` return | A token returning `false` would record a block and pay nothing | Code review |
| 7 | `selectTopValidator` seeded `bestScore` at the threshold but compared with `>` | A node scoring *exactly* the threshold could never be selected | Code review |
| 8 | `chain.py` fell back to Hardhat's public dev key with only a printed warning | Could sign real transactions on a real network with a publicly-known key | Code review |
| 9 | `tensor_miner` never re-clipped after its second subtraction | Every mined tensor contained negative values, violating its documented range | Review, confirmed 30/30 trials |
| 10 | `mine_and_commit` hashed `np.array2string`, which truncates past ~1000 elements | Two different large tensors hashed identically | Review, confirmed empirically |
| 11 | `efficiency_model` folded batch size into the efficiency score | A node could inflate its score 10x by reporting in bigger batches | Review, confirmed empirically |
| 12 | Stale `@chainlink/contracts` import path | Would not compile | The first real compile |
| 13 | `formHelix` hit Solidity's "stack too deep" | Would not compile | The first real compile |
| 14 | `withStatus` set "done" before refreshing the UI | Dashboard could show stale data while claiming success | The jsdom E2E harness |
| 15 | Docker container used `127.0.0.1` for the chain | A containerized client could never reach a host-run node; the exposed port mapped to nothing | Review |
| 16 | `monitor.py` re-initialized everything every iteration and caught bare `Exception` | Warning spam ~1440×/day; permanent failures retried silently forever | Review |
| 17 | `helixes.js` chose its badge colour from `isGreen` instead of `status` | A brand-new helix rendered as a red "closed" badge | Review |
| 18 | `task_matcher`'s priority multiplier was applied uniformly | `priority` looked functional but could never change any ranking | Review |
| 19 | Empty `DAM_NODE_PRIVATE_KEY` treated as set | Confusing crash instead of falling back | Reviewing my own earlier fix |
| 20 | README claimed the working deploy script was a placeholder | Contributors would assume deployment did nothing | Review |
| 21 | Miners chose their own `seedBlock` from a 128-block window | Seed shopping, and a producer could re-roll by withholding a block | Design review |
| 22 | This log quoted a gas figure measured before the fraud registry was wired in | Understated the real cost of a saturated `formHelix` by 27% | Re-running the measurement instead of trusting the note |
| 23 | `setRetargetParams` bounded `targetBlockTime` only at zero | An oversized value overflows `_maybeRetarget`, which runs on every commit — bricking block production, not just misconfiguring it | Reviewing the new retargeting code for owner-triggered failure modes |
| 24 | Two tests assumed an arbitrary nonce would fail the work target (the forgery test, and the proof-transferability test) | At the test difficulty an arbitrary nonce clears it ~1 run in 64, so the suite failed at random | One failed in the full suite while passing in isolation; the second surfaced only after repeated runs |
| 25 | `_maybeRetarget` re-fired within one block, reading zero elapsed time as a maximally fast epoch | Difficulty compounded 4× harder per extra in-block commit on no timing evidence — a griefing lever against other miners | Cloud review, then reproduced with an automine-disabled packed-block test |
| 26 | `mine_and_commit` recognised only chain id 31337 as a dev node, while `chain.py` recognised 31337 and 1337 | On Ganache the miner silently fell back to polling and timed out after 180s | Cloud review |
| 27 | `FraudDetection` counted calls, not reporters, and had no way to undo a report | An automated detector would blacklist any node that stayed anomalous for 3 polling cycles, permanently and irreversibly | Designing the detector-to-chain wiring |
| 28 | A single-reporter deployment could never reach the default blacklist threshold of 3 | With one authorized attester the whole enforcement path was dead code | Same — the fix to #27 made the threshold meaningful and exposed this |
| 29 | Five contracts declared `owner` with no way to transfer it | On a real network the deploying key would be the permanent administrator — no multisig handover, no rotation after a leak — and contracts are immutable, so unfixable after deploy | Planning the public-network deploy path |
| 30 | `FraudDetection`'s constructor auto-authorizes its deployer | With an explicit reporter set configured, the deploying key silently kept the power to blacklist nodes after ownership moved to the admin | Running the public deploy path and asserting every role individually |

---

## The three structural changes

Three fixes were architecture changes rather than patches, and all are worth understanding.

### Per-node attested telemetry

`PoEEnergyMarket` used to compute every node's score from two *shared* oracle feeds, so
the score had no connection to the node it was stored under, and anyone could call the
update for any address. Watching a legitimate node report good numbers and immediately
claiming them was enough to inherit its standing.

It now mirrors the trust model `MLTaskManager` already used: a trusted reporter submits
one specific node's measurements via `reportNodeMetrics`, gated by `onlyReporter`. The
Chainlink dependency disappeared entirely. A node cannot be trusted to grade its own
efficiency, so a third party attests — that is a real trust assumption, stated plainly
rather than hidden behind an oracle that looked decentralized but wasn't.

### On-chain proof verification

`commitBlock` used to accept the tensor's sum and norm as *arguments*. Nothing checked
them against anything, so submitting flattering numbers with a fresh hash collected a full
reward without mining.

The commit now carries the tensor itself, and the contract clears four gates:

1. **Work** — `keccak256(seed, nonce, tensor)` must fall below `hashDifficulty`, where
   `seed = keccak256(blockhash(seedBlock), msg.sender)`. The miner does not choose the
   seed, and it binds the proof to that proposer, so a nonce found by one node is useless
   to another.
2. **Difficulty** — the contract recomputes the element sum and squared Frobenius norm
   from the submitted tensor. Neither is taken on trust.
3. **Efficiency** — PoE score above threshold, mining time within `maxOE`, not blacklisted.
4. **Freshness** — the proof digest is single-use and the seed block must be recent.

Gates 1 and 2 are both necessary, and this is the subtle part: recomputing the metrics
proves the numbers are true of the submitted data, but data with a small sum is trivial to
write down — all zeros would pass. The work gate is what makes producing a qualifying
result cost something. Verification alone would have been security theatre.

Proven live: the Python miner searched 1,315 nonces, submitted the tensor, and the
contract accepted it — which also confirms Python's keccak packing byte-matches Solidity's
`abi.encodePacked`. The old forgery (all-zeros tensor, no work) was then attempted against
the deployed contract and reverted with zero reward.

### Two-phase mining, and difficulty that retargets itself

Verifying the proof left two things still wrong, both of which the previous round wrote
down honestly rather than fixing: the miner picked their own `seedBlock` out of a
128-block window, and difficulty only ever moved when the owner moved it.

The seed problem is the more interesting one. A free `seedBlock` argument means a miner
can shop for a seed, and — worse — a block producer can look at the hash it has just
produced, see whether that seed suits it, and decide whether to publish. That is one free
re-roll per block, forever.

Mining is now two-phase. `openSession()` records who is asking and in which block; the
seed is only then derived, from blocks *after* that:

```
seedStart = openedAt + SEED_DELAY                            (SEED_DELAY = 2)
seed      = keccak256(fold(blockhash(seedStart .. +SEED_SPAN-1)), miner, sessionId)
```

The ordering is the whole fix. The entropy postdates the commitment, so there is nothing
left to select. Folding `SEED_SPAN` (3) consecutive hashes means biasing a seed requires
producing *every* block in the span rather than one. Sessions are single-use and expire,
so proofs cannot be banked.

The obvious objection — just open a thousand sessions and pick the best seed — does not
work, and the reason is worth stating: sessions opened in the same block share the same
block hashes but get different seeds via `sessionId`, so grinding N sessions × M nonces
searches exactly the same uniform space as one session with N×M nonces. It buys gas, not
advantage.

Difficulty now retargets Bitcoin-style: every `retargetInterval` committed blocks, the
contract compares elapsed time against `interval × targetBlockTime` and rescales the work
target by that ratio, clamped to 4× per epoch. The clamp is what bounds the one attack
that remains — `block.timestamp` is proposer-nudgeable, so retargeting can be biased, just
not far. Difficulty is held inside `[MIN_HASH_DIFFICULTY, MAX_HASH_DIFFICULTY]`, the
ceiling being `type(uint256).max / 4` precisely so a 4× move cannot overflow.

Proven live, on a running chain: a session opened in block 23 drew its seed from blocks
25–27, and reading that seed before those blocks existed reverted. Python recomputed the
identical seed from the three folded hashes, and altering either the first or the last
hash in the span changed it. Difficulty then moved from `2.82e73` to `7.07e72` — exactly
the 4× clamp, in the harder direction, because the blocks arrived far faster than the 60s
target — with no setter called; the next block cost 13,022 hashes instead of 1,718.

---

### Fraud detection that can actually drive enforcement

`ai_backend/fraud_detector.py` had produced risk scores since before this work, and nothing
consumed them. Wiring it up naively would have been worse than leaving it disconnected.

`reportFraud` incremented a counter and blacklisted at 3. A detector running on a schedule
re-reports the same node every cycle, so any node that stayed anomalous would have been
blacklisted on the third pass — not because three parties agreed, but because one loop ran
three times — and the count would have grown without bound. There was also no way to undo
a report, and automated detection certainly produces false positives.

So the registry now counts **distinct reporters**, not calls. `blacklistThreshold` becomes
a statement about independent agreement, re-reporting is rejected rather than compounded,
and accusations are retractable by the reporter (`revokeReport`) or the owner
(`clearNode`). Making the threshold meaningful immediately exposed a second problem: this
deployment authorizes exactly one attester, so a threshold of 3 could never be reached and
the entire enforcement path was dead code. The deploy script now sets the threshold to
match the reporter set it actually creates, and says so in its output.

`node_client/fraud_reporter.py` is the bridge. It is a dry run unless given `--submit`,
refuses to score a node with no completed jobs (the detector reads an empty record as a
total completion collapse — an absence of evidence, not a finding), and with
`--revoke-cleared` withdraws accusations against nodes that stopped alerting, so a
scheduled run reconciles in both directions instead of only ratcheting.

Proven live end to end: a node with a 0.998 risk score was attested on chain, its bid was
refused by `DAMAuction` while a healthy node's went through, running the reporter twice
left the score at 1 rather than 2, and retracting the attestation let the same node bid
again on the next block.

---

## How this was verified

The standard throughout: **run it, don't read it**. Every claim above was checked by
executing something.

- **Contracts** — 137 Hardhat tests, including tests that assert *computed values*, not
  just that a call succeeded: exact reward arithmetic, exact efficiency scores, the
  ranking algorithm picking specific nodes, and a measured gas figure.
- **Gas** — a fully saturated 100-bid auction forms a helix in **2,517,223 gas, 4.2% of
  the block limit** (measured in the shipped configuration, with the fraud registry
  wired in), so the bid cap is provably affordable rather than merely present.
- **Attacks** — the score-theft, replay and forgery attacks were each reproduced against
  a live deployed contract and confirmed to fail after the fix, not merely assumed fixed.
- **Python** — exercised against a real chain: efficiency scores matched
  `1e18 / (energy × latency)` exactly, and a reward payout was independently recomputed
  and matched the token balance delta to the wei.
- **Frontend** — `scripts/verify_frontend.mjs` drives the real application end to end,
  connect through finalize, and must finish with zero console errors.

Reading code was not enough, repeatedly: hand-tracing the Solidity missed two bugs a
compiler caught in seconds, and reading the frontend missed a race that driving it
surfaced immediately.

---

## Still open

Deliberate, and none of them are silent — each is documented where it matters.

- **Consensus hardening, what is left of it.** A proposer that produces *every* block in a
  session's seed span can still bias that seed, and `block.timestamp` nudging biases
  retargeting within its 4× clamp. Both need a real randomness beacon to remove, not more
  contract logic.
- **Trusted reporter.** PoE telemetry and completion scores depend on one honest party.
  Removing that needs verifiable proofs, not more plumbing.
- **Fraud attestations are unstaked.** The detector now feeds the registry, but a reporter
  pays nothing for being wrong, so the registry is only as good as the authorized set.
  Staking and slashing would be the next real step.
- **Auction creation is unbounded.** It degrades off-chain enumeration but is not a
  gas DoS — no on-chain function loops over all auctions.
- **Never deployed to a public chain.** The path exists and is exercised end to end
  (preflight, external reward token, separated roles, ownership handover), but against a
  local chain driven through the public-network code path — not against Sepolia itself,
  which needs a funded key.
- **`npm audit`** advisories have never been triaged.
- **Marketing/landing page** was deferred in favour of the functional dashboard.

---

## Running it

```bash
npm install && pip install -r requirements.txt
npx hardhat test                 # 137 tests
npx hardhat node                 # terminal 1
npx hardhat run deployment/deploy_smart_contracts.js --network localhost
python node_client/monitor.py --once      # report this node's PoE metrics
python node_client/mine_and_commit.py     # mine a block and commit the proof
python node_client/fraud_reporter.py telemetry.json   # dry run; --submit to attest
cd frontend && python -m http.server 8080 # dashboard at 127.0.0.1:8080
node scripts/verify_frontend.mjs          # drive the dashboard end to end
```

Note that background processes do not survive between sessions here — every verification
pass started by restarting the chain and redeploying.
