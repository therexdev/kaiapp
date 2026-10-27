"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const { Worker } = require("../lib/worker"), { Signer } = require("koilib");
const { MAINNET_CHAIN } = require("../lib/koin-network/payment-network");
const hash = "a".repeat(64), wallet = Signer.fromSeed("shared-model-selection-fixture");
const target = { chainId: MAINNET_CHAIN, credits: wallet.address, creditsHash: "0x1220" + hash,
  policyHash: hash, domain: "shadow:mainnet-pilot-" + hash };
function models() {
  return { aliases: () => ["fast", "smart"].map(alias => ({ alias, status: "ready", minRamGb: 4 })),
    catalog: { aliases: { fast: { package: "fast" }, smart: { package: "smart" } }, packages: { fast: { sha256: hash }, smart: { sha256: hash } } },
    quarantineOf: () => null, packageStatus: () => ({ status: "ready" }) };
}
async function server(t, handle) {
  const server = http.createServer(handle); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
test("selected pins gate registration and signed presence when local Chat uses an unselected model", async t => {
  const bodies = [], schedulerUrl = await server(t, async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    bodies.push({ url: req.url, value: JSON.parse(body) });
    res.end(JSON.stringify(req.url === "/worker/register" ? { ok: true, token: "selected" } : { ok: true }));
  });
  let activeAlias = "smart";
  const worker = new Worker({ schedulerUrl, wallet, runtime: { status: () => ({ activeAlias, runtime: { running: true } }) },
    hardware: { ramBytes: 8e9 }, models: models(), modelPins: { fast: hash } });
  t.after(() => worker.stop());
  await worker._register(); assert.deepEqual(bodies[0].value.models, ["fast"]);
  assert.equal(bodies[0].value.capabilities.koinModelOnDemand, 0, "legacy wallet providers do not claim delegated on-demand readiness");
  worker.running = true; worker._koinAvailable = true; worker._koinSession = "b".repeat(32); worker._koinSequence = 0;
  await worker._koinPresence();
  assert.equal(bodies[1].value.report.ready, false); assert.equal(bodies[1].value.report.model, "");
  activeAlias = "fast"; await worker._koinPresence();
  assert.equal(bodies[2].value.report.ready, true); assert.equal(bodies[2].value.report.model, "fast");
  worker.models.quarantineOf = () => "revoked"; await worker._koinPresence();
  assert.equal(bodies[3].value.report.ready, false); assert.equal(bodies[3].value.report.model, "");
});
test("scoped providers sign the on-demand claim with exactly the selected installed models", async t => {
  let registered, signed;
  const schedulerUrl = await server(t, async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    registered = JSON.parse(body); res.end(JSON.stringify({ ok: true, token: "scoped" }));
  });
  const providerSigner = { address: wallet.address, register: async body => { signed = structuredClone(body); return "scoped-proof"; },
    presence() {}, assign() {}, qualification() {}, chunk() {}, result() {}, release() {} };
  const worker = new Worker({ schedulerUrl, providerSigner, runtime: {}, hardware: { ramBytes: 8e9 }, models: models(),
    modelPins: { fast: hash }, fundedOnly: true, qualificationTarget: target });
  t.after(() => worker.stop()); await worker._register();
  assert.deepEqual(signed.models, ["fast"]);
  assert.equal(signed.capabilities.koinModelOnDemand, 1);
  assert.deepEqual(registered, { ...signed, signature: "scoped-proof" });
});
test("funded and legacy assignments for unselected, removed or changed models cannot enter inference", async () => {
  let loads = 0;
  const worker = new Worker({ schedulerUrl: "https://fixture.invalid", wallet, runtime: { acquireFor: async () => { loads++; throw Error("must not load"); } },
    models: models(), modelPins: { fast: hash }, fundedOnly: true });
  for (const type of ["koin-mainnet-pilot-chat", "koin-funded-rehearsal-chat", "koin-shadow-chat", "chat", "inference-eval", "koin-provider-prepare"])
    await assert.rejects(worker._execute({ type, model: "smart" }), /not selected/);
  worker.models.packageStatus = () => ({ status: "absent" });
  await assert.rejects(worker._execute({ type: "koin-mainnet-pilot-chat", model: "fast" }), /not selected/);
  worker.models.packageStatus = () => ({ status: "ready" }); worker.models.catalog.packages.fast.sha256 = "c".repeat(64);
  await assert.rejects(worker._execute({ type: "koin-mainnet-pilot-chat", model: "fast" }), /not selected/);
  assert.equal(loads, 0);
});
test("a stale scheduler qualification for an unselected model is refused before inference or signing an answer", async t => {
  let loads = 0, signs = 0, submissions = 0;
  const schedulerUrl = await server(t, (req, res) => {
    if (!req.url.startsWith("/worker/next-job")) submissions++;
    res.end(JSON.stringify({ job: { type: "koin-provider-qualification", challenge: { model: "smart" } } }));
  });
  let failure;
  const worker = new Worker({ schedulerUrl, wallet: { address: wallet.address, signHash: async () => { signs++; return "signature"; } },
    runtime: { acquireFor: async () => { loads++; throw Error("must not load"); } }, models: models(), modelPins: { fast: hash }, fundedOnly: true, qualificationTarget: target,
    onEvent: event => { if (event.type === "worker:job-failed") { failure = event.message; worker.running = false; } } });
  t.after(() => worker.stop()); worker.running = true; worker.token = "selected"; worker._workAbort = new AbortController();
  await worker._run();
  assert.match(failure, /not selected/); assert.equal(loads, 0); assert.equal(signs, 0); assert.equal(submissions, 0);
});
