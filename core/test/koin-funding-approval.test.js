"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
const { createFundingApproval } = require("../../electron/koin-funding-approval");
const { KoinChain } = require("../lib/koin-network/chain");
const { hash } = require("../lib/koin-network/job-protocol");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function window() {
  return Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false, isVisible: () => true, isMinimized: () => false });
}
function controller(f, extra = {}) {
  return createFundingApproval({ mode: "isolated-rehearsal", client: f.client, journal: f.journal, clock: () => f.state.now,
    dialog: { showMessageBox: async () => ({ response: 1 }) }, sign: f.sign,
    submit: async d => { f.state.submissions.push(d.transaction); }, ...extra });
}
async function staged(j, id) {
  for (let i = 0; i < 20 && !j.saved(id).signed; i++) await new Promise(setImmediate);
  assert.equal(j.saved(id).signed, true);
}

test("native fixture approval binds both exact deposit purposes and never exports a signature", async t => {
  for (const kind of ["credits", "rewards"]) {
    const f = fixture(t); f.request.kind = kind; f.request.method = kind === "credits" ? "purchase" : "fund";
    const w = window(); let detail;
    const c = controller(f, { dialog: { showMessageBox: async (_w, options) => { detail = options.detail; assert.equal(options.defaultId, 0); return { response: 1 }; } } });
    const result = await c.approve(w, f.id, () => f.request);
    assert.equal(result.status, "await_finality"); assert.equal(result.deposit.held, true);
    assert.equal(f.state.signed, 1); assert.equal(f.state.submissions.length, 1);
    const tx = f.state.submissions[0]; assert.ok(detail.includes(tx.id)); assert.ok(detail.includes(f.d[kind])); assert.ok(detail.includes(f.d.tokenHash));
    assert.equal(result.transaction, undefined); assert.equal(w.listenerCount("hide"), 0); assert.equal(w.webContents.listenerCount("did-start-navigation"), 0);
    await f.include(tx, { irreversible: true }); assert.equal((await c.check(f.id)).state, "funded");
    assert.equal((await c.approve(w, f.id, () => f.request)).status, "recover_existing"); assert.equal(f.state.signed, 1);
  }
});

test("Cancel and preview-shaped responses create no signing fence", async t => {
  for (const response of [{ response: 0 }, { status: "reviewed", mode: "funding-preview" }]) {
    const f = fixture(t), c = controller(f, { dialog: { showMessageBox: async () => response } });
    assert.equal((await c.approve(window(), f.id, () => f.request)).status, "cancelled");
    assert.equal(f.journal.saved(f.id), null); assert.equal(f.state.signed, 0); assert.equal(f.state.submissions.length, 0);
    assert.equal((await controller(f).approve(window(), f.id, () => f.request)).status, "await_finality");
  }
});

test("changed terms, nonce, pins, pause, clock and window lifecycle block approval before signing", async t => {
  for (const change of [
    f => { f.request.args.amount = "1"; }, f => { f.state.nonce = "KAI="; }, f => { f.state.paused = true; },
    f => { f.provider.invokeGetContractMetadata = async () => ({ value: { hash: "wrong" } }); },
    f => { f.state.now += 180000; }, f => { f.state.now--; },
    (_f, w) => w.emit("hide"), (_f, w) => w.emit("minimize"), (_f, w) => w.emit("closed"),
    (_f, w) => w.webContents.emit("did-start-navigation", {}, "somewhere", false, true),
    (_f, w) => w.webContents.emit("render-process-gone"),
  ]) {
    const f = fixture(t), w = window();
    const c = controller(f, { dialog: { showMessageBox: async () => { change(f, w); return { response: 1 }; } } });
    assert.ok(["cancelled", "unavailable"].includes((await c.approve(w, f.id, () => f.request)).status));
    assert.equal(f.state.signed, 0); assert.equal(f.state.submissions.length, 0);
  }
});

