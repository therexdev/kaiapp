"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite"), { Transaction, Signer } = require("koilib");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
const { hash } = require("../lib/koin-network/job-protocol");
const policy = { maxRcPerDay: "1000000000" };
async function pending(t) {
  const f = fixture(t, policy); f.request.maxRc = "100000000";
  const d = await f.journal.begin(f.id, f.request), tx = await f.sign(d);
  await f.journal.stage(f.id, tx);
  const n = f.journal.nonceCoordinator; n.authorizeSubmission(f.id, policy);
  return { ...f, n, original: tx };
}
async function corrected(f, mutate = () => {}) {
  const tx = structuredClone(f.original); tx.signatures = []; tx.header.rc_limit = "900000000"; mutate(tx);
  await Transaction.prepareTransaction(tx); return tx;
}
async function stage(f) {
  const draft = await corrected(f); await f.n.reserveCorrection(f.id, draft);
  const tx = await f.sign({ transaction: draft }); await f.n.stageCorrection(f.id, tx); return tx;
}
function row(f) {
  const db = new DatabaseSync(path.join(f.dir, "wallet-nonces.sqlite"), { readOnly: true });
  try { return JSON.parse(db.prepare("SELECT data FROM reservations WHERE id=?").get(f.id).data); }
  finally { db.close(); }
}

test("one same-nonce Mana correction preserves the original and its attempts across restart", async t => {
  const f = await pending(t), before = row(f), draft = await corrected(f);
  assert.equal((await f.n.reserveCorrection(f.id, draft)).action, "sign_original");
  assert.equal(f.n.correction(f.id).state, "signing");
  assert.throws(() => f.n.authorizeSubmission(f.id, policy), /saved Mana correction/);
  assert.equal((await f.n.reserveCorrection(f.id, draft)).action, "recover_existing");
  const tx = await f.sign({ transaction: draft }); await f.n.stageCorrection(f.id, tx);
  assert.deepEqual(f.n.draft(f.id), before.draft); assert.deepEqual(f.n.envelope(f.id), before.transaction);
  assert.deepEqual(row(f).submissions, before.submissions);
  f.journal.close(); const reopened = f.open(), n = reopened.nonceCoordinator;
  assert.deepEqual(n.correction(f.id).transaction, tx);
  assert.equal(n.status(f.id).correction.rcLimit, "900000000");
  const copy = n.correction(f.id); copy.transaction.header.nonce = "KAI=";
  assert.equal(n.correction(f.id).transaction.header.nonce, "KAE=");
  assert.throws(() => n.authorizeSubmission(f.id, policy), /saved Mana correction/);
  assert.equal(f.state.signed, 2);
});

test("concurrent correction reviews elect one signing fence and a lost response never permits re-signing", async t => {
  const f = await pending(t), draft = await corrected(f), second = f.open();
  const results = await Promise.all([f.n.reserveCorrection(f.id, draft), second.nonceCoordinator.reserveCorrection(f.id, draft)]);
  assert.deepEqual(results.map(x => x.action).sort(), ["recover_existing", "sign_original"]);
  f.journal.close(); second.close(); const n = f.open().nonceCoordinator;
  assert.equal((await n.reserveCorrection(f.id, draft)).action, "recover_existing");
  assert.equal(n.correction(f.id).transaction, null);
  assert.throws(() => n.authorizeCorrectionSubmission(f.id, policy), /signed Mana correction/);
  await assert.rejects(n.reserveCorrection(f.id, await corrected(f, x => { x.header.rc_limit = "800000000"; })), /Cannot replace/);
  const other = structuredClone(draft); other.header.nonce = "KAI="; await Transaction.prepareTransaction(other);
  await assert.rejects(n.reserve(hash("unrelated-new-wallet-request"), "credits", other), /nonce changed|owns this wallet nonce/);
  assert.equal(f.state.signed, 1);
});

