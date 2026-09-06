async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to load ${url} (${response.status} ${response.statusText}). ` +
        "Did you run `npx hardhat run deployment/deploy_smart_contracts.js --network localhost`?"
    );
  }
  return response.json();
}

export async function loadContractConfig() {
  const [addresses, DAMAuction, MLTaskManager, PoEEnergyMarket] = await Promise.all([
    fetchJson("./contracts/addresses.json"),
    fetchJson("./contracts/abi/DAMAuction.json"),
    fetchJson("./contracts/abi/MLTaskManager.json"),
    fetchJson("./contracts/abi/PoEEnergyMarket.json"),
  ]);
  return { addresses, abis: { DAMAuction, MLTaskManager, PoEEnergyMarket } };
}

export function buildContracts(Contract, config, runner) {
  const { addresses, abis } = config;
  return {
    damAuction: new Contract(addresses.contracts.DAMAuction, abis.DAMAuction, runner),
    mlTaskManager: new Contract(addresses.contracts.MLTaskManager, abis.MLTaskManager, runner),
    poeEnergyMarket: new Contract(addresses.contracts.PoEEnergyMarket, abis.PoEEnergyMarket, runner),
  };
}
