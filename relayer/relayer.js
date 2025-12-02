require("dotenv").config();
const express = require("express");
const app = express();

const { ethers } = require("ethers");
const algosdk = require("algosdk");
const WebSocket = require("ws");

// -----------------------------
// 1. WEBSOCKET PROVIDER (AVAX)
// -----------------------------
const provider = new ethers.WebSocketProvider(
  "wss://api.avax-test.network/ext/bc/C/ws"
);

const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const LOCK_ADDRESS = process.env.LOCK_ADDRESS;
const ASA_ID = Number(process.env.ASA_ID);

// -----------------------------
// 2. ALGOD CLIENT (ALGORAND)
// -----------------------------
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

// -----------------------------
// 3. HTTP PING ENDPOINT (for UI)
// -----------------------------
app.get("/ping", (req, res) => {
    console.log("📡 Ping received from UI");
    res.status(200).json({ status: "ok" });
});
app.listen(5001, () =>
  console.log("🌐 HTTP server: http://localhost:5001/ping")
);

// -----------------------------
// 4. WEBSOCKET SERVER (UI PUSH)
// -----------------------------
const wss = new WebSocket.Server({ port: 5002 }, () =>
  console.log("🌐 WS server: ws://localhost:5002")
);

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// -----------------------------
// 5. LOCK ABI
// -----------------------------
const lockAbi = [
  "event Locked(address indexed user, uint256 amount, bytes32 indexed swapId, string targetAlgorandAddr)"
];

const lock = new ethers.Contract(LOCK_ADDRESS, lockAbi, wallet);

// Prevent double-processing
const processed = new Set();

// -----------------------------
// 6. EVENT LISTENER (Ethers v6)
// -----------------------------
provider.on(
  {
    address: LOCK_ADDRESS,
    topics: [ethers.id("Locked(address,uint256,bytes32,string)")]
  },
  async (log) => {
    try {
      const parsed = lock.interface.parseLog(log);

      const user = parsed.args.user;
      const amount = parsed.args.amount; // wei
      const swapId = parsed.args.swapId;
      const algoAddress = parsed.args.targetAlgorandAddr;

      console.log("\n🔔 LOCK EVENT DETECTED");
      console.log("User:", user);
      console.log("Amount:", amount.toString());
      console.log("SwapID:", swapId);
      console.log("Algorand:", algoAddress);

      // notify UI
      broadcast({
        type: "LOCK_DETECTED",
        user,
        amount: amount.toString(),
        swapId,
        algoAddress,
      });

      if (!/^[A-Z2-7]{58}$/.test(algoAddress)) {
        console.error("❌ INVALID ALGORAND ADDRESS:", algoAddress);
        return;
      }

      if (processed.has(swapId)) {
        console.log("⚠ Duplicate SwapID:", swapId);
        return;
      }
      processed.add(swapId);

      // convert wei -> ASA units (decimals = 0, 1:1)
      const asaAmount = amount / 10n ** 18n;
      console.log(`➡ Sending ASA Amount: ${asaAmount.toString()}`);

      const params = await algod.getTransactionParams().do();

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
      console.log(`   https://lora.algokit.io/testnet/transaction/${txId}`);

      // notify UI ASA_SENT
      broadcast({
        type: "ASA_SENT",
        swapId,
        asaTxId: txId,
        amount: asaAmount.toString(),
      });

      await algosdk.waitForConfirmation(algod, txId, 4);

      console.log("✔ COMPLETED: ASA Delivered Successfully!\n");

      // notify UI ASA_CONFIRMED
      broadcast({
        type: "ASA_CONFIRMED",
        swapId,
        asaTxId: txId,
      });

    } catch (err) {
      console.error("\n❌ RELAYER ERROR:", err);
      broadcast({ type: "ERROR", message: err.message || String(err) });
    }
  }
);
