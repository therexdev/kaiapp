"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const { Worker } = require("../lib/worker"), { Signer } = require("koilib");
const { MAINNET_CHAIN } = require("../lib/koin-network/payment-network");
const { validatePreparation } = require("../lib/koin-network/qualification-protocol");
const hash = "a".repeat(64), address = Signer.fromSeed("preparation-fixture").address;
const target = { chainId: MAINNET_CHAIN, credits: address, creditsHash: "0x1220" + hash, policyHash: hash, domain: "shadow:mainnet-pilot-" + hash };
const catalog = { aliases: { fast: { package: "fast" }, smart: { package: "smart" } }, packages: { fast: { sha256: hash }, smart: { sha256: hash } } };
const job = (now = Date.now()) => ({ type: "koin-provider-prepare", target, policyHash: hash, model: "smart", modelHash: hash, issuedAt: now, expiresAt: now + 120000 });
function fixture(runtime = {}) {
  const counts = { assigned: 0, signed: 0, released: 0, loaded: 0, ready: 0 };
  let activeAlias = "fast";
  const providerSigner = { address, register() {}, presence() { counts.signed++; return "presence-proof"; }, assign() { counts.assigned++; throw Error("preparation cannot receive job authority"); }, qualification() {}, chunk() {}, result() {}, release() {} };
  const worker = new Worker({ schedulerUrl: "http://127.0.0.1:1", providerSigner, qualificationTarget: target, fundedOnly: true,
    modelPins: { smart: hash }, models: { catalog: structuredClone(catalog), quarantineOf: () => null, packageStatus: () => ({ status: "ready" }) },
    runtime: { status: () => ({ activeAlias, loading: false, runtime: { kind: "llamacpp", running: true } }),
      acquireFor: async model => { counts.loaded++; activeAlias = model; return { release() { counts.released++; } }; }, ...runtime } });
  worker.running = true; worker._workAbort = new AbortController(); worker._koinAvailable = true; worker._koinSession = "b".repeat(32); worker._koinSequence = 0; worker.token = "fixture";
  return { worker, counts };
}

test("preparation validates exact deployed target, package identity and bounded lifetime before loading", () => {
  const now = Date.now(), valid = job(now);
  assert.deepEqual(validatePreparation(valid, catalog, target, now), valid);
  for (const mutate of [
    j => { j.extra = true; }, j => { j.type = "chat"; }, j => { j.target = { ...target, policyHash: "b".repeat(64) }; },
    j => { j.policyHash = "bad"; }, j => { j.modelHash = "b".repeat(64); }, j => { j.model = "missing"; },
    j => { j.expiresAt = now + 120001; }, j => { j.expiresAt = now; }, j => { j.issuedAt = now + 60001; j.expiresAt = now + 70000; },
  ]) { const invalid = structuredClone(valid); mutate(invalid); assert.throws(() => validatePreparation(invalid, catalog, target, now)); }
  const custom = structuredClone(catalog); custom.aliases.smart.custom = true;
  assert.throws(() => validatePreparation(valid, custom, target, now), /approved public model/);
});

test("actual worker preparation loads and reports presence without assignment, inference or a payment result", async t => {
  const f = fixture(), paths = []; let polls = 0;
  const server = http.createServer(async (req, res) => {
    paths.push(req.url.split("?")[0]);
    if (req.url.startsWith("/worker/next-job")) {
      if (++polls === 1) return res.end(JSON.stringify({ job: job() }));
      f.worker.running = false; res.writeHead(204); return res.end();
    }
    let body = ""; for await (const part of req) body += part;
    const value = JSON.parse(body); assert.equal(value.report.ready, true); assert.equal(value.report.model, "smart");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await f.worker.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  f.worker.schedulerUrl = `http://127.0.0.1:${server.address().port}`;
  await f.worker._run();
  assert.deepEqual(paths, ["/worker/next-job", "/koin/presence", "/worker/next-job"]);
  assert.equal(f.counts.assigned, 0); assert.equal(f.counts.loaded, 1); assert.equal(f.counts.signed, 1); assert.equal(f.counts.released, 1);
});

test("Stop and expiration cancel preparation promptly and release a late lease without reporting ready", async () => {
  for (const stop of [true, false]) {
    let resolveLoad, started;
    const loading = new Promise(resolve => { started = resolve; });
    const f = fixture({ acquireFor: () => { started(); return new Promise(resolve => { resolveLoad = resolve; }); } });
    f.worker._koinPresence = async () => { f.counts.ready++; return true; };
    const request = job(); if (!stop) request.expiresAt = Date.now() + 40;
    const promise = f.worker._prepareQualification(request);
    await loading;
    if (stop) await f.worker.stop();
    // Keep a test handle alive while AbortSignal.timeout's unref'ed timer runs.
    const keepAlive = setTimeout(() => {}, 500);
    await assert.rejects(promise); clearTimeout(keepAlive);
    resolveLoad({ release() { f.counts.released++; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.counts.released, 1); assert.equal(f.counts.ready, 0); assert.equal(f.counts.assigned, 0);
    await f.worker.stop();
  }
});

test("failed or unselected preparation never advertises ready and rejected presence does not spin reloads", async () => {
  const f = fixture(); f.worker._koinPresence = async () => { f.counts.ready++; return false; };
  await assert.rejects(f.worker._prepareQualification({ ...job(), model: "fast" }), /not selected/);
  assert.equal(f.counts.loaded, 0);
  const original = f.worker.runtime.status; f.worker.runtime.status = () => ({ activeAlias: "smart", runtime: { kind: "llamacpp", running: false } });
  await assert.rejects(f.worker._prepareQualification(job()), /not ready/);
  assert.equal(f.counts.ready, 0); assert.equal(f.counts.released, 1);
  f.worker.runtime.status = original;
  const pending = f.worker._prepareQualification(job());
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.counts.ready, 1); assert.equal(f.counts.loaded, 2);
  await f.worker.stop(); await assert.rejects(pending);
  assert.equal(f.counts.released, 2); assert.equal(f.counts.ready, 1);
});
