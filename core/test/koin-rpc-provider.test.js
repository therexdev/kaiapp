"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PinnedRpcProvider } = require("../lib/koin-network/rpc-provider");
const CHAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const A = "https://primary.invalid", B = "https://backup.invalid";
const json = (id, result) => ({ ok: true, status: 200,
  text: async () => JSON.stringify({ jsonrpc: "2.0", id, result }) });
const html = () => ({ ok: true, status: 200, text: async () => "<html>private-wallet-signature</html>" });
const rpcError = (id, error) => ({ ok: true, status: 200,
  text: async () => JSON.stringify({ jsonrpc: "2.0", id, error }) });
const amqpError = id => rpcError(id, { code: -32603,
  message: "An internal server error has occurred private-wallet-signature",
  data: "rpc failed, AMQP connection is not open" });
function fixture(handler, options = {}) {
  const calls = [];
  const fetchImpl = async (url, request) => {
    const body = JSON.parse(request.body);
    calls.push({ url, body, signal: request.signal });
    assert.equal(request.redirect, "error");
    assert.equal(request.headers["Content-Type"], "application/json");
    const result = await handler(url, body, request.signal);
    return result ?? json(body.id, body.method === "chain.get_chain_id" ? { chain_id: CHAIN } : {});
  };
  return { calls, provider: new PinnedRpcProvider([A, B], CHAIN, { fetchImpl, ...options }) };
}
test("pinned RPC falls back from HTML, pins both endpoints and keeps backup preference", async () => {
  const { provider, calls } = fixture((url, body) => {
    if (body.method !== "chain.get_chain_id") return url === A ? html() : json(body.id, { rc: "42" });
  });
  assert.equal(await provider.getAccountRc("owner"), "42");
  assert.equal(provider.readGeneration, 1);
  assert.deepEqual(calls.map(c => [c.url, c.body.method]), [
    [A, "chain.get_chain_id"], [A, "chain.get_account_rc"],
    [B, "chain.get_chain_id"], [B, "chain.get_account_rc"],
  ]);
  assert.equal(await provider.getAccountRc("owner"), "42");
  assert.equal(calls.at(-1).url, B);
  assert.equal(provider.readGeneration, 1);
  assert.throws(() => provider.rpcNodes.push("https://unreviewed.invalid"));
  assert.throws(() => { provider.rpcNodes = [B]; });
});
test("unavailable pinned RPCs stop after one attempt each and redact HTML", async () => {
  const { provider, calls } = fixture(() => html());
  await assert.rejects(provider.getHeadInfo(), error => {
    assert.equal(error.code, "koin_rpc_unavailable");
    assert.doesNotMatch(error.message, /private|signature|<html>/);
    return true;
  });
  assert.equal(calls.length, 2);
  assert.equal(provider.readGeneration, 0);
});
test("concurrent fallback and late primary success count all accepted endpoint transitions", async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { provider, calls } = fixture(async (url, body) => {
    if (body.method === "chain.get_chain_id") return;
    if (url === A && body.params.account === "slow") {
      entered(); return new Promise(resolve => { release = () => resolve(json(body.id, { rc: "1" })); });
    }
    return url === A ? html() : json(body.id, { rc: "2" });
  });
  const slow = provider.getAccountRc("slow");
  await started;
  assert.equal(await provider.getAccountRc("fast"), "2");
  assert.equal(provider.readGeneration, 1);
  release();
  assert.equal(await slow, "1");
  assert.equal(provider.readGeneration, 2);
  assert.equal(await provider.getAccountRc("next"), "2");
  assert.equal(calls.at(-1).url, B);
  assert.equal(provider.readGeneration, 3);
});
test("wrong-chain fallback is rejected before reading application state", async () => {
  const { provider, calls } = fixture((url, body) => url === A ? html() : json(body.id, { chain_id: "wrong" }));
  await assert.rejects(provider.getHeadInfo(), /Deployment chain mismatch/);
  assert.equal(calls.length, 2);
  assert(calls.every(c => c.body.method === "chain.get_chain_id"));
  assert.equal(provider.readGeneration, 0);
});
test("broadcasts, omitted broadcast flags and unknown methods never fail over", async () => {
  for (const [method, params] of [
    ["chain.submit_transaction", { transaction: { signatures: ["private-signature"] }, broadcast: true }],
    ["chain.submit_transaction", { transaction: {}, broadcast: undefined }],
    ["chain.submit_transaction", { transaction: {}, broadcast: "false" }],
    ["chain.submit_block", { block: {} }],
    ["chain.invoke_system_call", { name: "unreviewed" }],
  ]) {
    const { provider, calls } = fixture((_url, body) => body.method !== "chain.get_chain_id" ? html() : undefined);
    await assert.rejects(provider.call(method, params), /temporarily unavailable/);
    assert.equal(calls.filter(c => c.body.method === method).length, 1);
    assert(calls.every(c => c.url === A));
  }
});
test("explicit nonbroadcast simulation retries the unchanged transaction once", async () => {
  const tx = { id: "saved", header: { nonce: "KAE=" }, signatures: ["saved-signature"] };
  const { provider, calls } = fixture((url, body) => {
    if (body.method !== "chain.get_chain_id") return url === A ? html() : json(body.id, { receipt: { id: "saved" } });
  });
  assert.deepEqual(await provider.call("chain.submit_transaction", { transaction: tx, broadcast: false }), { receipt: { id: "saved" } });
  const submissions = calls.filter(c => c.body.method === "chain.submit_transaction");
  assert.equal(submissions.length, 2);
  for (const { body } of submissions) assert.deepEqual(body.params, { transaction: tx, broadcast: false });
});
test("semantic insufficient rc rejection is recognizable, redacted and never retried", async () => {
  const { provider, calls } = fixture((_url, body) => body.method !== "chain.get_chain_id" ? {
    ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id,
      error: { code: -32603, message: "insufficient rc private-signature", data: "private-key" } }),
  } : undefined);
  await assert.rejects(provider.call("chain.submit_transaction", { transaction: {}, broadcast: false }), error => {
    assert.match(error.message, /insufficient rc/);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.equal(calls.length, 2);
  assert(calls.every(c => c.url === A));
});
test("timed-out late response cannot undo fallback or mutate the generation", async () => {
  let release;
  const { provider, calls } = fixture((url, body) => {
    if (url === A && body.method !== "chain.get_chain_id")
      return new Promise(resolve => { release = () => resolve(json(body.id, { rc: "1" })); });
    if (body.method !== "chain.get_chain_id") return json(body.id, { rc: "2" });
  }, { timeoutMs: 200, attemptTimeoutMs: 30 });
  assert.equal(await provider.getAccountRc("owner"), "2");
  assert.equal(calls.find(c => c.body.method === "chain.get_account_rc").signal.aborted, true);
  assert.equal(provider.readGeneration, 1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(provider.readGeneration, 1);
  assert.equal(await provider.getAccountRc("owner"), "2");
  assert.equal(calls.at(-1).url, B);
  assert.equal(provider.readGeneration, 1);
});
test("one total deadline bounds all attempts and aborts stalled requests", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const calls = [];
  const provider = new PinnedRpcProvider([A, B, "https://third.invalid"], CHAIN, {
    timeoutMs: 45, attemptTimeoutMs: 30,
    fetchImpl: async (_url, request) => { calls.push(request); return new Promise(() => {}); },
  });
  const pending = assert.rejects(provider.getHeadInfo(), /temporarily unavailable/);
  await advance(t, 30);
  await advance(t, 15);
  await pending;
  assert.equal(calls.length, 2);
  assert(calls.every(c => c.signal.aborted));
});
test("Stop during the chain probe prevents the transaction POST and any fallback", async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { provider, calls } = fixture((_url, body) => {
    entered(); return new Promise(resolve => { release = () => resolve(json(body.id, { chain_id: CHAIN })); });
  });
  const controller = new AbortController();
  const pending = provider.call("chain.submit_transaction", { transaction: {}, broadcast: true }, { signal: controller.signal });
  await started;
  controller.abort(Error("private-stop-reason"));
  await assert.rejects(pending, error => error.code === "koin_rpc_stopped" && !error.message.includes("private"));
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.method, "chain.get_chain_id");
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(provider.readGeneration, 0);
});
test("HTTP403 and narrow RPC timeout errors permit bounded reads but not broadcasts", async () => {
  for (const failure of [
    () => ({ ok: false, status: 403, text: async () => "<html>private</html>" }),
    body => ({ ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id,
      error: { code: -32603, message: "An internal server error has occurred", data: "rpc failed, context deadline exceeded private" } }) }),
  ]) {
    const { provider, calls } = fixture((url, body) => {
      if (body.method === "chain.get_chain_id") return;
      return url === A ? failure(body) : json(body.id, { rc: "42" });
    });
    assert.equal(await provider.getAccountRc("owner"), "42");
    assert.equal(calls.filter(c => c.body.method === "chain.get_account_rc").length, 2);
    const write = fixture((_url, body) => body.method === "chain.get_chain_id" ? undefined : failure(body));
    await assert.rejects(write.provider.call("chain.submit_transaction", { transaction: {}, broadcast: true }), /temporarily unavailable/);
    assert.equal(write.calls.filter(c => c.body.method === "chain.submit_transaction").length, 1);
  }
});
test("AMQP outage retries confirmation reads only after verifying the backup chain", async () => {
  const params = { transaction_ids: ["saved-transaction"], include_receipt: true };
  const result = { transactions: [{ transaction: { id: "saved-transaction" } }] };
  const { provider, calls } = fixture((url, body) => {
    if (body.method === "chain.get_chain_id") return;
    return url === A ? amqpError(body.id) : json(body.id, result);
  });
  assert.deepEqual(await provider.call("transaction_store.get_transactions_by_id", params), result);
  assert.deepEqual(calls.map(c => [c.url, c.body.method]), [
    [A, "chain.get_chain_id"], [A, "transaction_store.get_transactions_by_id"],
    [B, "chain.get_chain_id"], [B, "transaction_store.get_transactions_by_id"],
  ]);
  for (const call of calls.filter(c => c.body.method !== "chain.get_chain_id"))
    assert.deepEqual(call.body.params, params);
  assert.equal(provider.readGeneration, 1);

  const wrongChain = fixture((url, body) => url === A ? amqpError(body.id) : json(body.id, { chain_id: "wrong" }));
  await assert.rejects(wrongChain.provider.getHeadInfo(), error => error.code === "koin_rpc_chain_mismatch");
  assert.equal(wrongChain.calls.length, 2);
  assert(wrongChain.calls.every(c => c.body.method === "chain.get_chain_id"));
});
test("AMQP outage is sanitized, bounded for reads and never retries a broadcast", async () => {
  for (const broadcast of [false, true]) {
    const { provider, calls } = fixture((_url, body) =>
      body.method === "chain.get_chain_id" ? undefined : amqpError(body.id));
    const params = { transaction: { id: "saved", signatures: ["private-signature"] }, broadcast };
    await assert.rejects(provider.call("chain.submit_transaction", params), error => {
      assert.equal(error.code, "koin_rpc_unavailable");
      assert.equal(error.message, "KOIN RPC is temporarily unavailable. Check confirmation again shortly.");
      assert.doesNotMatch(JSON.stringify(error), /private|AMQP|rpc failed/);
      return true;
    });
    const submissions = calls.filter(c => c.body.method === "chain.submit_transaction");
    assert.deepEqual(submissions.map(c => c.url), broadcast ? [A] : [A, B]);
    for (const call of submissions) assert.deepEqual(call.body.params, params);
    assert.equal(provider.readGeneration, 0);
  }
});
test("AMQP diagnostics do not turn resource limits or contract failures into retries", async () => {
  for (const [error, code] of [
    [{ code: -32603, message: "insufficient rc", data: "rpc failed, AMQP connection is not open" }, "koin_rpc_insufficient_rc"],
    [{ code: -32603, message: "transaction reverted", data: '{"logs":["rpc failed, AMQP connection is not open private-key"]}' }, "koin_rpc_rejected"],
    [{ code: -32603, message: "transaction reverted: AMQP connection is not open", data: "private-key" }, "koin_rpc_rejected"],
    [{ code: 1, message: "contract rejected", data: "rpc failed, AMQP connection is not open" }, "koin_rpc_rejected"],
    [{ code: -32603, message: "An internal server error has occurred", data: "private-key" }, "koin_rpc_rejected"],
  ]) {
    const { provider, calls } = fixture((_url, body) => body.method === "chain.get_chain_id" ? undefined : rpcError(body.id, error));
    await assert.rejects(provider.call("chain.submit_transaction", { transaction: {}, broadcast: false }), failure => {
      assert.equal(failure.code, code);
      assert.doesNotMatch(failure.message, /private|AMQP|rpc failed/);
      return true;
    });
    assert.equal(calls.length, 2);
    assert(calls.every(c => c.url === A));
  }
});
// Exercise real production defaults without sleeping through long outages.
async function advance(t, ms) {
  t.mock.timers.tick(ms);
  await new Promise(resolve => setImmediate(resolve));
}
test("default budget allows a slow chain-verified backup after a fully stalled primary", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { provider, calls } = fixture(async (url, body) => {
    if (url === A) return new Promise(() => {});
    // Public RPC observations: chain probe ~9.4 s, requested read ~6.5 s.
    await new Promise(resolve => setTimeout(resolve, body.method === "chain.get_chain_id" ? 9428 : 6533));
    return json(body.id, body.method === "chain.get_chain_id" ? { chain_id: CHAIN } : { rc: "42" });
  });
  const pending = provider.getAccountRc("owner").then(value => ({ value }), error => ({ error: error.code }));
  await advance(t, 20000);
  assert.equal(calls[0].signal.aborted, true);
  assert.deepEqual(calls.map(c => [c.url, c.body.method]), [[A, "chain.get_chain_id"], [B, "chain.get_chain_id"]]);
  await advance(t, 9428);
  assert.equal(calls.at(-1).body.method, "chain.get_account_rc");
  await advance(t, 6533);
  assert.deepEqual(await pending, { value: "42" });
  assert.equal(provider.readGeneration, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.at(-1).body.params, { account: "owner" });
});
test("default total budget stops all stalled endpoints at 45 seconds", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const calls = [], endpoints = [A, B, "https://third.invalid"];
  const provider = new PinnedRpcProvider(endpoints, CHAIN, {
    fetchImpl: async (url, request) => { calls.push({ url, signal: request.signal }); return new Promise(() => {}); },
  });
  let settled = false;
  const pending = provider.getHeadInfo().then(
    () => { settled = true; return "unexpected success"; },
    error => { settled = true; return error.code; });
  await advance(t, 20000);
  await advance(t, 20000);
  assert.deepEqual(calls.map(c => c.url), endpoints);
  assert.equal(settled, false);
  await advance(t, 4999);
  assert.equal(settled, false);
  await advance(t, 1);
  assert.equal(await pending, "koin_rpc_unavailable");
  assert(calls.every(c => c.signal.aborted));
  assert.equal(provider.readGeneration, 0);
  assert.throws(() => new PinnedRpcProvider(endpoints, CHAIN, { timeoutMs: 45001 }), /Invalid pinned KOIN RPC settings/);
});
test("a slow broadcast still has one attempt and preserves its exact signed bytes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const transaction = { id: "saved", header: { nonce: "KAE=" }, signatures: ["saved-signature"] };
  const { provider, calls } = fixture(async (_url, body) => {
    if (body.method !== "chain.get_chain_id") return new Promise(() => {});
    await new Promise(resolve => setTimeout(resolve, 9428));
    return json(body.id, { chain_id: CHAIN });
  });
  const pending = provider.call("chain.submit_transaction", { transaction, broadcast: true })
    .then(() => "unexpected success", error => error.code);
  await advance(t, 9428);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.params, { transaction, broadcast: true });
  await advance(t, 20000 - 9428);
  assert.equal(await pending, "koin_rpc_unavailable");
  assert(calls.every(c => c.url === A && c.signal.aborted));
  assert.equal(calls.filter(c => c.body.method === "chain.submit_transaction").length, 1);
  assert.equal(provider.readGeneration, 0);
});
test("a privacy abort scopes inherited RPC reads without cancelling unrelated requests", async () => {
  const controller = new AbortController();
  const { provider, calls } = fixture((_url, body) => body.method === "chain.get_head_info" ? new Promise(() => {}) : undefined);
  const pending = provider.withSignal(controller.signal, () => provider.getHeadInfo()).catch(e => e.code);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal(await pending, "koin_rpc_stopped");
  assert.ok(calls.at(-1).signal.aborted);
  const count = calls.length;
  await assert.rejects(provider.withSignal(controller.signal, () => provider.getChainId()), e => e.code === "koin_rpc_stopped");
  assert.equal(calls.length, count, "No fresh RPC after privacy cancellation");
  assert.equal(await provider.getChainId(), CHAIN);
});

