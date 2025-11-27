/**
 * setup.js
 * One-time environment initializer for AVAX → Algorand MVP Bridge
 *
 * - Deploys ERC20 + LockContract if TOKEN_ADDRESS / LOCK_ADDRESS empty
 * - Creates Algorand ASA if ASA_ID empty
 * - Updates .env WITHOUT overwriting existing values
 * - Prints next steps (run relayer + perform swap)
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const algosdk = require("algosdk");

// ------------------------------
// Load .env content into memory
// ------------------------------
const envPath = path.join(__dirname, "..", ".env");
let env = fs.readFileSync(envPath, "utf8");

function getEnvVar(key) {
  const match = env.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

function updateEnvVar(key, value) {
  if (getEnvVar(key)) return; // skip if already exists
  env += `\n${key}=${value}`;
}

// ------------------------------
// ENV values
// ------------------------------
const {
  AVAX_RPC,
  PRIVATE_KEY,
  ALGO_RELAYER_MNEMONIC,
  ALGOD_SERVER,
  ALGOD_TOKEN
} = process.env;

let TOKEN_ADDRESS = getEnvVar("TOKEN_ADDRESS");
let LOCK_ADDRESS = getEnvVar("LOCK_ADDRESS");
let ASA_ID = getEnvVar("ASA_ID");

// validations
if (!AVAX_RPC || !PRIVATE_KEY) {
  console.error("❌ Missing AVAX_RPC or PRIVATE_KEY in .env");
  process.exit(1);
}
if (!ALGO_RELAYER_MNEMONIC) {
  console.error("❌ Missing ALGO_RELAYER_MNEMONIC in .env");
  process.exit(1);
}
if (!ALGOD_SERVER) {
  console.error("❌ Missing ALGOD_SERVER in .env");
  process.exit(1);
}

// ------------------------------
// Deploy EVM contracts (AVAX)
// ------------------------------
async function deployEVMContracts() {
  console.log("\n🔵 Checking EVM contract deployment...");

  if (TOKEN_ADDRESS && LOCK_ADDRESS) {
    console.log("✔ AVAX contracts already deployed.");
    return;
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  console.log("🚀 Deploying TestToken...");
  const TestToken = await ethers.getContractFactory("TestToken");
  const token = await TestToken.deploy(
    ethers.parseUnits("1000000", 18)
  );
  await token.waitForDeployment();
  TOKEN_ADDRESS = await token.getAddress();
  console.log("   ✔ TestToken:", TOKEN_ADDRESS);

  console.log("🚀 Deploying LockContract...");
  const LockContract = await ethers.getContractFactory("LockContract");
  const lock = await LockContract.deploy(TOKEN_ADDRESS);
  await lock.waitForDeployment();
  LOCK_ADDRESS = await lock.getAddress();
  console.log("   ✔ LockContract:", LOCK_ADDRESS);

  // update env
  updateEnvVar("TOKEN_ADDRESS", TOKEN_ADDRESS);
  updateEnvVar("LOCK_ADDRESS", LOCK_ADDRESS);
}

// ------------------------------
// Create Algorand ASA
// ------------------------------
async function createASA() {
  console.log("\n🟣 Checking Algorand ASA creation...");

  if (ASA_ID) {
    console.log("✔ ASA already created.");
    return;
  }

  const algodClient = new algosdk.Algodv2(
    ALGOD_TOKEN || "",
    ALGOD_SERVER,
    ""
  );
  const acct = algosdk.mnemonicToSecretKey(ALGO_RELAYER_MNEMONIC);

  console.log("Creator:", acct.addr);

  const params = await algodClient.getTransactionParams().do();

  console.log("🚀 Creating ASA...");
  const txn = algosdk.makeAssetCreateTxnWithSuggestedParams(
    acct.addr,
    undefined,
    1000000,   // total supply
    0,         // decimals
    false,
    "TTALGO",
    "Test ASA for EVM bridge",
    "",
    undefined,
    acct.addr,
    acct.addr,
    acct.addr,
    acct.addr,
    params
  );

  const signed = txn.signTxn(acct.sk);
  const { txId } = await algodClient.sendRawTransaction(signed).do();
  console.log("   ⏳ ASA creation txId:", txId);

  // wait confirm
  let p = await algodClient.pendingTransactionInformation(txId).do();
  while (!p["confirmed-round"]) {
    await new Promise((r) => setTimeout(r, 1000));
    p = await algodClient
      .pendingTransactionInformation(txId)
      .do();
  }

  ASA_ID = p["asset-index"];
  console.log("   ✔ ASA Created:", ASA_ID);

  updateEnvVar("ASA_ID", ASA_ID);
}

// ------------------------------
// Save updated .env
// ------------------------------
function saveEnv() {
  fs.writeFileSync(envPath, env, "utf8");
  console.log("\n📄 .env updated successfully.");
}

// ------------------------------
// MAIN EXECUTION
// ------------------------------
(async () => {
  console.log("========== XYTHUM MVP SETUP ==========\n");

  await deployEVMContracts();
  await createASA();
  saveEnv();

  console.log("\n🎉 Setup complete!");

  console.log(`
Next Steps:

1️⃣ Open a new terminal:
   npm run relayer
   (keeps listening for AVAX → Algorand bridge events)

2️⃣ In your AVAX wallet (MetaMask):
   • Add TestToken using TOKEN_ADDRESS
   • Approve LockContract
   • Call lock(amount, swapId, algoAddress)

3️⃣ Check your Algorand wallet (Pera):
   • You must OPT-IN to the ASA first
   • You will receive the ASA when the relayer detects the event

✨ You are ready for your first cross-chain demo!
`);
})();
