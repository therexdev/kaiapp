"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
const { TestPayments } = require("../../electron/koin-test-payments");
const { configuration, atoms } = require("../../electron/koin-test-config");
const { KoinChain } = require("../lib/koin-network/chain");
const { assertPaymentMode, FOUNDATION_CHAIN, FOUNDATION_TOKEN } = require("../lib/koin-network/payment-mode");
const { hash } = require("../lib/koin-network/job-protocol");
function window() { return Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false, isVisible: () => true, isMinimized: () => false }); }
function setup(t, extra = {}) {
  const f = fixture(t), config = { schema: 1, mode: "isolated-rehearsal", deployment: f.d, owner: f.signer.getAddress(),
    schedulerUrl: "https://test.example/scheduler", policyHash: hash("test-prices"), version: 1, model: "koinos-fast", maxOutput: 128,
    maxRcPerTransaction: "10000000", maxRcPerDay: "20000000", limits: { amount: "500000000", perJob: "1000000", maxJobs: 10, durationMs: 3600000 } };
  f.state.available = "500000000";
  f.provider.call = async (_method, { transaction: tx }) => { f.state.submissions.push(structuredClone(tx)); return {}; };
  const wallet = { address: f.signer.getAddress(), signer: f.signer };
  const controller = new TestPayments({ config, client: f.client, journal: f.journal, wallet,
    clock: () => f.state.now, dialog: { showMessageBox: async () => ({ response: 1 }) }, ...extra });
  return { ...f, config, wallet, controller };
}
test("Test payment IPC rejects other documents and keeps stable builds disabled", async t => {
  const fs = require("fs"), path = require("path"), os = require("os"), { registerTestPaymentIPC } = require("../../electron/koin-test-ipc");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-test-ipc-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const w = window(); w.webContents.mainFrame = { url: "http://127.0.0.1:9000/" };
  let handler; const options = { dataDir: root, core: {}, dialog: {}, origin: "http://127.0.0.1:9000", getMainWindow: () => w,
    ipcMain: { handle: (_name, h) => { handler = h; } } };
  const stable = registerTestPaymentIPC({ ...options, isTest: false }), event = { sender: w.webContents, senderFrame: w.webContents.mainFrame };
  assert.equal((await handler(event, "purchase", "1")).enabled, false);
  await assert.rejects(handler({ ...event, senderFrame: { url: w.webContents.mainFrame.url } }, "status"), /access denied/); stable.dispose();
  const testBuild = registerTestPaymentIPC({ ...options, isTest: true });
  assert.equal((await handler(event, "status")).configured, false);
  w.webContents.mainFrame.url = "http://127.0.0.1:9000/mascot.html";
  await assert.rejects(handler(event, "import"), /access denied/); testBuild.dispose();
});
test("Test manifests reject mainnet, changed chain identity, arbitrary fields and imprecise amounts", t => {
  const f = setup(t), c = structuredClone(f.config); c.mode = "test-deployment";
  c.deployment.network = "foundation-testnet"; c.deployment.rpc = ["https://testnet.koinosfoundation.org/jsonrpc"];
  c.deployment.chainId = FOUNDATION_CHAIN; c.deployment.token = FOUNDATION_TOKEN;
  assert.equal(configuration(c).mode, "test-deployment");
  for (const mutate of [x => x.deployment.network = "mainnet", x => x.deployment.chainId = f.d.chainId, x => x.deployment.token = f.d.token, x => x.privateKey = "forbidden", x => x.limits.perJob = "900000000"]) {
    const bad = structuredClone(c); mutate(bad); assert.throws(() => configuration(bad));
  }
  assert.throws(() => assertPaymentMode("test-deployment", f.client));
  assert.throws(() => assertPaymentMode("isolated-rehearsal", new KoinChain(c.deployment)));
  assert.equal(atoms("1.00000001"), "100000001");
  for (const n of ["0", "-1", "1e3", "1.000000001", "01", 1]) assert.throws(() => atoms(n));
});
test("Test refund requires an exact native review and persists signed bytes before transport", async t => {
  let review; const f = setup(t, { dialog: { showMessageBox: async (_w, value) => { review = value; return { response: 1 }; } } });
  const result = await f.controller.run(window(), "refund", "1");
  assert.equal(result.state, "signed"); assert.equal(f.state.submissions.length, 1);
  assert.ok(review.detail.includes("1.00000000")); assert.ok(review.detail.includes(f.d.credits)); assert.ok(review.detail.includes(result.txId));
  assert.equal(review.defaultId, 0); assert.equal(result.transaction, undefined);
  assert.deepEqual(f.journal.nonceCoordinator.envelope(result.id), f.state.submissions[0]);
  await f.include(f.state.submissions[0], { irreversible: true });
  assert.equal((await f.controller.run(window(), "check", result.id)).state, "finalized");
});
test("Stop during native review and locked or changed wallets never sign", async t => {
  const f = setup(t), w = window(); let c;
  c = new TestPayments({ config: f.config, client: f.client, journal: f.journal, wallet: f.wallet, clock: () => f.state.now,
    dialog: { showMessageBox: async () => { c.stop(); return { response: 1 }; } } });
  await assert.rejects(c.run(w, "refund", "1"), /stopped/);
  assert.equal(f.journal.nonceCoordinator.list().length, 0); assert.equal(f.state.submissions.length, 0);
  Object.defineProperty(f.wallet, "signer", { get() { throw Error("Wallet is locked"); } });
  await assert.rejects(f.controller.run(w, "refund", "1"), /locked/); assert.equal(f.journal.nonceCoordinator.list().length, 0);
});
test("a lost Test refund response cannot create another signature and resume uses identical bytes", async t => {
  const f = setup(t); let signs = 0;
  const sign = f.signer.signTransaction.bind(f.signer); f.signer.signTransaction = tx => { signs++; return sign(tx); };
  f.provider.call = async (_method, { transaction: tx }) => { f.state.submissions.push(structuredClone(tx)); throw Error("lost"); };
  const result = await f.controller.run(window(), "refund", "1"), first = f.state.submissions[0];
  await assert.rejects(f.controller.run(window(), "refund", "2"), /owns this wallet nonce/);
  f.state.now += 1001; await f.controller.run(window(), "resume", result.id);
  assert.equal(signs, 1); assert.deepEqual(f.state.submissions[1], first);
  assert.equal(f.state.submissions.length, 2);
});
test("Test actions enforce deposit, refund and session limits before signatures", async t => {
  const f = setup(t);
  await assert.rejects(f.controller.run(window(), "purchase", "6"), /Test limit/);
  await assert.rejects(f.controller.run(window(), "refund", "6"), /available/);
  await assert.rejects(f.controller.run(window(), "reserve", { amount: "1" }), /manifest/);
  assert.equal(f.journal.nonceCoordinator.list().length, 0);
});
test("a rejected Test host lease prevents deposits and refunds before any local signing fence", async t => {
  const f = setup(t, { authorizeHost: async () => { throw Error("Another installation owns this Test wallet"); } });
  for (const action of ["purchase", "fund-rewards", "refund", "reserve"]) await assert.rejects(f.controller.run(window(), action, action === "reserve" ? undefined : "1"), /Another installation/);
  assert.equal(f.journal.nonceCoordinator.list().length, 0); assert.equal(f.state.submissions.length, 0);
});
test("Test reserve binds configured per-request and total limits into the on-chain operation", async t => {
  const f = setup(t); const result = await f.controller.run(window(), "reserve");
  assert.equal(result.state, "signed");
  const tx = f.state.submissions[0], s = (await f.client.serializer.deserialize(tx.operations[0].call_contract.args, "koin.Request")).session;
  assert.equal(s.remaining, f.config.limits.amount); assert.equal(s.per_job, f.config.limits.perJob);
  assert.equal(s.max_jobs, String(f.config.limits.maxJobs)); assert.equal(s.expires, String(f.state.now + 3600000));
});
test("desktop and backend derive the same protocol-valid session domain from deployment pins", t => {
  const f = setup(t), { testDomain } = require("../lib/koin-network/payment-mode"), D = require("../lib/koin-network/session-delegation");
  const domain = testDomain(f.d, f.config.schedulerUrl);
  assert.equal(D.target({ chainId: f.d.chainId, credits: f.d.credits, creditsHash: f.d.creditsHash, domain, policyHash: f.config.policyHash }).domain, domain);
  assert.notEqual(domain, testDomain(f.d, "https://other.example/scheduler"));
  assert.notEqual(domain, testDomain({ ...f.d, chainId: "another-chain" }, f.config.schedulerUrl));
});
test("journal backup survives a read-only reopen, and changed host identity blocks copied state", async t => {
  const { JournalSet } = require("../lib/koin-network/journal-set"), fs = require("fs"), path = require("path"), { DatabaseSync } = require("node:sqlite");
  const f = setup(t), destination = f.dir + "-backup"; t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const g = new JournalSet(f.dir, { maintenance: true }); g.snapshot(destination); f.journal.close();
  const reopened = f.open(); reopened.close(); assert.equal(g.inspect(destination).restorable, true); g.close();
  const db = new DatabaseSync(f.dir + ".recovery-anchor.sqlite"); db.prepare("UPDATE ownership SET host=?").run("another-system"); db.close();
  assert.throws(() => new JournalSet(f.dir), /another host/);
});