test("paced purchase RPC shares simultaneous chain probes and spreads the distinct reads", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const starts = [];
  const { provider, calls } = fixture(() => { starts.push(Date.now()); }, { requestIntervalMs: 250 });
  const pending = Promise.all([provider.getHeadInfo(), provider.getHeadInfo(), provider.getHeadInfo()]);
  for (let n = 0; n < 6; n++) await advance(t, n ? 250 : 0);
  await pending;
  assert.equal(calls.length, 4);
  for (let n = 1; n < starts.length; n++) assert.ok(starts[n] - starts[n - 1] >= 250);
  assert.equal(calls.filter(c => c.body.method === "chain.get_chain_id").length, 1);
});
test("Stop during a paced broadcast queue prevents its POST and leaves no reserved future slot", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { provider, calls } = fixture(() => {}, { requestIntervalMs: 250 });
  assert.equal(await provider.getChainId(), CHAIN);
  const controller = new AbortController();
  const pending = provider.call("chain.submit_transaction", { transaction: { id: "saved" }, broadcast: true }, { signal: controller.signal }).catch(e => e.code);
  await advance(t, 0); controller.abort();
  assert.equal(await pending, "koin_rpc_stopped");
  const next = provider.getChainId();
  await advance(t, 250); assert.equal(await next, CHAIN);
  assert.equal(calls.length, 2); assert(calls.every(c => c.body.method === "chain.get_chain_id"));
});
test("429 responses apply a bounded cooldown without retrying broadcasts", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { provider, calls } = fixture((_url, body) => body.method === "chain.get_chain_id" ? undefined :
    { ok: false, status: 429, headers: { get: () => "2" } }, { requestIntervalMs: 250 });
  const failed = provider.getHeadInfo().catch(e => ({ code: e.code, message: e.message }));
  await advance(t, 0); await advance(t, 250); await advance(t, 250);
  assert.equal((await failed).code, "koin_rpc_rate_limited");
  assert.equal(calls.length, 4);
  const next = provider.getChainId();
  await advance(t, 1749); assert.equal(calls.length, 4);
  await advance(t, 1); assert.equal(await next, CHAIN);
  const sent = provider.call("chain.submit_transaction", { transaction: { id: "saved", signatures: ["private-signature"] }, broadcast: true }).catch(e => e.code);
  await advance(t, 250); await advance(t, 250);
  assert.equal(await sent, "koin_rpc_rate_limited");
  assert.equal(calls.filter(c => c.body.method === "chain.submit_transaction").length, 1);
});
test("request deadlines include pacing and expired queued reads never run later", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { provider, calls } = fixture(() => {}, { requestIntervalMs: 250, attemptTimeoutMs: 10, timeoutMs: 20 });
  const pending = provider.getHeadInfo().catch(e => e.code);
  await advance(t, 0); await advance(t, 10); await advance(t, 10);
  assert.equal(await pending, "koin_rpc_unavailable");
  assert.equal(calls.length, 2);
  await advance(t, 1000); assert.equal(calls.length, 2);
});

