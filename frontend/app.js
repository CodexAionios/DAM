import { BrowserProvider, JsonRpcProvider, Contract } from "./vendor/ethers.min.js";
import { loadContractConfig, buildContracts } from "./components/contractConfig.js";
import { connectWallet } from "./components/wallet.js";
import { fetchAuctions, renderAuctions } from "./components/auctions.js";
import { fetchHelixes, renderHelixes } from "./components/helixes.js";
import { fetchPoeStatus, renderPoeStatus } from "./components/poe.js";

const statusEl = document.getElementById("status");
const accountDisplay = document.getElementById("account-display");
const connectBtn = document.getElementById("connect-btn");
const poeStatusEl = document.getElementById("poe-status");
const auctionsListEl = document.getElementById("auctions-list");
const helixesListEl = document.getElementById("helixes-list");

const state = {
  config: null,
  readContracts: null, // bound to a plain JSON-RPC provider, usable before wallet connect
  writeContracts: null, // bound to the connected signer, set after connect
  signer: null,
  address: null,
};

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`;
}

function describeError(error) {
  return error?.reason || error?.shortMessage || error?.message || String(error);
}

function requireWallet() {
  if (!state.writeContracts) {
    throw new Error("Connect a wallet first.");
  }
  return state.writeContracts;
}

async function withStatus(actionLabel, fn) {
  try {
    setStatus(`${actionLabel}...`);
    await fn();
    await refreshAll();
    setStatus(`${actionLabel}: done.`, "ok");
  } catch (error) {
    console.error(error);
    setStatus(`${actionLabel} failed: ${describeError(error)}`, "error");
  }
}

async function refreshAuctions() {
  const auctions = await fetchAuctions(state.readContracts);
  renderAuctions(auctionsListEl, auctions);
}

async function refreshHelixes() {
  const helixes = await fetchHelixes(state.readContracts);
  renderHelixes(helixesListEl, helixes);
}

async function refreshPoeStatus() {
  if (!state.address) {
    poeStatusEl.textContent = "Connect a wallet to see your on-chain PoE score.";
    return;
  }
  const poeStatus = await fetchPoeStatus(state.readContracts, state.address);
  renderPoeStatus(poeStatusEl, state.address, poeStatus);
}

async function refreshAll() {
  await Promise.all([refreshAuctions(), refreshHelixes(), refreshPoeStatus()]);
}

function wireEvents() {
  connectBtn.addEventListener("click", () => {
    withStatus("Connecting wallet", async () => {
      const { signer, address } = await connectWallet(BrowserProvider);
      state.signer = signer;
      state.address = address;
      state.writeContracts = buildContracts(Contract, state.config, signer);
      accountDisplay.textContent = address;

      // Convenience default: reportNodeMetrics is reporter-gated, so this
      // only actually succeeds when the connected wallet holds the reporter
      // key (the local-dev setup), in which case reporting for yourself is
      // the common case.
      const nodeInput = document.getElementById("report-node-input");
      if (nodeInput && !nodeInput.value) nodeInput.value = address;
    });
  });

  document.getElementById("report-metrics-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    const node = data.get("node");
    withStatus(`Reporting metrics for ${node}`, async () => {
      const contracts = requireWallet();
      await (
        await contracts.poeEnergyMarket.reportNodeMetrics(node, data.get("energy"), data.get("latency"))
      ).wait();
    });
  });

  document.getElementById("create-auction-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    withStatus("Creating auction", async () => {
      const contracts = requireWallet();
      await (
        await contracts.damAuction.createAuction(
          data.get("dataHash"),
          data.get("budget"),
          data.get("timeLimit"),
          data.get("efficiencyReq")
        )
      ).wait();
      form.reset();
    });
  });

  auctionsListEl.addEventListener("submit", (event) => {
    if (!event.target.matches(".bid-form")) return;
    event.preventDefault();
    const auctionId = event.target.dataset.auctionId;
    const data = new FormData(event.target);
    withStatus(`Submitting bid on auction #${auctionId}`, async () => {
      const contracts = requireWallet();
      await (
        await contracts.damAuction.submitBid(
          auctionId,
          data.get("efficiency"),
          data.get("latency"),
          data.get("hashPower"),
          data.get("price")
        )
      ).wait();
    });
  });

  auctionsListEl.addEventListener("click", (event) => {
    if (!event.target.matches(".form-helix-btn")) return;
    const auctionId = event.target.dataset.auctionId;
    withStatus(`Forming helix for auction #${auctionId}`, async () => {
      const contracts = requireWallet();
      await (await contracts.damAuction.formHelix(auctionId)).wait();
    });
  });

  helixesListEl.addEventListener("submit", (event) => {
    if (!event.target.matches(".report-form")) return;
    event.preventDefault();
    const helixId = event.target.dataset.helixId;
    const data = new FormData(event.target);
    withStatus(`Reporting completion for helix #${helixId}`, async () => {
      const contracts = requireWallet();
      await (
        await contracts.mlTaskManager.reportCompletion(helixId, data.get("member"), data.get("score"))
      ).wait();
    });
  });

  helixesListEl.addEventListener("click", (event) => {
    if (!event.target.matches(".finalize-btn")) return;
    const helixId = event.target.dataset.helixId;
    withStatus(`Finalizing helix #${helixId}`, async () => {
      const contracts = requireWallet();
      await (await contracts.mlTaskManager.finalizeHelix(helixId)).wait();
    });
  });
}

async function init() {
  try {
    state.config = await loadContractConfig();
  } catch (error) {
    setStatus(describeError(error), "error");
    return;
  }

  const readProvider = new JsonRpcProvider("http://127.0.0.1:8545");
  state.readContracts = buildContracts(Contract, state.config, readProvider);

  wireEvents();

  try {
    await refreshAll();
    setStatus("Ready. Connect a wallet to submit transactions.");
  } catch (error) {
    console.error(error);
    setStatus(`Failed to load on-chain state: ${describeError(error)}`, "error");
  }
}

init();
