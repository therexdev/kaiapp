"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path"), { Signer } = require("koilib");
const { PrepaidChat } = require("../../electron/koin-prepaid-chat"), P = require("../lib/koin-network/job-protocol"), { fundedResultHash } = require("../lib/koin-network/funded-protocol");
function setup(t, product = "prepaid-v1") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prepaid-chat-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const owner = Signer.fromSeed("prepaid-desktop-owner").getAddress(), signer = Signer.fromSeed("prepaid-desktop-worker");
  const tariff = Object.fromEntries(Object.entries({ model: "fixture", version: 1, modelHash: P.hash("model"), tokenizerHash: P.hash("tokenizer"), templateHash: P.hash("template"),
    inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "1000000", maxOutputTokens: 64, contextTokens: 4096, maxLatencyMs: 5000 }).sort(([a],[b])=>a.localeCompare(b)));
  const config = { owner, version: 1, model: "fixture", maxOutput: 16, schedulerUrl: "https://prepaid.invalid/scheduler", policyHash: P.hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", tariff])),
    deployment: { product, chainId: require("../lib/koin-network/payment-network").MAINNET_CHAIN, credits: Signer.fromSeed("contract").getAddress(), creditsHash: "0x1220" + P.hash("wasm") } };
  const calls = [], progress = []; let failAck = false, tamper = false, streaming, flow;
  const storage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s).map(b => b ^ 42), decryptString: b => b.map(n => n ^ 42).toString() };
  const options = { file: path.join(directory, "chat.json"), storage, config, progress: value => {
    if (value?.delta) assert.equal(flow.read().state, "answered", "stream prefix must be durable before renderer delivery"); progress.push(value);
  }, access: { authorize: () => ({ sessionToken: "secret", owner }) }, payments: { run: () => { throw Error("No wallet actions during chat"); } }, fetchImpl: async (url, init) => {
    const b = JSON.parse(init.body), action = url.split("/").at(-1); calls.push({ action, b });
    let value = {};
    if (action === "estimate") value.estimate = { model: "fixture", unit: product === "prepaid-usd-v1" ? "USD-1e-8" : "legacy-KOIN-1e-8", maxCharge: "21", maxFree: b.freeOnly ? "21" : "0", maxPaid: b.freeOnly ? "0" : "21", allowed: true };
    if (action === "completions") {
      const q = { schema: 2, mode: "shadow", domain: flow.target.domain, policyHash: config.policyHash, tariff, requestHash: P.hash(JSON.stringify(b.messages)),
        promptHash: P.hash("prompt"), inputIdsHash: P.hash("ids"), inputTokens: 5, maxOutput: b.max_tokens, maxCharge: "21", at: Date.now(), expires: Date.now() + 300000 };
      q.hash = P.hash(JSON.stringify(q));
      const id = b.requestId, session = P.hash("prepaid-account:" + owner), attempt = P.hash("attempt"), output = "A private answer";
      const signature = Buffer.from(await signer.signHash(fundedResultHash(flow.target, { id, session, attempt, quote: q }, output))).toString("base64");
      const r = { product, job: id, owner, provider: signer.getAddress(), attempt, quoteHash: q.hash, outputHash: P.hash(output), signature,
        dispatchedAt: q.at, completedAt: q.at + 1, usage: { inputTokens: 5, outputTokens: 3, amount: "8" } };
      value.completion = { id, choices: [{ message: { content: tamper ? "changed" : output } }], koin: { product, state: "ready", target: flow.target, session, quote: q, receipt: r, receiptHash: P.hash(JSON.stringify(r)) } };
      if (streaming) {
        const frames = [];
        for (const [index, text] of ["A private", output].entries()) {
          const receipt = { ...r, outputHash: P.hash(text), sequence: index + 1, usage: { inputTokens: 5, outputTokens: index + 2, amount: String(index + 7) },
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
