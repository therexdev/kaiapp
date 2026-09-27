"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { DatabaseSync } = require("node:sqlite"), path = require("path");
const { Signer, Transaction } = require("koilib");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
const { FundingRecovery } = require("../../electron/koin-funding-recovery"), { hash } = require("../lib/koin-network/job-protocol");

test("funding restart after lost inclusion response confirms one exact deposit with no new signature", async t => {
  for (const kind of ["credits", "rewards"]) {
    const f = fixture(t); f.request.kind = kind; f.request.method = kind === "credits" ? "purchase" : "fund";
    const runner = f.runner(f.journal, { submit: async d => { f.state.submissions.push(d.transaction); await f.include(d.transaction); throw Error("ack lost"); } });
    assert.equal((await runner.start(f.id, f.request)).action, "await_finality");
    assert.equal(f.journal.status(f.id).state, "unknown"); f.journal.close(); const reopened = f.open();
    assert.equal((await f.runner(reopened).tick(f.id)).action, "wait"); f.state.lib = f.state.height;
    assert.equal((await f.runner(reopened).tick(f.id)).state, "funded");
    assert.equal((await f.runner(reopened).start(f.id, f.request)).state, "funded");
    assert.equal(f.state.signed, 1); assert.equal(f.state.submissions.length, 1); assert.equal(reopened.status(f.id).attempts, 1);
    const next = await reopened.begin(hash("next"), f.request); assert.equal(next.action, "prepare_funding");
  }
});

test("signing timeout and process restart preserve the signing fence; exact late envelope can be recovered", async t => {
  const f = fixture(t); let original;
  await assert.rejects(f.runner(f.journal, { timeoutMs: 50, sign: async d => { original = await f.sign(d); return new Promise(() => {}); } }).start(f.id, f.request), /response lost/);
  f.journal.close(); const other = f.open();
  assert.equal((await f.runner(other).start(f.id, f.request)).reason, "recover_signing_envelope");
  await assert.rejects(other.begin(hash("another"), f.request), /owns this wallet nonce/);
  assert.equal(f.state.signed, 1); assert.equal(f.state.submissions.length, 0);
  await other.stage(f.id, original); assert.equal((await f.runner(other).tick(f.id)).action, "await_finality");
});

test("concurrent handles elect one signer and one initial submission", async t => {
  const f = fixture(t), second = f.open();
  const results = await Promise.allSettled([f.runner().start(f.id, f.request), f.runner(second).start(f.id, f.request)]);
  assert.ok(results.some(r => r.status === "fulfilled")); assert.equal(f.state.signed, 1); assert.equal(f.state.submissions.length, 1);
  await assert.rejects(second.begin(hash("other"), { ...f.request, kind: "rewards", method: "fund" }), /owns this wallet nonce/);
});

test("uncertain retries reuse exact bytes, enforce cooldown, stop at attempt cap and still accept late finality", async t => {
  const f = fixture(t, { maxAttempts: 2 }); await f.runner().start(f.id, f.request);
  assert.equal((await f.runner().tick(f.id)).reason, "funding_retry_delay"); f.state.now += 1001;
  // The fixture's canonical snapshot timestamp advances; refresh the observer after a restart.
  f.journal.close(); const j = f.open(); await f.runner(j).tick(f.id);
  assert.equal(f.state.submissions.length, 2); assert.deepEqual(f.state.submissions[0], f.state.submissions[1]);
  assert.equal((await f.runner(j).tick(f.id)).reason, "funding_attempt_limit");
  await f.include(f.state.submissions[0], { irreversible: true });
  assert.equal((await f.runner(j).tick(f.id)).state, "funded"); assert.equal(f.state.signed, 1);
});

test("pending, reversible, forked or incomplete receipts cannot confirm a deposit", async t => {
  const f = fixture(t); await f.runner().start(f.id, f.request); const tx = f.state.submissions[0];
  f.state.record = { transaction: tx }; assert.equal((await f.runner().tick(f.id)).reason, "funding_pending");
  await f.include(tx); assert.equal((await f.runner().tick(f.id)).action, "wait");
  f.state.lib = f.state.height; f.state.fork = true; assert.equal((await f.runner().tick(f.id)).reason, "funding_forked");
  f.state.fork = false; f.state.block.receipt.transaction_receipts = [];
  await assert.rejects(f.runner().tick(f.id), /Missing finalized/); assert.equal(f.journal.status(f.id).state, "unknown");
});

test("a reverted deposit resolves only after its canonical irreversible receipt and fresh state", async t => {
  const f = fixture(t); await f.runner().start(f.id, f.request);
  await f.include(f.state.submissions[0], { reverted: true }); assert.equal((await f.runner().tick(f.id)).action, "wait");
  f.state.lib = f.state.height; assert.equal((await f.runner().tick(f.id)).state, "reverted");
  assert.equal(f.state.liquid, "0"); assert.equal((await f.journal.begin(hash("explicit-new-review"), f.request)).action, "prepare_funding");
});

