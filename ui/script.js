/*******************************************************
 * CONFIG
 ******************************************************/
const TT_ADDRESS = "0xc000e6479C9229Bf82ea9a4c157456A7bc137eC9";
const LOCK_ADDRESS = "0x3d49aC51cd3c8C9503f7b6D3046426FFbcf8748A";
const ASA_ID = 750292256;

const RELAYER_PING_URL = "http://localhost:5001/ping";
const RELAYER_WS_URL = "ws://localhost:5002";

/*******************************************************
 * DOM ELEMENTS
 *******************************************************/
const relayerStatus = document.getElementById("relayerStatus");
const statusBox = document.getElementById("statusBox");
const historyBox = document.getElementById("historyBox");
const ttBalanceEl = document.getElementById("ttBalance");
const approvedAmountEl = document.getElementById("approvedAmount");
const outputAmountEl = document.getElementById("outputAmount");

const algoAddressInput = document.getElementById("algoAddress");
const amountInput = document.getElementById("amountInput");
const approveBtn = document.getElementById("approveBtn");
const bridgeBtn = document.getElementById("bridgeBtn");
const refreshBtn = document.getElementById("refreshBtn");
const connectBtn = document.getElementById("connectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");

const modeA2BBtn = document.getElementById("modeA2B");
const modeB2ABtn = document.getElementById("modeB2A");
const a2bBox = document.getElementById("a2bBox");
const algoToAvaxBox = document.getElementById("algoToAvaxBox");
const targetEvmInput = document.getElementById("targetEvmInput");
const sendASAButton = document.getElementById("sendASAButton"); // Now SIGN VIA WALLETCONNECT

const fromChainSelect = document.getElementById("fromChain");
const toChainSelect = document.getElementById("toChain");
const fromTag = document.getElementById("fromTag");
const toTag = document.getElementById("toTag");

const connectedAddressSpan = document.getElementById("connectedAddress");
const algoConnectedInfo = document.getElementById("algoConnectedInfo");

// Dynamically created Algo Disconnect button
const disconnectAlgoBtn = document.createElement("button");
disconnectAlgoBtn.id = "disconnectAlgoBtn";
disconnectAlgoBtn.className = "btn small right hidden";
disconnectAlgoBtn.textContent = "DISCONNECT ALGO";
// Insert it next to the Algo Connect button (assuming index.html structure)

/*******************************************************
 * STATE
 *******************************************************/
let provider = null;
let signer = null;
let tt = null;
let lock = null;
let mode = "A2B";
let pingInterval = null;
let ws = null;

/*******************************************************
 * HELPERS
 *******************************************************/
function normalizeSwapId(id) {
  if (!id) return "";
  try {
    // ethers.hexlify is available via the UMD script
    return ethers.hexlify(id).toLowerCase();
  } catch {
    return String(id).toLowerCase();
  }
}

function log(msg) {
  const time = new Date().toLocaleTimeString();
  statusBox.innerHTML += `[${time}] ${msg}<br>`;
  statusBox.scrollTop = statusBox.scrollHeight;
}

/*******************************************************
 * RELAYER PING
 *******************************************************/
