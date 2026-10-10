"use strict";
// Support probe for the reviewed 0.1 KOIN buyer deposit. Built-ins only so it
// runs with the installed Test app's Node runtime. Never opens wallet keys,
// writes journals, signs, changes the transaction, or broadcasts it.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const CHAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const OWNER = "1EXvuuW5HMrYRPdkraSi5Z4TBd4djyMj6E";
const CREDITS = "13xiS64Z7mQXBNXniKPYRbFDCaNfvKbrPT";
const TOKEN = "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK";
const RPCS = ["https://api.koinosblocks.com", "https://api.koinos.io"];
const OPERATIONS = [
  { call_contract: { contract_id: TOKEN, entry_point: 1960973952,
    args: "ChkAlHMeHhJXgiFTjXyBFaZKruKbBfjE34R3EhkAIHm3MhKMggZW0VIFI2yWqQVitQ8M1XCKGICt4gQ=" } },
  { call_contract: { contract_id: CREDITS, entry_point: 1883823242,
    args: "EhkAlHMeHhJXgiFTjXyBFaZKruKbBfjE34R3IICt4gQ=" } },
];
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function loadDeposit(dataDir, txId) {
  if (!/^0x1220[a-f0-9]{64}$/.test(txId || "")) throw Error("Original transaction ID required");
  const root = path.join(dataDir, "koin-foundation-test");
  const config = JSON.parse(fs.readFileSync(path.join(root, "deployment.json"), "utf8"));
  if (config.mode !== "mainnet-pilot" || config.owner !== OWNER || config.deployment?.chainId !== CHAIN ||
      config.deployment?.credits !== CREDITS || config.deployment?.token !== TOKEN)
    throw Error("Run this diagnostic on the reviewed buyer profile");
  const db = new DatabaseSync(path.join(root, "journals", "funding-recovery.sqlite"), { readOnly: true });
  let row;
  try { row = db.prepare("SELECT data,hash FROM deposits WHERE tx_id=?").get(txId); } finally { db.close(); }
  if (!row || hash(row.data) !== row.hash) throw Error("Original saved deposit is missing or damaged");
  const saved = JSON.parse(row.data), tx = saved.transaction;
  if (!tx || tx.id !== txId || saved.draft?.id !== txId || hash(JSON.stringify(tx)) !== saved.transactionHash ||
      hash(JSON.stringify(saved.draft)) !== saved.draftHash ||
      hash(JSON.stringify({ ...tx, signatures: [] })) !== saved.draftHash)
    throw Error("Original signed envelope is missing or damaged");
  if (saved.intent?.actor !== OWNER || saved.intent.kind !== "credits" || saved.intent.method !== "purchase" ||
      saved.intent.args?.amount !== "10000000" || tx.header?.chain_id !== CHAIN || tx.header?.payer !== OWNER ||
      tx.header.payee !== undefined || !/^[1-9][0-9]*$/.test(tx.header.rc_limit || "") ||
      tx.header.rc_limit !== saved.intent.maxRc || BigInt(tx.header.rc_limit) > BigInt(config.maxRcPerTransaction) ||
      JSON.stringify(tx.operations) !== JSON.stringify(OPERATIONS) || tx.signatures?.length !== 1 ||
      typeof tx.signatures[0] !== "string" || Buffer.from(tx.signatures[0], "base64url").length !== 65)
    throw Error("Saved transaction differs from the reviewed 0.1 KOIN purchase");
  return { tx, summary: { transaction: txId, owner: OWNER, amountKoin: "0.10000000", savedState: saved.state,
    held: saved.held === true, fundingAttempts: saved.attempts, savedReason: saved.reason,
    rcLimit: tx.header.rc_limit, nonce: tx.header.nonce } };
}
// Only select public RPC error fields. Never print a request or signed envelope.
const short = value => typeof value === "string" ? value.replace(/[\r\n\t]/g, " ").slice(0, 400) : undefined;
function publicError(error) {
  let data = error?.data;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { data = null; } }
  return { code: typeof error?.code === "number" ? error.code : undefined, message: short(error?.message) || "RPC unavailable",
    logs: Array.isArray(data?.logs) ? data.logs.filter(x => typeof x === "string").slice(0, 6).map(short) : undefined };
}
async function diagnose(deposit, fetcher = fetch) {
  const probes = await Promise.all(RPCS.map(async endpoint => {
    let id = 0;
    const rpc = async (method, params) => {
      if (!["chain.get_chain_id", "chain.get_account_rc", "chain.get_account_nonce", "transaction_store.get_transactions_by_id", "chain.submit_transaction"].includes(method) ||
          (method === "chain.submit_transaction" && (params.broadcast !== false || params.transaction !== deposit.tx)))
        throw Error("Diagnostic refused an unexpected RPC operation");
      const response = await fetcher(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), redirect: "error", signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw Error("RPC HTTP " + response.status);
      const value = await response.json();
      if (value.error) throw Object.assign(Error(value.error.message || "RPC error"), { code: value.error.code, data: value.error.data });
      if (!value.result || typeof value.result !== "object") throw Error("Invalid RPC response");
      return value.result;
    };
    try {
      if ((await rpc("chain.get_chain_id", {})).chain_id !== CHAIN) throw Error("RPC chain mismatch; simulation blocked");
      const [lookup, rc, nonce] = await Promise.all([
        rpc("transaction_store.get_transactions_by_id", { transaction_ids: [deposit.tx.id] }),
        rpc("chain.get_account_rc", { account: OWNER }), rpc("chain.get_account_nonce", { account: OWNER }),
      ]);
      const records = (lookup.transactions || []).filter(r => r.transaction?.id === deposit.tx.id);
      const result = { endpoint, transactionFound: records.length > 0,
        containingBlocks: records.flatMap(r => r.containing_blocks || []), availableRc: rc.rc, currentNonce: nonce.nonce };
      if (records.length) return { ...result, simulation: { skipped: "Transaction already reported by this RPC" } };
      try {
        // This is the same non-broadcast simulation used by deployment preflight.
        const simulated = await rpc("chain.submit_transaction", { transaction: deposit.tx, broadcast: false });
        const receipt = simulated.receipt;
        if (!receipt || receipt.id !== deposit.tx.id || ![undefined, false, true].includes(receipt.reverted) ||
            typeof receipt.rc_used !== "string" || !/^[0-9]+$/.test(receipt.rc_used))
          throw Error("Missing or invalid simulation receipt");
        return { ...result, simulation: { broadcast: false, reverted: receipt.reverted === true,
          rcUsed: receipt.rc_used, logs: Array.isArray(receipt.logs) ? receipt.logs.slice(0, 6).map(short) : [] } };
      } catch (error) { return { ...result, simulation: { broadcast: false, error: publicError(error) } }; }
    } catch (error) { return { endpoint, error: publicError(error) }; }
  }));
  return { mode: "read-only-mainnet-deposit-diagnostic", ...deposit.summary, probes };
}
if (require.main === module) {
  (async () => {
    if (process.argv.length !== 4) throw Error("Usage: diagnose-mainnet-deposit.cjs CORE_DATA_DIRECTORY TRANSACTION_ID");
    console.log(JSON.stringify(await diagnose(loadDeposit(process.argv[2], process.argv[3])), null, 2));
  })().catch(error => { console.error(short(error.message)); process.exitCode = 1; });
}
module.exports = { loadDeposit, diagnose, OPERATIONS, CHAIN, OWNER, CREDITS, TOKEN };
