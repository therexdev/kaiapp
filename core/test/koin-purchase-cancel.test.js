"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { Signer, Transaction, Serializer, utils } = require("koilib");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
const Cancel = require("../lib/koin-network/funding-cancel");
const { simulateCancellation } = require("../lib/koin-network/mana-preflight");
async function setup(t) {
  const f = fixture(t, { usd: true });
  f.request.args = await require("../lib/koin-network/purchase-quote").issue({ deployment: f.d,
    signer: Signer.fromSeed("funding-recovery-verifier"), account: f.signer.getAddress(), amount: "500000000", usdPerKoin: "20000000", version: 1, now: f.state.now });
  await f.runner().start(f.id, f.request);
  const nonces = f.journal.nonceCoordinator, original = nonces.envelope(f.id), draft = await Cancel.prepare(f.d, nonces.draft(f.id));
  return { ...f, nonces, original, draft };
}
async function stage(f) {
  await f.nonces.reserveCancellation(f.id, f.draft);
  const tx = structuredClone(f.draft); await f.signer.signTransaction(tx); await f.nonces.stageCancellation(f.id, tx); return tx;
}
test("cancellation is exactly the native balance read and rejects altered operations, authority, nonce and limits", async t => {
  const f = await setup(t), native = new Serializer(utils.tokenAbi.types), method = utils.tokenAbi.methods.balanceOf;
  assert.deepEqual(f.draft.operations, [{ call_contract: { contract_id: f.d.token, entry_point: method.entry_point,
    args: utils.encodeBase64url(await native.serialize({ owner: f.signer.getAddress() }, method.argument)) } }]);
  for (const change of [
    tx => { tx.operations.push(f.original.operations[0]); },
    tx => { tx.operations[0].call_contract.entry_point = utils.tokenAbi.methods.transfer.entry_point; },
    tx => { tx.operations[0].call_contract.contract_id = f.d.credits; },
    tx => { tx.operations = [Cancel.operation(f.d, f.d.admin)]; },
    tx => { tx.header.payer = f.d.admin; }, tx => { tx.header.payee = f.d.admin; },
    tx => { tx.header.nonce = "KAI="; }, tx => { tx.header.rc_limit = "20000000"; },
    tx => { tx.header.rc_limit = "1000"; },
  ]) {
    let tx = structuredClone(f.draft); change(tx); tx = await Transaction.prepareTransaction(tx);
    await assert.rejects(f.nonces.reserveCancellation(f.id, tx)); assert.equal(f.nonces.cancellation(f.id), null);
  }
  await assert.rejects(f.nonces.reserveCancellation(f.id, f.draft, () => false), /stopped/);
  const signed = await stage(f);
  assert.deepEqual(f.nonces.envelope(f.id), f.original);
  assert.throws(() => f.nonces.authorizeSubmission(f.id, { maxRcPerDay: "20000000" }), /cancellation/);
  await assert.rejects(f.nonces.stageCancellation(f.id, f.original), /Original cancellation/);
  assert.deepEqual(f.nonces.cancellation(f.id).transaction, signed);
});
test("cancellation preserves an earlier Mana correction and shares its daily resource ceiling", async t => {
  const f = await setup(t), corrected = await Transaction.prepareTransaction({ ...f.nonces.draft(f.id), header: { ...f.original.header, rc_limit: "15000000" } });
  await f.nonces.reserveCorrection(f.id, corrected); await f.signer.signTransaction(corrected); await f.nonces.stageCorrection(f.id, corrected);
  f.nonces.authorizeCorrectionSubmission(f.id, { maxRcPerDay: "20000000" });
  const cancel = await stage(f);
  assert.deepEqual(f.nonces.correction(f.id).transaction, corrected);
  assert.deepEqual(f.nonces.authorizeCancellationSubmission(f.id, { maxRcPerDay: "20000000" }), cancel);
  assert.throws(() => f.nonces.authorizeCorrectionSubmission(f.id, { maxRcPerDay: "20000000" }), /cancellation/);
  assert.throws(() => f.nonces.authorizeCancellationSubmission(f.id, { maxRcPerDay: "30000000" }), /policy changed/);
  assert.throws(() => f.nonces.authorizeCancellationSubmission(f.id, { maxRcPerDay: "20000000" }), /retry limit/);
  for (let i = 0; i < 2; i++) { f.state.now += 1001; f.nonces.authorizeCancellationSubmission(f.id, { maxRcPerDay: "20000000" }); }
  f.state.now += 1001;
  assert.throws(() => f.nonces.authorizeCancellationSubmission(f.id, { maxRcPerDay: "20000000" }), /retry limit/);
  await f.include(cancel, { zeroTransfer: true, irreversible: true });
  await f.nonces.reconcile(f.id); await f.journal.advance(f.id, { allowSubmit: false });
  assert.equal(f.journal.status(f.id).reason, "expired_purchase_cancelled");
  assert.equal(f.nonces.correction(f.id).state, "superseded"); assert.deepEqual(f.nonces.correction(f.id).transaction, corrected);
});
test("unknown, reversible, stale, wrong-chain and malformed cancellation receipts cannot release a payment", async t => {
  for (const scenario of ["unknown", "reversible", "stale", "chain", "receipt", "payer", "cost", "fork"]) {
    const f = await setup(t), cancel = await stage(f);
    if (scenario !== "unknown") await f.include(cancel, { zeroTransfer: true, irreversible: scenario !== "reversible" });
    if (scenario === "stale") f.state.now += 120001;
    if (scenario === "chain") f.provider.getChainId = async () => "other";
    if (scenario === "receipt") f.state.block.receipt.transaction_receipts = [];
    if (scenario === "payer") f.state.block.receipt.transaction_receipts[0].payer = f.d.admin;
    if (scenario === "cost") f.state.block.receipt.transaction_receipts[0].rc_used = "99999999";
    if (scenario === "fork") f.state.fork = true;
    try { await f.nonces.reconcile(f.id); } catch { /* The unresolved fence is the required outcome. */ }
    assert.equal(f.nonces.status(f.id).state, "signed", scenario);
    assert.deepEqual(f.nonces.envelope(f.id), f.original); assert.deepEqual(f.nonces.cancellation(f.id).transaction, cancel);
  }
});
test("cancellation simulation validates signature, pinned code, exact receipt and resource headroom without broadcasting", async t => {
  const f = await setup(t), cancel = await stage(f), calls = [];
  f.provider.getAccountRc = async () => "20000000";
  f.provider.call = async (method, args) => { calls.push(args.broadcast); return { receipt: { id: args.transaction.id, payer: f.signer.getAddress(), rc_used: "1000" } }; };
  assert.equal((await simulateCancellation(f.client, cancel, f.nonces.draft(f.id))).txId, cancel.id);
  assert.deepEqual(calls, [false]);
  for (const receipt of [null, { id: "wrong", rc_used: "1000" }, { id: cancel.id, rc_used: "1000", reverted: true }, { id: cancel.id, rc_used: "9000000" }]) {
    f.provider.call = async (_method, args) => { assert.equal(args.broadcast, false); return { receipt }; };
    await assert.rejects(simulateCancellation(f.client, cancel, f.nonces.draft(f.id)));
  }
  const forged = structuredClone(f.draft); await Signer.fromSeed("wrong-cancellation-owner").signTransaction(forged);
  await assert.rejects(simulateCancellation(f.client, forged, f.nonces.draft(f.id)), /exact signed/);
  f.provider.invokeGetContractMetadata = async () => ({ value: { hash: "0x1220" + "9".repeat(64) } });
  await assert.rejects(simulateCancellation(f.client, cancel, f.nonces.draft(f.id)), /bytecode/);
});
