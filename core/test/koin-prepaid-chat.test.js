"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path"), { Signer } = require("koilib");
const { PrepaidChat } = require("../../electron/koin-prepaid-chat"), P = require("../lib/koin-network/job-protocol"), { fundedResultHash } = require("../lib/koin-network/funded-protocol");
function setup(t, product = "prepaid-v1", multi = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prepaid-chat-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const owner = Signer.fromSeed("prepaid-desktop-owner").getAddress(), signer = Signer.fromSeed("prepaid-desktop-worker");
  const tariff = Object.fromEntries(Object.entries({ model: "fixture", version: 1, modelHash: P.hash("model"), tokenizerHash: P.hash("tokenizer"), templateHash: P.hash("template"),
    inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "1000000", maxOutputTokens: 64, contextTokens: 4096, maxLatencyMs: 5000 }).sort(([a],[b])=>a.localeCompare(b)));
  const second = Object.fromEntries(Object.entries({ ...tariff, model: "fixture-large", modelHash: P.hash("second model"), inputAtomsPerMillion: "2000000", outputAtomsPerMillion: "3000000", maxOutputTokens: 8 }).sort(([a], [b]) => a.localeCompare(b)));
  const tariffs = (multi ? [tariff, second] : [tariff]).sort((a, b) => `${a.model}:${a.version}` < `${b.model}:${b.version}` ? -1 : 1);
  const config = { owner, version: 1, model: "fixture", maxOutput: 16, schedulerUrl: "https://prepaid.invalid/scheduler", policyHash: P.hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", ...tariffs])),
    deployment: { product, chainId: require("../lib/koin-network/payment-network").MAINNET_CHAIN, credits: Signer.fromSeed("contract").getAddress(), creditsHash: "0x1220" + P.hash("wasm") } };
  const calls = [], progress = []; let failAck = false, tamper = false, streaming, flow, unavailable, catalogOutage = false, catalogTamper = false, tariffTamper = false;
  const storage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s).map(b => b ^ 42), decryptString: b => b.map(n => n ^ 42).toString() };
  const options = { file: path.join(directory, "chat.json"), storage, config, progress: value => {
    if (value?.delta) assert.equal(flow.read().state, "answered", "stream prefix must be durable before renderer delivery"); progress.push(value);
  }, access: { authorize: () => ({ sessionToken: "secret", owner }) }, payments: { run: () => { throw Error("No wallet actions during chat"); } }, fetchImpl: async (url, init) => {
    const b = JSON.parse(init.body), action = url.split("/").at(-1); calls.push({ action, b });
    let value = {};
    if (action === "models") {
      if (catalogOutage) throw Error("Catalog unavailable");
      const at = Date.now(), listed = structuredClone(tariffs); if (catalogTamper) listed[0].inputAtomsPerMillion = "9999999";
      value.catalog = { schema: 1, policyHash: config.policyHash, tariffs: listed, asOf: at, validUntil: at + 15000,
        models: tariffs.map(t => ({ model: t.model, providers: t.model === unavailable ? 0 : 1, available: t.model !== unavailable })) };
    }
    const selected = structuredClone(tariffs.find(t => t.model === b.model) || tariff);
    const cost = (input, output) => String((BigInt(input) * BigInt(selected.inputAtomsPerMillion) + BigInt(output) * BigInt(selected.outputAtomsPerMillion) + 999999n) / 1000000n);
    if (action === "estimate") value.estimate = { model: b.model, unit: product === "prepaid-usd-v1" ? "USD-1e-8" : "legacy-KOIN-1e-8", maxCharge: cost(5, b.max_tokens), maxFree: b.freeOnly ? cost(5, b.max_tokens) : "0", maxPaid: b.freeOnly ? "0" : cost(5, b.max_tokens), allowed: true };
    if (action === "completions") {
      const at = Date.now(); if (tariffTamper) selected.inputAtomsPerMillion = "4000000";
      const q = { schema: 2, mode: "shadow", domain: flow.target.domain, policyHash: config.policyHash, tariff: selected, requestHash: P.hash(JSON.stringify(b.messages)),
        promptHash: P.hash("prompt"), inputIdsHash: P.hash("ids"), inputTokens: 5, maxOutput: b.max_tokens, maxCharge: cost(5, b.max_tokens), at, expires: at + 300000 };
      q.hash = P.hash(JSON.stringify(q));
      const id = b.requestId, session = P.hash("prepaid-account:" + owner), attempt = P.hash("attempt"), output = "A private answer";
      const signature = Buffer.from(await signer.signHash(fundedResultHash(flow.target, { id, session, attempt, quote: q }, output))).toString("base64");
      const r = { product, job: id, owner, provider: signer.getAddress(), attempt, quoteHash: q.hash, outputHash: P.hash(output), signature,
        dispatchedAt: q.at, completedAt: q.at + 1, usage: { inputTokens: 5, outputTokens: 3, amount: cost(5, 3) } };
      value.completion = { id, choices: [{ message: { content: tamper ? "changed" : output } }], koin: { product, state: "ready", target: flow.target, session, quote: q, receipt: r, receiptHash: P.hash(JSON.stringify(r)) } };
      if (streaming) {
        const frames = [];
        for (const [index, text] of ["A private", output].entries()) {
          const receipt = { ...r, outputHash: P.hash(text), sequence: index + 1, usage: { inputTokens: 5, outputTokens: index + 2, amount: cost(5, index + 2) },
            signature: Buffer.from(await signer.signHash(require("../lib/koin-network/funded-protocol").fundedChunkHash(flow.target, { id, session, attempt, quote: q }, text, index + 1))).toString("base64") };
          const completion = { id, choices: [{ message: { content: text } }], koin: { ...value.completion.koin, state: index ? "charged" : "streaming", receipt, receiptHash: P.hash(JSON.stringify(receipt)) } };
          frames.push("data: " + JSON.stringify({ ok: true, product, mode: "mainnet-pilot", paymentsEnabled: true, completion }) + "\n\n");
          if (streaming.interrupt) break;
        }
        if (!streaming.interrupt) frames.push("data: [DONE]\n\n");
        const bytes = Buffer.from(frames.join(""));
        return new Response(new ReadableStream({ start(controller) {
          for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.subarray(i, i + 17)); controller.close();
        } }), { headers: { "content-type": "text/event-stream" } });
      }
    }
    if (action === "acknowledge") {
      assert.equal(flow.read().state, "answered", "verified answer must already be durable before delivery acknowledgement");
      if (failAck) throw Error("Lost acknowledgement response"); value.state = "charged";
    }
    return Response.json({ ok: true, product, mode: "mainnet-pilot", paymentsEnabled: true, owner, ...value });
  } };
  flow = new PrepaidChat(options);
  return { flow, options, calls, progress, stream: value => { streaming = value; }, file: options.file, body: { model: "koinos-network", messages: [{ role: "user", content: "A private question" }], max_tokens: 16 },
    unavailable: model => { unavailable = model; }, catalogOutage: () => { catalogOutage = true; }, catalogTamper: () => { catalogTamper = true; }, tariffTamper: () => { tariffTamper = true; }, tariffs,
    signal: new AbortController().signal, failAck: () => { failAck = true; }, tamper: () => { tamper = true; } };
}
test("normal prepaid chat saves the verified answer before showing it and never opens a wallet reservation", async t => {
  const f = setup(t), answer = await f.flow.chat({}, f.body, f.signal);
  assert.equal(answer.choices[0].message.content, "A private answer");
  assert.deepEqual(f.calls.map(c => c.action), ["estimate", "completions", "acknowledge"]);
  const raw = fs.readFileSync(f.file, "utf8"); assert.ok(!raw.includes("A private answer")); assert.ok(!raw.includes("A private question"));
});
test("lost delivery acknowledgement still returns the saved answer and restart reuses its exact receipt", async t => {
  const f = setup(t); f.failAck(); const first = await f.flow.chat({}, f.body, f.signal);
  const recovered = await new PrepaidChat(f.options).recover({}, f.signal);
  assert.equal(recovered.completion.id, first.id); assert.equal(f.calls.filter(c => c.action === "completions").length, 1);
  assert.equal(f.calls.filter(c => c.action === "acknowledge")[0].b.receiptHash, f.calls.filter(c => c.action === "acknowledge")[1].b.receiptHash);
});
test("tampered answers are rejected and retain the request ID for safe recovery", async t => {
  const f = setup(t); f.tamper(); await assert.rejects(f.flow.chat({}, f.body, f.signal), /verified/);
  assert.deepEqual(f.calls.map(c => c.action), ["estimate", "completions", "cancel"]); assert.equal(f.flow.read().state, "pending");
});

