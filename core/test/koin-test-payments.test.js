"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
const { TestPayments } = require("../../electron/koin-test-payments");
const { configuration, atoms } = require("../../electron/koin-test-config");
const { KoinChain, encodedAddress } = require("../lib/koin-network/chain");
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
  assert.equal((await handler(event, "purchase-info")).enabled, false);
  await assert.rejects(handler({ ...event, senderFrame: { url: w.webContents.mainFrame.url } }, "status"), /access denied/); stable.dispose();
  const manifestPath = require.resolve("../lib/koin-network/credit-service.json"), original = require(manifestPath);
  let testBuild;
  try {
    require.cache[manifestPath].exports = { schema: 1, state: "unavailable", reason: "Credit service is not activated in this fixture" };
    testBuild = registerTestPaymentIPC({ ...options, isTest: true });
  } finally { require.cache[manifestPath].exports = original; }
  assert.equal((await handler(event, "status")).configured, false);
  const availability = await handler(event, "purchase-info");
  assert.equal(availability.activation, "unavailable");
  assert.match(availability.blocked, /not activated/);
  assert.deepEqual(fs.readdirSync(root), [], "checking availability creates no payment or wallet records");
  // An earlier account may still be readable or require recovery. It must
  // never make the unrelated public purchase service appear ready.
  fs.mkdirSync(path.join(root, "koin-foundation-test"));
  fs.writeFileSync(path.join(root, "koin-foundation-test", "deployment.json"), "earlier account fixture");
  assert.deepEqual(await handler(event, "purchase-info"), availability);
  await assert.rejects(handler(event, "purchase-info", {}), /takes no arguments/);
  w.webContents.mainFrame.url = "http://127.0.0.1:9000/mascot.html";
  await assert.rejects(handler(event, "import"), /access denied/);
  await assert.rejects(handler(event, "purchase-info"), /access denied/);
  w.webContents.mainFrame.url = "http://127.0.0.1:9000/"; testBuild.dispose();
  await assert.rejects(handler(event, "purchase-info"), /open app/);
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
  assert.equal(result.creditAction, "refund"); assert.equal(result.reason, "credit_submission_pending");
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
test("Stop or hide during real submission verification prevents a late broadcast and preserves the signed refund", async t => {
  for (const stop of [f => f.controller.stop(), (_f, w) => w.emit("hide")]) {
    const f = setup(t), w = window();
    let reachedVerification, releaseVerification, signs = 0;
    const reached = new Promise(resolve => { reachedVerification = resolve; });
    const gate = new Promise(resolve => { releaseVerification = resolve; });
    const metadata = f.provider.invokeGetContractMetadata, sign = f.signer.signTransaction.bind(f.signer);
    f.signer.signTransaction = tx => { signs++; return sign(tx); };
    // Leave KoinChain.submit real. Delay its public verification reads only
    // after the reviewed envelope has been signed and persisted.
    f.provider.invokeGetContractMetadata = async address => {
      if (f.journal.nonceCoordinator.list().some(r => r.state === "signed")) {
        reachedVerification(); await gate;
      }
      return metadata(address);
    };
    const pending = f.controller.run(w, "refund", "1");
    await reached;
    const [reservation] = f.journal.nonceCoordinator.list();
    const saved = f.journal.nonceCoordinator.envelope(reservation.id);
    assert.equal(signs, 1); assert.equal(saved.signatures.length, 1);
    stop(f, w); releaseVerification();
    const stopped = await pending;
    assert.equal(stopped.state, "signed"); assert.equal(stopped.reason, "credit_submission_uncertain");
    assert.equal(f.state.submissions.length, 0);
    assert.deepEqual(f.journal.nonceCoordinator.envelope(reservation.id), saved);
    // A subsequent explicit review resends those exact bytes, without signing.
    f.state.now += 1001;
    await f.controller.run(w, "resume", reservation.id);
    assert.equal(signs, 1); assert.deepEqual(f.state.submissions, [saved]);
  }
});
test("a lost Test refund response cannot create another signature and resume uses identical bytes", async t => {
  const f = setup(t); let signs = 0;
  const sign = f.signer.signTransaction.bind(f.signer); f.signer.signTransaction = tx => { signs++; return sign(tx); };
  f.provider.call = async (_method, { transaction: tx }) => { f.state.submissions.push(structuredClone(tx)); throw Error("private RPC body: " + JSON.stringify(tx)); };
  const result = await f.controller.run(window(), "refund", "1"), first = f.state.submissions[0];
  assert.equal(result.state, "signed"); assert.equal(result.creditAction, "refund"); assert.equal(result.reason, "credit_submission_uncertain");
  assert.ok(!JSON.stringify(result).includes("private RPC body")); assert.ok(!JSON.stringify(result).includes(first.signatures[0]));
  const checked = await f.controller.run(window(), "check", result.id);
  assert.equal(checked.state, "signed"); assert.equal(checked.reason, "credit_saved_review_required");
  assert.equal(f.state.submissions.length, 1); assert.deepEqual(f.journal.nonceCoordinator.envelope(result.id), first);
  await assert.rejects(f.controller.run(window(), "refund", "2"), /owns this wallet nonce/);
  f.state.now += 1001; const resumed = await f.controller.run(window(), "resume", result.id);
  assert.equal(resumed.reason, "credit_submission_uncertain");
  assert.equal(signs, 1); assert.deepEqual(f.state.submissions[1], first);
  assert.equal(f.state.submissions.length, 2);
});
test("release reports a bounded Mana rejection while preserving its signed envelope and action label", async t => {
  const f = setup(t), session = hash("expired-session"), read = f.provider.readContract;
  const getSession = require("../lib/koin-network/credits-abi.json").methods.get_session.entry_point;
  f.provider.readContract = async op => op.entry_point === getSession ? {
    result: Buffer.from(await f.client.serializer.serialize({ session: {
      id: Buffer.from(session, "hex").toString("base64url"), owner: encodedAddress(f.wallet.address),
      settle_until: String(f.state.now - 1), closed: false,
    } }, "koin.Result")).toString("base64url"),
  } : read(op);
  let signs = 0; const sign = f.signer.signTransaction.bind(f.signer);
  f.signer.signTransaction = tx => { signs++; return sign(tx); };
  f.provider.call = async (_method, { transaction }) => {
    f.state.submissions.push(structuredClone(transaction));
    throw Object.assign(Error("insufficient rc: private body " + JSON.stringify(transaction)), { code: "koin_rpc_insufficient_rc" });
  };
  const result = await f.controller.run(window(), "release", session);
  assert.equal(result.state, "signed"); assert.equal(result.creditAction, "release"); assert.equal(result.reason, "credit_insufficient_rc");
  const saved = f.journal.nonceCoordinator.envelope(result.id);
  assert.deepEqual(saved, f.state.submissions[0]); assert.equal(signs, 1);
  assert.ok(!JSON.stringify(result).includes(saved.signatures[0])); assert.ok(!JSON.stringify(result).includes("private body"));
  assert.equal((await f.controller.status()).transactions[0].creditAction, "release");
  assert.equal((await f.controller.run(window(), "check", result.id)).reason, "credit_saved_review_required");
  assert.equal(f.state.submissions.length, 1); assert.equal(signs, 1);
  assert.deepEqual(f.journal.nonceCoordinator.envelope(result.id), saved);
});
test("credit confirmation distinguishes reported reversible transactions from an irreversible receipt without submitting", async t => {
  const f = setup(t), result = await f.controller.run(window(), "refund", "1");
  await f.include(f.state.submissions[0]);
  const pending = await f.controller.run(window(), "check", result.id);
  assert.equal(pending.state, "signed"); assert.equal(pending.reason, "credit_await_finality"); assert.equal(pending.creditAction, "refund");
  f.state.lib = f.state.height;
  const confirmed = await f.controller.run(window(), "check", result.id);
  assert.equal(confirmed.state, "finalized"); assert.equal(confirmed.reason, undefined); assert.equal(confirmed.creditAction, "refund");
  assert.equal(f.state.submissions.length, 1);
});
for (const [name, change, reason] of [
  ["changed nonce", f => { f.state.nonce = "KAI="; }, "credit_nonce_changed"],
  ["failed transaction lookup", f => { f.provider.getTransactionsById = async () => { throw Error("private RPC response"); }; }, "credit_confirmation_unavailable"],
  ["malformed transaction lookup", f => { f.provider.getTransactionsById = async () => ({ transactions: {} }); }, "credit_confirmation_unavailable"],
  ["failed nonce lookup", f => { f.provider.getNextNonce = async () => { throw Error("private nonce response"); }; }, "credit_confirmation_unavailable"],
  ["changed chain", f => { f.provider.getChainId = async () => "wrong-chain"; }, "credit_confirmation_unavailable"],
  ["RPC transition between recovery reads", f => { f.provider.readGeneration = 0; f.provider.getNextNonce = async () => { f.provider.readGeneration++; return f.state.nonce; }; }, "credit_confirmation_unavailable"],
]) test(`credit confirmation does not suggest resubmission after ${name}`, async t => {
  const f = setup(t), result = await f.controller.run(window(), "refund", "1"), saved = f.journal.nonceCoordinator.envelope(result.id);
  change(f);
  const checked = await f.controller.run(window(), "check", result.id);
  assert.equal(checked.state, "signed"); assert.equal(checked.creditAction, "refund"); assert.equal(checked.reason, reason);
  assert.ok(!JSON.stringify(checked).includes("private")); assert.deepEqual(f.journal.nonceCoordinator.envelope(result.id), saved);
  assert.equal(f.state.submissions.length, 1);
});
test("Test actions enforce deposit, refund and session limits before signatures", async t => {
  const f = setup(t);
  await assert.rejects(f.controller.run(window(), "purchase", "6"), /Test limit/);
  await assert.rejects(f.controller.run(window(), "refund", "6"), /available/);
  await assert.rejects(f.controller.run(window(), "reserve", { amount: "1" }), /manifest/);
  assert.equal(f.journal.nonceCoordinator.list().length, 0);
});
test("checking a saved deposit reports whether submission was attempted without sending again", async t => {
  const f = setup(t); f.state.available = "0";
  const draft = await f.journal.begin(f.id, f.request); await f.journal.stage(f.id, await f.sign(draft));
  const saved = await f.controller.run(window(), "check", f.id);
  assert.equal(saved.state, "signed"); assert.equal(saved.funding.reason, "funding_resume_review_required");
  assert.equal(saved.funding.attempts, 0); assert.equal(f.state.submissions.length, 0);
  await f.controller.run(window(), "resume", f.id);
  const unknown = await f.controller.run(window(), "check", f.id);
  assert.equal(unknown.state, "signed"); assert.equal(unknown.funding.state, "unknown");
  assert.equal(unknown.funding.attempts, 1); assert.equal(f.state.submissions.length, 1);
  await f.include(f.state.submissions[0], { irreversible: true });
  assert.equal((await f.controller.run(window(), "check", f.id)).state, "finalized");
  assert.equal(f.state.signed, 1); assert.equal(f.state.submissions.length, 1);
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
test("normal chat reserves only the available KOIN below the configured ceiling, and zero balance cannot sign", async t => {
  for (const available of ["10000000", "12"]) {
    const f = setup(t); f.state.available = available;
    const result = await f.controller.run(window(), "reserve"); assert.equal(result.state, "signed");
    const s = (await f.client.serializer.deserialize(f.state.submissions[0].operations[0].call_contract.args, "koin.Request")).session;
    assert.equal(s.remaining, available);
    assert.equal(s.per_job, BigInt(available) < BigInt(f.config.limits.perJob) ? available : f.config.limits.perJob);
  }
  const f = setup(t); f.state.available = "0";
  await assert.rejects(f.controller.run(window(), "reserve"), /Add KOIN/);
  assert.equal(f.state.submissions.length, 0); assert.equal(f.journal.nonceCoordinator.list().length, 0);
});
test("expired reservations retain their saved identity and show the contract deadline; release waits for both local and chain time", async t => {
  const f = setup(t), reserved = await f.controller.run(window(), "reserve"), tx = f.state.submissions[0];
  const original = (await f.client.serializer.deserialize(tx.operations[0].call_contract.args, "koin.Request")).session;
  await f.include(tx, { irreversible: true });
  await f.controller.run(window(), "check", reserved.id);
  const session = { ...original, settle_until: String(Number(original.expires) + 86400000) };
  const read = f.provider.readContract, abi = require("../lib/koin-network/credits-abi.json");
  f.provider.readContract = async op => {
    let value;
    if (op.entry_point === abi.methods.get_session.entry_point) value = { session };
    else if (op.entry_point === abi.methods.balances.entry_point && op.args) value = { balance: { available: "0", reserved: original.remaining } };
    else return read(op);
    return { result: Buffer.from(await f.client.serializer.serialize(value, "koin.Result")).toString("base64url") };
  };
  let chainTime = Number(original.expires) + 1;
  f.provider.getHeadInfo = async () => ({ head_block_time: String(chainTime) });
  assert.deepEqual((await f.controller.status()).expiredReservations, []);
  f.state.now = Number(original.expires) + 1;
  const [expired] = (await f.controller.status()).expiredReservations;
  assert.equal(expired.session, Buffer.from(original.id, "base64url").toString("hex"));
  assert.equal(expired.remaining, original.remaining); assert.equal(expired.canRelease, false); assert.equal(expired.releaseAfter, Number(session.settle_until));
  await assert.rejects(f.controller.run(window(), "release", expired.session), /settlement window/);
  assert.equal(f.state.submissions.length, 1);
  f.state.now = Number(session.settle_until) + 1;
  assert.equal((await f.controller.status()).expiredReservations[0].canRelease, false);
  chainTime = f.state.now;
  assert.equal((await f.controller.status()).expiredReservations[0].canRelease, true);
  session.owner = encodedAddress(f.d.admin);
  await assert.rejects(f.controller.status(), /differs from its saved approval/);
  session.owner = original.owner; session.remaining = "0";
  assert.deepEqual((await f.controller.status()).expiredReservations, []);
  session.remaining = original.remaining; session.closed = true;
  assert.deepEqual((await f.controller.status()).expiredReservations, []);
  assert.equal(f.state.submissions.length, 1);
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
