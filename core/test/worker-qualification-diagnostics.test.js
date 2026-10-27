"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const { Worker } = require("../lib/worker"), P = require("../lib/koin-network/job-protocol");
const Diagnostics = require("../lib/koin-network/provider-diagnostics");
const wallet = require("koilib").Signer.fromSeed("qualification-diagnostics-fixture"), modelHash = P.hash("model");
const target = { chainId: require("../lib/koin-network/payment-network").MAINNET_CHAIN, credits: wallet.address,
  creditsHash: "0x1220" + P.hash("contract"), policyHash: P.hash("policy"), domain: "shadow:mainnet-pilot-" + P.hash("diagnostic-fixture") };
function job() {
  const at = Date.now(), prompt = "Reply PONG", tariff = Object.fromEntries(Object.entries({ contextTokens: 512, inputAtomsPerMillion: "1", maxLatencyMs: 30000,
    maxOutputTokens: 8, model: "fast", modelHash, outputAtomsPerMillion: "1", templateHash: P.hash("template"), tokenizerHash: P.hash("tokenizer"), version: 1 }).sort(([a], [b]) => a.localeCompare(b)));
  const quote = { schema: 2, mode: "shadow", domain: target.domain, policyHash: target.policyHash, tariff,
    requestHash: P.hash("request"), promptHash: P.hash(prompt), inputIdsHash: P.hash("[7]"), inputTokens: 1, maxOutput: 8,
    maxCharge: "1", at, expires: at + 300000 };
  quote.hash = P.hash(JSON.stringify(quote));
  return { type: "koin-provider-qualification", policyHash: P.hash("quality-policy"), target,
    challenge: { type: "koin-shadow-chat", id: P.hash("job"), attempt: P.hash("attempt"), model: "fast", prompt, quote, dispatchedAt: at, deadline: at + 30000 } };
}
async function server(t, handler) {
  const server = http.createServer(handler); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); }); return `http://127.0.0.1:${server.address().port}`;
}
test("a real qualification tokenizer error survives an idle poll and clears only after an acknowledged retry", { timeout: 10000 }, async t => {
  let badTokens = true, polls = 0, loads = 0, releases = 0, signed = 0, submitted = 0, afterFailure, afterIdle, beforeAck;
  const endpoint = await server(t, (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/tokenize" ? { tokens: badTokens ? [8] : [7] } : { content: "PONG" }));
  });
  let worker;
  const schedulerUrl = await server(t, (req, res) => {
    if (req.url.startsWith("/worker/next-job")) {
      polls++;
      if (polls === 2) { afterFailure = worker.status(); res.writeHead(204); res.end(); return; }
      if (polls === 3) { afterIdle = worker.status(); badTokens = false; }
      if (polls === 4) { worker.running = false; res.writeHead(204); res.end(); return; }
      res.end(JSON.stringify({ job: job() })); return;
    }
    if (req.url.startsWith("/koin/provider/qualification/result")) {
      submitted++; beforeAck = worker.status();
      res.end(JSON.stringify({ accepted: true, qualification: { state: "testing" } })); return;
    }
    res.writeHead(404); res.end();
  });
  const providerSigner = { address: wallet.address, register() {}, presence() {}, assign() {}, qualification: async () => { signed++; return "fixture-signature"; }, chunk() {}, result() {}, release() {} };
  worker = new Worker({ schedulerUrl, providerSigner, fundedOnly: true, qualificationTarget: target, modelPins: { fast: modelHash },
    runtime: { status: () => ({ runtime: { kind: "llamacpp" } }), acquireFor: async () => { loads++; return { endpoint, release() { releases++; } }; } },
    models: { catalog: { aliases: { fast: { package: "fast" } }, packages: { fast: { sha256: modelHash } } }, packageStatus: () => ({ status: "ready" }) } });
  t.after(() => worker.stop()); worker.running = true; worker.token = "fixture"; worker._workAbort = new AbortController();
  await worker._run();
  assert.equal(afterFailure.modelDiagnostics[0].code, "tokenizer_mismatch"); assert.match(afterFailure.lastError, /tokenizer/);
  assert.deepEqual(afterIdle.modelDiagnostics, afterFailure.modelDiagnostics); assert.equal(afterIdle.lastError, null, "an idle poll must not erase the useful model failure");
  assert.deepEqual(beforeAck.modelDiagnostics, afterFailure.modelDiagnostics, "successful local inference is not a network acknowledgment");
  assert.deepEqual(worker.status().modelDiagnostics, []); assert.equal(loads, 2); assert.equal(releases, 2); assert.equal(signed, 1); assert.equal(submitted, 1);
  assert.equal(worker.stats.qualification.state, "testing", "diagnostics never grant qualification");
});