test("USD credits use the same private normal chat path and cannot accept a legacy receipt", async t => {
  const f = setup(t, "prepaid-usd-v1"), answer = await f.flow.chat({}, f.body, f.signal);
  assert.equal(answer.koin.product, "prepaid-usd-v1"); assert.equal(answer.costUsd, 8e-8);
  assert.equal(f.calls.find(c => c.action === "completions").b.billing, "koin-prepaid-usd-v1");
  const wrong = structuredClone(answer); wrong.koin.product = "prepaid-v1";
  assert.throws(() => f.flow.verify(wrong, {}, answer.id), /verified/);
});
test("signed metered chunks reach the renderer incrementally after encrypted persistence", async t => {
  const f = setup(t, "prepaid-usd-v1"); f.stream({});
  const result = await f.flow.chat({}, { ...f.body, stream: true, freeOnly: true }, f.signal);
  assert.deepEqual(f.progress.filter(p => p?.delta).map(p => p.delta), ["A private", " answer"]);
  assert.equal(result.choices[0].message.content, "A private answer");
  assert.equal(f.calls.find(c => c.action === "completions").b.freeOnly, true); assert.equal(f.calls.find(c => c.action === "completions").b.stream, true);
});
test("interrupted metered stream preserves the last verified prefix and restart recovery never starts another charge", async t => {
  const f = setup(t, "prepaid-usd-v1"); f.stream({ interrupt: true });
  await assert.rejects(f.flow.chat({}, f.body, f.signal), /interrupted/);
  assert.equal(f.flow.read().state, "answered");
  const result = await new PrepaidChat(f.options).recover({}, f.signal);
  assert.equal(result.completion.choices[0].message.content, "A private");
  assert.equal(f.calls.filter(c => c.action === "completions").length, 1);
  assert.ok(!fs.readFileSync(f.file, "utf8").includes("A private"));
});
test("advanced subcalls keep separate encrypted recovery records and repeated calls do not charge again", async t => {
  const f = setup(t, "prepaid-usd-v1", true), { CreditRuns, creditAtoms } = require("../../electron/credit-runs"), directory = path.dirname(f.file);
  assert.equal(creditAtoms("12.34567"), "1234567"); assert.throws(() => creditAtoms("0")); assert.throws(() => creditAtoms("1.000001"));
  let approved;
  const original = f.options.fetchImpl;
  const transport = async (url, init) => {
    const b = JSON.parse(init.body), action = url.split("/").at(-1);
    if (action.startsWith("run-")) {
      if (action === "run-open") approved = { id: b.runId, model: b.model, maxTotal: b.maxTotal, freeOnly: b.freeOnly, state: "open" };
      if (action === "run-stop") approved.state = "stopped";
      return Response.json({ ok: true, product: "prepaid-usd-v1", mode: "mainnet-pilot", paymentsEnabled: true, owner: f.options.config.owner, run: approved });
    }
    return original(url, init);
  };
  f.flow.fetch = transport;
  const service = { storage: f.options.storage, account: { assertCreditAuthorization() {} }, fetchImpl: transport, progress() {} };
  const c = { directory, config: f.options.config, flow: f.flow, auth: { owner: f.options.config.owner, sessionToken: "secret" } };
  const create = () => { const r = new CreditRuns(service), make = r.flow.bind(r); r.flow = (...args) => { const flow = make(...args); f.flow.file = flow.file; return flow; }; return r; };
  let runs = create(); const { run } = await runs.open(c, { budget: "1", mode: "research", model: "fixture-large", freeOnly: false }, f.signal);
  const first = { runId: run.id, callId: P.hash("first subcall"), request: { ...f.body, model: "koinos-network:fixture-large", max_tokens: 8, stream: false } };
  const answer = await runs.chat(c, first, f.signal); runs = create();
  assert.equal((await runs.chat(c, first, f.signal)).id, answer.id);
  assert.equal(f.calls.filter(c => c.action === "completions").length, 1);
  assert.equal(f.calls.find(c => c.action === "completions").b.runId, run.id);
  await runs.chat(c, { ...first, callId: P.hash("second subcall") }, f.signal);
  const recovered = await runs.status(c, run.id, f.signal); assert.equal(recovered.steps.length, 2);
  assert.ok(recovered.steps.every(s => s.text === "A private answer" && s.credits === "19"));
  assert.equal(runs.list(c).length, 1);
  const otherDirectory = path.join(directory, "new-wallet-context"); fs.mkdirSync(otherDirectory);
  const switched = { ...c, directory: otherDirectory, config: { ...c.config, owner: require("koilib").Signer.fromSeed("second-linked-wallet").getAddress() }, contexts: [c] };
  assert.equal(runs.list(switched)[0].id, run.id);
  assert.equal((await runs.status(switched, run.id, f.signal)).steps.length, 2, "linked-wallet selection retains original receipt verification and saved results");
  assert.equal((await runs.stop(switched, run.id, f.signal)).run.state, "stopped");
  for (const file of fs.readdirSync(runs.directory(c, run.id))) {
    const text = fs.readFileSync(path.join(runs.directory(c, run.id), file), "utf8"); assert.ok(!text.includes("A private answer")); assert.ok(!text.includes("A private question"));
  }
});