test("verification phase chain pins are short lived, endpoint bound and never reused by a broadcast", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const { provider, calls } = fixture(() => {});
  await provider.withVerificationScope(async () => {
    await provider.getHeadInfo(); await provider.getAccountRc("owner");
    assert.equal(calls.filter(c => c.body.method === "chain.get_chain_id").length, 1);
    await provider.call("chain.submit_transaction", { transaction: { id: "saved" }, broadcast: true });
    assert.equal(calls.filter(c => c.body.method === "chain.get_chain_id").length, 2, "broadcast always verifies its endpoint immediately before sending");
    t.mock.timers.setTime(110000); await provider.getHeadInfo();
    assert.equal(calls.filter(c => c.body.method === "chain.get_chain_id").length, 3);
    await provider.withVerificationScope(() => provider.getHeadInfo());
    assert.equal(calls.filter(c => c.body.method === "chain.get_chain_id").length, 4, "next approval phase has an independent chain pin");
  });
  await provider.getHeadInfo();
  assert.equal(calls.filter(c => c.body.method === "chain.get_chain_id").length, 5, "no global chain-id cache");
});

test("aborting one simultaneous chain-probe waiter does not abort another action", async () => {
  let enter, release;
  const started = new Promise(resolve => { enter = resolve; });
  const { provider, calls } = fixture(async (_url, body) => {
    if (body.method === "chain.get_chain_id") { enter(); await new Promise(resolve => { release = resolve; }); }
  });
  const stop = new AbortController();
  const a = provider.call("chain.get_head_info", {}, { signal: stop.signal }).catch(e => e.code);
  const b = provider.getAccountRc("owner"); await started; stop.abort();
  assert.equal(await a, "koin_rpc_stopped");
  assert.equal(calls[0].signal.aborted, false);
  release(); await b;
  assert.equal(calls.filter(c => c.body.method === "chain.get_chain_id").length, 1);
  assert.equal(calls.filter(c => c.body.method === "chain.get_head_info").length, 0);
});

