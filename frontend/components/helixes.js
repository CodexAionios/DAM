const STATUS_NAMES = ["Unknown", "Registered", "Finalized"];

function badgeClassFor(helix) {
  // Unknown/Registered are in-progress states, not "closed" - only a
  // Finalized helix's badge color should reflect isGreen (which defaults to
  // false until finalizeHelix runs, so using it for earlier states always
  // rendered a misleading red "closed" badge on a brand-new helix).
  if (helix.status !== 2) return "badge-active";
  return helix.isGreen ? "badge-active" : "badge-closed";
}

export async function fetchHelixes(contracts) {
  const count = await contracts.damAuction.helixCounter();
  const helixes = [];
  for (let id = 1n; id <= count; id++) {
    const [members, summary] = await Promise.all([
      contracts.damAuction.getHelixMembers(id),
      contracts.mlTaskManager.getHelixSummary(id),
    ]);
    helixes.push({
      id,
      members,
      auctionId: summary.auctionId,
      taskId: summary.taskId,
      poeGoal: summary.poeGoal,
      status: Number(summary.status),
      combinedScore: summary.combinedScore,
      isGreen: summary.isGreen,
    });
  }
  return helixes;
}

export function renderHelixes(container, helixes) {
  if (helixes.length === 0) {
    container.innerHTML = "<p class=\"empty\">No helixes formed yet.</p>";
    return;
  }

  container.innerHTML = helixes
    .map(
      (helix) => `
    <article class="card" data-helix-id="${helix.id}">
      <header>
        <strong>Helix #${helix.id}</strong>
        <span class="badge ${badgeClassFor(helix)}">
          ${STATUS_NAMES[helix.status]}${helix.status === 2 ? (helix.isGreen ? " - green" : " - not green") : ""}
        </span>
      </header>
      <dl>
        <dt>Auction</dt><dd>#${helix.auctionId}</dd>
        <dt>PoE goal</dt><dd>${helix.poeGoal}</dd>
        <dt>Combined score</dt><dd>${helix.combinedScore}</dd>
        <dt>Members</dt>
        <dd class="mono">${helix.members.map((m) => `<div>${m}</div>`).join("")}</dd>
      </dl>
      ${
        helix.status === 1
          ? `
      <form class="report-form" data-helix-id="${helix.id}">
        <select name="member">
          ${helix.members.map((m) => `<option value="${m}">${m}</option>`).join("")}
        </select>
        <input name="score" type="number" min="0" placeholder="Score" required />
        <button type="submit">Report completion (reporter only)</button>
      </form>
      <button class="finalize-btn" data-helix-id="${helix.id}">Finalize helix</button>
      `
          : ""
      }
    </article>`
    )
    .join("");
}
