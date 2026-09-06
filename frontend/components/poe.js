export async function fetchPoeStatus(contracts, address) {
  const [score, threshold] = await Promise.all([
    contracts.poeEnergyMarket.efficiencyScores(address),
    contracts.poeEnergyMarket.efficiencyThreshold(),
  ]);
  return { score, threshold };
}

export function renderPoeStatus(container, address, status) {
  container.innerHTML = `
    <dl>
      <dt>Account</dt><dd class="mono">${address}</dd>
      <dt>On-chain PoE score</dt><dd>${status.score}</dd>
      <dt>Efficiency threshold</dt><dd>${status.threshold}</dd>
      <dt>Meets threshold?</dt><dd>${status.score >= status.threshold ? "yes" : "no"}</dd>
    </dl>
  `;
}
