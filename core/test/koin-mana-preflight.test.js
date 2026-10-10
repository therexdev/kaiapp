"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
const { simulateFunding } = require("../lib/koin-network/mana-preflight");

async function setup(t) {
  const f = fixture(t), draft = await f.journal.begin(f.id, f.request), transaction = await f.sign(draft);
  const calls = [], balances = ["10000000", "10000000"];
  f.provider.getAccountRc = async account => {
    assert.equal(account, f.request.actor); return balances.shift();
  };
  const receipt = { id: transaction.id, payer: f.request.actor, rc_used: "2000001", reverted: false };
  f.provider.call = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    return { receipt: structuredClone(receipt) };
  };
  return { ...f, transaction, calls, balances, receipt };
}

test("funding preflight simulates the exact signed envelope with headroom and never broadcasts or changes it", async t => {
  const f = await setup(t), before = structuredClone(f.transaction), request = structuredClone(f.request), now = Date.now();
  const result = await simulateFunding(f.client, f.transaction, f.request);
  assert.deepEqual(f.calls, [{ method: "chain.submit_transaction", params: { transaction: before, broadcast: false } }]);
  assert.deepEqual(f.transaction, before); assert.deepEqual(f.request, request);
  assert.deepEqual({ ...result, checkedAt: 0 }, { txId: before.id, rcUsed: "2000001", requiredRc: "2510002", rcLimit: "10000000", checkedAt: 0 });
  assert.ok(result.checkedAt >= now); assert.equal(f.balances.length, 0);
  assert.equal(f.journal.status(f.id).attempts, 0); assert.equal(f.state.signed, 1);
  delete f.receipt.payer; delete f.receipt.reverted;
  f.balances.push("10000000", "10000000");
  assert.equal((await simulateFunding(f.client, f.transaction, f.request)).rcUsed, "2000001");
});

test("funding preflight rejects changed scope, signature, chain, contract or pause before simulation", async t => {
  for (const reason of ["scope", "signature", "chain", "contract", "pause"]) await t.test(reason, async s => {
    const f = await setup(s);
    if (reason === "scope") f.transaction.header.rc_limit = "20000000";
    if (reason === "signature") f.transaction.signatures = [];
    if (reason === "chain") f.provider.getChainId = async () => "wrong";
    if (reason === "contract") f.provider.invokeGetContractMetadata = async () => ({ value: { hash: "wrong" } });
    if (reason === "pause") f.state.paused = true;
    await assert.rejects(simulateFunding(f.client, f.transaction, f.request), { code: "funding_simulation_failed" });
    assert.equal(f.calls.length, 0);
  });
});

test("funding preflight rejects missing, malformed, reverted, unrelated and excessive-cost receipts", async t => {
  const mutations = {
    missing: () => ({}), wrongId: r => ({ receipt: { ...r, id: "wrong" } }),
    wrongPayer: r => ({ receipt: { ...r, payer: "wrong" } }),
    reverted: r => ({ receipt: { ...r, reverted: true } }),
    badReverted: r => ({ receipt: { ...r, reverted: "false" } }),
    receiptError: r => ({ receipt: { ...r, rpc_error: { message: "secret" } } }),
    numeric: r => ({ receipt: { ...r, rc_used: 2 } }), zero: r => ({ receipt: { ...r, rc_used: "0" } }),
    padded: r => ({ receipt: { ...r, rc_used: "0002" } }),
    overflow: r => ({ receipt: { ...r, rc_used: "18446744073709551616" } }),
    exceedsLimit: r => ({ receipt: { ...r, rc_used: "10000001" } }),
  };
  for (const [name, response] of Object.entries(mutations)) await t.test(name, async s => {
    const f = await setup(s);
    f.provider.call = async (method, params) => {
      assert.equal(method, "chain.submit_transaction"); assert.equal(params.broadcast, false);
      return response(f.receipt);
    };
    await assert.rejects(simulateFunding(f.client, f.transaction, f.request), { code: "funding_simulation_failed" });
  });
});

test("funding preflight checks both signed ceiling and measured headroom without widening either", async t => {
  for (const reason of ["before", "margin", "after"]) await t.test(reason, async s => {
    const f = await setup(s), original = structuredClone(f.transaction);
    if (reason === "before") f.balances[0] = "9999999";
    if (reason === "margin") f.receipt.rc_used = "9000000";
    // Still covers measured margin but cannot cover the signed ceiling.
    if (reason === "after") f.balances[1] = "9999999";
    await assert.rejects(simulateFunding(f.client, f.transaction, f.request), { code: "funding_insufficient_rc" });
    assert.deepEqual(f.transaction, original);
    assert.equal(f.calls.length, reason === "before" ? 0 : 1);
  });
});

test("funding preflight returns bounded errors without leaking signatures or transport details", async t => {
  for (const mode of ["throw", "errorResult", "rc", "balance", "badBalance"]) await t.test(mode, async s => {
    const f = await setup(s), secret = f.transaction.signatures[0];
    if (mode === "balance") f.provider.getAccountRc = async () => { throw Error(secret); };
    else if (mode === "badBalance") f.balances[0] = 10000000;
    else f.provider.call = async () => {
      const error = { message: (mode === "rc" ? "insufficient rc " : "transport ") + secret, data: { privateKey: "private-marker" } };
      if (mode === "errorResult") return { error };
      throw error;
    };
    await assert.rejects(simulateFunding(f.client, f.transaction, f.request), error => {
      assert.equal(error.code, mode === "rc" ? "funding_insufficient_rc" : "funding_simulation_failed");
      assert.ok(!error.message.includes(secret)); assert.ok(!JSON.stringify(error).includes("private-marker"));
      assert.ok(error.message.length < 200); return true;
    });
  });
});

test("a lost simulation response times out without retrying or proceeding to broadcast", async t => {
  const f = await setup(t);
  let reached;
  const entered = new Promise(resolve => { reached = resolve; });
  f.provider.call = (method, params) => {
    f.calls.push({ method, params }); reached();
    return new Promise(() => {});
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = simulateFunding(f.client, f.transaction, f.request);
  await entered;
  const rejected = assert.rejects(pending, { code: "funding_simulation_failed" });
  t.mock.timers.tick(20000);
  await rejected;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].params.broadcast, false);
  assert.equal(f.balances.length, 1); assert.equal(f.journal.status(f.id).attempts, 0);
});
