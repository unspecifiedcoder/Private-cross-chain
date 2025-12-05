// relayer.js
require("dotenv").config();
const express = require("express");
const app = express();

const { ethers } = require("ethers");
const algosdk = require("algosdk");
const WebSocket = require("ws");
const cors = require("cors");

// -----------------------------
// 0. CONFIG & CLIENTS
// -----------------------------
const AVAX_WS = "wss://api.avax-test.network/ext/bc/C/ws";

const provider = new ethers.WebSocketProvider(AVAX_WS);

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const LOCK_ADDRESS = process.env.LOCK_ADDRESS;
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS;
const ASA_ID = Number(process.env.ASA_ID);
const TT_DECIMALS = Number(process.env.TT_DECIMALS || "18");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || "5000");

if (!PRIVATE_KEY) console.warn("⚠️ PRIVATE_KEY missing in .env");
if (!LOCK_ADDRESS) console.warn("⚠️ LOCK_ADDRESS missing in .env");
if (!TOKEN_ADDRESS) console.warn("⚠️ TOKEN_ADDRESS missing in .env");
if (!ASA_ID || Number.isNaN(ASA_ID)) {
  console.warn("⚠️ ASA_ID missing or invalid in .env");
}
if (!process.env.ALGO_RELAYER_MNEMONIC) {
  console.warn("⚠️ ALGO_RELAYER_MNEMONIC missing in .env");
}
if (!process.env.ALGOD_SERVER) {
  console.warn("⚠️ ALGOD_SERVER missing in .env");
}

// EVM wallet
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Algorand client
const algod = new algosdk.Algodv2(
  process.env.ALGOD_TOKEN || "",
  process.env.ALGOD_SERVER,
  process.env.ALGOD_PORT || ""
);

// Relayer account from mnemonic
const algoRelayer = algosdk.mnemonicToSecretKey(
  process.env.ALGO_RELAYER_MNEMONIC
);

// Normalize relayer address → always a base32 string
let RELAYER_ALGO_ADDR;
if (typeof algoRelayer.addr === "string") {
  RELAYER_ALGO_ADDR = algoRelayer.addr;
} else if (algoRelayer.addr && algoRelayer.addr.publicKey) {
  RELAYER_ALGO_ADDR = algosdk.encodeAddress(algoRelayer.addr.publicKey);
} else {
  throw new Error("Unexpected format for algoRelayer.addr");
}

// -----------------------------
// 1. STARTUP LOGS
// -----------------------------
console.log("🔥 XYTHUM DARKPOOL RELAYER BOOTING...");
console.log("EVM Relayer:", wallet.address);
console.log("Algorand Relayer (raw addr object):", algoRelayer.addr);
console.log("Algorand Relayer (base32):", RELAYER_ALGO_ADDR);
console.log("ASA ID:", ASA_ID);
console.log("TT_DECIMALS:", TT_DECIMALS);
console.log("POLL_INTERVAL_MS:", POLL_INTERVAL_MS);
console.log("ALGOD_SERVER:", process.env.ALGOD_SERVER);
console.log("----------------------------------------------");

// Optional sanity check on normalized address
if (!algosdk.isValidAddress(RELAYER_ALGO_ADDR)) {
  console.warn("⚠️ WARNING: RELAYER_ALGO_ADDR failed SDK validation");
} else {
  console.log("✅ RELAYER_ALGO_ADDR is SDK-valid");
}

// -----------------------------
// 2. HTTP SERVER (for /ping)
// -----------------------------
app.use(cors());
app.use(express.json());

app.get("/ping", (req, res) => {
  console.log("📡 /ping from UI");
  res.json({ status: "ok" });
});

app.listen(5001, () =>
  console.log("🌐 HTTP server: http://localhost:5001/ping")
);

// -----------------------------
// 3. WEBSOCKET SERVER (UI PUSH)
// -----------------------------
const wss = new WebSocket.Server({ port: 5002 }, () =>
  console.log("🌐 WS server: ws://localhost:5002")
);

// BigInt-safe broadcast
function broadcast(obj) {
  const safe = JSON.parse(
    JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v))
  );
  const msg = JSON.stringify(safe);

  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

// -----------------------------
// 4. CONTRACT INTERFACES
// -----------------------------
const lockAbi = [
  "event Locked(address indexed user, uint256 amount, bytes32 indexed swapId, string targetAlgorandAddr)"
];
const tokenAbi = [
  "function transfer(address to, uint256 value) external returns (bool)"
];

const lock = new ethers.Contract(LOCK_ADDRESS, lockAbi, wallet);
const token = new ethers.Contract(TOKEN_ADDRESS, tokenAbi, wallet);

// -----------------------------
// 5. AVAX → ALGO (Lock → ASA Send)
// -----------------------------

