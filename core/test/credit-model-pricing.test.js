"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { modelPricing } = require("../../electron/credit-model-pricing");
const { PrepaidChat } = require("../../electron/koin-prepaid-chat");
const P = require("../lib/koin-network/job-protocol");
const canonical = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const hash = tariffs => P.hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", ...tariffs]));
function fixture(count = 15) {
  const now = 1793000000000;
  const tariffs = Array.from({ length: count }, (_, index) => canonical({ model: `fixture-${String(index).padStart(2, "0")}`, version: 1,
    modelHash: P.hash("model" + index), tokenizerHash: P.hash("tokenizer"), templateHash: P.hash("template"),
    inputAtomsPerMillion: "100000000", outputAtomsPerMillion: "250000000", maxOutputTokens: 256, contextTokens: 4096, maxLatencyMs: 30000 }));
  const config = { ...structuredClone(require("../lib/koin-network/credit-service.json").config), owner: "1EXvuuW5HMrYRPdkraSi5Z4TBd4djyMj6E", policyHash: hash(tariffs) };
  const catalog = { schema: 1, policyHash: config.policyHash, asOf: now, validUntil: now + 15000, tariffs,
    models: tariffs.map(t => ({ model: t.model, available: false, providers: 0 })) };
  const calls = [], signal = new AbortController().signal;
  const flow = new PrepaidChat({ config, clock: () => now,
    access: { authorize: () => ({ owner: config.owner, sessionToken: "private-fixture-token" }) },
    storage: { isEncryptionAvailable: () => { throw Error("Pricing never opens secure storage"); } },
    payments: { run: () => { throw Error("Pricing never signs or purchases"); } },
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
      assert.equal(url, config.schedulerUrl + "/koin/prepaid/models");
      assert.equal(init.redirect, "error"); assert.equal(init.signal, signal);
      return Response.json({ ok: true, product: config.deployment.product, mode: "mainnet-pilot", paymentsEnabled: true,
        owner: config.owner, catalog, sessionToken: "do-not-project-response-secrets" });
    } });
  const context = { config, flow, auth: { sessionToken: "do-not-project-context-secrets" }, directory: "private-directory" };
  const service = { context: async s => { assert.equal(s, signal); return context; },
    purchases: new Proxy({}, { get() { throw Error("Pricing never opens purchase records"); } }) };
  return { service, context, config, catalog, tariffs, signal, calls, now,
    repin() { config.policyHash = catalog.policyHash = hash(tariffs); } };
}

test("model pricing reads the complete approved catalog without payment, capability or availability requirements", async () => {
  const f = fixture(), result = await modelPricing(f.service, f.signal);
  assert.deepEqual(Object.keys(result).sort(), ["availabilityValidUntil", "models", "observedAt", "policyHash", "product", "schema"]);
  assert.equal(result.models.length, 15); assert.equal(result.policyHash, f.config.policyHash);
  assert.equal(result.observedAt, f.now); assert.equal(result.availabilityValidUntil, f.now + 15000);
  assert.deepEqual(result.models[0], { model: "fixture-00", label: "fixture-00", inputCreditsPerMillion: "1000", outputCreditsPerMillion: "2500",
    inputUsdPerMillion: "1", outputUsdPerMillion: "2.5" });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, { sessionToken: "private-fixture-token", creditWallet: f.config.owner });
  assert.doesNotMatch(JSON.stringify(result), /private|secret|available|providers|directory|owner|sessionToken/);
  assert.equal(result.expiresAt, undefined, "availability TTL is not a tariff expiry");
});

test("model pricing keeps exact decimal units from one USD atom through uint64 maximum", async () => {
  const f = fixture(1);
  f.tariffs[0].inputAtomsPerMillion = "1"; f.tariffs[0].outputAtomsPerMillion = "18446744073709551615"; f.repin();
  const row = (await modelPricing(f.service, f.signal)).models[0];
  assert.equal(row.inputCreditsPerMillion, "0.00001"); assert.equal(row.inputUsdPerMillion, "0.00000001");
  assert.equal(row.outputCreditsPerMillion, "184467440737095.51615"); assert.equal(row.outputUsdPerMillion, "184467440737.09551615");
});

