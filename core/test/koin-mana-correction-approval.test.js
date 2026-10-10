"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
const { TestPayments } = require("../../electron/koin-test-payments");
function window() { return Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false, isVisible: () => true, isMinimized: () => false }); }
async function setup(t) {
  const f = fixture(t, { mainnet: true, maxRcPerDay: "1000000000" });
  f.request.maxRc = "100000000"; f.request.args.amount = "10000000";
  await f.runner().start(f.id, f.request);
  f.journal.nonceCoordinator.authorizeSubmission(f.id, { maxRcPerDay: "1000000000" });
  f.journal.hold(f.id);
  const original = f.journal.nonceCoordinator.envelope(f.id), calls = [], reviews = [];
  const config = { mode: "mainnet-pilot", deployment: f.d, owner: f.signer.getAddress(),
    maxRcPerTransaction: "100000000", maxRcPerDay: "1000000000", limits: { amount: "10000000" } };
  f.provider.getAccountRc = async () => "14948227003";
  f.provider.call = async (method, params) => {
    calls.push({ method, ...structuredClone(params) });
    return { receipt: { id: params.transaction.id, payer: config.owner, rc_used: "220000000", reverted: false } };
  };
  let signs = 0;
  const sign = f.signer.signTransaction.bind(f.signer);
  f.signer.signTransaction = async tx => { signs++; return sign(tx); };
  const make = (journal = f.journal, extra = {}) => new TestPayments({ config, client: f.client, journal,
    wallet: { address: config.owner, signer: f.signer }, clock: () => f.state.now,
    authorizeHost: async () => {}, dialog: { showMessageBox: async (_w, review) => { reviews.push(review); return { response: 1 }; } }, ...extra });
  return { ...f, config, original, calls, reviews, make, signs: () => signs };
}
test("native Mana correction preserves original deposit and restart replays the corrected envelope without resigning", async t => {
  const f = await setup(t), c = f.make(), result = await c.run(window(), "correct-mana", f.id);
  assert.equal(result.state, "correction_await_finality");
  assert.equal(f.signs(), 1); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].broadcast, false); assert.equal(f.calls[1].broadcast, true);
  assert.deepEqual(f.calls[0].transaction, f.calls[1].transaction);
  const corrected = f.calls[1].transaction;
  assert.equal(corrected.header.rc_limit, "900000000"); assert.equal(corrected.header.nonce, f.original.header.nonce);
  assert.deepEqual(corrected.operations, f.original.operations);
  assert.deepEqual(f.journal.nonceCoordinator.envelope(f.id), f.original);
  assert.equal(f.journal.status(f.id).attempts, 1);
  assert.match(f.reviews[0].detail, /0.10000000 KOIN/); assert.match(f.reviews[0].detail, /9.00000000 Mana/);
  assert.equal(f.reviews[0].defaultId, 0);
  f.journal.close(); f.state.now += 1001;
  const reopened = f.open(), resumed = f.make(reopened);
  await resumed.run(window(), "resume", f.id);
  assert.equal(f.signs(), 1); assert.deepEqual(f.calls.at(-1).transaction, corrected);
  await f.include(corrected, { irreversible: false });
  let checked = await resumed.run(window(), "check", f.id);
  assert.equal(checked.state, "signed"); assert.notEqual(checked.funding.state, "funded");
  f.state.lib = f.state.height;
  checked = await resumed.run(window(), "check", f.id);
  assert.equal(checked.state, "consumed_elsewhere"); assert.equal(checked.funding.state, "funded");
  assert.equal(checked.correction.state, "finalized");
  assert.deepEqual(reopened.nonceCoordinator.envelope(f.id), f.original);
});
test("cancel and denied host lease create no correction or signature", async t => {
  const f = await setup(t);
  const c = f.make(f.journal, { dialog: { showMessageBox: async () => ({ response: 0 }) } });
  assert.equal((await c.run(window(), "correct-mana", f.id)).state, "cancelled");
  assert.equal(f.journal.nonceCoordinator.correction(f.id), null); assert.equal(f.signs(), 0);
  const denied = f.make(f.journal, { authorizeHost: async () => { throw Error("host denied"); } });
  await assert.rejects(denied.run(window(), "correct-mana", f.id), /host denied/);
  assert.equal(f.signs(), 0); assert.equal(f.calls.length, 0);
});
test("failed simulation retains correction without broadcast; later native resume never signs twice", async t => {
  const f = await setup(t), c = f.make(), call = f.provider.call;
  f.provider.call = async () => { throw Error("insufficient rc"); };
  const failed = await c.run(window(), "correct-mana", f.id);
  assert.equal(failed.state, "correction_simulation_failed"); assert.equal(failed.reason, "funding_insufficient_rc");
  assert.equal(f.signs(), 1); assert.equal(failed.correction.attempts, 0); assert.equal(f.calls.length, 0);
  const envelope = f.journal.nonceCoordinator.correction(f.id).transaction;
  assert.throws(() => f.journal.nonceCoordinator.authorizeSubmission(f.id, { maxRcPerDay: "1000000000" }));
  f.provider.call = call;
  await c.run(window(), "resume", f.id);
  assert.equal(f.signs(), 1); assert.deepEqual(f.calls.at(-1).transaction, envelope);
});
test("Stop during signing preserves the late correction and blocks simulation and broadcast", async t => {
  const f = await setup(t), c = f.make(), sign = f.signer.signTransaction;
  f.signer.signTransaction = async tx => { c.stop(); return sign(tx); };
  await assert.rejects(c.run(window(), "correct-mana", f.id), /stopped/);
  assert.equal(f.signs(), 1); assert.ok(f.journal.nonceCoordinator.correction(f.id).transaction);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.journal.nonceCoordinator.envelope(f.id), f.original);
});
test("an original transaction winning during simulation prevents correction broadcast", async t => {
  const f = await setup(t), call = f.provider.call;
  f.provider.call = async (method, params) => {
    const result = await call(method, params); await f.include(f.original, { irreversible: true }); return result;
  };
  const result = await f.make().run(window(), "correct-mana", f.id);
  assert.equal(result.state, "finalized"); assert.equal(result.funding.state, "funded");
  assert.equal(result.correction.state, "superseded"); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].broadcast, false);
});
test("a reverted correction releases the nonce but never marks the deposit funded", async t => {
  const f = await setup(t), c = f.make();
  await c.run(window(), "correct-mana", f.id);
  await f.include(f.calls.at(-1).transaction, { irreversible: true, reverted: true });
  const result = await c.run(window(), "check", f.id);
  assert.equal(result.correction.state, "reverted"); assert.equal(result.funding.state, "reverted");
});
test("a signing failure stays fenced across restart and never triggers another signature", async t => {
  const f = await setup(t); let attempts = 0;
  f.signer.signTransaction = async () => { attempts++; throw Error("lost signing response"); };
  await assert.rejects(f.make().run(window(), "correct-mana", f.id), /lost signing/);
  f.journal.close(); const reopened = f.open();
  await assert.rejects(f.make(reopened).run(window(), "resume", f.id), /signing fence/);
  assert.equal(attempts, 1); assert.equal(f.calls.length, 0);
});
test("Stop during the final chain verification prevents broadcast", async t => {
  const f = await setup(t), c = f.make(), verify = f.client.verify.bind(f.client); let trigger = false;
  const authorize = f.journal.nonceCoordinator.authorizeCorrectionSubmission.bind(f.journal.nonceCoordinator);
  f.journal.nonceCoordinator.authorizeCorrectionSubmission = (...args) => { trigger = true; return authorize(...args); };
  f.client.verify = async () => { const result = await verify(); if (trigger) c.stop(); return result; };
  const result = await c.run(window(), "correct-mana", f.id);
  assert.equal(result.state, "correction_await_finality"); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].broadcast, false);
});
test("a lost correction broadcast response times out and leaves confirmation checks usable without another send", async t => {
  const f = await setup(t), c = f.make(), call = f.provider.call, timer = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => timer(fn, ms === 30000 ? 10 : ms, ...args);
  t.after(() => { global.setTimeout = timer; });
  f.provider.call = async (method, params) => {
    const result = await call(method, params);
    return params.broadcast ? new Promise(() => {}) : result;
  };
  const result = await c.run(window(), "correct-mana", f.id);
  assert.equal(result.state, "correction_await_finality"); assert.equal(result.reason, "funding_submission_uncertain");
  assert.equal(result.correction.attempts, 1);
  const checked = await c.run(window(), "check", f.id);
  assert.equal(checked.state, "signed"); assert.equal(f.calls.length, 2); assert.equal(f.signs(), 1);
});