async function pingRelayer() {
  try {
    const res = await fetch(RELAYER_PING_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("Bad response from relayer");
    await res.text();

    relayerStatus.textContent = "RELAYER: ONLINE";
    relayerStatus.classList.add("online");
    relayerStatus.classList.remove("offline");
  } catch (err) {
    relayerStatus.textContent = "RELAYER: OFFLINE";
    relayerStatus.classList.remove("online");
    relayerStatus.classList.add("offline");
  }
}

function startPing() {
  if (!pingInterval) {
    pingInterval = setInterval(pingRelayer, 60000);
    pingRelayer();
  }
}

function stopPing() {
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = null;

  relayerStatus.textContent = "RELAYER: OFFLINE";
  relayerStatus.classList.remove("online");
  relayerStatus.classList.add("offline");
}

/*******************************************************
 * RELAYER WEBSOCKET
 *******************************************************/
function connectWS() {
  try {
    ws = new WebSocket(RELAYER_WS_URL);

    ws.onopen = () => {
      log("Connected to dark executor WS.");
      console.log("[WS] connected");
    };

    ws.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); }
      catch { return; }

      console.log("[WS MSG]", data);

      // === NEW: ASA received for Algo → Avax ===
      if (data.type === "ALGO_ASA_RECEIVED") {
        const shortSwap = (data.swapId || "").slice(0, 12);
        const shortAsaTx = (data.asaTx || "").slice(0, 12);

        log(`Darkpool: inbound ASA detected for swapId=${shortSwap}...`);
        log(`Algorand TX: ${data.asaTx}`);

        // hide QR once relayer confirms ASA in
        algoQrBox.classList.add("hidden");

        // create / update history
        saveHistory({
          swapId: data.swapId,
          amount: data.asaAmount,
          algoAddr: ALGO_RELAYER_ADDR,
          avaxTx: null,
          asaTx: data.asaTx,
          direction: "ALGO_TO_AVAX",
          status: "ASA_RECEIVED",
          time: Date.now()
        });

        loadHistory();
      }

      // === NEW: TT sent + confirmed on AVAX ===
      if (data.type === "ALGO_TT_SENT") {
        log(`Executor: TT transfer broadcast on AVAX. tx=${data.evmTx}`);
        updateHistoryEvm(data.swapId, data.evmTx, "TT_SENT");
      }

      if (data.type === "ALGO_TT_CONFIRMED") {
        log(`Darkpool: AVAX settlement confirmed. tx=${data.evmTx}`);

        updateHistoryEvm(data.swapId, data.evmTx, "CONFIRMED");
      }

      if (data.type === "LOCK_DETECTED") {
        const shortSwap = normalizeSwapId(data.swapId).slice(0, 12);
        log(`Darkpool: intent detected (swapId=${shortSwap}...).`);
      }

      if (data.type === "ASA_SENT") {
        const shortTx = (data.asaTxId || "").slice(0, 12);
        log(`Executor: ASA pushed on Algorand. tx=${shortTx}...`);
        updateHistoryASA(data.swapId, data.asaTxId, "SENT");
      }

      if (data.type === "ASA_CONFIRMED") {
        const shortTx = (data.asaTxId || "").slice(0, 12);
        log(`Settlement confirmed on Algorand (tx=${shortTx}...).`);
        updateHistoryASA(data.swapId, data.asaTxId, "CONFIRMED");
      }

      if (data.type === "ALGO_LOCK_DETECTED") {
        log(`Darkpool: inbound ASA intent (ALGO → AVAX), amount=${data.asaAmount}.`);
      }

      if (data.type === "ALGO_TX_SUBMITTED") {
        log(`Submitted ASA TXID: ${data.txId}`);
      }

      if (data.type === "TT_SENT") {
        log(`Executor: TT transfer broadcast on AVAX. tx=${data.evmTx}.`);
      }

      if (data.type === "TT_CONFIRMED") {
        log(`Darkpool: AVAX settlement confirmed. tx=${data.evmTx}.`);
      }

      if (data.type === "ERROR") {
        log(`❌ EXECUTOR ERROR: ${data.message || data.error}`);
      }
    };

    ws.onerror = (e) => {
      console.error("[WS ERROR]", e);
      log("WS error from relayer.");
    };

    ws.onclose = () => {
      console.log("[WS CLOSED]");
      log("Relayer WS disconnected.");
    };
  } catch (e) {
    console.error("WS connect error", e);
  }
}

// auto-reconnect WS every 3s if dead
setInterval(() => {
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    connectWS();
  }
}, 3000);

/*******************************************************
 * WALLET + CONTRACT INIT (EVM)
 *******************************************************/
async function init() {
  if (!window.ethereum) {
    alert("MetaMask / Core wallet not found");
    return;
  }

  // ethers is available via the UMD script
  provider = new ethers.BrowserProvider(window.ethereum);
  signer = await provider.getSigner();

  const addr = await signer.getAddress();
  connectedAddressSpan.textContent = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  connectBtn.textContent = `CONNECTED: ${addr.slice(0, 6)}...${addr.slice(-4)}`;
  connectBtn.disabled = true;
  disconnectBtn.classList.remove('hidden');

  const ttAbi = [
      "function balanceOf(address) view returns(uint256)",
      "function approve(address,uint256)",
      "function allowance(address,address) view returns(uint256)"
    ];
  const lockAbi = ["function lock(uint256,bytes32,string)"];

  tt = new ethers.Contract(TT_ADDRESS, ttAbi, signer);
  lock = new ethers.Contract(LOCK_ADDRESS, lockAbi, signer);

  await refreshBalances();
  loadHistory();
  // connectWS is called in the main DOMContentLoaded listener
}