test("a nonce changing during the final draft preparation cannot create a signing fence", async t => {
  const f = fixture(t), prepare = f.client.prepare.bind(f.client); let calls = 0;
  f.client.prepare = async (...args) => { if (++calls === 2) f.state.nonce = "KAI="; return prepare(...args); };
  assert.equal((await controller(f).approve(window(), f.id, () => f.request)).status, "unavailable");
  assert.equal(f.journal.saved(f.id), null); assert.equal(f.state.signed, 0);
});

test("Stop returns while a native dialog is unresolved and its late response cannot approve", async t => {
  const f = fixture(t), shown = deferred(), reply = deferred();
  const c = controller(f, { dialog: { showMessageBox: () => { shown.resolve(); return reply.promise; } } });
  const pending = c.approve(window(), f.id, () => f.request); await shown.promise; c.cancel();
  assert.equal((await pending).status, "cancelled"); reply.resolve({ response: 1 });
  assert.equal(f.journal.saved(f.id), null); assert.equal(f.state.signed, 0);
});

test("Stop during signing saves a late signature, survives restart and resumes only after a new exact review", async t => {
  const f = fixture(t), signed = deferred(), delivery = deferred(); let tx;
  const c = controller(f, { sign: async d => { tx = await f.sign(d); signed.resolve(); await delivery.promise; return tx; } });
  const pending = c.approve(window(), f.id, () => f.request); await signed.promise; c.cancel();
  assert.equal((await pending).status, "stopped"); assert.equal(f.journal.status(f.id).held, true);
  delivery.resolve(); await staged(f.journal, f.id); assert.equal(f.state.submissions.length, 0);
  f.journal.close(); const journal = f.open(); let reviews = 0;
  const resumed = controller(f, { journal, dialog: { showMessageBox: async (_w, d) => { reviews++; assert.ok(d.detail.includes(tx.id)); return { response: 1 }; } } });
  assert.equal((await resumed.check(f.id)).reason, "funding_user_stopped");
  assert.equal((await f.runner(journal).tick(f.id)).reason, "funding_user_stopped");
  assert.equal((await resumed.approve(window(), f.id, () => f.request)).status, "recover_existing");
  f.state.now += 180001; f.state.height++; f.state.lib = f.state.height;
  assert.equal((await resumed.resume(window(), f.id, () => f.request)).status, "await_finality");
  assert.equal(reviews, 1); assert.equal(f.state.signed, 1); assert.equal(f.state.submissions.length, 1); assert.deepEqual(f.state.submissions[0], tx);
});

test("signing timeout holds a late envelope and a missing envelope never triggers another signature", async t => {
  const f = fixture(t), delivery = deferred(); let tx;
  const c = controller(f, { timeoutMs: 50, sign: async d => { tx = await f.sign(d); await delivery.promise; return tx; } });
  assert.equal((await c.approve(window(), f.id, () => f.request)).status, "stopped");
  assert.equal((await c.resume(window(), f.id, () => f.request)).status, "recover_signing_envelope");
  await assert.rejects(f.journal.begin(hash("another"), f.request), /owns this wallet nonce/);
  assert.equal(f.state.signed, 1); delivery.resolve(); await staged(f.journal, f.id);
  assert.equal(f.journal.status(f.id).held, true); assert.equal(f.state.submissions.length, 0);
});

test("two controllers with separate journal handles elect only one signer and submitter", async t => {
  const f = fixture(t), other = f.open();
  const results = await Promise.all([controller(f).approve(window(), f.id, () => f.request), controller(f, { journal: other }).approve(window(), f.id, () => f.request)]);
  assert.ok(results.some(r => r.status === "await_finality")); assert.equal(f.state.signed, 1); assert.equal(f.state.submissions.length, 1);
});

