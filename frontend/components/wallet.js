export async function connectWallet(BrowserProvider) {
  if (!window.ethereum) {
    throw new Error(
      "No injected wallet found. Install MetaMask (or a compatible wallet) and point it at the " +
        "Hardhat localhost network (chainId 31337, RPC http://127.0.0.1:8545)."
    );
  }
  const provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  const net = await provider.getNetwork();
  return { provider, signer, address, chainId: net.chainId.toString() };
}
