require("@nomicfoundation/hardhat-toolbox");

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
      url: "http://127.0.0.1:8545",
    },
  },
};