test("model pricing rejects changed policy, tampered prices and incomplete or stale catalogs", async () => {
  for (const [change, error] of [
    [f => { f.catalog.policyHash = P.hash("unapproved policy"); }, /Approved network model catalog/],
    [f => { f.tariffs[0].inputAtomsPerMillion = "100"; }, /prices differ/],
    [f => { f.catalog.models.pop(); }, /Incomplete/],
    [f => { f.catalog.validUntil = f.now; }, /out of date/],
    [f => { f.catalog.asOf = f.now + 5001; f.catalog.validUntil = f.now + 15000; }, /out of date/],
    [f => { f.catalog.validUntil = f.now + 15001; }, /out of date/],
    [f => { f.catalog.models[0].available = true; }, /no qualified provider/]
  ]) {
    const f = fixture(); change(f); await assert.rejects(modelPricing(f.service, f.signal), error);
  }
});

test("model pricing accepts the bounded full catalog and refuses malformed prices or excess models", async () => {
  const bounded = fixture(64); assert.equal((await modelPricing(bounded.service, bounded.signal)).models.length, 64);
  for (const count of [0, 65]) { const f = fixture(count); await assert.rejects(modelPricing(f.service, f.signal), /Bounded/); }
  for (const rate of ["0", "01", "1.5", "1e8", "-1", "18446744073709551616", 100000000, null]) {
    const f = fixture(1); f.tariffs[0].inputAtomsPerMillion = rate; f.repin();
    await assert.rejects(modelPricing(f.service, f.signal), /Invalid approved model rate/);
  }
  const duplicate = fixture(2); duplicate.tariffs[1].model = duplicate.tariffs[0].model; duplicate.repin();
  await assert.rejects(modelPricing(duplicate.service, duplicate.signal), /Unique/);
});

test("model pricing never presents legacy KOIN tariffs as USD credits and respects cancellation", async () => {
  const f = fixture(); f.config.deployment.product = "prepaid-v1";
  await assert.rejects(modelPricing(f.service, f.signal), /USD credit service/); assert.equal(f.calls.length, 0);
  let reads = 0;
  await assert.rejects(modelPricing({ context: () => { reads++; } }, AbortSignal.abort()), { name: "AbortError" });
  assert.equal(reads, 0);
});

test("model pricing IPC preserves exact main-document, Test and no-arguments guards", async t => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { EventEmitter } = require("node:events");
  const { CreditService } = require("../../electron/credit-service"), { registerTestPaymentIPC } = require("../../electron/koin-test-ipc");
  const f = fixture(), directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-model-prices-"));
  const w = Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false });
  w.webContents.mainFrame = { url: "http://127.0.0.1:9000/" };
  const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame }; let handler, registration, reads = 0;
  t.mock.method(global, "setInterval", () => ({ unref() {} }));
  t.mock.method(CreditService.prototype, "context", async function (signal) {
    reads++; assert.ok(signal instanceof AbortSignal);
    // The real catalog verification is exercised above; isolate the IPC guards.
    return { ...f.context, flow: { models: () => require("../../electron/credit-models").catalog(f.catalog, f.config, f.now) } };
  });
  const options = { dataDir: directory, core: {}, dialog: {}, origin: "http://127.0.0.1:9000", getMainWindow: () => w,
    ipcMain: { handle: (_channel, fn) => { handler = fn; } } };
  t.after(() => { registration?.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  registration = registerTestPaymentIPC({ ...options, isTest: false });
  assert.equal((await handler(event, "model-pricing")).enabled, false); assert.equal(reads, 0); registration.dispose();
  registration = registerTestPaymentIPC({ ...options, isTest: true });
  await assert.rejects(handler({ ...event, senderFrame: { url: event.senderFrame.url } }, "model-pricing"), /access denied/);
  for (const input of [{}, "1", null]) await assert.rejects(handler(event, "model-pricing", input), /takes no arguments/);
  assert.equal(reads, 0); assert.equal((await handler(event, "model-pricing")).models.length, 15); assert.equal(reads, 1);
  assert.deepEqual(fs.readdirSync(directory), [], "the pricing bridge does not open a payment journal");
  w.webContents.mainFrame.url = "http://127.0.0.1:9000/mascot.html";
  await assert.rejects(handler(event, "model-pricing"), /access denied/);
  w.webContents.mainFrame.url = "http://127.0.0.1:9000/"; registration.dispose();
  await assert.rejects(handler(event, "model-pricing"), /open app/);
});
