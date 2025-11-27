const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with", deployer.address);

  // ethers v6 uses top-level parseUnits
  const initial = hre.ethers.parseUnits("1000000", 18);

  // Deploy TestToken
  const TestToken = await hre.ethers.getContractFactory("TestToken");
  const token = await TestToken.deploy(initial);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log("TestToken deployed:", tokenAddress);

  // Deploy LockContract
  const LockContract = await hre.ethers.getContractFactory("LockContract");
  const lock = await LockContract.deploy(tokenAddress);
  await lock.waitForDeployment();
  const lockAddress = await lock.getAddress();
  console.log("LockContract deployed:", lockAddress);

  console.log("\nEXPORTS (paste into .env):");
  console.log(`TOKEN_ADDRESS=${tokenAddress}`);
  console.log(`LOCK_ADDRESS=${lockAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
