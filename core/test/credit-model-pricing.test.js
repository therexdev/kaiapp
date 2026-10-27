"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { modelPricing, configuredModelPricing } = require("../../electron/credit-model-pricing");
const P = require("../lib/koin-network/job-protocol");
const canonical = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const hash = tariffs => P.hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", ...tariffs]));
function fixture(count = 15) {
  const tariffs = Array.from({ length: count }, (_, index) => canonical({ model: `fixture-${String(index).padStart(2, "0")}`, version: 1,
    modelHash: P.hash("model" + index), tokenizerHash: P.hash("tokenizer"), templateHash: P.hash("template"),
    inputAtomsPerMillion: "100000000", outputAtomsPerMillion: "250000000", maxOutputTokens: 256, contextTokens: 4096, maxLatencyMs: 30000 }));
  const config = { ...structuredClone(require("../lib/koin-network/credit-service.json").config), policyHash: hash(tariffs) };
  const prices = { schema: 1, product: "prepaid-usd-v1", policyHash: config.policyHash, tariffs };
  return { config, tariffs, prices, repin() { config.policyHash = prices.policyHash = hash(tariffs); } };
}

test("all bundled model rates match the exact deployed policy and reviewed backend source", () => {
  const prices = require("../lib/koin-network/credit-model-prices.json"), config = require("../lib/koin-network/credit-service.json").config;
  const sorted = prices.tariffs.map(canonical).sort((a, b) => `${a.model}:${a.version}` < `${b.model}:${b.version}` ? -1 : 1);
  assert.equal(crypto.createHash("sha256").update(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", ...sorted])).digest("hex"), config.policyHash);
  assert.equal(prices.policyHash, "9a4d812014a210d0d9fa083c479c0c0d82341ece2bde33b596ea8bb3826b9089");
  assert.deepEqual(prices.source, { repository: "therexdev/kai", commit: "80eb56c94600b800c0b69910acde0937f0da052d", file: "deploy/koin-mainnet/settings.prepaid-usd.models.example.json" });
  const result = configuredModelPricing(config, prices);
  assert.equal(result.models.length, 15);
  assert.deepEqual(result.models.find(row => row.model === "koinos-fast"), { model: "koinos-fast", label: "Koinos Fast",
    inputCreditsPerMillion: "10", outputCreditsPerMillion: "40", inputUsdPerMillion: "0.01", outputUsdPerMillion: "0.04" });
});

test("model prices are visible before wallet connection without network, storage, payment or availability reads", async () => {
  const service = { service: structuredClone(require("../lib/koin-network/credit-service.json")),
    context() { throw Error("Pricing must not request an account"); },
    account: new Proxy({}, { get() { throw Error("Pricing never opens wallet or account storage"); } }),
    purchases: new Proxy({}, { get() { throw Error("Pricing never opens purchase records"); } }) };
  const before = Date.now(), result = await modelPricing(service);
  assert.deepEqual(Object.keys(result).sort(), ["availabilityValidUntil", "models", "observedAt", "policyHash", "product", "schema"]);
  assert.equal(result.models.length, 15); assert.equal(result.policyHash, service.service.config.policyHash);
  assert.ok(result.observedAt >= before && result.observedAt <= Date.now()); assert.equal(result.availabilityValidUntil, null);
  assert.doesNotMatch(JSON.stringify(result), /sessionToken|owner|providers|"available"/);
  assert.equal(result.expiresAt, undefined, "immutable rates do not invent provider availability or expiry");
});

test("configured model prices preserve exact decimal units from one USD atom through uint64 maximum", () => {
  const f = fixture(1);
  f.tariffs[0].inputAtomsPerMillion = "1"; f.tariffs[0].outputAtomsPerMillion = "18446744073709551615"; f.repin();
  const row = configuredModelPricing(f.config, f.prices).models[0];
  assert.equal(row.inputCreditsPerMillion, "0.00001"); assert.equal(row.inputUsdPerMillion, "0.00000001");
  assert.equal(row.outputCreditsPerMillion, "184467440737095.51615"); assert.equal(row.outputUsdPerMillion, "184467440737.09551615");
});

test("changed policy, tampered prices and incomplete model sets never become a displayed tariff", () => {
  for (const change of [f => { f.prices.policyHash = P.hash("different"); }, f => { f.config.policyHash = P.hash("new policy"); },
    f => { f.tariffs[0].inputAtomsPerMillion = "100"; }, f => { f.tariffs.pop(); }, f => { f.tariffs[0].modelHash = P.hash("different weights"); }]) {
    const f = fixture(); change(f); assert.throws(() => configuredModelPricing(f.config, f.prices), /approved|policy/);
  }
});

test("configured model pricing accepts the bounded full set and refuses malformed rates, duplicate or excess models", () => {
  const bounded = fixture(64); assert.equal(configuredModelPricing(bounded.config, bounded.prices).models.length, 64);
  for (const count of [0, 65]) { const f = fixture(count); assert.throws(() => configuredModelPricing(f.config, f.prices), /Bounded/); }
  for (const rate of ["0", "01", "1.5", "1e8", "-1", "18446744073709551616", 100000000, null]) {
    const f = fixture(1); f.tariffs[0].inputAtomsPerMillion = rate; f.repin();
    assert.throws(() => configuredModelPricing(f.config, f.prices), /Invalid approved model rate/);
  }
  const duplicate = fixture(2); duplicate.tariffs[1].model = duplicate.tariffs[0].model; duplicate.repin();
  assert.throws(() => configuredModelPricing(duplicate.config, duplicate.prices), /Unique/);
});

test("model prices never present legacy KOIN tariffs as USD credits and respect cancellation or unavailable configuration", async () => {
  const f = fixture(); f.config.deployment.product = "prepaid-v1";
  assert.throws(() => configuredModelPricing(f.config, f.prices), /USD credit service/);
  await assert.rejects(modelPricing({ service: { state: "unavailable", reason: "Service not activated" } }), /not activated/);
  await assert.rejects(modelPricing(new Proxy({}, { get() { throw Error("No reads after cancellation"); } }), AbortSignal.abort()), { name: "AbortError" });
});

test("public configured model pricing IPC serves both channels with main-document and no-arguments guards", async t => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { EventEmitter } = require("node:events");
  const { CreditService } = require("../../electron/credit-service"), { registerTestPaymentIPC } = require("../../electron/koin-test-ipc");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-model-prices-"));
  const w = Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false });
  w.webContents.mainFrame = { url: "http://127.0.0.1:9000/" };
  const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame }; let handler, registration;
  t.mock.method(global, "setInterval", () => ({ unref() {} }));
  t.mock.method(CreditService.prototype, "context", () => { throw Error("Public prices must never authenticate an account"); });
  const options = { dataDir: directory, core: {}, dialog: {}, origin: "http://127.0.0.1:9000", getMainWindow: () => w,
    ipcMain: { handle: (_channel, fn) => { handler = fn; } } };
  t.after(() => { registration?.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  registration = registerTestPaymentIPC({ ...options, isTest: false });
  assert.equal((await handler(event, "model-pricing")).models.length, 15); registration.dispose();
  registration = registerTestPaymentIPC({ ...options, isTest: true });
  await assert.rejects(handler({ ...event, senderFrame: { url: event.senderFrame.url } }, "model-pricing"), /access denied/);
  for (const input of [{}, "1", null]) await assert.rejects(handler(event, "model-pricing", input), /takes no arguments/);
  assert.equal((await handler(event, "model-pricing")).models.length, 15);
  assert.deepEqual(fs.readdirSync(directory), [], "public pricing creates no account or payment records");
  w.webContents.mainFrame.url = "http://127.0.0.1:9000/mascot.html";
  await assert.rejects(handler(event, "model-pricing"), /access denied/);
  w.webContents.mainFrame.url = "http://127.0.0.1:9000/"; registration.dispose();
  await assert.rejects(handler(event, "model-pricing"), /open app/);
});
