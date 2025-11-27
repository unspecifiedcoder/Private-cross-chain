require("dotenv").config();
const express = require("express");
const app = express();

const { ethers } = require("ethers");
const algosdk = require("algosdk");

// -----------------------------
// 1. WEBSOCKET PROVIDER
// -----------------------------
const provider = new ethers.WebSocketProvider(
  "wss://api.avax-test.network/ext/bc/C/ws"
);

const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const LOCK_ADDRESS = process.env.LOCK_ADDRESS;
const ASA_ID = Number(process.env.ASA_ID);

// Algorand client
const algod = new algosdk.Algodv2(
  process.env.ALGOD_TOKEN || "",
  process.env.ALGOD_SERVER,
  ""
);
const algoRelayer = algosdk.mnemonicToSecretKey(
  process.env.ALGO_RELAYER_MNEMONIC
);

console.log("🔥 RELAYER STARTED");
console.log("EVM Wallet:", wallet.address);
console.log("Algorand Wallet:", algoRelayer.addr);
console.log("ASA:", ASA_ID);
console.log("📡 Listening via WebSocket...\n");

// ---------------------------------------------
// HTTP PING ENDPOINT (UI → RELAYER)
// ---------------------------------------------
app.get("/ping", (req, res) => {
  console.log("📡 Ping received from UI");
  res.send("pong");
});
app.listen(5001, () => console.log("🌐 HTTP server: http://localhost:5001/ping"));

// ---------------------------------------------
// ABI (CORRECTED FOR INDEXED swapId)
// ---------------------------------------------
const lockAbi = [
  "event Locked(address indexed user, uint256 amount, bytes32 indexed swapId, string targetAlgorandAddr)"
];

const lock = new ethers.Contract(LOCK_ADDRESS, lockAbi, wallet);

// Prevent double-processing
const processed = new Set();

// ---------------------------------------------
// EVENT LISTENER (PROPER DECODING)
// ---------------------------------------------
provider.on({
    address: LOCK_ADDRESS,
    topics: [ethers.id("Locked(address,uint256,bytes32,string)")]
}, async (log) => {

  try {
    // SAFE EVENT PARSE
    const parsed = lock.interface.parseLog(log);

    const user = parsed.args.user;
    const amount = parsed.args.amount;
    const swapId = parsed.args.swapId;
    const algoAddress = parsed.args.targetAlgorandAddr;

    if (processed.has(swapId)) {
      console.log("⚠ Duplicate SwapID:", swapId);
      return;
    }
    processed.add(swapId);

    console.log("\n🔔 LOCK EVENT DETECTED");
    console.log("User:", user);
    console.log("Amount:", amount.toString());
    console.log("SwapID:", swapId);
    console.log("Algorand:", algoAddress);

    // Validate Algorand address
    if (!/^[A-Z2-7]{58}$/.test(algoAddress)) {
      console.error("❌ INVALID ALGORAND ADDRESS:", algoAddress);
      return;
    }

    // -------------------------------------------
    // SEND ASA TO RECEIVER
    // -------------------------------------------
    const params = await algod.getTransactionParams().do();
    const asaAmount = amount / 10n ** 18n;
    console.log("➡ Sending ASA Amount:", asaAmount.toString());
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      from: algoRelayer.addr,
      to: algoAddress,
      amount: Number(asaAmount),
      assetIndex: ASA_ID,
      suggestedParams: params,
    });

    const signed = txn.signTxn(algoRelayer.sk);
    const { txId } = await algod.sendRawTransaction(signed).do();

    console.log("\n➡ ASA Sent (Algorand TXID):", txId);
    console.log("🔍 Explorer link:");
    console.log(`   https://lora.algokit.io/tx/${txId}`);

    await algosdk.waitForConfirmation(algod, txId, 4);

    console.log("✔ COMPLETED: ASA Delivered Successfully!\n");

  } catch (err) {
    console.error("\n❌ RELAYER ERROR:", err);
  }
});