// prevent double-processing
const processedSwapIds = new Set();

provider.on(
  {
    address: LOCK_ADDRESS,
    topics: [ethers.id("Locked(address,uint256,bytes32,string)")]
  },
  async (log) => {
    try {
      const parsed = lock.interface.parseLog(log);

      const user = parsed.args.user;
      const amount = parsed.args.amount; // BigInt
      const swapId = parsed.args.swapId;
      let algoAddress = parsed.args.targetAlgorandAddr;

      console.log("\n================ AVAX → ALGO =================");
      console.log("🔔 LOCK EVENT");
      console.log("User:", user);
      console.log("Amount (wei):", amount.toString());
      console.log("SwapID:", swapId);
      console.log("Raw Algorand addr:", JSON.stringify(algoAddress));

      // Push to UI
      broadcast({
        type: "LOCK_DETECTED",
        direction: "AVAX_TO_ALGO",
        user,
        amount: amount.toString(),
        swapId,
        algoAddress,
      });

      // --- Sanity checks ---
      if (processedSwapIds.has(swapId)) {
        console.log("⚠️ Swap already processed, skipping:", swapId);
        return;
      }

      if (!algoAddress || typeof algoAddress !== "string") {
        console.error("❌ INVALID ALGO ADDRESS (not string):", algoAddress);
        return;
      }

      algoAddress = algoAddress.trim();
      console.log("Sanitized Algorand addr:", `"${algoAddress}"`);

      // Basic format check
      if (!/^[A-Z2-7]{58}$/.test(algoAddress)) {
        console.error("❌ INVALID ALGO ADDRESS (regex failed):", algoAddress);
        return;
      }

      // SDK-level validation of destination only
      if (!algosdk.isValidAddress(algoAddress)) {
        console.error("❌ INVALID ALGO ADDRESS (SDK validation failed):", algoAddress);
        return;
      }

      processedSwapIds.add(swapId);

      // Convert wei → ASA amount (1:1 for demo, 18→0 decimals)
      const asaAmount = amount / 10n ** BigInt(TT_DECIMALS);
      console.log("💰 ASA amount to send:", asaAmount.toString());

      if (asaAmount <= 0n) {
        console.error("❌ ASA amount is zero or negative, aborting.");
        return;
      }

      const params = await algod.getTransactionParams().do();

      console.log("🧾 BUILDING ASA TRANSFER TX");
      console.log("from:", RELAYER_ALGO_ADDR);
      console.log("to:", algoAddress);
      console.log("assetIndex:", ASA_ID);
      console.log("amount (Number):", Number(asaAmount));

      const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        from: RELAYER_ALGO_ADDR,
        to: algoAddress,
        amount: Number(asaAmount),
        assetIndex: ASA_ID,
        suggestedParams: params,
      });

      const signed = txn.signTxn(algoRelayer.sk);
      const { txId } = await algod.sendRawTransaction(signed).do();

      console.log("➡ ASA SENT on Algorand, txID:", txId);
      console.log(
        "🔍 Explorer:",
        `https://lora.algokit.io/testnet/transaction/${txId}`
      );

      broadcast({
        type: "ASA_SENT",
        direction: "AVAX_TO_ALGO",
        swapId,
        asaTxId: txId,
        amount: asaAmount.toString(),
      });

      await algosdk.waitForConfirmation(algod, txId, 4);
      console.log("✔ ASA CONFIRMED on Algorand");

      broadcast({
        type: "ASA_CONFIRMED",
        direction: "AVAX_TO_ALGO",
        swapId,
        asaTxId: txId,
      });

      console.log("✅ AVAX → ALGO FLOW COMPLETE for swap:", swapId);
      console.log("===============================================");
    } catch (err) {
      console.error("\n❌ RELAYER ERROR (AVAX→ALGO):", err);
      broadcast({
        type: "ERROR",
        where: "AVAX_TO_ALGO",
        message: err.message || String(err),
      });
    }
  }
);

// -----------------------------
// 6. ALGO → AVAX (QR + EXPECT_ASA + Poll)
// -----------------------------

// swapId -> { expectedAmount (BigInt), initialBalance (BigInt), targetEvm }
const pendingIntents = {};

