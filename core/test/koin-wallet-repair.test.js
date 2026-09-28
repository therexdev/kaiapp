"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { Transaction, Signer } = require("koilib");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
const { hash } = require("../lib/koin-network/job-protocol");
async function conflict(f) {
  const draft = (await f.journal.begin(f.id, f.request)).transaction;
  const tx = structuredClone(draft); tx.operations = tx.operations.slice(0, 1);
  await Transaction.prepareTransaction(tx); await f.signer.signTransaction(tx);
  return { draft, tx };
}
test("reviewed irreversible conflict releases a stuck unsigned request without crediting a deposit", async t => {
  const f = fixture(t), { draft, tx } = await conflict(f), n = f.journal.nonceCoordinator;
  await f.include(tx, { irreversible: true }); const review = await n.reviewConsumed(f.id, tx.id);
  assert.equal(review.originalTxId, draft.id); assert.equal((await n.repairConsumed(review)).state, "consumed_elsewhere");
  assert.equal((await f.journal.advance(f.id)).state, "conflicted");
  assert.equal(f.state.signed, 0); assert.equal(f.state.submissions.length, 0);
  await f.signer.signTransaction(draft); await assert.rejects(n.stage(f.id, draft), /Resolved/);
  assert.equal((await f.journal.begin(hash("new-after-conflict"), f.request)).action, "prepare_funding");
});
test("repair cannot use reversible, forked, unrelated-owner or different-nonce transactions", async t => {
  for (const which of ["reversible", "fork", "owner", "nonce"]) {
    const f = fixture(t), { tx } = await conflict(f);
    if (which === "owner") { const other = Signer.fromSeed("wrong repair owner"); tx.header.payer = other.getAddress(); tx.signatures = []; await Transaction.prepareTransaction(tx); await other.signTransaction(tx); }
    if (which === "nonce") { tx.header.nonce = "KAI="; tx.signatures = []; await Transaction.prepareTransaction(tx); await f.signer.signTransaction(tx); }
    await f.include(tx, { irreversible: which !== "reversible" }); f.state.fork = which === "fork";
    await assert.rejects(f.journal.nonceCoordinator.reviewConsumed(f.id, tx.id));
    assert.equal(f.journal.nonceCoordinator.status(f.id).state, "signing");
  }
});
test("repair rechecks finality after review and refuses an expired review", async t => {
  const f = fixture(t), { tx } = await conflict(f), n = f.journal.nonceCoordinator;
  await f.include(tx, { irreversible: true }); const review = await n.reviewConsumed(f.id, tx.id);
  f.state.fork = true; await assert.rejects(n.repairConsumed(review), /irreversible/);
  f.state.fork = false; f.state.now += 180000; await assert.rejects(n.repairConsumed(review), /Fresh recovery review/);
  assert.equal(n.status(f.id).state, "signing");
});
test("original on-chain envelope recovery completes lost signing without invoking a signer again", async t => {
  const f = fixture(t), d = await f.journal.begin(f.id, f.request), signed = await f.sign(d);
  await f.include(signed, { irreversible: true });
  assert.equal((await f.journal.nonceCoordinator.recoverOriginal(f.id, signed.id)).state, "finalized");
  assert.equal((await f.journal.advance(f.id)).state, "funded");
  assert.equal(f.state.signed, 1); assert.equal(f.state.submissions.length, 0);
});