test("worker diagnostic lifecycle clears on identity changes and Stop without copying arbitrary error text", async () => {
  const providerSigner = { address: wallet.address, register() {}, presence() {}, assign() {}, qualification() {}, chunk() {}, result() {}, release() {} };
  const worker = new Worker({ schedulerUrl: "https://fixture.invalid", providerSigner, runtime: {}, fundedOnly: true, qualificationTarget: target, modelPins: { fast: modelHash } });
  const local = { model: "fast", code: "model_load_failed", at: Date.now(), message: "private runtime path and token" };
  worker._modelDiagnostics.set("fast", local);
  assert.deepEqual(worker.status().modelDiagnostics, [{ model: "fast", code: "model_load_failed", at: local.at }]);
  providerSigner.address = "changed-wallet"; assert.deepEqual(worker.status().modelDiagnostics, []);
  worker._modelDiagnostics.set("fast", local); await worker.stop(); assert.deepEqual(worker.status().modelDiagnostics, []);
});

test("local diagnostic classifications and renderer metadata are bounded and never include raw errors", () => {
  const now = Date.now(), secret = Error("Bearer secret: private prompt and filename");
  for (const [stage, error, expected] of [["loading", secret, "model_load_failed"], ["loading", { name: "TimeoutError" }, "preparation_timeout"],
    ["preparing", secret, "model_load_failed"], ["tokenizing", secret, "tokenizer_unavailable"], ["tokenizing", Error("Local tokenizer differs from quoted tokenizer"), "tokenizer_mismatch"],
    ["loading", Error("Shadow metering currently requires llama.cpp"), "runtime_unavailable"], ["answering", secret, "inference_failed"],
    ["answering", { name: "TimeoutError" }, "inference_timeout"], ["reporting", secret, "result_unconfirmed"], ["validating", secret, "check_invalid"]]) {
    assert.equal(Diagnostics.code(stage, error, now + 1000, now), expected);
  }
  assert.equal(Diagnostics.code("preparing", secret, now, now), "preparation_timeout");
  const valid = { model: "fast", code: "inference_failed", at: now };
  assert.deepEqual(Diagnostics.sanitize([{ ...valid, message: secret.message }, { ...valid, model: "private" }, { ...valid, code: "arbitrary" },
    { ...valid, at: now + 5001 }, { ...valid, at: now - 86400001 }, valid], ["fast"], now), [valid]);
  assert.deepEqual(Diagnostics.sanitize(Array(65).fill(valid), ["fast"], now), []);
});

test("idle 204 and empty 200 polls are spaced, release runtime admission, preserve long polling and stop immediately", { timeout: 10000 }, async t => {
  const requests = []; let releases = 0, firstIdle, fourthIdle, delayed;
  const first = new Promise(resolve => { firstIdle = resolve; }), fourth = new Promise(resolve => { fourthIdle = resolve; });
  const schedulerUrl = await server(t, (_req, res) => {
    requests.push(performance.now());
    const idle = () => { res.writeHead(204); res.end(); };
    if ([1, 4].includes(requests.length)) res.end(JSON.stringify({ job: null }));
    else if (requests.length === 2) delayed = setTimeout(idle, 1500); else idle();
  });
  t.after(() => clearTimeout(delayed));
  const worker = new Worker({ schedulerUrl, wallet: { address: wallet.address }, fundedOnly: true, idlePollMs: 5000,
    runtime: { acquireNetworkWork: async () => ({ release() {
      releases++; if (releases === 1) firstIdle(); if (releases === 4) fourthIdle();
    } }) } });
  t.after(() => worker.stop()); worker.running = true; worker.token = "fixture"; worker._workAbort = new AbortController(); worker._loop = worker._run();
  await first; assert.equal(requests.length, 1, "runtime admission is released during the empty-200 wait");
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(requests.length, 1, "an idle scheduler cannot be hot-polled");
  await fourth;
  assert.equal(requests.length, 4); assert.ok(requests[1] - requests[0] >= 950, "empty-200 requests have one-second spacing");
  assert.ok(requests[2] - requests[1] >= 1450 && requests[2] - requests[1] < 2200, "a long poll has no additional one-second wait");
  assert.ok(requests[3] - requests[2] >= 950, "immediate-204 requests have one-second spacing");
  const stopping = performance.now(); await worker.stop();
  assert.ok(performance.now() - stopping < 300, "Stop aborts the idle wait promptly");
  assert.equal(releases, 4, "each runtime admission releases exactly once"); assert.equal(worker.stats.lastError, null);
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(requests.length, 4, "Stop leaves no delayed poll behind");
});

test("Stop during admission release cannot strand an already-aborted idle wait", { timeout: 5000 }, async t => {
  let polls = 0, released = 0, stopping, stopped;
  const finished = new Promise(resolve => { stopped = resolve; });
  const schedulerUrl = await server(t, (_req, res) => { polls++; res.writeHead(204); res.end(); });
  const worker = new Worker({ schedulerUrl, wallet: { address: wallet.address }, runtime: { acquireNetworkWork: async () => ({ release() {
    released++; stopping = performance.now(); stopped(worker.stop());
  } }) } });
  t.after(() => worker.stop()); worker.running = true; worker.token = "fixture"; worker._workAbort = new AbortController(); worker._loop = worker._run();
  await finished;
  assert.ok(performance.now() - stopping < 300); assert.equal(polls, 1); assert.equal(released, 1);
  assert.equal(worker.running, false); assert.equal(worker._loop, null); assert.equal(worker.stats.lastError, null);
});