/*******************************************************
 * BALANCES
 *******************************************************/
async function refreshBalances() {
  if (!signer || !tt || !lock) return;

  try {
    const addr = await signer.getAddress();
    const ttBal = await tt.balanceOf(addr);
    // ethers is available via the UMD script
    ttBalanceEl.textContent = ethers.formatUnits(ttBal, 18);

    const allowance = await tt.allowance(addr, LOCK_ADDRESS);
    approvedAmountEl.textContent = ethers.formatUnits(allowance, 18);
  } catch (err) {
    console.error("refreshBalances error:", err);
    log("Error refreshing balances (check network / addresses).");
  }
}

/*******************************************************
 * CONNECT / DISCONNECT HANDLERS (EVM)
 *******************************************************/

connectBtn.onclick = async () => {
  try {
    if (!window.ethereum) {
      alert("MetaMask / Core not found");
      return;
    }

    await window.ethereum.request({ method: "eth_requestAccounts" });

    log("Connecting wallet...");
    await init();
    log("✔ EVM Wallet connected.");
    startPing();
  } catch (err) {
    console.error("Connect Error:", err);
    alert("ERROR: " + (err.message || String(err)));
  }
};

disconnectBtn.onclick = () => {
  provider = null;
  signer = null;
  tt = null;
  lock = null;

  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }

  stopPing();

  statusBox.innerHTML = "";
  ttBalanceEl.textContent = "0";
  approvedAmountEl.textContent = "0";
  outputAmountEl.textContent = "0";

  connectedAddressSpan.textContent = "–";
  connectBtn.textContent = "CONNECT WALLET";
  connectBtn.disabled = false;
  disconnectBtn.classList.add('hidden');

  log("✖ EVM Wallet disconnected.");
};
/*******************************************************
 * MODE SWITCHING
 *******************************************************/
// ... (existing mode switching logic) ...
modeA2BBtn.onclick = () => {
  mode = "A2B";
  a2bBox.classList.remove("hidden");
  algoToAvaxBox.classList.add("hidden");
  fromChainSelect.value = "AVAX";
  toChainSelect.value = "ALGO";
  fromTag.textContent = "AVAX";
  toTag.textContent = "ALGO";
  log("Mode: AVAX → Algorand (user signs only on AVAX).");
};

modeB2ABtn.onclick = () => {
  mode = "B2A";
  a2bBox.classList.add("hidden");
  algoToAvaxBox.classList.remove("hidden");
  fromChainSelect.value = "ALGO";
  toChainSelect.value = "AVAX";
  fromTag.textContent = "ALGO";
  toTag.textContent = "AVAX";
  log("Mode: Algorand → AVAX (ASA in, TT out).");
};

/*******************************************************
 * CHAIN TAGS (visual only)
 *******************************************************/
fromChainSelect.addEventListener("change", () => {
  fromTag.textContent = fromChainSelect.value;
});

toChainSelect.addEventListener("change", () => {
  toTag.textContent = toChainSelect.value;
});

/*******************************************************
 * INPUT → OUTPUT BOX (1:1 RATE)
 *******************************************************/
amountInput.addEventListener("input", () => {
  const val = parseFloat(amountInput.value || "0");
  outputAmountEl.textContent = isNaN(val) ? "0" : val.toString();
});

/*******************************************************
 * APPROVE
 *******************************************************/
// ... (existing approveBtn.onclick logic) ...
approveBtn.onclick = async () => {
  if (!signer || !tt) {
    alert("Connect EVM wallet first");
    return;
  }

  const raw = amountInput.value;
  if (!raw || Number(raw) <= 0) {
    alert("Enter amount first");
    return;
  }

  try {
    // ethers is available via the UMD script
    const amt = ethers.parseUnits(raw, 18);
    log("Requesting approval to move value into darkpool...");

    const tx = await tt.approve(LOCK_ADDRESS, amt);
    log("Approve tx sent: " + tx.hash);

    await tx.wait();
    log("✔ Approval confirmed on AVAX.");

    await refreshBalances();
  } catch (err) {
    console.error("Approve error:", err);
    log("Approval failed: " + (err.message || String(err)));
  }
};


