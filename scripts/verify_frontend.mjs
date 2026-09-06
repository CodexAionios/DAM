// Throwaway verification harness (not part of the shipped app). jsdom does
// not execute <script type="module"> (a known jsdom limitation), so instead
// we use jsdom purely for the DOM/document, and load the real app.js through
// Node's own ES module loader - wiring `document`/`window`/`fetch` as
// globals first, exactly as a browser would provide them.
import { JSDOM } from "jsdom";
import { Wallet, JsonRpcProvider } from "ethers";

const HARDHAT_ACCOUNT0_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FRONTEND_ORIGIN = "http://127.0.0.1:8080";

class MockInjectedProvider {
  constructor(rpcProvider, wallet) {
    this.rpcProvider = rpcProvider;
    this.wallet = wallet;
  }

  async request({ method, params }) {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [this.wallet.address];
      case "eth_sendTransaction": {
        const txRequest = { ...params[0] };
        if (txRequest.gas && !txRequest.gasLimit) {
          txRequest.gasLimit = txRequest.gas;
          delete txRequest.gas;
        }
        const txResponse = await this.wallet.sendTransaction(txRequest);
        await txResponse.wait();
        return txResponse.hash;
      }
      default:
        return this.rpcProvider.send(method, params ?? []);
    }
  }

  on() {}
  removeListener() {}
}

