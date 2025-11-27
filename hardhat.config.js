require("dotenv").config();
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");


module.exports = {
solidity: "0.8.20",
networks: {
fuji: {
url: process.env.AVAX_RPC || "https://api.avax-test.network/ext/bc/C/rpc",
chainId: 43113,
accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []
}
}
};