test("wrong transfer, malformed receipt, missing backing and residual allowance cannot activate credits", async t => {
  for (const change of [
    f => { f.state.block.receipt.transaction_receipts[0].events[0].source = f.d.rewards; },
    f => { f.state.block.receipt.transaction_receipts[0].events[0].data = ""; },
    f => { f.state.block.receipt.transaction_receipts[0].reverted = "false"; },
    f => { f.state.block.receipt.transaction_receipts[0].payer = f.d.admin; },
    f => { f.state.liquid = "0"; },
  ]) {
    const f = fixture(t); await f.runner().start(f.id, f.request); await f.include(f.state.submissions[0], { irreversible: true }); change(f);
    await assert.rejects(f.runner().tick(f.id)); assert.equal(f.journal.status(f.id).state, "unknown");
  }
  const f = fixture(t); await f.runner().start(f.id, f.request); await f.include(f.state.submissions[0], { irreversible: true });
  f.state.allowance = "1"; assert.equal((await f.runner().tick(f.id)).reason, "residual_allowance");
});

test("saved funding rejects wider terms, another signer, replacement nonce and post-await mutation", async t => {
  const f = fixture(t), d = await f.journal.begin(f.id, f.request), signed = await f.sign(d);
  for (const mutate of [tx => { tx.operations.reverse(); }, tx => { tx.header.nonce = "KAI="; }, tx => { tx.header.rc_limit = "10000001"; }]) {
    const tx = structuredClone(d.transaction); mutate(tx); const changed = await Transaction.prepareTransaction(tx); await f.signer.signTransaction(changed);
    await assert.rejects(f.journal.stage(f.id, changed));
  }
  const wrong = structuredClone(d.transaction); await Signer.fromSeed("wrong-funding-signer").signTransaction(wrong);
  await assert.rejects(f.journal.stage(f.id, wrong), /signer/);
  await assert.rejects(f.journal.begin(f.id, { ...f.request, args: { ...f.request.args, amount: "1" } }), /replace funding intent/);
  const pending = f.journal.stage(f.id, signed); signed.operations.reverse(); await pending;
  assert.equal((await f.runner().tick(f.id)).action, "await_finality"); assert.equal(f.state.submissions[0].operations[0].call_contract.contract_id, f.d.token);
});

test("policy, pause, wallet nonce or expired review changes stop an unsubmitted signed deposit", async t => {
  for (const change of [f => { f.config.version = "2"; }, f => { f.state.paused = true; }, f => { f.state.nonce = "KAI="; }, f => { f.state.now += 180000; }]) {
    const f = fixture(t), d = await f.journal.begin(f.id, f.request); await f.journal.stage(f.id, await f.sign(d)); change(f);
    assert.equal((await f.runner().tick(f.id)).action, "review"); assert.equal(f.state.submissions.length, 0);
  }
});

test("daily Mana ceiling survives restart and separate confirmed deposits", async t => {
  const f = fixture(t, { maxRcPerDay: "10000000" }); await f.runner().start(f.id, f.request);
  await f.include(f.state.submissions[0], { irreversible: true }); assert.equal((await f.runner().tick(f.id)).state, "funded");
  const second = hash("next-budgeted-deposit"); assert.equal((await f.runner().start(second, f.request)).reason, "funding_daily_rc_budget");
  assert.equal(f.state.submissions.length, 1); f.journal.close(); const j = f.open();
  assert.equal((await f.runner(j).tick(second)).reason, "funding_daily_rc_budget");
});

test("changed chain/code, malformed reads, damaged journal and backwards clocks fail closed", async t => {
  for (const change of [f => { f.provider.getChainId = async () => "wrong"; },
    f => { f.provider.invokeGetContractMetadata = async () => ({ value: { hash: "wrong" } }); },
    f => { f.provider.readContract = async () => ({ error: "unavailable" }); },
    f => { f.state.now--; },
    f => { const db = new DatabaseSync(path.join(f.dir, "funding-recovery.sqlite")); db.exec("UPDATE deposits SET data='{}'"); db.close(); },
    f => { const db = new DatabaseSync(path.join(f.dir, "funding-recovery.sqlite")); db.exec("DELETE FROM mana"); db.close(); },
  ]) {
    const f = fixture(t); await f.runner().start(f.id, f.request); change(f); await assert.rejects(f.runner().tick(f.id));
    assert.equal(f.state.submissions.length, 1);
  }
  const f = fixture(t); assert.throws(() => new FundingRecovery(f.dir, { mode: "production", client: f.client, maxRcPerDay: "1" }), /isolated/);
  assert.throws(() => f.open({ maxRcPerDay: "1" }), /policy changed/);
});