test("purchase reads can use a healthy pinned backup before a stalled primary deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let late;
  const { provider, calls } = fixture(async (url, body) => {
    if (url === A) return new Promise(resolve => { late = () => resolve(json(body.id, { chain_id: CHAIN })); });
    return json(body.id, body.method === "chain.get_chain_id" ? { chain_id: CHAIN } : { rc: "42" });
  }, { readHedgeMs: 750 });
  const result = provider.getAccountRc("owner");
  await advance(t, 749); assert.equal(calls.length, 1);
  await advance(t, 1); assert.equal(await result, "42");
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(provider.readGeneration, 1);
  late(); await advance(t, 0); assert.equal(provider.readGeneration, 1);
  await provider.getAccountRc("next"); assert.equal(calls.at(-1).url, B);
});

test("hedged reads retain chain mismatches, total deadlines, Stop and single broadcast behavior", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const wrong = fixture((url, body) => url === A ? new Promise(() => {}) : json(body.id, { chain_id: "wrong" }), { readHedgeMs: 10 });
  const mismatch = wrong.provider.getHeadInfo().catch(e => e.code);
  await advance(t, 10); assert.equal(await mismatch, "koin_rpc_chain_mismatch");
  assert(wrong.calls.every(c => c.body.method === "chain.get_chain_id"));
  const deadline = fixture(() => new Promise(() => {}), { readHedgeMs: 750, timeoutMs: 20, attemptTimeoutMs: 10 });
  const timed = deadline.provider.getHeadInfo().catch(e => e.code);
  await advance(t, 20); assert.equal(await timed, "koin_rpc_unavailable");
  await advance(t, 1000); assert.equal(deadline.calls.length, 1, "queued backup never starts beyond the total deadline");
  const stop = new AbortController(), paused = fixture(() => new Promise(() => {}), { readHedgeMs: 750 });
  const stoppedRead = paused.provider.call("chain.get_head_info", {}, { signal: stop.signal }).catch(e => e.code);
  await advance(t, 0); stop.abort(); assert.equal(await stoppedRead, "koin_rpc_stopped");
  await advance(t, 1000); assert.equal(paused.calls.length, 1);
  const write = fixture((_url, body) => body.method === "chain.get_chain_id" ? undefined : html(), { readHedgeMs: 750 });
  await assert.rejects(write.provider.call("chain.submit_transaction", { transaction: { id: "saved" }, broadcast: true }), /unavailable/);
  assert.equal(write.calls.filter(c => c.body.method === "chain.submit_transaction").length, 1);
  assert(write.calls.every(c => c.url === A));
});
