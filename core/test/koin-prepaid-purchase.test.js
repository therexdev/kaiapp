"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
test("prepaid purchase submits its atomic bundle without waiting for a refundable balance snapshot", async t => {
  const f = fixture(t, { prepaid: true }); f.state.lib = 1;
  await f.runner().start(f.id, f.request);
  assert.equal(f.state.signed, 1); assert.equal(f.state.submissions.length, 1);
  const original = f.state.submissions[0]; await f.include(original, { irreversible: true });
  assert.equal((await f.journal.advance(f.id, { allowSubmit: false })).state, "funded");
  assert.equal(f.state.submissions.length, 1); assert.equal(f.state.signed, 1);
});
test("pending prepaid purchase retains exact signed bytes and finalizes after restart without a second purchase", async t => {
  const f = fixture(t, { prepaid: true }); await f.runner().start(f.id, f.request); const tx = f.state.submissions[0];
  f.journal.close(); const reopened = f.open();
  await f.include(tx, { irreversible: true });
  assert.equal((await reopened.advance(f.id, { allowSubmit: false })).state, "funded");
  assert.equal(f.state.signed, 1); assert.equal(f.state.submissions.length, 1);
});
test("prepaid product rejects legacy mutable entry points in its ABI", async t => {
  const f = fixture(t, { prepaid: true });
  for (const method of ["reserve", "refund", "release", "revoke"]) await assert.rejects(f.client.operation("credits", method, {}), /Unknown/);
  assert.equal((await f.client.operation("credits", "purchase", f.request.args)).entry_point, f.client.abis.credits.methods.purchase.entry_point);
});
test("Retry purchase reuses the saved payment and never signs or charges a second purchase", async t => {
  const f = fixture(t, { prepaid: true }), { EventEmitter } = require("events"), { TestPayments } = require("../../electron/koin-test-payments");
  const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false, isVisible: () => true, isMinimized: () => false });
  let signatures = 0, reviews = 0; const sign = f.signer.signTransaction.bind(f.signer);
  f.signer.signTransaction = async tx => { signatures++; return sign(tx); };
  f.provider.call = async (_method, { transaction }) => { f.state.submissions.push(structuredClone(transaction)); throw Error("Connection lost before inclusion"); };
  const controller = new TestPayments({ config: { mode: "isolated-rehearsal", owner: f.signer.getAddress(), maxRcPerTransaction: "10000000", maxRcPerDay: "20000000", limits: { amount: "500000000" } },
    client: f.client, journal: f.journal, wallet: { address: f.signer.getAddress(), signer: f.signer }, clock: () => f.state.now,
    dialog: { showMessageBox: async () => { reviews++; return { response: 1 }; } } });
  const first = await controller.run(window, "purchase", "5"); assert.ok(first.deposit?.txId);
  const again = await controller.run(window, "purchase", "0.2"); assert.equal(again.deposit.id, first.deposit.id);
  f.state.now += 1001;
  await controller.run(window, "purchase-retry");
  assert.equal(signatures, 1); assert.equal(reviews, 2); assert.equal(f.state.submissions.length, 2);
  assert.deepEqual(f.state.submissions[0], f.state.submissions[1]);
  await f.include(f.state.submissions[0], { irreversible: true });
  await controller.run(window, "purchase-retry");
  assert.equal(controller.pendingPurchase(), null); assert.equal(reviews, 2); assert.equal(f.state.submissions.length, 2);
});
