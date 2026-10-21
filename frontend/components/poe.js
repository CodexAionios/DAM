// Scores are hashes per joule in 1e18 fixed point (see PoEEnergyMarket).
const SCALE = 10n ** 18n;

/** Format a 1e18-scaled bigint as a decimal with two places. */
export function formatEfficiency(scaled) {
  const value = BigInt(scaled);
  const whole = value / SCALE;
  const cents = (value % SCALE) / 10n ** 16n;
  return `${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

export async function fetchPoeStatus(contracts, address) {
  const [score, threshold, attested] = await Promise.all([
    contracts.poeEnergyMarket.efficiencyScores(address),
    contracts.poeEnergyMarket.efficiencyThreshold(),
    contracts.poeEnergyMarket.attestedEnergy(address),
  ]);
  return { score, threshold, attested };
}

export function renderPoeStatus(container, address, status) {
  const committed = status.score > 0n;
  container.innerHTML = `
    <dl>
      <dt>Account</dt><dd class="mono">${address}</dd>
      <dt>Efficiency (last block)</dt><dd>${
        committed ? `${formatEfficiency(status.score)} hashes/J` : "none yet - no committed block"
      }</dd>
      <dt>Efficiency floor</dt><dd>${formatEfficiency(status.threshold)} hashes/J</dd>
      <dt>Energy attested for next block</dt><dd>${
        status.attested > 0n ? `${status.attested} mJ` : "none pending"
      }</dd>
      <dt>Meets floor?</dt><dd>${committed && status.score >= status.threshold ? "yes" : "no"}</dd>
    </dl>
  `;
}
