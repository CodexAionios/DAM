# DAM — Decentralized AI Marketplace

> **Status: closed (October 2026).** This repository is kept as a reference
> implementation and a case study. It is complete in the sense that matters: everything
> in it runs, is tested, and says honestly what it does not do. It is not being developed
> further, and this README explains why.

DAM set out to turn idle gaming hardware into a marketplace for AI compute, with nodes
ranked and rewarded by energy efficiency. What exists is a working, tested implementation
of one part of that — mining blocks that are verified on chain and rewarded by **verified
work per joule** — plus a marketplace layer (auctions, node clusters) that runs end to end
but has no work to sell. The project closed because the part that works has no customer,
and the part that would have customers needs hardware supply and verifiable energy
measurement that a smart contract cannot provide.

---

## What DAM set out to do

The 2024–25 design documents described:

- **AI task auctions.** Data providers auction ML jobs; nodes bid on computing power,
  latency and a *Proof of Efficiency* score.
- **Proof of Efficiency (PoE).** Nodes ranked by "energy consumption per operation", so the
  most efficient hardware wins work and earns more.
- **Helixes.** Instead of one winner, the top six bidders form a cluster that splits the
  job, modelled on party systems in cooperative online games.
- **Tensor evolution mining.** A "smarter proof of work" that evolves a tensor by gradient
  descent toward a target, instead of brute-forcing hashes.
- **A token** paying node operators, especially owners of consumer GPUs and consoles.

## What was built

| Component | What it does | Evidence |
| --- | --- | --- |
| `PoEConsensus.sol` | Two-phase mining: a miner claims a session, and its seed is drawn from blocks that did not exist yet. Commits are verified on chain — keccak proof of work, recomputed tensor metrics, single-use sessions — and difficulty retargets itself | 47 tests, including the forgery and replay attacks that used to work |
| `PoEEnergyMarket.sol` | Scores each block as **expected hashes / attested joules**. The work is derived on chain from the target the proof cleared; only the energy is attested | Tests encode the bug it replaced (below) |
| `PoEGreenNode.sol` | Pays base reward × (1 + efficiency relative to a reference), capped at 2× | Exact reward arithmetic, cap enforced twice |
| `DAMAuction.sol` + `MLTaskManager.sol` | Auctions with bid caps, helix formation by a 40/30/30 ranking, completion reporting, "green" finalization | Saturated 100-bid auction measured at 4.2% of the block gas limit |
| `FraudDetection.sol` | Blacklist by *distinct* reporters, retractable, enforced at bidding, helix selection and commit | Fed by `node_client/fraud_reporter.py`, proven live |
| `Ownable2Step.sol` | Two-step ownership for every administered contract, so a deploy can hand control to a multisig | Every contract's handover tested |
| `node_client/` | web3.py client: energy measurement (RAPL, or a declared wattage labelled as an estimate — never a proxy), mining and commit, auctions, fraud reporting | Live runs against a chain; the client checks the on-chain score against its own computation |
| `frontend/` | Plain HTML/JS dashboard, no build step | Driven end to end by `scripts/verify_frontend.mjs` with real transactions |

**161 contract tests and 13 Python tests pass**, three runs in a row with no flakes. The
score-theft, replay and forgery attacks recorded in
[`docs/engineering_log.md`](docs/engineering_log.md) were each reproduced against a live
deployment and shown to fail after their fixes; the idle-node bug was reproduced against
the original contracts before they were changed. A public-network deploy path
(Sepolia, Base Sepolia, any EVM chain) exists with preflight checks and separated roles; it
has been exercised through that code path against a local node, never against a public
chain.

---

## What the engineering found

Each of these was established by running something, not by argument. Details and
reproductions are in the engineering log.

**1. Tensor evolution mining does no work.** Shrinking a tensor until its sum and norm fall
under a target is trivially easy — an all-zeros tensor passes any target. Once the contract
recomputed the metrics instead of trusting them, the only way to make a block cost anything
was to bind the tensor to an unpredictable seed and require a keccak hash below a target:
ordinary proof of work. The "smarter" part of the design turned out to be the part that
contributes nothing; the cost comes entirely from the conventional part.

**2. Trust never disappeared; it moved.** Every efficiency input started out forgeable: the
score was read from a shared oracle anyone could claim, the tensor metrics were
caller-supplied, one proof could be replayed into five blocks. Each fix closed a hole by
moving trust to a named party — a reporter who attests, a seed nobody chooses. That is the
honest outcome, but it means the system is only as decentralized as its reporter.

**3. The efficiency metric rewarded idleness.** The score was `1e18 / (energy × latency)`,
and the node client reported CPU utilisation as "energy". A machine doing nothing reported
the least energy and scored highest: in a reproduction against the original contracts, an
idle node earned **13.33** tokens per block and a node at full load **10.03**. Several
rounds of hardening had secured *who* could report the inputs without anyone asking what
the formula rewarded. Fixed at closure: efficiency is now verified hashes per attested joule — what the
original design asked for — and an idle node scores nothing because it has committed no
work. The numerator is trustless; only the denominator is attested.

