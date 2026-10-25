"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const { Worker } = require("../lib/worker");

async function fixture(t, register) {
  const bodies = [], server = http.createServer(async (req, res) => {
    if (!req.url.startsWith("/worker/register")) { res.writeHead(204); res.end(); return; }
    let text = ""; for await (const part of req) text += part;
    bodies.push(JSON.parse(text)); register(req, res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const worker = new Worker({ schedulerUrl: `http://127.0.0.1:${server.address().port}`, wallet: { address: "fixture", signHash: async () => "fixture-signature" },
    runtime: {}, hardware: { ramBytes: 8e9 }, models: { aliases: () => [{ alias: "fast", status: "ready", minRamGb: 4 }] } });
  t.after(() => worker.stop());
  return { worker, bodies };
}
test("Stop aborts a pending provider registration and a delayed response cannot turn earning back on", async t => {
  let arrived, respond; const waiting = new Promise(resolve => { arrived = resolve; });
  const { worker } = await fixture(t, (_req, res) => { respond = () => res.end(JSON.stringify({ ok: true, token: "late" })); arrived(); });
  const pending = worker.start(); const rejected = assert.rejects(pending, /abort|cancel/i);
  await waiting; await worker.stop(); await rejected; respond();
  assert.equal(worker.running, false); assert.equal(worker.token, null); assert.equal(worker._loop, null);
});
test("caller deadline cancels provider registration and a later attempt connects normally", async t => {
  let requests = 0;
  const { worker } = await fixture(t, (_req, res) => { if (++requests > 1) res.end(JSON.stringify({ ok: true, token: "fresh" })); });
  await assert.rejects(worker.start(AbortSignal.timeout(50)), /timeout/i);
  assert.equal(worker.running, false); assert.equal(worker._registerGate, null);
  await worker.start(AbortSignal.timeout(1000)); assert.equal(worker.running, true); assert.equal(worker.token, "fresh");
  await worker.stop(); assert.equal(worker.running, false);
});
test("one provider advertises all installed matching network pins and excludes revoked, changed and unapproved models", async t => {
  const { worker, bodies } = await fixture(t, (_req, res) => res.end(JSON.stringify({ ok: true, token: "pins" })));
  const ids = ["fast", "smart", "changed", "revoked", "other"];
  worker.models = {
    aliases: () => ids.map(alias => ({ alias, status: "ready", minRamGb: 4 })),
    catalog: { aliases: Object.fromEntries(ids.map(id => [id, { package: id }])), packages: Object.fromEntries(ids.map(id => [id, { sha256: id === "changed" ? "b".repeat(64) : "a".repeat(64) }])) },
    quarantineOf: id => id === "revoked" ? "revoked" : null
  };
  worker.modelPins = Object.fromEntries(ids.filter(id => id !== "other").map(id => [id, "a".repeat(64)]));
  await worker._register(); assert.deepEqual(bodies[0].models, ["fast", "smart"]);
  assert.ok(worker.modelGate.filter(g => ["changed", "revoked", "other"].includes(g.alias)).every(g => !g.advertised && g.reasonCode === "unapproved"));
});

test("public prepaid provider refreshes an idle legacy poll after five seconds without a connection error or retry backoff", async t => {
  let polls = 0, resumed; const next = new Promise(resolve => { resumed = resolve; });
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/worker/register")) return res.end(JSON.stringify({ ok: true, token: "idle" }));
    if (++polls === 2) { res.writeHead(204); res.end(); resumed(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const worker = new Worker({ schedulerUrl: `http://127.0.0.1:${server.address().port}`, wallet: { address: "fixture", signHash: async () => "signature" },
    runtime: {}, fundedOnly: true, idlePollMs: 5000 });
  t.after(async () => { await worker.stop(); server.closeAllConnections(); server.close(); });
  const started = Date.now(); await worker.start();
  await next; const elapsed = Date.now() - started;
  await worker.stop();
  assert.ok(elapsed >= 4900 && elapsed < 7500, `idle poll renewed after ${elapsed}ms`);
  assert.equal(worker.stats.lastError, null);
});

test("an assigned response keeps the ordinary body deadline once headers arrive and Stop discards its late job", async t => {
  let polls = 0, response, received, headers;
  const entered = new Promise(resolve => { received = resolve; });
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/worker/register")) return res.end(JSON.stringify({ ok: true, token: "slow-body" }));
    polls++; response = res; res.writeHead(200, { "content-type": "application/json" }); res.flushHeaders(); received();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const worker = new Worker({ schedulerUrl: `http://127.0.0.1:${server.address().port}`, wallet: { address: "fixture", signHash: async () => "signature" },
    runtime: {}, fundedOnly: true, idlePollMs: 5000 });
  t.after(async () => { await worker.stop(); server.closeAllConnections(); server.close(); });
  let executed = 0; worker._execute = async () => { executed++; throw Error("A stopped response must not execute"); };
  await worker.start(); await entered;
  // The short deadline is only for an idle request, not a response that is
  // already delivering a job. No second poll should appear while its body waits.
  await new Promise(resolve => setTimeout(resolve, 5200));
  assert.equal(polls, 1); assert.equal(worker.stats.lastError, null);
  await worker.stop(); response.end(JSON.stringify({ job: { id: "late", type: "chat" } }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(executed, 0);
});