async function waitFor(predicate, { timeout = 20000, interval = 150, label = "condition" } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

async function main() {
  const rpcProvider = new JsonRpcProvider("http://127.0.0.1:8545");
  const wallet = new Wallet(HARDHAT_ACCOUNT0_KEY, rpcProvider);

  const htmlResponse = await fetch(`${FRONTEND_ORIGIN}/index.html`);
  const html = await htmlResponse.text();
  const dom = new JSDOM(html, { url: `${FRONTEND_ORIGIN}/index.html`, pretendToBeVisual: true });

  // Wire browser-shaped globals for app.js (and its imports) to use.
  global.window = dom.window;
  global.document = dom.window.document;
  global.FormData = dom.window.FormData;
  const nativeFetch = fetch;
  global.fetch = (url, opts) => nativeFetch(new URL(url, `${FRONTEND_ORIGIN}/`), opts);
  dom.window.ethereum = new MockInjectedProvider(rpcProvider, wallet);

  const doc = () => dom.window.document;
  const statusText = () => doc().getElementById("status")?.textContent ?? "";

  const runStep = async (label, action, { doneText = "done.", timeout = 20000 } = {}) => {
    console.log(`--- ${label} ---`);
    await action();
    await waitFor(
      async () => {
        const text = statusText();
        if (text.includes("failed")) throw new Error(`Status reported failure: "${text}"`);
        return text.includes(doneText);
      },
      { label: `${label} -> status containing "${doneText}"`, timeout }
    );
    console.log(`status: ${statusText()}`);
  };

  // Load the real, unmodified app.js via Node's own ESM loader. It calls
  // init() itself at import time (top-level `init();` at the bottom of the file).
  await import("../frontend/app.js");

  // Watch for app-level console.error calls. Node's own module-loader
  // warning (MODULE_TYPELESS_PACKAGE_JSON) is emitted lazily and isn't
  // reliably timed relative to the import() above, so it's filtered by
  // content below rather than by when the watcher starts.
  const consoleErrors = [];
  const originalConsoleError = console.error.bind(console);
  console.error = (...args) => {
    const text = args.map(String).join(" ");
    if (!text.includes("MODULE_TYPELESS_PACKAGE_JSON")) {
      consoleErrors.push(text);
    }
    originalConsoleError(...args);
  };

  try {
    await waitFor(() => statusText().includes("Ready"), { label: "initial page load", timeout: 8000 });
  } catch (error) {
    console.error(`DEBUG statusText: "${statusText()}"`);
    console.error(`DEBUG consoleErrors: ${JSON.stringify(consoleErrors, null, 2)}`);
    throw error;
  }
  console.log(`Initial status: ${statusText()}`);

  await runStep("Connect wallet", () => {
    doc().getElementById("connect-btn").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  });

  const accountDisplay = doc().getElementById("account-display").textContent;
  if (accountDisplay.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`account-display shows "${accountDisplay}", expected ${wallet.address}`);
  }

  await runStep("Report node metrics (energy=10, latency=1)", () => {
    const form = doc().getElementById("report-metrics-form");
    // The connect-wallet step should have pre-filled this with the connected
    // address; assert that rather than overwriting it, so this also proves
    // the pre-fill behavior works.
    if (form.querySelector("[name=node]").value.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error("report-metrics-form's node field was not pre-filled with the connected address");
    }
    form.querySelector("[name=energy]").value = "10";
    form.querySelector("[name=latency]").value = "1";
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });

  const poeStatusHtml = doc().getElementById("poe-status").innerHTML;
  if (!poeStatusHtml.includes(wallet.address)) {
    throw new Error(`poe-status does not show the connected account: ${poeStatusHtml}`);
  }
  console.log(`PoE status panel: ${doc().getElementById("poe-status").textContent.replace(/\s+/g, " ")}`);

  await runStep("Create auction (efficiencyReq=1000)", () => {
    const form = doc().getElementById("create-auction-form");
    form.querySelector("[name=dataHash]").value = "12345";
    form.querySelector("[name=budget]").value = "1000";
    form.querySelector("[name=timeLimit]").value = "500";
    form.querySelector("[name=efficiencyReq]").value = "1000";
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });

  const auctionCard = doc().querySelector('[data-auction-id="1"]');
  if (!auctionCard) throw new Error("Auction #1 card did not render after creation");
  console.log("Auction #1 card rendered.");

  await runStep("Submit bid on auction #1", () => {
    const form = doc().querySelector('.bid-form[data-auction-id="1"]');
    form.querySelector("[name=efficiency]").value = "1000";
    form.querySelector("[name=latency]").value = "50";
    form.querySelector("[name=hashPower]").value = "100";
    form.querySelector("[name=price]").value = "5";
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });

  const bidCountText = doc().querySelector('[data-auction-id="1"]').textContent.replace(/\s+/g, " ");
  if (!bidCountText.includes("1 / 100")) {
    throw new Error(`Auction #1 card does not show the expected bid count "1 / 100": ${bidCountText}`);
  }
  console.log("Auction #1 shows bid count 1 / 100 (per-auction cap surfaced in the UI).");

  await runStep("Form helix for auction #1", () => {
    doc().querySelector('.form-helix-btn[data-auction-id="1"]').dispatchEvent(
      new dom.window.Event("click", { bubbles: true })
    );
  });

  const helixCard = doc().querySelector('[data-helix-id="1"]');
  if (!helixCard) throw new Error("Helix #1 card did not render after formHelix");
  const helixMembersText = helixCard.textContent;
  if (!helixMembersText.toLowerCase().includes(wallet.address.toLowerCase())) {
    throw new Error(`Helix #1 card does not list the bidder as a member: ${helixMembersText}`);
  }
  console.log("Helix #1 card rendered with the bidder as a member.");

  await runStep(`Report completion for helix #1 (score=1500)`, () => {
    const form = doc().querySelector('.report-form[data-helix-id="1"]');
    form.querySelector("[name=member]").value = wallet.address;
    form.querySelector("[name=score]").value = "1500";
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });

  await runStep("Finalize helix #1", () => {
    doc().querySelector('.finalize-btn[data-helix-id="1"]').dispatchEvent(
      new dom.window.Event("click", { bubbles: true })
    );
  });

  const finalizedCard = doc().querySelector('[data-helix-id="1"]').textContent.replace(/\s+/g, " ");
  console.log(`Final helix #1 card text: ${finalizedCard}`);
  if (!finalizedCard.includes("Finalized")) throw new Error("Helix #1 was not marked Finalized in the UI");
  if (!finalizedCard.includes("green")) throw new Error("Helix #1 was not marked green (expected 1500 >= 1000 goal)");

  if (consoleErrors.length > 0) {
    throw new Error(`console.error was called during the run:\n${consoleErrors.join("\n")}`);
  }

  console.log("\nALL FRONTEND CHECKS PASSED.");
}

main().catch((error) => {
  fail(error.stack || error.message);
});
