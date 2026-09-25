"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const http = require("http");
const { Signer } = require("koilib");
const { hash, validateJob, validateQuote, resultHash } = require("../lib/koin-network/job-protocol");
const { executeShadow } = require("../lib/koin-network/shadow-worker");
const { Worker } = require("../lib/worker");
const modelHash = hash("model"), prompt = "<fixture>hello</fixture>", ids = [10, 20, 30];
const catalog = { aliases: { "koinos-fast": { package: "approved" } }, packages: { approved: { sha256: modelHash } } };
function fixtureJob() {
  const tariff = { contextTokens: 4096, inputAtomsPerMillion: "1000000", maxLatencyMs: 60000,
    maxOutputTokens: 100, model: "koinos-fast", modelHash, outputAtomsPerMillion: "2000000",
    templateHash: hash("template"), tokenizerHash: hash("tokenizer"), version: 1 };
  const at = Date.now(), q = { schema: 2, mode: "shadow", domain: "shadow:worker-test", policyHash: hash("policy"), tariff,
    requestHash: hash("messages"), promptHash: hash(prompt), inputIdsHash: hash(JSON.stringify(ids)), inputTokens: 3,
    maxOutput: 17, maxCharge: "37", at, expires: at + 300000 };
  q.hash = hash(JSON.stringify(q));
  return { id: hash("job"), type: "koin-shadow-chat", model: "koinos-fast", prompt, quote: q,
    attempt: hash("attempt"), dispatchedAt: at, deadline: at + 60000 };
}
async function engine(t, handler) {
  const calls = [], server = http.createServer(async (req, res) => {
    let text = ""; for await (const b of req) text += b;
    const body = JSON.parse(text); calls.push({ path: req.url, body });
    const result = handler ? await handler(req.url, body) : req.url === "/tokenize" ? { tokens: ids } : { content: "4", tokens_predicted: 999999 };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  let released = 0;
  const runtime = { status: () => ({ runtime: { kind: "llamacpp" } }), acquireFor: async () => ({
    endpoint: `http://127.0.0.1:${server.address().port}`, release: () => { released++; } }) };
  return { calls, runtime, released: () => released };
}
test("shadow quotes commit all terms and public-model jobs reject unsupported fields", () => {
  const job = fixtureJob(); validateJob(job, catalog); validateQuote(job.quote);
  assert.throws(() => validateJob({ ...job, tools: [{ name: "shell" }] }, catalog), /Invalid shadow/);
  assert.throws(() => validateJob({ ...job, prompt: "different" }, catalog), /Prompt commitment/);
  assert.throws(() => validateQuote({ ...job.quote, maxCharge: "1" }), /price mismatch/);
  assert.throws(() => validateQuote({ ...job.quote, mode: "paid" }), /Invalid shadow/);
  assert.throws(() => validateJob(job, { ...catalog, aliases: { "koinos-fast": { package: "approved", custom: true } } }), /public model/);
  assert.throws(() => validateJob(job, { ...catalog, packages: { approved: { sha256: hash("other") } } }), /public model/);
  assert.throws(() => validateJob(job, catalog, job.deadline), /Expired/);
  assert.notDeepEqual(resultHash(job.quote.domain, job.id, job.attempt, job.quote.hash, "4"),
    resultHash(job.quote.domain, job.id, hash("other attempt"), job.quote.hash, "4"));
});
test("worker uses committed prompt and exact token ceiling, ignoring provider usage", async (t) => {
  const e = await engine(t), job = fixtureJob();
  const r = await executeShadow({ job, catalog, runtime: e.runtime });
  assert.equal(r.output, "4"); assert.equal(r.usage.completion_tokens, 0);
  assert.deepEqual(e.calls.map((c) => c.path), ["/tokenize", "/completion"]);
  assert.equal(e.calls[0].body.add_special, false); assert.equal(e.calls[0].body.parse_special, true);
  assert.deepEqual(e.calls[1].body, { prompt, n_predict: 17, temperature: 0, stream: false, cache_prompt: false });
  assert.equal(e.released(), 1);
});
test("token ID mismatch blocks inference even when token counts are equal", async (t) => {
  const e = await engine(t, () => ({ tokens: [10, 20, 99] }));
  await assert.rejects(executeShadow({ job: fixtureJob(), catalog, runtime: e.runtime }), /differs/);
  assert.equal(e.calls.length, 1); assert.equal(e.released(), 1);
});
test("no opt-in, fallback engine and remote runtime endpoints are refused", async (t) => {
  const e = await engine(t), job = fixtureJob();
  const w = new Worker({ runtime: e.runtime, models: { catalog }, koinShadowJobs: false });
  await assert.rejects(w._execute(job), /opt-in/); assert.equal(e.calls.length, 0);
  const fallback = { ...e.runtime, status: () => ({ runtime: { kind: "ollama" } }) };
  await assert.rejects(executeShadow({ job, catalog, runtime: fallback }), /llama.cpp/);
  const remote = { ...e.runtime, acquireFor: async () => ({ endpoint: "https://remote.example", release() {} }) };
  await assert.rejects(executeShadow({ job, catalog, runtime: remote }), /Local runtime/);
});
test("Stop aborts shadow generation and releases the managed runtime", async (t) => {
  let began; const started = new Promise((r) => { began = r; });
  const e = await engine(t, async (url) => {
    if (url === "/tokenize") return { tokens: ids };
    began(); await new Promise((r) => setTimeout(r, 50)); return { content: "late" };
  });
  const worker = new Worker({ runtime: e.runtime, models: { catalog }, koinShadowJobs: true });
  const execution = worker._execute(fixtureJob());
  const rejected = assert.rejects(execution, /abort/i);
  await started; await worker.stop(); await rejected;
  assert.equal(e.released(), 1);
});
test("truncated results are never signed as successful work", async (t) => {
  const e = await engine(t, (url) => url === "/tokenize" ? { tokens: ids } : { content: "partial", truncated: true });
  await assert.rejects(executeShadow({ job: fixtureJob(), catalog, runtime: e.runtime }), /truncated/);
  assert.equal(e.released(), 1);
});
test("worker loop submits a bound shadow receipt without legacy earnings or chunk traffic", async (t) => {
  const e = await engine(t), signer = Signer.fromSeed("worker-shadow-loop"), job = fixtureJob();
  let received, instance;
  const paths = [], scheduler = http.createServer(async (req, res) => {
    paths.push(new URL(req.url, "http://fixture").pathname);
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/worker/next-job")) { res.end(JSON.stringify({ job })); return; }
    if (req.url.startsWith("/koin/shadow/jobs/result")) {
      let raw = ""; for await (const part of req) raw += part;
      received = JSON.parse(raw);
      res.end(JSON.stringify({ mode: "shadow", paymentsEnabled: false, accepted: true })); return;
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => scheduler.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { scheduler.closeAllConnections(); scheduler.close(r); }));
  instance = new Worker({ schedulerUrl: `http://127.0.0.1:${scheduler.address().port}`, runtime: e.runtime,
    wallet: { signHash: async (h) => Buffer.from(await signer.signHash(h)).toString("base64") }, models: { catalog },
    koinShadowJobs: true, onEvent: (event) => { if (event.type === "worker:shadow-job-done" || event.type === "worker:job-failed") instance.running = false; } });
  instance.running = true; instance.token = "fixture";
  await instance._run();
  assert.ok(received); assert.deepEqual(paths, ["/worker/next-job", "/koin/shadow/jobs/result"]);
  assert.equal(Signer.recoverAddress(resultHash(job.quote.domain, job.id, job.attempt, job.quote.hash, received.output), Buffer.from(received.signature, "base64")), signer.getAddress());
  assert.equal(instance.stats.jobsDone, 0); assert.equal(instance.stats.receiptsAccepted, 0);
  assert.equal(instance.stats.shadowJobsDone, 1);
});
