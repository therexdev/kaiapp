"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Signer } = require("koilib"), P = require("../lib/koin-network/job-protocol");
const { SessionFreeChat, SessionFreeChatStore } = require("../../electron/session-free-chat");
const { fundedResultHash } = require("../lib/koin-network/funded-protocol");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-session-free-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const provider = Signer.fromSeed("session-only-free-provider"), owner = Signer.fromSeed("session-only-free-user").getAddress();
  const tariff = Object.fromEntries(Object.entries({ model: "fixture", version: 1, modelHash: P.hash("model"), tokenizerHash: P.hash("tokens"), templateHash: P.hash("template"),
    inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "1000000", maxOutputTokens: 32, contextTokens: 2048, maxLatencyMs: 5000 }).sort(([a], [b]) => a.localeCompare(b)));
  const config = { owner, version: 1, model: "fixture", maxOutput: 16, schedulerUrl: "https://credits.invalid/scheduler", policyHash: P.hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", tariff])),
    deployment: { product: "prepaid-usd-v1", chainId: require("../lib/koin-network/payment-network").MAINNET_CHAIN, credits: Signer.fromSeed("free-contract").getAddress(), creditsHash: "0x1220" + P.hash("wasm") } };
  const calls = [], state = { loss: false, available: true, completion: null, malformed: false }; let flow;
  const options = { file: path.join(dir, "chat-session-free.json"), config, access: { authorize: () => ({ sessionToken: "private-session", owner }) },
    fetchImpl: async (url, init) => {
      const b = JSON.parse(init.body), action = new URL(url).pathname.split("/").at(-1); calls.push({ action, b });
      let result = {};
      if (action === "models") { const now = Date.now(); result.catalog = { schema: 1, policyHash: config.policyHash, tariffs: [tariff], asOf: now, validUntil: now + 15000, models: [{ model: "fixture", providers: 1, available: true }] }; }
      if (action === "estimate") {
        assert.equal(b.freeOnly, true); assert.equal(b.paidFirst, undefined);
        result.estimate = { model: "fixture", unit: "USD-1e-8", maxCharge: "21", maxFree: state.available ? "21" : "0", maxPaid: state.available ? "0" : "21", allowed: state.available || state.malformed };
      }
      if (action === "completions") {
        assert.equal(b.freeOnly, true); assert.equal(b.maxPaid, "0"); assert.equal(b.paidFirst, undefined);
        const at = Date.now(), q = { schema: 2, mode: "shadow", domain: flow.target.domain, policyHash: config.policyHash, tariff,
          requestHash: P.hash(JSON.stringify(b.messages)), promptHash: P.hash("prompt"), inputIdsHash: P.hash("ids"), inputTokens: 5, maxOutput: 16, maxCharge: "21", at, expires: at + 300000 };
        q.hash = P.hash(JSON.stringify(q)); const output = "Private response never saved", session = P.hash("prepaid-account:" + owner), attempt = P.hash("attempt"), id = b.requestId;
        const r = { product: "prepaid-usd-v1", job: id, owner, provider: provider.getAddress(), attempt, quoteHash: q.hash, outputHash: P.hash(output),
          signature: Buffer.from(await provider.signHash(fundedResultHash(flow.target, { id, session, attempt, quote: q }, output))).toString("base64"), dispatchedAt: at, completedAt: at + 1, usage: { inputTokens: 5, outputTokens: 3, amount: "8" } };
        state.completion = { id, choices: [{ message: { content: output } }], koin: { product: "prepaid-usd-v1", state: "charged", target: flow.target, session, quote: q, receipt: r, receiptHash: P.hash(JSON.stringify(r)) } };
        if (state.loss) throw Error("Lost network response after charge"); result.completion = state.completion;
      }
      if (action === "result") { assert.equal(b.requestId, state.completion.id); result.completion = state.completion; }
      return Response.json({ ok: true, product: "prepaid-usd-v1", mode: "mainnet-pilot", paymentsEnabled: true, owner, ...result });
    } };
  const create = () => flow = new SessionFreeChat({ ...options, sessionStore: new SessionFreeChatStore() }); create();
  return { options, state, calls, create, get flow() { return flow; }, input: { model: "koinos-network", messages: [{ role: "user", content: "Private question never saved" }], max_tokens: 16, paidFirst: true }, signal: AbortSignal.timeout(10000) };
}
test("temporary access forces actual free allowance and persists only public recovery metadata", async t => {
  const f = fixture(t), answer = await f.flow.chat(null, f.input, f.signal);
  assert.equal(answer.choices[0].message.content, "Private response never saved");
  const disk = JSON.parse(fs.readFileSync(f.options.file, "utf8"));
  assert.equal(disk.input, undefined); assert.equal(disk.answer, undefined); assert.equal(disk.state, "pending"); assert.equal(disk.maxPaid, "0"); assert.equal(disk.sessionOnly, true);
  assert.ok(!JSON.stringify(disk).includes("Private")); assert.equal(f.flow.read().state, "answered");
  f.flow.acknowledge(answer.id); assert.equal(JSON.parse(fs.readFileSync(f.options.file)).state, "delivered");
});
test("restart after lost reply retrieves the same signed answer without another charge or private disk data", async t => {
  const f = fixture(t); f.state.loss = true;
  await assert.rejects(f.flow.chat(null, f.input, f.signal), /Lost network response/);
  const id = JSON.parse(fs.readFileSync(f.options.file)).id; f.flow.sessionStore.dispose();
  const restarted = f.create(); assert.equal(restarted.read().id, id); assert.equal(restarted.read().input, undefined);
  await assert.rejects(restarted.recover(null, f.signal), /same message/);
  const answer = await restarted.chat(null, f.input, f.signal);
  assert.equal(answer.id, id); assert.equal(f.calls.filter(c => c.action === "completions").length, 1); assert.equal(f.calls.filter(c => c.action === "result").length, 1);
  assert.ok(!fs.readFileSync(f.options.file, "utf8").includes("Private"));
});
test("no free allowance or malformed paid estimate cannot submit a temporary-session paid request", async t => {
  const f = fixture(t); f.state.available = false;
  await assert.rejects(f.flow.chat(null, f.input, f.signal), /Free only/);
  assert.equal(f.calls.filter(c => c.action === "completions").length, 0);
  f.state.malformed = true;
  await assert.rejects(f.flow.chat(null, f.input, f.signal), /cannot spend purchased/);
  assert.equal(f.calls.filter(c => c.action === "completions").length, 0);
  await assert.rejects(f.flow.chat(null, { ...f.input, runId: P.hash("run") }, f.signal), /free chat only/);
});
test("temporary-session disposal clears in-memory secrets and cannot decrypt prior session blobs", () => {
  const store = new SessionFreeChatStore(), encrypted = store.encryptString("private reply"); assert.equal(store.decryptString(encrypted), "private reply");
  store.dispose(); assert.equal(store.isEncryptionAvailable(), false); assert.throws(() => store.decryptString(encrypted), /ended/);
  const next = new SessionFreeChatStore(); assert.throws(() => next.decryptString(encrypted)); next.dispose();
});

test("temporary access cannot enter paid advanced execution through private helper calls", async () => {
  let reads = 0;
  const service = { storage: {}, account: {}, runs: { read() { reads++; throw Error("Run read must not happen"); } } };
  const c = { auth: { sessionOnly: true } }, runs = new (require("../../electron/credit-runs").CreditRuns)(service);
  await assert.rejects(runs.open(c, {}, AbortSignal.timeout(1000)), /free chat only/);
  await assert.rejects(runs.chat(c, {}, AbortSignal.timeout(1000)), /free chat only/);
  assert.throws(() => runs.flow(c, {}, "invalid"), /free chat only/);
  const executor = new (require("../../electron/credit-run-executor").CreditRunExecutor)({ service, core: {} });
  await assert.rejects(executor.execute(c, {}, AbortSignal.timeout(1000)), /free chat only/); assert.equal(reads, 0);
});