**4. On a rollup, the mining secures nothing.** Deployed to Base or any L2, consensus is the
L2's. `PoEConsensus` blocks are records inside a contract, not blocks of a chain, and the
proof of work in front of them is a rate limit on token emission, not security.

**5. The marketplace has nothing to sell.** An auction carries a `dataHash`, but nothing
distributes data, runs a model, returns a result, or verifies one. The `budget` field is
never escrowed or paid. The helix machinery forms, scores and finalizes clusters correctly
around a job that does not exist.

## Why it stopped

- **The working part has no customer.** Green-mining rewards pay out a token that nobody
  needs to buy. Without demand from outside the system, emissions are a subsidy for empty
  infrastructure.
- **The part that would have customers is an existing, occupied market.** Paying owners of
  idle consumer GPUs for compute is [Salad's](https://salad.com/about) business since 2018,
  and decentralized GPU networks with paying customers already exist (Akash, io.net,
  Render). Entering needs a supply of hardware and a source of demand. The project had
  neither — only designs.
- **Remote energy cannot be verified.** The score's denominator is a reading taken on the
  machine being scored. Among operators who own their hardware that is ordinary accounting.
  In an open network, an operator who under-reports joules earns more than one who reports
  honestly, and no contract logic can fix that.

The alternative was to keep expanding the design. The decision was to finish instead: fix
the one known defect at the centre of the code, document everything, and stop.

## What survives

- **The code, as a reference.** Two-phase seeding against grinding, bounded retargeting,
  two-step ownership, a distinct-reporter fraud registry, and an energy meter that refuses
  to guess are reusable patterns, each with the reasoning and tests behind it.
- **The instinct about the metric.** Performance per watt was the right thing to care
  about, and it matters more now than when DAM started: in September 2026 the European
  Commission
  [proposed an energy rating scheme for data centres](https://commission.europa.eu/news-and-media/news/making-data-centres-energy-efficient-thanks-new-eu-rating-system-2026-09-21_es)
  above 500 kW, with first labels expected in 2027. But that is a measurement problem, not
  a token problem. DAM's mistake was trying to capture it with a token.

## Lessons

- **Run it, don't read it.** Hand-tracing missed bugs that a compiler, a test or a live
  deployment caught in seconds, every time.
- **Ask what a metric rewards, not only who may report it.** The efficiency score's inputs
  were hardened repeatedly before anyone checked that it rewarded the opposite of its name.
- **A claim is not a property until it has been executed.** The design documents asserted
  that tensor evolution made proof of work smarter. Executing it showed the cost came
  entirely from the conventional part.
- **Decide who the user is before choosing the MVP.** The first pivot picked the circuit
  that already worked, without asking who wanted it. That question, asked first, would have
  reached this conclusion sooner.

---

## Running it

Requires Node.js and Python 3.

```bash
npm install
pip install -r requirements.txt

npx hardhat test                              # 161 contract tests
python -m unittest discover -s tests/python   # 13 energy-measurement tests

npx hardhat node                              # terminal 1: local chain
npx hardhat run deployment/deploy_smart_contracts.js --network localhost

python node_client/monitor.py                 # can this machine measure energy?
python node_client/mine_and_commit.py         # mine, attest energy, commit, verify the score
python node_client/client.py                  # efficiency, auctions, helixes
```

Energy comes from RAPL counters (`/sys/class/powercap`, Linux; root-only since kernel
5.10). Without them both scripts stop and ask for `--assume-watts W`; readings are then
labelled as estimates everywhere they are printed.

The dashboard: `cd frontend && python -m http.server 8080`, then open
`http://127.0.0.1:8080` with a wallet on chain id 31337. To drive it end to end
automatically, keep the server running and run `node scripts/verify_frontend.mjs`.

For a public network, copy `.env.example` to `.env`, fill it in, and deploy with
`--network baseSepolia` (or `sepolia`, or `custom`). The script validates configuration
and balances before sending anything, and hands ownership to `ADMIN_ADDRESS` in two steps.

## Repository map

```plaintext
contracts/            Solidity: consensus, efficiency market, rewards, auctions, fraud, ownership
node_client/          Python node: energy.py, mine_and_commit.py, monitor.py, client.py, fraud_reporter.py
ai_backend/           tensor_miner.py, fraud_detector.py, helix_manager.py (off-chain twin of formHelix)
frontend/             Dashboard, no build step; contract addresses and ABIs written by the deploy
deployment/           Deploy script (local and public), docker-compose
scripts/              verify_frontend.mjs, the dashboard's end-to-end harness
tests/                Hardhat suites; tests/python for the energy meter
docs/                 engineering_log.md (start here), api_documentation.md, whitepaper.md
```

[`docs/engineering_log.md`](docs/engineering_log.md) records every bug found, how each was
proven, and what remains open. [`docs/api_documentation.md`](docs/api_documentation.md)
documents every contract function with its access control and caveats.

## License

MIT.
