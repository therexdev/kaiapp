"use strict";
// Cross-repository qualification acceptance over loopback HTTP. The real
// Worker, scheduler, signatures and qualification journal run unchanged.
// Tokenization and inference are controlled fixtures, not model-quality proof.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http");
if (!process.argv[2]) throw Error("Usage: node scripts/verify-provider-qualification.js BACKEND_CHECKOUT");
const BACK = path.resolve(process.argv[2]);
if (!fs.existsSync(path.join(BACK, "lib/koin-network/provider-qualification.js"))) throw Error("The pinned backend checkout is required for qualification verification");
const { Signer } = require("koilib"), { Worker } = require("../core/lib/worker");
const P = require("../core/lib/koin-network/job-protocol");
const { Scheduler } = require(path.join(BACK, "lib/scheduler"));
const { Meter } = require(path.join(BACK, "lib/koin-network/metering"));
const { ProviderQualification } = require(path.join(BACK, "lib/koin-network/provider-qualification"));
const config = require("../core/lib/koin-network/credit-service.json").config;
const entries = require(path.join(BACK, "deploy/koin-mainnet/settings.prepaid-usd.models.example.json")).settings.models;
const pack = require("../core/provider-check/candidates.json").models.find(m => m.model === "koinos-smart");
const policy = require(path.join(BACK, "deploy/koin-mainnet/qualification/smart-2026-10-24.policy.json"));
const policyHash = P.hash(JSON.stringify(policy));

// Keep the exact commercial tariff commitment and literal candidate prompts.
// Only the tokenizer implementation and generated output are fixtures.
const encode = text => [...Buffer.from(text)];
const caseForMessages = messages => {
  const item = pack.cases.find(c => JSON.stringify(c.messages) === JSON.stringify(messages));
  assert.ok(item, "qualification must use a reviewed candidate case");
  assert.equal(P.hash(item.prompt), item.promptHash);
  return item;
};
const meter = new Meter(entries.map(({ tariff }) => ({ tariff, adapter: {
  ...tariff, render: messages => caseForMessages(messages).prompt, encode,
  input: messages => encode(caseForMessages(messages).prompt).length,
  output: text => encode(text).length,
} })));
assert.equal(entries.length, 15);
assert.equal(meter.policyHash, config.policyHash);
assert.equal(pack.modelHash, policy.modelHash);
assert.equal(policy.minPass, 12);
assert.equal(policy.maxLatencyMs, 30000);
assert.deepEqual(pack.cases.map(({ id, messages, expected, maxOutput }) => ({ id, messages, expected, maxOutput })), policy.cases);