test("full committed catalog supports distinct model rates and preserves selected-model recovery without a catalog read", async t => {
  const f = setup(t, "prepaid-usd-v1", true), body = { ...f.body, model: "koinos-network:fixture-large", max_tokens: 8 };
  const first = await f.flow.chat({}, body, f.signal);
  assert.equal(first.servedModel, "fixture-large"); assert.equal(first.koin.receipt.usage.amount, "19");
  assert.equal(f.calls.find(c => c.action === "completions").b.model, "fixture-large");
  assert.equal(f.flow.read().tariffs.length, 2);
  const reads = f.calls.filter(c => c.action === "models").length; f.catalogOutage();
  const recovered = await new PrepaidChat(f.options).recover({}, f.signal);
  assert.equal(recovered.completion.id, first.id); assert.equal(recovered.completion.servedModel, "fixture-large");
  assert.equal(f.calls.filter(c => c.action === "models").length, reads);
  assert.equal(f.calls.filter(c => c.action === "completions").length, 1);
});
test("new model selection uses its own output ceiling and does not silently substitute an unavailable model", async t => {
  const f = setup(t, "prepaid-usd-v1", true); f.unavailable("fixture-large");
  await assert.rejects(f.flow.chat({}, { ...f.body, model: "koinos-network:fixture-large", max_tokens: 8 }, f.signal), /unavailable/);
  assert.equal(f.calls.filter(c => c.action === "completions").length, 0);
  await assert.rejects(f.flow.estimate({ ...f.body, model: "koinos-network:fixture-large", max_tokens: 9 }, f.signal), /integer/);
  const answer = await f.flow.chat({}, f.body, f.signal); assert.equal(answer.koin.receipt.usage.amount, "8");
});
test("unapproved catalog prices and otherwise valid signed replies with a changed selected tariff are rejected", async t => {
  const badCatalog = setup(t, "prepaid-usd-v1", true); badCatalog.catalogTamper();
  await assert.rejects(badCatalog.flow.chat({}, badCatalog.body, badCatalog.signal), /approved policy/);
  assert.equal(badCatalog.calls.filter(c => c.action === "completions").length, 0);
  const badQuote = setup(t, "prepaid-usd-v1", true); badQuote.tariffTamper();
  await assert.rejects(badQuote.flow.chat({}, { ...badQuote.body, model: "koinos-network:fixture-large", max_tokens: 8 }, badQuote.signal), /approved credit price/);
  assert.equal(badQuote.flow.read().state, "pending");
});
test("catalog verifier rejects stale readiness, duplicate aliases, omitted models and private model identities", () => {
  const Models = require("../../electron/credit-models"), now = Date.now();
  const t = Object.fromEntries(Object.entries({ model: "one", version: 1, modelHash: P.hash("m"), tokenizerHash: P.hash("t"), templateHash: P.hash("p"), inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "1000000", maxOutputTokens: 16, contextTokens: 4096, maxLatencyMs: 5000 }).sort(([a], [b]) => a.localeCompare(b)));
  const config = { policyHash: P.hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", t])), maxOutput: 16 };
  const c = { schema: 1, policyHash: config.policyHash, tariffs: [t], asOf: now, validUntil: now + 15000, models: [{ model: "one", available: true, providers: 1 }] };
  assert.equal(Models.catalog(c, config, now).models[0].inputCreditsPerMillion, "10");
  assert.throws(() => Models.catalog({ ...c, validUntil: now }, config, now), /out of date/);
  assert.throws(() => Models.catalog({ ...c, models: [] }, config, now), /Incomplete/);
  assert.throws(() => Models.tariffs([t, t], config.policyHash), /Unique/);
  assert.throws(() => Models.tariffs([{ ...t, model: "desktop:openai" }], config.policyHash), /Unique/);
  assert.throws(() => Models.tariffs([{ ...t, model: "dev-tiny" }], config.policyHash), /Unique/);
});