wss.on("connection", (socket) => {
  console.log("🔗 UI WebSocket client connected");

  socket.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.type === "EXPECT_ASA") {
        console.log("\n================ ALGO → AVAX =================");
        console.log("📥 EXPECT_ASA from UI");
        console.log("swapId:", data.swapId);
        console.log("targetEvm:", data.targetEvm);
        console.log("amount (ASA units):", data.amount);

        const expectedAmount = BigInt(data.amount);
        const initialBalance = BigInt(
          await getAsaBalance(RELAYER_ALGO_ADDR, ASA_ID)
        );

        pendingIntents[data.swapId] = {
          expectedAmount,
          initialBalance,
          targetEvm: data.targetEvm,
        };

        console.log("🔔 EXPECT_ASA registered:");
        console.log({
          swapId: data.swapId,
          expectedAmount: expectedAmount.toString(),
          initialBalance: initialBalance.toString(),
          targetEvm: data.targetEvm,
        });
      }
    } catch (e) {
      console.error("❌ WS parse error:", e);
    }
  });

  socket.on("close", () => {
    console.log("🔌 UI WebSocket client disconnected");
  });
});

// -----------------------------
// 7. ASA BALANCE HELPER
// -----------------------------
async function getAsaBalance(address, assetId) {
  try {
    const info = await algod.accountInformation(address).do();
    const holdings = info.assets || [];

    for (const a of holdings) {
      const id = a["asset-id"] ?? a["assetId"];
      if (id && id.toString() === assetId.toString()) {
        return a.amount;
      }
    }
    return 0;
  } catch (e) {
    console.error("❌ getAsaBalance error:", e);
    return 0;
  }
}

// -----------------------------
// 8. SEND TT ON AVAX (for ALGO → AVAX leg)
// -----------------------------
async function sendTT(targetEvm, asaAmountBigInt, swapId) {
  try {
    console.log("🧮 Computing TT amount for AVAX...");
    console.log("Input ASA:", asaAmountBigInt.toString());

    const ttAmount = asaAmountBigInt * 10n ** BigInt(TT_DECIMALS);

    console.log("TT amount (wei):", ttAmount.toString());
    console.log("Sending TT to:", targetEvm);

    const tx = await token.transfer(targetEvm, ttAmount);

    console.log("➡ TT Sent on AVAX, tx:", tx.hash);
    console.log(
      "🔍 Snowtrace:",
      `https://testnet.snowtrace.io/tx/${tx.hash}`
    );

    broadcast({
      type: "ALGO_TT_SENT",
      swapId,
      evmTx: tx.hash,
      targetEvm,
    });

    const receipt = await tx.wait();
    console.log("✔ TT CONFIRMED on AVAX, block:", receipt.blockNumber);

    broadcast({
      type: "ALGO_TT_CONFIRMED",
      swapId,
      evmTx: tx.hash,
      targetEvm,
    });

    console.log("✅ ALGO → AVAX TT settlement done for swap:", swapId);
  } catch (e) {
    console.error("❌ sendTT error:", e);
    broadcast({
      type: "ERROR",
      where: "ALGO_TO_AVAX_TT",
      swapId,
      message: e.message || String(e),
    });
  }
}

// -----------------------------
// 9. POLLER (ASA BALANCE MONITOR)
// -----------------------------
let pollingActive = false;

async function pollAlgorandInbound() {
  try {
    const activeSwaps = Object.keys(pendingIntents);

    if (activeSwaps.length === 0) {
      if (pollingActive) {
        console.log("🛑 No pending intents → stopping ASA monitor");
      }
      pollingActive = false;
      return setTimeout(pollAlgorandInbound, POLL_INTERVAL_MS);
    }

    if (!pollingActive) {
      console.log("\n▶ Starting ASA monitoring (ALGO → AVAX)...");
      pollingActive = true;
    }

    // MVP: one swap at a time
    const swapId = activeSwaps[0];
    const intent = pendingIntents[swapId];

    const initial = intent.initialBalance;
    const expected = intent.expectedAmount;
    const current = BigInt(await getAsaBalance(RELAYER_ALGO_ADDR, ASA_ID));
    const target = initial + expected;

    console.log("\n🔎 ASA POLL TICK");
    console.log("swapId:", swapId);
    console.log("Initial balance:", initial.toString());
    console.log("Current balance:", current.toString());
    console.log("Expected target:", target.toString());

    if (current >= target) {
      console.log("✅ ASA RECEIVED on Algorand for swap:", swapId);

      broadcast({
        type: "ALGO_ASA_RECEIVED",
        swapId,
        asaAmount: expected.toString(),
      });

      await sendTT(intent.targetEvm, expected, swapId);

      console.log("🧹 Clearing intent:", swapId);
      delete pendingIntents[swapId];

      console.log("🛑 Stopping ASA monitoring (until next QR)");
      pollingActive = false;
    } else {
      console.log("⏳ Waiting for ASA funding…");
    }
  } catch (e) {
    console.error("❌ pollAlgorandInbound error:", e);
  }

  setTimeout(pollAlgorandInbound, POLL_INTERVAL_MS);
}

pollAlgorandInbound();
console.log(`⏱ Polling Algorand every ${POLL_INTERVAL_MS}ms for inbound ASA...`);