const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const close = async server => {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
};
const json = (response, value, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

for (const scenario of ["normal-transport", "correct-answers-late-first-arrival", "temporary-upstream-failure", "saved-result-lost-acknowledgment"]) {
  const lateArrival = scenario === "correct-answers-late-first-arrival", transientFailure = scenario === "temporary-upstream-failure", lostAck = scenario === "saved-result-lost-acknowledgment";
  const title = lateArrival ? "correct signed answers cannot bypass the reviewed qualification deadline" : transientFailure
    ? "a temporary result delivery failure recovers the same signed answer without another inference"
    : lostAck ? "a saved result with a lost acknowledgment replays once without duplicate evidence or signing"
      : "Smart qualifies through the actual worker with Fast as the packaged default";
  test(title, { timeout: 20000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-qualification-flow-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      const destination = new URL(url);
      assert.equal(destination.hostname, "127.0.0.1", "qualification acceptance must never contact a public network");
      assert.equal(destination.protocol, "http:");
      return originalFetch(url, init);
    };
    let scheduler, worker, offset = 0, firstResult = true, failure, qualificationSignatures = 0;
    const requests = [], events = [], resultBodies = [];
    const signer = Signer.fromSeed("qualification-flow-controlled-provider");
    const runtime = http.createServer(async (request, response) => {
      try {
        let body = ""; for await (const part of request) body += part;
        const input = JSON.parse(body);
        if (request.url === "/tokenize") {
          assert.equal(input.add_special, false); assert.equal(input.parse_special, true);
          assert.ok(pack.cases.some(c => c.prompt === input.content));
          return json(response, { tokens: encode(input.content) });
        }
        assert.equal(request.url, "/completion");
        assert.deepEqual(Object.keys(input).sort(), ["cache_prompt", "n_predict", "prompt", "stream", "temperature"]);
        assert.equal(input.temperature, 0); assert.equal(input.stream, false); assert.equal(input.cache_prompt, false);
        const item = pack.cases.find(c => JSON.stringify(encode(c.prompt)) === JSON.stringify(input.prompt));
        assert.ok(item, "inference must use the previously verified input IDs");
        assert.equal(input.n_predict, item.maxOutput);
        requests.push({ id: item.id, promptHash: item.promptHash, maxOutput: input.n_predict });
        json(response, { content: item.expected[0], stop: true, stopped_eos: true });
      } catch (error) { failure = error; json(response, { error: "Controlled runtime assertion failed" }, 500); }
    });
    const server = http.createServer(async (request, response) => {
      try {
        request.url = request.url.replace(/^\/scheduler(?=\/)/, "");
        const isResult = request.url.startsWith("/koin/provider/qualification/result");
        let captured = "";
        if (isResult) request.on("data", part => { captured += part; });
        if (firstResult && isResult) {
          firstResult = false;
          if (lateArrival) {
            // Advance only the verifier's controlled clock after generation.
            // No real wait, changed deadline, or fabricated failed answer.
            offset = policy.maxLatencyMs + 1000;
          }
          if (transientFailure) {
            for await (const _part of request) { /* capture the exact first body without accepting it */ }
            resultBodies.push(captured); json(response, { error: "Controlled temporary upstream failure" }, 503); return;
          }
          if (lostAck) {
            // The real route saves and verifies the result before ending its
            // response. Drop only that acknowledgment, preserving the journal.
            response.end = () => { response.destroy(); return response; };
          }
        }
        await scheduler.handle(request, response);
        if (isResult) resultBodies.push(captured);
      } catch (error) { failure = error; json(response, { error: "Controlled scheduler assertion failed" }, 500); }
    });
    try {
      await listen(runtime); await listen(server);
      const schedulerUrl = `http://127.0.0.1:${server.address().port}/scheduler`;
      const target = { chainId: config.deployment.chainId, credits: config.deployment.credits, creditsHash: config.deployment.creditsHash,
        domain: require("../core/lib/koin-network/payment-mode").testDomain(config.deployment, schedulerUrl), policyHash: config.policyHash };
      scheduler = new Scheduler({ dataDir: directory, priceSources: [], bootstrapPoolSat: "0" });
      const qualifier = scheduler.providerQualification = new ProviderQualification({ file: path.join(directory, "qualification.json"),
        policy, target, meter, clock: () => Date.now() + offset });
      const catalog = { aliases: { "koinos-smart": { package: pack.package, minRamGb: 8 } }, packages: { [pack.package]: { sha256: pack.modelHash } } };
      worker = new Worker({ schedulerUrl,
        wallet: { address: signer.getAddress(), signHash: async hash => {
          if (worker?._executing) qualificationSignatures++;
          return Buffer.from(await signer.signHash(hash)).toString("base64");
        } },
        runtime: { activeAlias: "koinos-smart", status: () => ({ activeAlias: "koinos-smart", runtime: { kind: "llamacpp", running: true } }),
          acquireFor: async model => { assert.equal(model, "koinos-smart"); return { endpoint: `http://127.0.0.1:${runtime.address().port}/`, release() {} }; } },
        hardware: { ramBytes: 32e9 }, models: { catalog, aliases: () => [{ alias: "koinos-smart", status: "ready", minRamGb: 8 }] },
        fundedOnly: true, qualificationTarget: target, koinMainnetPilotJobs: true, koinMainnetTarget: target, idlePollMs: 5000,
        onEvent: event => events.push(event),
      });
      await worker.start();
      const deadline = Date.now() + 15000;
      while (!failure && Date.now() < deadline && !["qualified", "failed"].includes(qualifier.status(signer.getAddress())?.state))
        await new Promise(resolve => setTimeout(resolve, 20));
      if (failure) throw failure;
      const status = qualifier.status(signer.getAddress()), run = qualifier.state.runs[signer.getAddress()];
      assert.equal(status?.state, lateArrival ? "failed" : "qualified");
      assert.equal(status.passed, lateArrival ? 11 : 12); assert.equal(status.completed, 12); assert.equal(status.total, 12);
      assert.equal(requests.length, 12);
      assert.equal(qualificationSignatures, 12, "recovery reuses the existing qualification signature");
      assert.equal(resultBodies.length, transientFailure || lostAck ? 13 : 12);
      const byJob = new Map();
      for (const body of resultBodies) { const id = JSON.parse(body).jobId; if (!byJob.has(id)) byJob.set(id, []); byJob.get(id).push(body); }
      assert.equal(byJob.size, 12);
      assert.equal([...byJob.values()].filter(bodies => bodies.length === 2).length, transientFailure || lostAck ? 1 : 0);
      for (const bodies of byJob.values()) assert.equal(new Set(bodies).size, 1, "a retry must preserve the exact output and signature");
      assert.deepEqual(requests.map(r => r.id).sort(), pack.cases.map(c => c.id).sort());
      assert.equal(run.results.filter(r => r.reason === "deadline").length, lateArrival ? 1 : 0);
      assert.equal(qualifier.records().length, lateArrival ? 0 : 1, "late results cannot create provider eligibility");
      assert.equal(P.hash(JSON.stringify(policy)), policyHash, "the reviewed policy must remain unchanged");
      assert.equal(qualifier.policyHash, policyHash);
      assert.equal(events.filter(e => e.type === "worker:job-failed").length, lateArrival ? 1 : 0);
      console.log(JSON.stringify({ acceptance: "passed", scenario,
        status, inferences: requests.length, qualificationSignatures, resultSubmissions: resultBodies.length, fullCatalogPolicyHash: meter.policyHash, qualificationPolicyHash: policyHash,
        packagedDefault: config.model, warmModel: "koinos-smart", recordsCreated: qualifier.records().length,
        deadlineFailures: run.results.filter(r => r.reason === "deadline").length,
        controlledFixtures: ["UTF8 tokenizer", "expected inference output", "verifier clock for late arrival"],
        limits: "Verifies transport, signatures, literal prompts, generation settings and deadline enforcement; does not establish real model quality or hardware speed." }));
    } finally {
      await worker?.stop(); scheduler?.close();
      await close(server); await close(runtime);
      globalThis.fetch = originalFetch;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
