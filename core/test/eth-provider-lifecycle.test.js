"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const http = require("node:http");
const { makeProvider } = require("../lib/koinos/eth-bridge");

async function rpc(t, handler) {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = JSON.parse(body);
    const results = (Array.isArray(json) ? json : [json]).map(handler);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(json) ? results : results[0]));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("failed Ethereum discovery releases retries before trying the next provider", { timeout: 5000 }, async t => {
  let failedCalls = 0;
  const bad = await rpc(t, ({ id }) => { failedCalls++; return { jsonrpc: "2.0", id, error: { code: -32000, message: "offline fixture" } }; });
  const good = await rpc(t, ({ id, method }) => ({ jsonrpc: "2.0", id, result: method === "eth_chainId" ? "0x1" : "0x123" }));
  const provider = await makeProvider([bad, good], { timeoutMs: 500 });
  t.after(() => provider.destroy());
  assert.equal(await provider.getBlockNumber(), 0x123);
  assert.equal((await provider.getNetwork()).chainId, 1n);
  // Let a previously queued request finish, then cross ethers' one-second retry.
  await new Promise(resolve => setTimeout(resolve, 100));
  const after = failedCalls;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(failedCalls, after, "discarded provider stops making requests");
});

test("unresponsive Ethereum RPC is bounded and releases its provider", { timeout: 5000 }, async t => {
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const start = Date.now();
  await assert.rejects(makeProvider([`http://127.0.0.1:${server.address().port}`], { timeoutMs: 100 }), /No Ethereum RPC reachable/);
  assert.ok(Date.now() - start < 2000);
});

test("price quotes destroy owned providers on success and failure, preserve supplied providers", async t => {
  const bridge = require("../lib/koinos/eth-bridge"), swap = require("../lib/koinos/eth-swap");
  const { fetchUsdPerKoin } = require("../lib/koinos/koin-price");
  let destroyed = 0, fails = false;
  const provider = { destroy() { destroyed++; } };
  t.mock.method(bridge, "makeProvider", async () => provider);
  t.mock.method(swap, "quoteVkoinOut", async () => { if (fails) throw Error("offline fixture"); return 10000000000n; });
  assert.ok((await fetchUsdPerKoin()).usdPerKoin > 0);
  assert.equal(destroyed, 1);
  fails = true;
  assert.equal((await fetchUsdPerKoin()).usdPerKoin, null);
  assert.equal(destroyed, 2);
  assert.equal((await fetchUsdPerKoin({ provider })).usdPerKoin, null);
  fails = false;
  assert.ok((await fetchUsdPerKoin({ provider })).usdPerKoin > 0);
  assert.equal(destroyed, 2, "injected provider belongs to its caller");
});
