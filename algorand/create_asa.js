require("dotenv").config();
const algosdk = require("algosdk");

// FIXED: Correct env variables
const algodToken = "";
const algodServer = process.env.ALGOD_SERVER;
const algodPort = ""; // PORT always empty for Algonode

const setup = async () => {
    // FIXED: Correct mnemonic key
    if(!process.env.ALGO_RELAYER_MNEMONIC) {
        throw new Error("ALGO_RELAYER_MNEMONIC missing in .env");
    }

    // FIXED: Use correct mnemonic variable
    const account = algosdk.mnemonicToSecretKey(process.env.ALGO_RELAYER_MNEMONIC);

    console.log(`Creating Asset with Creator: ${account.addr}`);

    // FIXED: Use correct Algonode URL
    const client = new algosdk.Algodv2(algodToken, algodServer, algodPort);

    // Define Asset
    const suggestedParams = await client.getTransactionParams().do();

    const txn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
        from: account.addr,
        total: 1000000000,
        decimals: 0,
        defaultFrozen: false,
        manager: account.addr,
        reserve: account.addr,
        freeze: account.addr,
        clawback: account.addr,
        unitName: "wAVAX",
        assetName: "Wrapped AVAX (Bridge)",
        assetURL: "https://bridge.example.com",
        suggestedParams,
    });

    // Sign and Send
    const signedTxn = txn.signTxn(account.sk);
    const { txId } = await client.sendRawTransaction(signedTxn).do();
    console.log(`Transaction sent: ${txId}. Waiting for confirmation...`);

    // Wait for confirmation
    const result = await algosdk.waitForConfirmation(client, txId, 4);
    const assetIndex = result["asset-index"];

    console.log(`\n SUCCESS! Asset Created.`);
    console.log(`Asset ID: ${assetIndex}`);
    console.log(`\n IMPORTANT: Update your .env file:`);
    console.log(`ASA_ID=${assetIndex}`);
};

setup().catch(console.error);
