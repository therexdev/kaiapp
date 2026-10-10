"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PinnedRpcProvider } = require("../lib/koin-network/rpc-provider");
const CHAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const A = "https://primary.invalid", B = "https://backup.invalid";
const json = (id, result) => ({ ok: true, status: 200,
  text: async () => JSON.stringify({ jsonrpc: "2.0", id, result }) });
const html = () => ({ ok: true, status: 200, text: async () => "<html>private-wallet-signature</html>" });
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
test("one total deadline bounds all attempts and aborts stalled requests", async () => {
  const calls = [];
  const provider = new PinnedRpcProvider([A, B, "https://third.invalid"], CHAIN, {
    timeoutMs: 45, attemptTimeoutMs: 30,
    fetchImpl: async (_url, request) => { calls.push(request); return new Promise(() => {}); },
  });
  const started = Date.now();
  await assert.rejects(provider.getHeadInfo(), /temporarily unavailable/);
  assert(Date.now() - started < 300);
  assert(calls.length <= 2);
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
