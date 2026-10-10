"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const probe = require("../../scripts/diagnose-mainnet-deposit.cjs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-deposit-diagnostic-")), root = path.join(dir, "koin-foundation-test");
  fs.mkdirSync(path.join(root, "journals"), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "deployment.json"), JSON.stringify({ mode: "mainnet-pilot", owner: probe.OWNER, maxRcPerTransaction: "100000000", deployment: { chainId: probe.CHAIN, credits: probe.CREDITS, token: probe.TOKEN } }));
  const draft = { id: "0x1220" + "a".repeat(64), header: { chain_id: probe.CHAIN, payer: probe.OWNER, rc_limit: "100000000", nonce: "KAE=" }, operations: probe.OPERATIONS, signatures: [] };
  const tx = { ...draft, signatures: [Buffer.alloc(65, 1).toString("base64url")] };
  const saved = { transaction: tx, draft, transactionHash: hash(JSON.stringify(tx)), draftHash: hash(JSON.stringify(draft)),
    state: "unknown", held: true, attempts: 1, reason: null, intent: { actor: probe.OWNER, kind: "credits", method: "purchase", args: { amount: "10000000" }, maxRc: "100000000" } };
  const file = path.join(root, "journals", "funding-recovery.sqlite"), db = new DatabaseSync(file);
  db.exec("CREATE TABLE deposits(tx_id TEXT,data TEXT,hash TEXT)"); const data = JSON.stringify(saved);
  db.prepare("INSERT INTO deposits VALUES(?,?,?)").run(tx.id, data, hash(data)); db.close();
  return { dir, file, tx, saved };
}
test("diagnostic only simulates the unchanged saved deposit and preserves the journal bytes", async t => {
  const f = fixture(t), before = fs.readFileSync(f.file), deposit = probe.loadDeposit(f.dir, f.tx.id), calls = [];
  const report = await probe.diagnose(deposit, async (url, request) => {
    const q = JSON.parse(request.body); calls.push(q);
    assert.ok(["https://api.koinosblocks.com", "https://api.koinos.io"].includes(url));
    let result = {};
    if (q.method === "chain.get_chain_id") result = { chain_id: probe.CHAIN };
    if (q.method === "chain.submit_transaction") {
      assert.equal(q.params.broadcast, false); assert.deepEqual(q.params.transaction, f.tx);
      return { ok: true, json: async () => ({ error: { code: -32603, message: "insufficient rc", data: JSON.stringify({ logs: [], transaction: f.tx, privateKey: "never-print" }) } }) };
    }
    return { ok: true, json: async () => ({ result }) };
  });
  assert.equal(calls.filter(q => q.method === "chain.submit_transaction").length, 2);
  assert.equal(report.probes[0].simulation.error.message, "insufficient rc");
  assert.equal(JSON.stringify(report).includes(f.tx.signatures[0]), false);
  assert.equal(JSON.stringify(report).includes("never-print"), false);
  assert.deepEqual(fs.readFileSync(f.file), before);
});
test("diagnostic never simulates against the wrong chain or when the transaction is already found", async t => {
  for (const mode of ["wrong-chain", "found"]) {
    const f = fixture(t), deposit = probe.loadDeposit(f.dir, f.tx.id);
    await probe.diagnose(deposit, async (_url, request) => {
      const q = JSON.parse(request.body); assert.notEqual(q.method, "chain.submit_transaction");
      return { ok: true, json: async () => ({ result: q.method === "chain.get_chain_id" ? { chain_id: mode === "wrong-chain" ? "wrong" : probe.CHAIN } : q.method === "transaction_store.get_transactions_by_id" ? { transactions: [{ transaction: f.tx }] } : {} }) };
    });
  }
});
test("damaged or changed saved deposits stop before any network request", t => {
  const f = fixture(t);
  assert.throws(() => probe.loadDeposit(f.dir, "bad"), /transaction ID/);
  const db = new DatabaseSync(f.file); f.saved.transaction.operations = [];
  const data = JSON.stringify(f.saved); db.prepare("UPDATE deposits SET data=?,hash=?").run(data, hash(data)); db.close();
  assert.throws(() => probe.loadDeposit(f.dir, f.tx.id), /damaged/);
});
