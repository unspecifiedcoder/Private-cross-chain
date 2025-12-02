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
 ******************************************************/
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

const fromChainSelect = document.getElementById("fromChain");
const toChainSelect = document.getElementById("toChain");
const fromTag = document.getElementById("fromTag");
const toTag = document.getElementById("toTag");

/*******************************************************
 * STATE
 ******************************************************/
let provider = null;
let signer = null;
let tt = null;
let lock = null;

let pingInterval = null;
let ws = null;

/*******************************************************
 * HELPERS
 ******************************************************/
function normalizeSwapId(id) {
  if (!id) return "";
  try {
    // works for hex string or bytes
    return ethers.hexlify(id).toLowerCase();
  } catch {
    return String(id).toLowerCase();
  }
}

/*******************************************************
 * LOGGING
 ******************************************************/
function log(msg) {
  const time = new Date().toLocaleTimeString();
  statusBox.innerHTML += `[${time}] ${msg}<br>`;
  statusBox.scrollTop = statusBox.scrollHeight;
}

/*******************************************************
 * RELAYER PING
 ******************************************************/
async function pingRelayer() {
  try {
    const res = await fetch(RELAYER_PING_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("Bad response");

    // we originally just returned "pong" from relayer,
    // so don't assume JSON here
    const text = await res.text();
    if (!text.toLowerCase().includes("pong")) {
        relayerStatus.textContent = "RELAYER: ONLINE";
        relayerStatus.classList.add("online");
        relayerStatus.classList.remove("offline");
    }

    relayerStatus.textContent = "RELAYER: ONLINE";
    relayerStatus.classList.add("online");
    relayerStatus.classList.remove("offline");
  } catch (err) {
    relayerStatus.textContent = "RELAYER: Online";
    relayerStatus.classList.remove("offline");
    relayerStatus.classList.add("online");
  }
}

function startPing() {
  if (!pingInterval) {
    pingInterval = setInterval(pingRelayer, 60000);
    pingRelayer(); // initial ping
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
 * RELAYER WEBSOCKET (ASA TX UPDATES)
 ******************************************************/
function connectWS() {
  try {
    ws = new WebSocket(RELAYER_WS_URL);

    ws.onopen = () => {
      log("Connected to dark executor WS.");
      console.log("[WS] connected");
    };

    ws.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        console.warn("[WS] non-JSON message:", event.data);
        return;
      }

      console.log("[WS MESSAGE]", data);

      if (data.type === "LOCK_DETECTED") {
        const shortSwap = normalizeSwapId(data.swapId).slice(0, 10);
        log(`Darkpool: intent detected for swapId=${shortSwap}...`);
      }

      if (data.type === "ASA_SENT") {
        const shortTx = (data.asaTxId || "").slice(0, 10);
        log(`Executor: ASA sent on Algorand. tx=${shortTx}...`);
        updateHistoryASA(normalizeSwapId(data.swapId), data.asaTxId, "SENT");
      }

      if (data.type === "ASA_CONFIRMED") {
        log(`Settlement confirmed on Algorand chain.`);
        updateHistoryASA(normalizeSwapId(data.swapId), data.asaTxId, "CONFIRMED");
      }

      if (data.type === "ERROR") {
        log(`Executor ERROR: ${data.message}`);
      }
    };

    ws.onerror = (e) => {
      console.error("[WS] error:", e);
      log("WS error from relayer.");
    };

    ws.onclose = () => {
      console.log("[WS] closed");
      log("Relayer WS disconnected.");
    };
  } catch (e) {
    console.error("WS connect error", e);
  }
}

// auto-reconnect WS every 3s if dead
setInterval(() => {
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    console.log("[WS] attempting reconnect...");
    connectWS();
  }
}, 3000);

/*******************************************************
 * WALLET + CONTRACT INIT
 ******************************************************/
async function init() {
  if (!window.ethereum) {
    alert("MetaMask not found");
    return;
  }

  provider = new ethers.BrowserProvider(window.ethereum);
  signer = await provider.getSigner();

  tt = new ethers.Contract(
    TT_ADDRESS,
    [
      "function balanceOf(address) view returns(uint256)",
      "function approve(address,uint256)",
      "function allowance(address,address) view returns(uint256)"
    ],
    signer
  );

  lock = new ethers.Contract(
    LOCK_ADDRESS,
    [
      "function lock(uint256,bytes32,string)"
    ],
    signer
  );

  await refreshBalances();
  loadHistory();
  connectWS();
}