/*******************************************************
 * BRIDGE (AVAX → ALGORAND)
 *******************************************************/
// ... (existing bridgeBtn.onclick logic) ...
bridgeBtn.onclick = async () => {
  if (!signer || !lock) {
    alert("Connect EVM wallet first");
    return;
  }

  const algoAddr = algoAddressInput.value.trim();
  if (!algoAddr || algoAddr.length < 50) {
    alert("Invalid Algorand address");
    return;
  }

  const rawAmount = amountInput.value;
  if (!rawAmount || Number(rawAmount) <= 0) {
    alert("Enter amount");
    return;
  }

  try {
    // ethers is available via the UMD script
    const amt = ethers.parseUnits(rawAmount, 18);
    // Use ethers.keccak256 for swapId generation
    const rawSwapId = ethers.keccak256(
      ethers.toUtf8Bytes(Date.now().toString() + Math.random().toString())
    );
    const swapId = normalizeSwapId(rawSwapId);

    log("Encrypting intent.");
    log("Routing through dark executor.");
    log("Preparing lock transaction on AVAX...");

    const tx = await lock.lock(amt, rawSwapId, algoAddr);
    log("Lock tx sent: " + tx.hash);
    await tx.wait();

    const shortSwap = swapId.slice(0, 12);
    log("✔ Lock confirmed on AVAX. swapId = " + shortSwap + ".");

    saveHistory({
      swapId,
      amount: rawAmount,
      algoAddr,
      avaxTx: tx.hash,
      asaTx: null,
      status: "LOCKED",
      time: Date.now()
    });

    await refreshBalances();
  } catch (err) {
    console.error("Bridge error:", err);
    log("Bridge failed: " + (err.message || String(err)));
  }
};


/*******************************************************
 * ALGORAND → AVAX (SEND ASA – WalletConnect)
 *******************************************************/
// Add this next to your other config constants:
const ALGO_RELAYER_ADDR = "PEBXY7IHTKE6D5YTMY6WXDDF6WNRKK5KWPXTJH4X3BDMU5EBHBYH5R7XEE";

// QR elements
const algoQrBox = document.getElementById("algoQrBox");
const asaQrCanvas = document.getElementById("asaQrCanvas");
const asaQrHint = document.getElementById("asaQrHint");

// track last swapId for B2A (optional)
let lastAlgoToAvaxSwapId = null;

sendASAButton.onclick = async () => {
  if (mode !== "B2A") return;

  const amountStr = amountInput.value.trim();
  const evm = targetEvmInput.value.trim();

  if (!amountStr || !evm) {
    log("❌ Enter ASA amount and destination AVAX address.");
    return;
  }

  const asaAmount = Number(amountStr);
  if (!asaAmount || asaAmount <= 0) {
    log("❌ Invalid ASA amount.");
    return;
  }

  // basic EVM address sanity
  if (!/^0x[a-fA-F0-9]{40}$/.test(evm)) {
    log("❌ Invalid AVAX address.");
    return;
  }

  // Create unique swapId used both in QR note and relayer expectation
  const swapId = "algo-" + Date.now();
  lastAlgoToAvaxSwapId = swapId;

  // Algorand expects integer base units (ASA has 0 decimals in your setup)
  const payUrl =
    `algorand://${ALGO_RELAYER_ADDR}` +
    `?amount=${asaAmount}` +
    `&asset=${ASA_ID}` +
    `&note=${encodeURIComponent(swapId)}`;

  log("Encrypting ALGO → AVAX intent.");
  log("Dark executor prepared Algorand payment URI.");
  log("Rendering QR. Scan with your Algorand wallet to sign & send ASA.");

  // Show QR panel
  algoQrBox.classList.remove("hidden");
  asaQrHint.textContent =
    "Scan this with Pera / Lute / Defly. After you send ASA, the dark executor will detect it and settle TT on AVAX.";

  // Draw QR
  QRCode.toCanvas(
    asaQrCanvas,
    payUrl,
    { width: 240, margin: 1 },
    (err) => {
      if (err) {
        console.error("QR error:", err);
        log("❌ Failed to render QR: " + err.message);
      }
    }
  );

  // Tell relayer what to expect
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "EXPECT_ASA",
        swapId,
        amount: asaAmount.toString(),
        targetEvm: evm
      })
    );
  }

  log(`Awaiting ASA payment for swapId=${swapId}...`);
};




