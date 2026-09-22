"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createProvider } = require("../lib/koinos-rpc");
const { ChainService } = require("../lib/koinos/chain");
const { ChainRead } = require("../lib/chain-read");
const { NETWORKS } = require("../lib/koinos/constants");

const PUBLIC = ["https://api.koinosai.com", "https://api.koinosblocks.com", "https://api.koinos.io"];
const settings = (values = {}) => ({ get: (key, fallback) => values[key] ?? fallback });
const success = result => Response.json({ jsonrpc: "2.0", id: 1, result });

test("both app chain clients prefer KAI, retain both backups, and preserve custom RPC priority", () => {
  for (const [Client, key] of [[ChainService, "customRpc.mainnet"], [ChainRead, "koinos.rpcUrl"]]) {
    assert.deepEqual(new Client(settings()).provider().rpcNodes, PUBLIC);
    const own = "https://our-node.example";
    assert.deepEqual(new Client(settings({ [key]: own })).provider().rpcNodes, [own, ...PUBLIC]);
    assert.deepEqual(new Client(settings({ [key]: PUBLIC[0] + "/" })).rpcUrls(), [PUBLIC[0] + "/", ...PUBLIC.slice(1)]);
    assert.deepEqual(new Client(settings({ [key]: PUBLIC[1] + "/" })).rpcUrls(), [PUBLIC[1] + "/", PUBLIC[0], PUBLIC[2]]);
  }
  const net = { network: "harbinger" };
  assert.deepEqual(new ChainService(settings(net)).rpcUrls(), ["http://127.0.0.1:8081"]);
  assert.deepEqual(new ChainService(settings({ ...net, "customRpc.harbinger": "https://testnet.example" })).rpcUrls(), ["https://testnet.example"]);
});

async function endpoint(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("real HTTP reaches the second backup after two failures, then returns to the recovered primary", async t => {
  const hits = [];
  let down = true;
  const first = await endpoint(t, (req, res) => {
    hits.push("primary");
    assert.equal(req.headers["content-type"], "application/json");
    res.writeHead(down ? 503 : 200, { "Content-Type": "application/json" });
    res.end(down ? "unavailable" : JSON.stringify({ result: { head_topology: { height: "102" } } }));
  });
  const second = await endpoint(t, (_req, res) => {
    hits.push("first-backup");
    res.writeHead(429); res.end("rate limited");
  });
  const third = await endpoint(t, (_req, res) => {
    hits.push("second-backup");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: { head_topology: { height: "101" } } }));
  });
  const provider = new ChainService(settings()).provider([first, second, third]);
  assert.equal((await provider.getHeadInfo()).head_topology.height, "101");
  down = false;
  assert.equal((await provider.getHeadInfo()).head_topology.height, "102");
  assert.deepEqual(hits, ["primary", "first-backup", "second-backup", "primary"]);
});

test("timeout aborts a stalled request before moving to the backup", async () => {
  const hits = [];
  let aborted = false;
  const provider = createProvider(PUBLIC, { timeoutMs: 20, fetchImpl: async (url, { signal }) => {
    hits.push(url);
    if (url === PUBLIC[2]) return success({ chain_id: "mainnet" });
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted"));
    }, { once: true }));
  } });
  assert.equal(await provider.getChainId(), "mainnet");
  assert.equal(aborted, true);
  assert.deepEqual(hits, PUBLIC);
});

test("HTTP rejection, malformed data, transport errors and a missing RPC service fall back", async t => {
  for (const [label, fail] of [
    ["HTTP 403", () => new Response("Forbidden", { status: 403 })],
    ["invalid JSON", () => new Response("<html>proxy error</html>")],
    ["missing result", () => Response.json({ jsonrpc: "2.0" })],
    ["connection failure", () => { throw new Error("connection reset"); }],
    ["missing service", () => Response.json({ error: { code: -32601, message: "Method not found" } })],
  ]) await t.test(label, async () => {
    const hits = [];
    const provider = createProvider(PUBLIC, { fetchImpl: async url => {
      hits.push(url);
      return url === PUBLIC[0] ? fail() : success({ values: [] });
    } });
    assert.deepEqual(await provider.call("account_history.get_account_history", { address: "public-test-address" }), { values: [] });
    assert.deepEqual(hits, PUBLIC.slice(0, 2));
  });
});

test("all unavailable endpoints fail once each without an endless retry loop", async () => {
  const hits = [];
  const provider = createProvider(PUBLIC, { fetchImpl: async url => {
    hits.push(url);
    return new Response("unavailable", { status: 503 });
  } });
  await assert.rejects(provider.getHeadInfo(), /HTTP 503/);
  assert.deepEqual(hits, PUBLIC);
});

test("chain rejection preserves logs and does not try a different provider", async () => {
  const hits = [];
  const provider = createProvider(PUBLIC, { fetchImpl: async url => {
    hits.push(url);
    return Response.json({ error: { code: -32603, message: "transaction rejected", data: JSON.stringify({ logs: ["insufficient mana"] }) } });
  } });
  await assert.rejects(provider.call("chain.submit_transaction", { transaction: { id: "test-only" } }), /insufficient mana/);
  assert.deepEqual(hits, [PUBLIC[0]]);
});

test("submission transport fallback reuses the exact signed payload without preparing another transaction", async () => {
  const bodies = [];
  const params = { transaction: { id: "test-only", signatures: ["fixture-only"] }, broadcast: true };
  const provider = createProvider(PUBLIC, { fetchImpl: async (url, { body }) => {
    bodies.push(body);
    return url === PUBLIC[0] ? new Response("unavailable", { status: 503 }) : success({ receipt: { id: "test-only" } });
  } });
  assert.deepEqual(await provider.call("chain.submit_transaction", params), { receipt: { id: "test-only" } });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(JSON.parse(bodies[1]).params, params);
});

test("parallel requests keep independent priority and retry budgets", async () => {
  const hits = { a: [], b: [] };
  const provider = createProvider(PUBLIC, { fetchImpl: async (url, { body }) => {
    const { method } = JSON.parse(body);
    hits[method].push(url);
    if (url === PUBLIC[0]) {
      await new Promise(resolve => setImmediate(resolve));
      return new Response("unavailable", { status: 503 });
    }
    return success(method);
  } });
  assert.deepEqual(await Promise.all([provider.call("a", {}), provider.call("b", {})]), ["a", "b"]);
  assert.deepEqual(hits, { a: PUBLIC.slice(0, 2), b: PUBLIC.slice(0, 2) });
});

test("public backup cannot make an unavailable local node appear healthy", async t => {
  const hits = [];
  const local = NETWORKS.mainnet.localRpcUrl;
  t.mock.method(globalThis, "fetch", async url => {
    hits.push(url);
    return url === local
      ? new Response("stopped", { status: 503 })
      : success({ head_topology: { height: "100" }, last_irreversible_block: "90", head_block_time: String(Date.now()) });
  });
  const status = await new ChainService(settings()).syncStatus();
  assert.match(status.local.error, /HTTP 503/);
  assert.equal(status.inSync, false);
  assert.equal(status.remote.height, 100);
  assert.deepEqual(hits.sort(), [local, PUBLIC[0]].sort());
});