test("Stop during submission cannot erase a later irreversible deposit; checks never submit", async t => {
  const f = fixture(t); let c;
  c = controller(f, { submit: async d => { f.state.submissions.push(d.transaction); c.cancel(); await f.include(d.transaction, { irreversible: true }); throw Error("ack lost"); } });
  assert.equal((await c.approve(window(), f.id, () => f.request)).status, "stopped");
  f.journal.close(); const journal = f.open(), reopened = controller(f, { journal });
  assert.equal((await reopened.check(f.id)).state, "funded"); assert.equal((await reopened.resume(window(), f.id, () => f.request)).status, "complete");
  assert.equal(f.state.signed, 1); assert.equal(f.state.submissions.length, 1);
});
test("submission failures explain Mana or uncertainty without exposing RPC data or releasing the deposit", async t => {
  for (const [error, reason] of [
    ['{"message":"insufficient rc","private":"do-not-display"}', "funding_insufficient_rc"],
    ["lost response do-not-display", "funding_submission_uncertain"],
  ]) {
    const f = fixture(t), c = controller(f, { submit: async () => { throw Error(error); } });
    const result = await c.approve(window(), f.id, () => f.request);
    assert.equal(result.status, "await_finality"); assert.equal(result.reason, reason);
    assert.equal(result.deposit.state, "unknown"); assert.equal(result.deposit.attempts, 1);
    assert.equal(result.deposit.held, true); assert.equal(f.state.signed, 1);
    assert.equal(JSON.stringify(result).includes("do-not-display"), false);
    await assert.rejects(f.journal.begin(hash("another-deposit"), f.request), /owns this wallet nonce/);
  }
});

test("a Stop from another journal handle invalidates an already-open resume review", async t => {
  const f = fixture(t), other = f.open(), c = controller(f);
  await c.approve(window(), f.id, () => f.request); f.state.now += 1001;
  const stale = controller(f, { dialog: { showMessageBox: async () => { other.hold(f.id); return { response: 1 }; } } });
  assert.equal((await stale.resume(window(), f.id, () => f.request)).status, "unavailable");
  assert.equal(f.journal.status(f.id).held, true); assert.equal(f.state.submissions.length, 1); assert.equal(f.state.signed, 1);
});

test("resume preserves attempt caps and exact bytes, rejects changed intent and never resets the daily budget", async t => {
  const f = fixture(t, { maxAttempts: 2, maxRcPerDay: "10000000" }), c = controller(f);
  await c.approve(window(), f.id, () => f.request);
  assert.equal((await c.resume(window(), f.id, () => ({ ...f.request, args: { ...f.request.args, amount: "1" } }))).status, "unavailable");
  f.state.now += 1001; await c.resume(window(), f.id, () => f.request);
  assert.equal(f.state.submissions.length, 2); assert.deepEqual(...f.state.submissions);
  f.state.now += 1001; await c.resume(window(), f.id, () => f.request);
  assert.equal(f.journal.status(f.id).reason, "funding_attempt_limit"); assert.equal(f.state.submissions.length, 2); assert.equal(f.state.signed, 1);
  assert.equal((await c.resume(window(), f.id, () => f.request)).status, "unavailable");
  await f.include(f.state.submissions[0], { irreversible: true }); assert.equal((await c.check(f.id)).state, "funded");
  const id = hash("second-reviewed-deposit"); await c.approve(window(), id, () => f.request);
  assert.equal(f.journal.status(id).attempts, 0); assert.equal(f.state.submissions.length, 2);
});

test("read-only reconciliation never reserves an attempt and approval cannot mix clients or enable production", async t => {
  const f = fixture(t), draft = await f.journal.begin(f.id, f.request); await f.journal.stage(f.id, await f.sign(draft));
  assert.equal((await controller(f).check(f.id)).reason, "funding_resume_review_required"); assert.equal(f.journal.status(f.id).attempts, 0);
  assert.throws(() => controller(f, { client: new KoinChain(f.d, f.provider) }), /journal's client/);
  assert.throws(() => controller(f, { mode: "production" }), /isolated/);
  await assert.rejects(f.journal.beginReviewed(hash("no-review"), f.request, null, () => true), /review required/);
});
