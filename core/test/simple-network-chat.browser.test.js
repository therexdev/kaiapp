"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Signer } = require("koilib"), P = require("../lib/koin-network/job-protocol");
const { fundedResultHash } = require("../lib/koin-network/funded-protocol");
const { PrepaidChat } = require("../../electron/koin-prepaid-chat");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";

test("Network selection chooses an online default and Send verifies one credit debit without a payment review", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-simple-network-"));
  const core = await require("../server").createCore({ dataDir: directory, port: 0, onEvent() {} });
  core.settings.set("network.privacyMode", "local-first");
  const owner = Signer.fromSeed("simple-chat-buyer").getAddress(), signer = Signer.fromSeed("simple-chat-provider");
  const tariffs = ["koinos-fast", "koinos-smart"].map(model => Object.fromEntries(Object.entries({ model, version: 1,
    modelHash: P.hash(model), tokenizerHash: P.hash("tokenizer"), templateHash: P.hash("template"),
    inputAtomsPerMillion: "100000000", outputAtomsPerMillion: "100000000", maxOutputTokens: 64, contextTokens: 4096, maxLatencyMs: 30000,
  }).sort(([a], [b]) => a.localeCompare(b))));
  const config = { owner, version: 1, model: "koinos-fast", maxOutput: 16, limits: { perJob: "1000000" }, schedulerUrl: "https://network.invalid/scheduler",
    policyHash: P.hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", ...tariffs])),
    deployment: { product: "prepaid-usd-v1", chainId: require("../lib/koin-network/payment-network").MAINNET_CHAIN,
      credits: Signer.fromSeed("simple-chat-contract").getAddress(), creditsHash: "0x1220" + P.hash("wasm") } };
  const common = { enabled: true, configured: true, activation: "ready", blocked: "", product: "prepaid-usd-v1", mode: "mainnet-pilot", paymentsEnabled: true, owner };
  const calls = [], requests = new Map(); let page, browser, flow, spent = 0n, online = "koinos-smart";
  const balance = () => ({ ...common, credits: { unit: "USD-1e-8", version: String(requests.size + 1), available: String(100000000n - spent),
    purchased: { purchased: "100000000", spent: String(spent), available: String(100000000n - spent), held: "0" },
    free: { state: "ineligible", available: "0" }, observedAt: Date.now() }, purchases: [], usage: [] });
  const options = { file: path.join(directory, "paid-chat.json"), config,
    storage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s).map(b => b ^ 42), decryptString: b => b.map(n => n ^ 42).toString() },
    access: { authorize: () => ({ sessionToken: "test-session", owner }) },
    payments: { run: () => { throw Error("Normal chat must never request a wallet action"); } },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body), action = url.split("/").at(-1); let value = {};
      if (action === "models") { const now = Date.now(); value.catalog = { schema: 1, policyHash: config.policyHash, tariffs, asOf: now, validUntil: now + 15000,
        models: tariffs.map(tariff => ({ model: tariff.model, available: tariff.model === online, providers: tariff.model === online ? 1 : 0 })) }; }
      if (action === "estimate") value.estimate = { model: body.model, unit: "USD-1e-8", maxCharge: String((5 + body.max_tokens) * 100), maxFree: "0", maxPaid: String((5 + body.max_tokens) * 100), allowed: !body.freeOnly };
      if (action === "completions") {
        assert.equal(body.freeOnly, false); assert.equal(body.model, online);
        let completion = requests.get(body.requestId);
        if (!completion) {
          const tariff = tariffs.find(t => t.model === body.model), now = Date.now(), id = body.requestId, session = P.hash("prepaid-account:" + owner), attempt = P.hash(id);
          const output = "A signed network answer", quote = { schema: 2, mode: "shadow", domain: flow.target.domain, policyHash: config.policyHash, tariff,
            requestHash: P.hash(JSON.stringify(body.messages)), promptHash: P.hash("prompt"), inputIdsHash: P.hash("ids"), inputTokens: 5,
            maxOutput: body.max_tokens, maxCharge: String((5 + body.max_tokens) * 100), at: now, expires: now + 300000 };
          quote.hash = P.hash(JSON.stringify(quote));
          const receipt = { product: common.product, job: id, owner, provider: signer.getAddress(), attempt, quoteHash: quote.hash, outputHash: P.hash(output),
            signature: Buffer.from(await signer.signHash(fundedResultHash(flow.target, { id, session, attempt, quote }, output))).toString("base64"),
            dispatchedAt: now, completedAt: now + 1, usage: { inputTokens: 5, outputTokens: 3, amount: "800" } };
          completion = { id, choices: [{ message: { content: output } }], koin: { product: common.product, state: "charged", target: flow.target, session,
            quote, receipt, receiptHash: P.hash(JSON.stringify(receipt)) } };
          requests.set(id, completion); spent += 800n;
        }
        value.completion = completion;
      }
      if (action === "acknowledge") value.state = "charged";
      if (action === "result") value.completion = requests.get(body.requestId);
      return Response.json({ ok: true, ...common, ...value });
    } };
  flow = new PrepaidChat(options);
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  t.after(async () => { await browser.close(); await core.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.exposeFunction("simpleCreditIPC", async (action, input) => {
    calls.push({ action, input }); const signal = AbortSignal.timeout(10000);
    if (["chat-info", "purchase-info"].includes(action)) { const catalog = await flow.models(signal); return { ...common, model: config.model, maxOutput: 16, maxRequestCredits: "10", models: catalog.models, modelAvailabilityUntil: catalog.validUntil }; }
    if (action === "credit-status") return balance();
    if (action === "chat-completion") return flow.chat(null, input, signal);
    if (action === "chat-ack") { flow.acknowledge(input); return { state: "delivered" }; }
    if (action === "provider-public-info") return { state: "offline", enabled: false, detail: "Off" };
    if (action === "provider-public-status") return { state: "offline", label: "OFFLINE", detail: "Off" };
    if (action === "stop") return {};
    throw Error("Unexpected action " + action);
  });
  await page.addInitScript(() => {
    localStorage.setItem("kai-interface-language", "en");
    window.kaiKoinTestBridge = { onProgress: () => () => {}, run: (action, input) => window.simpleCreditIPC(action, input) };
  });
  await page.goto(`http://127.0.0.1:${await core.start()}`);
  await page.locator('#nav [data-view="chat"]').click();
  await page.selectOption("#src-pick", "network");
  await page.waitForFunction(() => document.getElementById("model-pick").value === "koinos-network:koinos-smart");
  assert.equal(await page.locator("#network-free-only").isVisible(), false, "ordinary Send has no spending checkbox to complete");
  assert.equal(await page.locator("#network-free-only").isChecked(), false);
  assert.equal(await page.locator("#credit-run-review").isVisible(), false);
  await page.fill("#input", "Use my purchased credits"); await page.click("#btn-send");
  await page.waitForFunction(() => document.getElementById("messages").textContent.includes("A signed network answer") && !document.getElementById("btn-send").disabled);
  assert.equal(requests.size, 1); assert.equal(spent, 800n);
  assert.match(await page.locator("#messages").textContent(), /0\.008 credits/);
  await page.waitForFunction(() => document.getElementById("network-chat-balance").textContent === "999.992 credits");
  assert.equal(calls.filter(call => call.action === "chat-completion").length, 1);
  assert.equal(calls.some(call => /purchase-approve|purchase-retry|reserve|run-open|release/.test(call.action)), false);
  assert.equal(flow.read().state, "delivered");
  assert.ok(!fs.readFileSync(options.file, "utf8").includes("Use my purchased credits"));

  // An automatic default tracks an asynchronously available model. A person's
  // explicit choice stays selected when that model subsequently goes offline.
  await page.evaluate(() => { KaiNetwork.info.modelAvailabilityUntil = Date.now() - 1; window.dispatchEvent(new Event("kai-network-models-changed")); });
  assert.equal(await page.inputValue("#model-pick"), "koinos-network:koinos-smart", "catalog refresh does not temporarily select an offline packaged default");
  online = "koinos-fast"; await page.evaluate(() => KaiNetwork.refresh());
  await page.waitForFunction(() => document.getElementById("model-pick").value === "koinos-network:koinos-fast");
  await page.selectOption("#model-pick", "koinos-network:koinos-fast");
  online = "koinos-smart"; await page.evaluate(() => KaiNetwork.refresh());
  assert.equal(await page.inputValue("#model-pick"), "koinos-network:koinos-fast");
  await page.fill("#input", "Do not change my chosen model"); await page.click("#btn-send");
  await page.waitForFunction(() => document.getElementById("messages").textContent.includes("model is unavailable") && !document.getElementById("btn-send").disabled);
  assert.equal(requests.size, 1); assert.equal(spent, 800n);

  await page.locator("#network-spending-summary").click(); await page.locator("#network-free-only").check();
  assert.equal(await page.locator("#network-spending-summary").textContent(), "Spending: free credits only");
  await page.reload(); await page.locator('#nav [data-view="chat"]').click(); await page.selectOption("#src-pick", "network");
  await page.waitForFunction(() => document.getElementById("model-pick").value === "koinos-network:koinos-fast");
  assert.equal(await page.locator("#network-free-only").isChecked(), true);
  assert.equal(await page.locator("#network-spending-summary").textContent(), "Spending: free credits only");

  core.settings.set("network.privacyMode", "local-only");
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#src-pick option[value="network"]')?.disabled);
  assert.match(await page.locator('#src-pick option[value="network"]').textContent(), /Local-Only/);
  assert.deepEqual(errors, []);
});
