require("@nomicfoundation/hardhat-toolbox");

const fs = require("fs");
const path = require("path");

// Minimal .env loader. A dependency would do this too, but the project keeps
// zero production dependencies and vendors its frontend libraries, so a few
// lines here beat adding a package for `KEY=value`. Real environment variables
// always win, so CI can set them without a file present.
function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

// Signing key for public networks. Absent, the public networks simply have no
// accounts, which fails with a clear Hardhat error rather than silently using
// something unexpected - and local development never needs it, because the
// Hardhat node supplies its own funded accounts.
function deployerAccounts() {
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) return [];

  const normalized = key.startsWith("0x") ? key : `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(
      "DEPLOYER_PRIVATE_KEY is set but is not a 32-byte hex key. Expected 64 hex " +
        "characters, optionally 0x-prefixed. (Value not echoed - check your .env.)"
    );
  }
  return [normalized];
}

const accounts = deployerAccounts();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // DAMAuction.formHelix() has enough local variables to hit Solidity's
      // legacy "stack too deep" limit; the IR pipeline avoids that.
      viaIR: true,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./tests",
    scripts: "./deployment",
  },
  networks: {
    localhost: {
      url: process.env.DAM_RPC_URL || "http://127.0.0.1:8545",
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      chainId: 11155111,
      accounts,
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "",
      chainId: 84532,
      accounts,
    },
    // Escape hatch for any other EVM chain without editing this file.
    // Set CUSTOM_RPC_URL and CUSTOM_CHAIN_ID, then `--network custom`.
    custom: {
      url: process.env.CUSTOM_RPC_URL || "",
      chainId: process.env.CUSTOM_CHAIN_ID ? Number(process.env.CUSTOM_CHAIN_ID) : undefined,
      accounts,
    },
  },
};
