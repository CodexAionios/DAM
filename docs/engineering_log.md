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
| Tests | **87 passing** Hardhat tests (from 0 real ones) |
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
  on trust (below), with owner-settable difficulty and fraud enforcement.
- **`PoEGreenNode.sol`** — gained `transferOwnership`, without which `PoEConsensus` could
  never have become its authorized caller, and a checked token transfer.
- **`FraudDetection.sol`** — unchanged, but now actually consulted by two contracts.

### Node client

`chain.py` (shared web3.py access layer, reading the same deployment artifacts the
frontend uses), `monitor.py` (psutil energy proxy + real RPC latency, reported on chain),
`client.py` (auctions, bids, helix membership — rewritten off the imaginary REST API),
and `mine_and_commit.py` (mines a tensor, searches for a proof nonce, commits it).

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

---

## The two structural changes

Two fixes were architecture changes rather than patches, and both are worth understanding.

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

---

## How this was verified

The standard throughout: **run it, don't read it**. Every claim above was checked by
executing something.

- **Contracts** — 87 Hardhat tests, including tests that assert *computed values*, not
  just that a call succeeded: exact reward arithmetic, exact efficiency scores, the
  ranking algorithm picking specific nodes, and a measured gas figure.
- **Gas** — a fully saturated 100-bid auction forms a helix in **1,984,465 gas, 3.3% of
  the block limit**, so the bid cap is provably affordable rather than merely present.
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

- **Consensus hardening.** `seed` derives from `blockhash`, which a real network's block
  producer can influence at the margin. Difficulty is owner-set, not retargeted.
- **Trusted reporter.** PoE telemetry and completion scores depend on one honest party.
  Removing that needs verifiable proofs, not more plumbing.
- **Fraud reporting is manual.** `ai_backend/fraud_detector.py` produces risk scores;
  nothing feeds them to `FraudDetection.reportFraud`.
- **Auction creation is unbounded.** It degrades off-chain enumeration but is not a
  gas DoS — no on-chain function loops over all auctions.
- **No testnet path.** Everything is local-Hardhat only: real oracle feeds, a real reward
  token and network config are all unaddressed.
- **`npm audit`** advisories have never been triaged.
- **Marketing/landing page** was deferred in favour of the functional dashboard.

---

## Running it

```bash
npm install && pip install -r requirements.txt
npx hardhat test                 # 87 tests
npx hardhat node                 # terminal 1
npx hardhat run deployment/deploy_smart_contracts.js --network localhost
python node_client/monitor.py --once      # report this node's PoE metrics
python node_client/mine_and_commit.py     # mine a block and commit the proof
cd frontend && python -m http.server 8080 # dashboard at 127.0.0.1:8080
node scripts/verify_frontend.mjs          # drive the dashboard end to end
```

Note that background processes do not survive between sessions here — every verification
pass started by restarting the chain and redeploying.
