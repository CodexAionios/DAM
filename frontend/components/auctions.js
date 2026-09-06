export async function fetchAuctions(contracts) {
  const count = await contracts.damAuction.auctionCounter();
  const maxBids = await contracts.damAuction.maxBidsPerAuction();

  const auctions = [];
  for (let id = 1n; id <= count; id++) {
    const [task, bids] = await Promise.all([
      contracts.damAuction.dataTasks(id),
      contracts.damAuction.bidCount(id),
    ]);
    auctions.push({
      id,
      dataHash: task.dataHash,
      budget: task.budget,
      timeLimit: task.timeLimit,
      efficiencyReq: task.efficiencyReq,
      isActive: task.isActive,
      provider: task.provider,
      bidCount: bids,
      maxBids,
    });
  }
  return auctions;
}

export function renderAuctions(container, auctions) {
  if (auctions.length === 0) {
    container.innerHTML = "<p class=\"empty\">No auctions yet. Create one above.</p>";
    return;
  }

  container.innerHTML = auctions
    .map(
      (auction) => `
    <article class="card" data-auction-id="${auction.id}">
      <header>
        <strong>Auction #${auction.id}</strong>
        <span class="badge ${auction.isActive ? "badge-active" : "badge-closed"}">
          ${auction.isActive ? "active" : "closed"}
        </span>
      </header>
      <dl>
        <dt>Data hash</dt><dd>${auction.dataHash}</dd>
        <dt>Budget</dt><dd>${auction.budget}</dd>
        <dt>Time limit</dt><dd>${auction.timeLimit}</dd>
        <dt>Min. efficiency</dt><dd>${auction.efficiencyReq}</dd>
        <dt>Bids</dt><dd>${auction.bidCount} / ${auction.maxBids}</dd>
        <dt>Provider</dt><dd class="mono">${auction.provider}</dd>
      </dl>
      ${
        auction.isActive
          ? `
      <form class="bid-form" data-auction-id="${auction.id}">
        <input name="efficiency" type="number" min="0" placeholder="Efficiency" required />
        <input name="latency" type="number" min="0" placeholder="Latency" required />
        <input name="hashPower" type="number" min="0" placeholder="Hash power" required />
        <input name="price" type="number" min="0" placeholder="Price" required />
        <button type="submit">Submit bid</button>
      </form>
      <button class="form-helix-btn" data-auction-id="${auction.id}">Form helix (owner only)</button>
      `
          : ""
      }
    </article>`
    )
    .join("");
}