test("correction cannot change payment terms, owner, payer, chain, nonce or existing daily policy", async t => {
  const mutations = [
    tx => { tx.header.rc_limit = "100000000"; }, tx => { tx.header.rc_limit = "99999999"; },
    tx => { tx.header.nonce = "KAI="; }, tx => { tx.header.payer = Signer.fromSeed("other correction owner").getAddress(); },
    tx => { tx.header.payee = Signer.fromSeed("other correction sponsor").getAddress(); },
    tx => { tx.header.chain_id = "EiA" + "A".repeat(43) + "=="; },
    tx => { tx.operations = tx.operations.slice(0, 1); },
    tx => { tx.operations[1].call_contract.args = "AA=="; },
    tx => { tx.header.rc_limit = "1000000001"; },
  ];
  for (const mutate of mutations) {
    const f = await pending(t), tx = await corrected(f, mutate);
    await assert.rejects(f.n.reserveCorrection(f.id, tx));
    assert.equal(f.n.correction(f.id), null); assert.deepEqual(f.n.envelope(f.id), f.original);
  }
  const f = await pending(t), draft = await corrected(f);
  await assert.rejects(f.n.reserveCorrection(f.id, draft, () => false), /stopped/);
  assert.equal(f.n.correction(f.id), null);
  await stage(f);
  assert.throws(() => f.n.authorizeCorrectionSubmission(f.id, { maxRcPerDay: "1100000000" }), /policy changed/);
});

test("correction signatures are exact, owner signed, immutable and never substituted", async t => {
  const f = await pending(t), draft = await corrected(f); await f.n.reserveCorrection(f.id, draft);
  const wrong = structuredClone(draft); await Signer.fromSeed("wrong correction signer").signTransaction(wrong);
  await assert.rejects(f.n.stageCorrection(f.id, wrong), /Unexpected|owner/);
  assert.equal(f.n.correction(f.id).transaction, null);
  const signed = await f.sign({ transaction: draft }); await f.n.stageCorrection(f.id, signed);
  await f.n.stageCorrection(f.id, signed);
  const different = await corrected(f, tx => { tx.header.rc_limit = "800000000"; }); await f.signer.signTransaction(different);
  await assert.rejects(f.n.stageCorrection(f.id, different), /Original Mana correction/);
  assert.deepEqual(f.n.correction(f.id).transaction, signed);
});

test("same-nonce daily Mana accounting reserves the larger cap and retains every retry", async t => {
  const f = await pending(t), tx = await stage(f), before = row(f).submissions;
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.deepEqual(f.n.authorizeCorrectionSubmission(f.id, policy), tx);
    assert.equal(f.n.status(f.id).correction.attempts, attempt);
    f.state.now += 1000;
  }
  assert.throws(() => f.n.authorizeCorrectionSubmission(f.id, policy), /retry limit/);
  assert.deepEqual(row(f).submissions, before);
  await f.include(tx, { irreversible: true }); assert.equal((await f.n.reconcile(f.id)).state, "consumed_elsewhere");
  // 9 Mana for the nonce family leaves exactly 1 Mana in this 10-Mana day.
  const next = structuredClone(f.original); next.signatures = []; next.header.nonce = "KAI=";
  await Transaction.prepareTransaction(next); const nextId = hash("after-mana-correction");
  await f.n.reserve(nextId, "credits", next); await f.signer.signTransaction(next); await f.n.stage(nextId, next);
  assert.deepEqual(f.n.authorizeSubmission(nextId, policy), next);
  await f.include(next, { irreversible: true }); await f.n.reconcile(nextId);
  f.state.nonce = "KAM=";
  const third = structuredClone(next); third.signatures = []; third.header.nonce = "KAM=";
  await Transaction.prepareTransaction(third); const thirdId = hash("exhausted-mana-day");
  await f.n.reserve(thirdId, "credits", third); await f.signer.signTransaction(third); await f.n.stage(thirdId, third);
  assert.throws(() => f.n.authorizeSubmission(thirdId, policy), /Daily wallet resource budget/);
});