/*******************************************************
 * HISTORY
 *******************************************************/
function updateHistoryEvm(swapId, evmTx, state) {
  const normSwap = normalizeSwapId(swapId);
  const list = JSON.parse(localStorage.getItem("history") || "[]");
  const updated = list.map((e) => {
    if (normalizeSwapId(e.swapId) === normSwap) {
      e.avaxTx = evmTx || e.avaxTx;
      e.status = state || e.status;
    }
    return e;
  });
  localStorage.setItem("history", JSON.stringify(updated));
  loadHistory();
}

function saveHistory(entry) {
// ... (existing saveHistory logic) ...
  const list = JSON.parse(localStorage.getItem("history") || "[]");
  entry.swapId = normalizeSwapId(entry.swapId);
  list.push(entry);
  localStorage.setItem("history", JSON.stringify(list));
  loadHistory();
}

function updateHistoryASA(swapId, asaTxId, state) {
// ... (existing updateHistoryASA logic) ...
  const normIncoming = normalizeSwapId(swapId);
  if (!normIncoming) return;

  const list = JSON.parse(localStorage.getItem("history") || "[]");
  const updated = list.map((e) => {
    if (normalizeSwapId(e.swapId) === normIncoming) {
      e.asaTx = asaTxId || e.asaTx;
      e.status = state || e.status;
    }
    return e;
  });
  localStorage.setItem("history", JSON.stringify(updated));
  loadHistory();
}

function loadHistory() {
// ... (existing loadHistory logic) ...
  const list = JSON.parse(localStorage.getItem("history") || "[]");
  historyBox.innerHTML = "";

  list
    .slice()
    .reverse()
    .forEach((e) => {
      const amount = e.amount ?? "?";
      const status = e.status ?? "UNKNOWN";
      const swapIdShort = normalizeSwapId(e.swapId).slice(0, 10);
      const avaxTxShort = (e.avaxTx || "").slice(0, 12);
      const asaTxShort = (e.asaTx || "").slice(0, 12);

      historyBox.innerHTML += `
        <div>
          <b>${amount} TT</b> ⇄ ASA<br>
          Status: ${status}<br>
          SwapID: ${swapIdShort}...<br>
          AVAX_TX: ${
            e.avaxTx
              ? `<a href="https://testnet.snowtrace.io/tx/${e.avaxTx}" target="_blank">${avaxTxShort}...</a>`
              : "n/a"
          }<br>
          ASA_TX: ${
            e.asaTx
              ? `<a href="https://lora.algokit.io/testnet/transaction/${e.asaTx}" target="_blank">${asaTxShort}...</a>`
              : "pending"
          }
          <hr>
        </div>`;
    });
}

document.getElementById("clearHistory").onclick = () => {
  localStorage.removeItem("history");
  loadHistory();
};

/*******************************************************
 * REFRESH BUTTON
 *******************************************************/
refreshBtn.onclick = async () => {
  await refreshBalances();
  log("Balances refreshed.");
};

/*******************************************************
 * INITIALIZATION
//  *******************************************************/
// document.addEventListener('DOMContentLoaded', () => {
//     // Attach Algo Disconnect button to the DOM
//     document.getElementById("connectAlgoBtn").parentNode.insertBefore(disconnectAlgoBtn, document.getElementById("connectAlgoBtn").nextSibling);
    
//     // Set up listeners for WalletConnect buttons
//     document.getElementById("connectAlgoBtn").onclick = connectAlgorandWallet;
//     disconnectAlgoBtn.onclick = disconnectAlgorandWallet;

//     // Default mode and initial services
//     modeA2BBtn.click();
//     connectWS();
// });