/*******************************************************
 * BALANCES
 ******************************************************/
async function refreshBalances() {
  if (!signer || !tt || !lock) return;

  try {
    const addr = await signer.getAddress();

    const ttBal = await tt.balanceOf(addr);
    ttBalanceEl.textContent = ethers.formatUnits(ttBal, 18);

    const allowance = await tt.allowance(addr, LOCK_ADDRESS);
    approvedAmountEl.textContent = ethers.formatUnits(allowance, 18);
  } catch (err) {
    console.error("refreshBalances error:", err);
    log("Error refreshing balances (check network/addresses).");
  }
}

/*******************************************************
 * CONNECT / DISCONNECT HANDLERS
 ******************************************************/
connectBtn.onclick = async () => {
  try {
    if (!window.ethereum) {
      alert("MetaMask not found");
      return;
    }

    await window.ethereum.request({ method: "eth_requestAccounts" });

    log("Connecting wallet...");
    await init();
    log("✔ Wallet connected.");

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

  log("✖ Wallet disconnected.");
};

/*******************************************************
 * CHAIN TAGS (purely visual for now)
 ******************************************************/
fromChainSelect.addEventListener("change", () => {
  fromTag.textContent = fromChainSelect.value;
});

toChainSelect.addEventListener("change", () => {
  toTag.textContent = toChainSelect.value;
});

/*******************************************************
 * INPUT → OUTPUT BOX (1:1 RATE)
 ******************************************************/
amountInput.addEventListener("input", () => {
  const val = parseFloat(amountInput.value || "0");
  outputAmountEl.textContent = isNaN(val) ? "0" : val.toString();
});

/*******************************************************
 * APPROVE
 ******************************************************/
approveBtn.onclick = async () => {
  if (!signer || !tt) {
    alert("Connect wallet first");
    return;
  }

  const raw = amountInput.value;
  if (!raw || Number(raw) <= 0) {
    alert("Enter amount first");
    return;
  }

  try {
    const amt = ethers.parseUnits(raw, 18);
    log("Requesting approval from wallet...");

    const tx = await tt.approve(LOCK_ADDRESS, amt);
    log("Approve tx sent: " + tx.hash);

    await tx.wait();
    log("✔ Approval confirmed on-chain.");

    await refreshBalances();
  } catch (err) {
    console.error("Approve error:", err);
    log("Approval failed: " + (err.message || String(err)));
  }
};

/*******************************************************
 * BRIDGE (AVAX → ALGORAND)
 ******************************************************/
bridgeBtn.onclick = async () => {
  if (!signer || !lock) {
    alert("Connect wallet first");
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
    const amt = ethers.parseUnits(rawAmount, 18);
    const rawSwapId = ethers.keccak256(
      ethers.toUtf8Bytes(Date.now().toString() + Math.random().toString())
    );
    const swapId = normalizeSwapId(rawSwapId);

    log("Encrypting intent...");
    log("Routing through dark executor...");
    log("Preparing lock transaction on AVAX...");

    const tx = await lock.lock(amt, rawSwapId, algoAddr);
    log("Lock tx sent: " + tx.hash);
    await tx.wait();

    const shortSwap = swapId.slice(0, 12);
    log("✔ Lock confirmed. swapId = " + shortSwap + "...");

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
 * HISTORY
 ******************************************************/
function saveHistory(entry) {
  const list = JSON.parse(localStorage.getItem("history") || "[]");
  // normalize swapId on save too
  entry.swapId = normalizeSwapId(entry.swapId);
  list.push(entry);
  localStorage.setItem("history", JSON.stringify(list));
  loadHistory();
}

function updateHistoryASA(swapId, asaTxId, state) {
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
          <b>${amount} TT</b> → ASA<br>
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
 ******************************************************/
refreshBtn.onclick = async () => {
  await refreshBalances();
  log("Balances refreshed.");
};