test("a finalized or reverted correction releases only after canonical irreversible proof", async t => {
  for (const reverted of [false, true]) {
    const f = await pending(t), tx = await stage(f); await f.include(tx, { reverted });
    assert.equal((await f.n.reconcile(f.id)).state, "signed");
    f.state.lib = f.state.height; f.state.fork = true;
    assert.equal((await f.n.reconcile(f.id)).state, "signed");
    f.state.fork = false;
    const status = await f.n.reconcile(f.id);
    assert.equal(status.state, "consumed_elsewhere"); assert.equal(status.correction.state, reverted ? "reverted" : "finalized");
    assert.equal(status.finality.txId, tx.id); assert.equal(status.correction.finality.txId, tx.id);
    assert.throws(() => f.n.authorizeSubmission(f.id, policy), /signed envelope/);
    assert.throws(() => f.n.authorizeCorrectionSubmission(f.id, policy), /signed Mana correction/);
  }
});

test("if the original wins, the correction is superseded and even a late signature is preserved without sending", async t => {
  for (const signBeforeFinality of [true, false]) {
    const f = await pending(t), draft = await corrected(f); await f.n.reserveCorrection(f.id, draft);
    const tx = await f.sign({ transaction: draft }); if (signBeforeFinality) await f.n.stageCorrection(f.id, tx);
    await f.include(f.original, { irreversible: true }); const status = await f.n.reconcile(f.id);
    assert.equal(status.state, "finalized"); assert.equal(status.correction.state, "superseded");
    if (!signBeforeFinality) await f.n.stageCorrection(f.id, tx);
    assert.deepEqual(f.n.correction(f.id).transaction, tx); assert.deepEqual(f.n.envelope(f.id), f.original);
    assert.throws(() => f.n.authorizeCorrectionSubmission(f.id, policy), /signed Mana correction/);
  }
});

test("damaged correction data and malformed receipts never release the original wallet fence", async t => {
  const f = await pending(t), tx = await stage(f); await f.include(tx, { irreversible: true });
  f.state.block.receipt.transaction_receipts[0].payer = f.d.admin;
  await assert.rejects(f.n.reconcile(f.id), /Invalid wallet receipt/);
  assert.equal(f.n.status(f.id).state, "signed");
  const db = new DatabaseSync(path.join(f.dir, "wallet-nonces.sqlite"));
  const saved = JSON.parse(db.prepare("SELECT data FROM reservations WHERE id=?").get(f.id).data);
  saved.correction.draft.header.nonce = "KAI=";
  const data = JSON.stringify(saved); db.prepare("UPDATE reservations SET data=?,hash=? WHERE id=?").run(data, hash(data), f.id); db.close();
  assert.throws(() => f.n.status(f.id), /Damaged wallet Mana correction/);
});

test("chain recovery accepts only the pre-fenced correction and never signs another transaction", async t => {
  const f = await pending(t), draft = await corrected(f);
  await f.n.reserveCorrection(f.id, draft);
  const tx = await f.sign({ transaction: draft }); // A signer response was lost before staging.
  await f.include(tx, { irreversible: true });
  const wrong = await corrected(f, v => { v.header.rc_limit = "800000000"; });
  await assert.rejects(f.n.recoverOriginal(f.id, wrong.id), /saved Mana correction ID required/);
  assert.equal(f.n.correction(f.id).transaction, null);
  const status = await f.n.recoverOriginal(f.id, tx.id);
  assert.equal(status.state, "consumed_elsewhere"); assert.equal(status.correction.state, "finalized");
  assert.deepEqual(f.n.correction(f.id).transaction, tx); assert.deepEqual(f.n.envelope(f.id), f.original);
  assert.equal(f.state.signed, 2); assert.equal(f.state.submissions.length, 0);
});

test("manual conflict repair maintains correction finality and never saves a terminal missing envelope", async t => {
  for (const saved of [true, false]) {
    const f = await pending(t), draft = await corrected(f); await f.n.reserveCorrection(f.id, draft);
    const tx = await f.sign({ transaction: draft }); if (saved) await f.n.stageCorrection(f.id, tx);
    await f.include(tx, { irreversible: true }); const review = await f.n.reviewConsumed(f.id, tx.id);
    if (saved) {
      const status = await f.n.repairConsumed(review);
      assert.equal(status.state, "consumed_elsewhere"); assert.equal(status.correction.state, "finalized");
    } else {
      await assert.rejects(f.n.repairConsumed(review), /Recover the saved Mana correction envelope/);
      assert.equal(f.n.status(f.id).state, "signed"); assert.equal(f.n.correction(f.id).state, "signing");
    }
  }
});
