"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http"), crypto = require("node:crypto");
const { RuntimeManager } = require("../lib/runtime-manager"), { Worker } = require("../lib/worker"), { LocalProviderCheck } = require("../../electron/provider-check");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { const end = Date.now() + 2000; while (!check()) { if (Date.now() > end) throw Error("Condition did not complete"); await new Promise(r => setTimeout(r, 5)); } }
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-check-network-")), file = path.join(directory, "model.gguf");
  fs.writeFileSync(file, "fixture model bytes");
  const pack = structuredClone(require("../provider-check/candidates.json")), model = pack.models.find(m => m.model === "koinos-smart"); pack.models = [model]; model.modelHash = hash("fixture model bytes");
  const tokenMap = new Map(); let n = 0;
  for (const v of model.vectors) { const ids = [++n, 7]; v.count = ids.length; v.idsHash = hash(JSON.stringify(ids)); tokenMap.set(v.text, ids); }
  for (const c of model.cases) { const ids = [++n, 9]; c.inputTokens = ids.length; c.inputIdsHash = hash(JSON.stringify(ids)); tokenMap.set(c.prompt, ids); }
  const models = { catalog: { aliases: { [model.model]: { package: model.package } }, packages: { [model.package]: { sha256: model.modelHash } } },
    resolveAlias: () => ({}), packagePath: () => file, quarantineOf: () => null, aliases: () => [{ alias: model.model, status: "ready", minRamGb: 1 }] };
  const runtime = new RuntimeManager({ models }); runtime.activeAlias = model.model;
  runtime.runtime = { endpoint: "http://127.0.0.1:12345", status: () => ({ kind: "llamacpp", running: true, pid: 123, endpoint: "http://127.0.0.1:12345", model: file }) };
  const firstPoll = deferred(), firstGeneration = deferred(), generated = deferred(), submission = deferred(), acknowledge = deferred(), localGeneration = deferred(), localRelease = deferred();
  const polls = [], reports = []; let localRequests = 0, localCompletions = 0;
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    if (req.url.startsWith("/worker/register")) return res.end(JSON.stringify({ ok: true, token: "fixture-token", koinShadow: true }));
    if (req.url === "/koin/presence") { reports.push(JSON.parse(body).report); return res.end("{}"); }
    if (req.url.startsWith("/worker/next-job")) { polls.push(res); firstPoll.resolve(); return; }
    if (req.url.startsWith("/worker/result")) { assert.equal(JSON.parse(body).signature, "fixture-signature"); submission.resolve(); await acknowledge.promise; return res.end(JSON.stringify({ accepted: true })); }
    res.writeHead(204); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const worker = new Worker({ schedulerUrl: `http://127.0.0.1:${server.address().port}`, runtime, models,
    hardware: { ramBytes: 8e9 }, wallet: { address: "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK", signHash: async () => "fixture-signature" } });
  worker._execute = async () => { firstGeneration.resolve(); await generated.promise; return { output: "fixture answer", usage: { completion_tokens: 1 } }; };
  const check = new LocalProviderCheck({ core: { runtime, models, account: { wallet: worker.wallet } }, appVersion: "fixture", pack,
    fetchImpl: async (url, init) => {
      localRequests++; const body = JSON.parse(init.body);
      if (url.endsWith("/tokenize")) return Response.json({ tokens: tokenMap.get(body.content) });
      if (++localCompletions === 1) { localGeneration.resolve(); await Promise.race([localRelease.promise, new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }))]); }
      return Response.json({ content: model.cases.find(c => c.inputIdsHash === hash(JSON.stringify(body.prompt))).expected[0], stop: true, stopped_eos: true });
    } });
  t.after(async () => { generated.resolve(); acknowledge.resolve(); localRelease.resolve(); check.cancel(); await worker.stop(); await check.task; server.closeAllConnections(); server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { worker, runtime, check, file, polls, reports, firstPoll, firstGeneration, generated, submission, acknowledge, localGeneration, localRelease,
    get localRequests() { return localRequests; }, deliver: () => polls[0].end(JSON.stringify({ job: { id: "fixture-job", type: "chat" } })) };
}

test("local diagnostic drains an assigned poll, generation and signed submission before checking, then earning resumes", { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.worker.start(); await f.firstPoll.promise;
  f.check.start(); await turn();
  assert.equal(f.runtime.networkWorkPaused(), true); assert.equal(f.localRequests, 0);
  await until(() => f.reports.some(r => r.ready === false));
  f.deliver(); await f.firstGeneration.promise; assert.equal(f.localRequests, 0, "assigned inference finishes first");
  f.generated.resolve(); await f.submission.promise; assert.equal(f.localRequests, 0, "signed result acknowledgment finishes first");
  f.acknowledge.resolve(); await f.localGeneration.promise;
  assert.equal(f.polls.length, 1, "no new poll competes with the local diagnostic");
  assert.equal(f.worker.running, true, "the user's earning switch stays on");
  // Ordinary same-model local chat leases keep their existing semantics.
  const chat = await f.runtime.acquireFor("koinos-smart"); chat.release();
  f.localRelease.resolve(); await f.check.task; await until(() => f.polls.length === 2 && f.reports.at(-1)?.ready === true);
  assert.equal(f.check.status().passed, 12); assert.equal(f.check.status().completed, 45);
  assert.equal(f.runtime.networkWorkPaused(), false); assert.equal(f.worker.running, true);
});

test("cancelling a waiting diagnostic preserves its assigned network job and releases the pause", { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.worker.start(); await f.firstPoll.promise;
  f.check.start(); await turn(); f.check.cancel(); await f.check.task;
  assert.equal(f.runtime.networkWorkPaused(), false); assert.equal(f.localRequests, 0); assert.equal(f.check.report.outcome.code, "cancelled");
  f.deliver(); await f.firstGeneration.promise; f.generated.resolve(); await f.submission.promise; f.acknowledge.resolve();
  await until(() => f.polls.length === 2); assert.equal(f.worker.running, true);
});

test("Stop while a local diagnostic owns the gate does not deadlock or restart earning", { timeout: 5000 }, async t => {
  const f = await fixture(t); f.check.start(); await f.localGeneration.promise;
  await f.worker.start(); await turn(); assert.equal(f.polls.length, 0);
  await f.worker.stop(); assert.equal(f.worker.running, false);
  f.check.cancel(); await f.check.task; assert.equal(f.runtime.networkWorkPaused(), false);
  await turn(); assert.equal(f.polls.length, 0);
});

test("a failed model hash releases diagnostic admission so enabled sharing can poll", { timeout: 5000 }, async t => {
  const f = await fixture(t); fs.writeFileSync(f.file, "changed bytes");
  f.check.start(); await f.worker.start(); await f.check.task; await f.firstPoll.promise;
  assert.equal(f.check.report.outcome.code, "model_hash_mismatch"); assert.equal(f.runtime.networkWorkPaused(), false); assert.equal(f.worker.running, true);
});

test("network admission cannot race a diagnostic request and multiple diagnostics remain exclusive", async () => {
  const runtime = new RuntimeManager({ models: {} });
  let admitted = false;
  const network = runtime.acquireNetworkWork().then(lease => { admitted = true; return lease; });
  const first = await runtime.pauseNetworkWork();
  await turn(); assert.equal(admitted, false);
  let secondStarted = false;
  const secondTask = runtime.pauseNetworkWork().then(lease => { secondStarted = true; return lease; });
  await turn(); assert.equal(secondStarted, false);
  first.release(); const second = await secondTask; assert.equal(admitted, false);
  second.release(); (await network).release(); assert.equal(runtime.networkWorkPaused(), false);
  const occupied = await runtime.acquireNetworkWork(), abort = new AbortController();
  const pending = runtime.pauseNetworkWork(abort.signal); abort.abort(); await assert.rejects(pending, /abort/i);
  occupied.release(); assert.equal(runtime.networkWorkPaused(), false); assert.equal(runtime._admissionWaiters.size, 0);
});

test("a diagnostic wait deadline clears its pause without releasing another request's work", async () => {
  const runtime = new RuntimeManager({ models: {} }), work = await runtime.acquireNetworkWork();
  const alive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(runtime.pauseNetworkWork(AbortSignal.timeout(20)), /timeout/i);
    assert.equal(runtime.networkWorkPaused(), false); assert.equal(runtime._networkWork, 1);
    assert.equal(runtime._admissionWaiters.size, 0);
  } finally { clearTimeout(alive); work.release(); }
});
