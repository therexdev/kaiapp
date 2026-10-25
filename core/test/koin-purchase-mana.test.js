"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { Transaction, Signer } = require("koilib");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
const { purchaseMana, assertPurchaseMana } = require("../lib/koin-network/purchase-mana");
const { hash } = require("../lib/koin-network/job-protocol");
const Cancel = require("../lib/koin-network/funding-cancel");
const DAY = 86400000, DAILY = "500000000";
function options(f) {
  return { client: f.client, nonces: f.journal.nonceCoordinator, owner: f.signer.getAddress(),
    maxRcPerTransaction: "100000000", maxRcPerDay: DAILY };
}
async function pending(t) {
  const f = fixture(t, { maxRcPerDay: DAILY }); f.request.maxRc = "100000000";
  f.provider.getAccountRc = async () => "15000000000";
  await f.runner().start(f.id, f.request);
  f.journal.nonceCoordinator.authorizeSubmission(f.id, { maxRcPerDay: DAILY });
  return f;
}
test("fresh purchase chooses a supported ceiling before review without signing or reserving", async t => {
  const f = fixture(t, { maxRcPerDay: DAILY }), o = options(f);
  f.provider.getAccountRc = async () => "15000000000";
  assert.equal(await purchaseMana(o), DAILY);
  f.provider.getAccountRc = async () => "250000000";
  assert.equal(await purchaseMana(o), "250000000");
  assert.equal(await assertPurchaseMana(o, "200000000"), "200000000");
  await assert.rejects(assertPurchaseMana(o, "300000000"), /no longer available/);
  assert.equal(f.state.signed, 0); assert.equal(f.state.submissions.length, 0);
  assert.deepEqual(o.nonces.list(), []);
  f.provider.getAccountRc = async () => "20000000000";
  assert.equal(await purchaseMana({ ...o, maxRcPerDay: "2000000000" }), "900000000");
});
test("fresh payment fails before a signature when allowance, Mana, or cancellation changes during the read", async t => {
  const f = fixture(t), o = options(f);
  for (const value of ["0", "99999999", 200000000, "-1", "18446744073709551616"]) {
    f.provider.getAccountRc = async () => value;
    await assert.rejects(purchaseMana(o));
  }
  let reads = 0;
  f.provider.getAccountRc = async () => { reads++; return "500000000"; };
  await assert.rejects(purchaseMana({ ...o, nonces: { availableSubmissionRc: () => "0" } }), /allowance/);
  assert.equal(reads, 0);
  let checks = 0;
  await assert.rejects(purchaseMana({ ...o, nonces: { availableSubmissionRc: () => ++checks === 1 ? DAILY : "0" } }), /allowance/);
  const stop = new AbortController();
  f.provider.getAccountRc = async () => { stop.abort(); return DAILY; };
  await assert.rejects(purchaseMana({ ...o, signal: stop.signal }), { name: "AbortError" });
  assert.equal(f.state.signed, 0); assert.deepEqual(o.nonces.list(), []);
});
test("an irreversible exact receipt releases unused Mana for another same-day purchase and survives restart", async t => {
  const f = await pending(t), o = options(f), tx = f.state.submissions[0];
  assert.equal(o.nonces.availableSubmissionRc(o.owner, DAILY), "400000000");
  await f.include(tx, { irreversible: true });
  const status = await o.nonces.reconcile(f.id);
  assert.equal(status.finality.actualRc, "1000");
  assert.equal(o.nonces.availableSubmissionRc(o.owner, DAILY), "499999000");
  f.journal.close(); const journal = f.open({ maxRcPerDay: DAILY }), nonces = journal.nonceCoordinator;
  const limit = await purchaseMana({ ...o, nonces });
  assert.equal(limit, "499999000");
  const next = await f.client.prepare(f.request.kind, f.request.method, f.request.args, { actor: o.owner, rcLimit: limit });
  const id = hash("second-purchase");
  await nonces.reserve(id, "funding", next); await f.signer.signTransaction(next); await nonces.stage(id, next);
  assert.equal(nonces.authorizeSubmission(id, { maxRcPerDay: DAILY }).id, next.id);
  assert.equal(nonces.availableSubmissionRc(o.owner, DAILY), "0");
});
test("receipt accounting charges only the winning original, correction, or cancellation once", async t => {
  for (const winning of ["original", "correction", "cancellation"]) {
    const f = await pending(t), o = options(f), n = o.nonces, original = n.envelope(f.id);
    const correction = await Transaction.prepareTransaction({ ...n.draft(f.id), header: { ...original.header, rc_limit: "200000000" } });
    await n.reserveCorrection(f.id, correction); await f.signer.signTransaction(correction); await n.stageCorrection(f.id, correction);
    n.authorizeCorrectionSubmission(f.id, { maxRcPerDay: DAILY });
    const cancellation = await Cancel.prepare(f.d, n.draft(f.id));
    await n.reserveCancellation(f.id, cancellation); await f.signer.signTransaction(cancellation); await n.stageCancellation(f.id, cancellation);
    n.authorizeCancellationSubmission(f.id, { maxRcPerDay: DAILY });
    assert.equal(n.availableSubmissionRc(o.owner, DAILY), "300000000");
    await f.include({ original, correction, cancellation }[winning], { irreversible: true, zeroTransfer: winning === "cancellation", reverted: winning === "correction" });
    await n.reconcile(f.id);
    assert.equal(n.availableSubmissionRc(o.owner, DAILY), "499999000", winning);
  }
});
test("unconfirmed, missing-cost, unknown-envelope, and malformed receipts cannot refund reserved headroom", async t => {
  for (const scenario of ["unconfirmed", "missing-cost", "unknown-envelope", "oversized", "numeric"]) {
    const f = await pending(t), o = options(f), n = o.nonces;
    let tx = n.envelope(f.id);
    if (scenario === "unknown-envelope") { tx = await Cancel.prepare(f.d, n.draft(f.id)); await f.signer.signTransaction(tx); }
    await f.include(tx, { irreversible: scenario !== "unconfirmed", zeroTransfer: scenario === "unknown-envelope" });
    const receipt = f.state.block.receipt.transaction_receipts[0];
    if (scenario === "missing-cost") delete receipt.rc_used;
    if (scenario === "oversized") receipt.rc_used = "100000001";
    if (scenario === "numeric") receipt.rc_used = 1000;
    if (scenario === "unknown-envelope") await n.repairConsumed(await n.reviewConsumed(f.id, tx.id));
    else await n.reconcile(f.id).catch(() => {});
    assert.equal(n.availableSubmissionRc(o.owner, DAILY), "400000000", scenario);
  }
});
test("a receipt on a later day counts its actual cost on that day without relying on a same-day submission", async t => {
  const f = await pending(t), o = options(f), tx = f.state.submissions[0];
  f.state.now += DAY;
  assert.equal(o.nonces.availableSubmissionRc(o.owner, DAILY), DAILY);
  await f.include(tx, { irreversible: true }); await o.nonces.reconcile(f.id);
  assert.equal(o.nonces.availableSubmissionRc(o.owner, DAILY), "499999000");
});
test("sequential USD purchases use verified actual Mana despite the funding audit table retaining both reviewed ceilings", async t => {
  const f = fixture(t, { usd: true, maxRcPerDay: DAILY }), o = options(f), n = o.nonces;
  f.provider.getAccountRc = async () => "15000000000";
  const quote = () => require("../lib/koin-network/purchase-quote").issue({ deployment: f.d,
    signer: Signer.fromSeed("funding-recovery-verifier"), account: o.owner,
    amount: "500000000", usdPerKoin: "20000000", version: 1, now: f.state.now });
  const runner = f.runner(f.journal, { submit: async decision => {
    const id = n.list().find(row => row.txId === decision.transaction.id).id;
    n.authorizeSubmission(id, { maxRcPerDay: DAILY });
    f.state.submissions.push(structuredClone(decision.transaction));
  } });
  f.request.args = await quote(); f.request.maxRc = await purchaseMana(o);
  assert.equal(f.request.maxRc, DAILY);
  assert.equal((await runner.start(f.id, f.request)).action, "await_finality");
  assert.equal(f.state.submissions.length, 1);
  await f.include(f.state.submissions[0], { irreversible: true });
  assert.equal((await runner.tick(f.id)).action, "done");
  assert.equal(f.journal.status(f.id).state, "funded");
  assert.equal(n.availableSubmissionRc(o.owner, DAILY), "499999000");

  f.state.now += 2000;
  f.request.args = await quote(); f.request.maxRc = await purchaseMana(o);
  const nextId = hash("second-USD-purchase");
  assert.equal((await runner.start(nextId, f.request)).action, "await_finality");
  assert.equal(f.state.submissions.length, 2);
  assert.notEqual(f.state.submissions[0].id, f.state.submissions[1].id);
  assert.equal(f.state.submissions[1].header.rc_limit, "499999000");
  await f.include(f.state.submissions[1], { irreversible: true });
  assert.equal((await runner.tick(nextId)).action, "done");
  assert.equal(f.journal.status(nextId).state, "funded");
  assert.equal(n.availableSubmissionRc(o.owner, DAILY), "499998000");
  assert.equal(f.state.signed, 2);
});
test("cost accounting requires a valid nonfuture execution day and distinguishes explicit zero from missing cost", async t => {
  for (const scenario of ["missing-time", "future-time", "zero-cost", "missing-cost"]) {
    const f = await pending(t), o = options(f), n = o.nonces;
    await f.include(n.envelope(f.id), { irreversible: true });
    const read = f.provider.getBlocks.bind(f.provider);
    // Keep the fresh head truthful while varying only the purported containing
    // block timestamp, so future metadata cannot be used to refund headroom.
    if (scenario.endsWith("time")) f.provider.getBlocks = async (...args) => {
      const blocks = await read(...args);
      if (args[3]?.returnReceipt) {
        if (scenario === "missing-time") delete blocks[0].block.header.timestamp;
        else blocks[0].block.header.timestamp = String(f.state.now + DAY);
      }
      return blocks;
    };
    const receipt = f.state.block.receipt.transaction_receipts[0];
    if (scenario === "zero-cost") receipt.rc_used = "0";
    if (scenario === "missing-cost") delete receipt.rc_used;
    const status = await n.reconcile(f.id);
    assert.equal(n.availableSubmissionRc(o.owner, DAILY), scenario === "zero-cost" ? DAILY : "400000000", scenario);
    assert.equal(status.finality.actualRc, scenario === "zero-cost" ? "0" : undefined);
    f.state.now--;
    assert.throws(() => n.availableSubmissionRc(o.owner, DAILY), /clock changed/);
  }
});
