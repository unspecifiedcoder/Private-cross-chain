/*******************************************************
 * CONFIG
 ******************************************************/
const TT_ADDRESS = "0xc000e6479C9229Bf82ea9a4c157456A7bc137eC9";
const LOCK_ADDRESS = "0x3d49aC51cd3c8C9503f7b6D3046426FFbcf8748A";
const ASA_ID = 750292256;

const RELAYER_PING_URL = "http://localhost:5001/ping";


/*******************************************************
 * DOM ELEMENTS
 ******************************************************/
const relayerStatus = document.getElementById("relayerStatus");
const statusBox = document.getElementById("statusBox");
const historyBox = document.getElementById("historyBox");
const ttBalanceEl = document.getElementById("ttBalance");
const asaBalanceEl = document.getElementById("asaBalance");
const approvedAmountEl = document.getElementById("approvedAmount");

const algoAddressInput = document.getElementById("algoAddress");
const amountInput = document.getElementById("amountInput");
const approveBtn = document.getElementById("approveBtn");
const bridgeBtn = document.getElementById("bridgeBtn");
const refreshBtn = document.getElementById("refreshBtn");
let pingInterval = null;

/*******************************************************
 * LOGGING
 ******************************************************/
function log(msg) {
    statusBox.innerHTML += `> ${msg}<br>`;
    statusBox.scrollTop = statusBox.scrollHeight;
}

/*******************************************************
 * RELAYER PING CHECK
 ******************************************************/
async function pingRelayer() {
    try {
        const res = await fetch(RELAYER_PING_URL);
        if (res.ok) {
            relayerStatus.textContent = "RELAYER: ONLINE";
            relayerStatus.classList.remove("offline");
            relayerStatus.classList.add("online");
        }
    } catch {
        relayerStatus.textContent = "RELAYER: OFFLINE";
        relayerStatus.classList.remove("online");
        relayerStatus.classList.add("offline");
    }
}
setInterval(pingRelayer, 30000);


/*******************************************************
 * WALLET + CONTRACT SETUP
 ******************************************************/
let provider, signer, tt, lock;

async function init() {
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
}

async function refreshBalances() {
    const addr = await signer.getAddress();

    // TT balance
    const ttBal = await tt.balanceOf(addr);
    ttBalanceEl.textContent = ethers.formatUnits(ttBal, 18);

    // ASA (user-provided)
    asaBalanceEl.textContent = "(Check in Algorand Wallet)";

    // Allowance
    const allowance = await tt.allowance(addr, LOCK_ADDRESS);
    approvedAmountEl.textContent = ethers.formatUnits(allowance, 18);
}


/*******************************************************
 * APPROVE
 ******************************************************/
approveBtn.onclick = async () => {
    const amt = ethers.parseUnits(amountInput.value, 18);
    log("Requesting approval...");

    const tx = await tt.approve(LOCK_ADDRESS, amt);
    log("Approve tx sent: " + tx.hash);

    await tx.wait();
    log("✔ Approved!");

    await refreshBalances();
};


/*******************************************************
 * BRIDGE (AVAX → ALGORAND)
 ******************************************************/
bridgeBtn.onclick = async () => {
    const algoAddr = algoAddressInput.value.trim();
    const amt = ethers.parseUnits(amountInput.value, 18);

    if (!algoAddr || algoAddr.length < 50) {
        alert("Invalid Algorand address");
        return;
    }

    const swapId = ethers.keccak256(ethers.toUtf8Bytes(Date.now().toString()));

    log("Locking… ");

    const tx = await lock.lock(amt, swapId, algoAddr);
    await tx.wait();

    log("✔ Locked! SwapID = " + swapId);

    // save history
    saveHistory({
        swapId,
        amount: amountInput.value,
        algoAddr,
        txHash: tx.hash,
        time: Date.now()
    });
};


/*******************************************************
 * HISTORY
 ******************************************************/
function saveHistory(entry) {
    const list = JSON.parse(localStorage.getItem("history") || "[]");
    list.push(entry);
    localStorage.setItem("history", JSON.stringify(list));
    loadHistory();
}

function loadHistory() {
    const list = JSON.parse(localStorage.getItem("history") || "[]");
    historyBox.innerHTML = "";

    list.forEach(e => {
        historyBox.innerHTML += `
        <div>
            <b>${e.amount} TT</b> → ASA<br>
            SwapID: ${e.swapId.slice(0,10)}...<br>
            TX: <a href="https://lora.algokit.io/testnet/transaction/${e.txHash}" target="_blank">${e.txHash.slice(0,12)}...</a>
            <hr>
        </div>`;
    });
}

document.getElementById("clearHistory").onclick = () => {
    localStorage.removeItem("history");
    loadHistory();
};
document.getElementById("connectBtn").onclick = async () => {
    try {
        await window.ethereum.request({ method: "eth_requestAccounts" });
        await init();
        log("✔ Wallet connected.");
    } catch {
        alert("Connection rejected");
    }
};

document.getElementById("disconnectBtn").onclick = () => {
    provider = null;
    signer = null;


    statusBox.innerHTML = "";
    ttBalanceEl.textContent = "0";
    asaBalanceEl.textContent = "0";
    approvedAmountEl.textContent = "0";

    log("✖ Wallet disconnected.");
};


/*******************************************************
 * INIT
 ******************************************************/
init();
