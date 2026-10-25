"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
test("paid network picker preserves chosen model, shows its price and blocks unavailable capacity without fallback", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-model-picker-")), core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  core.settings.set("network.privacyMode", "local-first");
  let browser;
  t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const catalog = require("../models/catalog.json"), models = Object.entries(catalog.aliases).filter(([, m]) => !m.dev).map(([model, m], i) => ({
    model, label: m.label, available: i < 11, providers: i < 11 ? 1 : 0,
    inputCreditsPerMillion: model === "koinos-balanced" ? "15" : "10", outputCreditsPerMillion: model === "koinos-balanced" ? "60" : "40", maxOutput: 128, version: 1,
  }));
  await page.addInitScript(models => {
    localStorage.setItem("kai-interface-language", "en"); window.modelOptions = models; window.paidCalls = [];
    window.kaiKoinTestBridge = { onProgress: () => () => {}, run: async (action, input) => {
      window.paidCalls.push({ action, input });
      const common = { enabled: true, configured: true, product: "prepaid-usd-v1", mode: "mainnet-pilot", activation: "ready", blocked: "" };
      if (action === "chat-info") return { ...common, model: "koinos-fast", maxOutput: 128, runBudgets: true,
        models: window.catalogOutage ? [] : structuredClone(window.modelOptions), modelAvailabilityUntil: window.modelExpiry || Date.now() + 15000,
        recoveryAvailable: true, blocked: window.catalogOutage ? "Catalog temporarily unavailable" : "", maxRequestCredits: "5" };
      if (action === "status") return { ...common, accessReady: true, credits: { available: "100000000", purchased: "100000000", spent: "0", held: "0" }, purchases: [], usage: [], worker: { running: false } };
      if (action === "credit-status") return { ...common, owner: "fixture-account", credits: { unit: "USD-1e-8", available: "100000000", purchased: { available: "100000000" }, free: { state: "unavailable", available: "0" } }, purchases: [], usage: [] };
      if (action === "provider-public-info") return { state: "unavailable", detail: "Fixture" };
      if (action === "chat-completion") return { id: "a".repeat(64), servedModel: input.model.slice("koinos-network:".length), choices: [{ message: { role: "assistant", content: "Selected model reply" } }], koin: { product: "prepaid-usd-v1", receipt: { usage: { amount: "2000" } } } };
      if (action === "chat-ack") return { state: "delivered" };
      if (action === "run-open") return { run: { id: "b".repeat(64), model: input.model } };
      if (action === "run-stop") return {};
      if (action === "run-list") return { runs: [] };
      throw Error("Unexpected fixture action " + action);
    } };
  }, models);
  await page.goto(`http://127.0.0.1:${await core.start()}`);
  await page.evaluate(() => window.dispatchEvent(new Event("kai-network-use")));
  await page.waitForFunction(() => document.getElementById("src-pick").value === "network" && document.getElementById("model-pick").options.length === 15);
  assert.equal(await page.locator("#model-pick option:disabled").count(), 4);
  assert.equal(await page.locator("#model-pick").inputValue(), "koinos-network:koinos-fast");
  await page.selectOption("#model-pick", "koinos-network:koinos-balanced");
  assert.match(await page.locator("#network-model-price").textContent(), /15 input \/ 60 output credits per million tokens/);
  await page.evaluate(() => KaiNetwork.refresh());
  assert.equal(await page.locator("#model-pick").inputValue(), "koinos-network:koinos-balanced");
  await page.fill("#input", "Use the selected model"); await page.locator("#btn-send").click();
  await page.waitForFunction(() => document.getElementById("messages").textContent.includes("Selected model reply") && !document.getElementById("btn-send").disabled);
  assert.equal(await page.evaluate(() => window.paidCalls.find(c => c.action === "chat-completion").input.model), "koinos-network:koinos-balanced");
  await page.evaluate(async () => { window.modelOptions.find(m => m.model === "koinos-balanced").available = false; await KaiNetwork.refresh(); });
  assert.equal(await page.locator("#model-pick").inputValue(), "koinos-network:koinos-balanced");
  assert.equal(await page.locator('#model-pick option[value="koinos-network:koinos-balanced"]').isDisabled(), true);
  assert.match(await page.locator("#network-model-price").textContent(), /Unavailable/);
  await page.fill("#input", "Do not replace this model"); await page.locator("#btn-send").click();
  await page.waitForFunction(() => document.getElementById("messages").textContent.includes("This network model is unavailable") && !document.getElementById("btn-send").disabled);
  assert.equal(await page.evaluate(() => window.paidCalls.filter(c => c.action === "chat-completion").length), 1);
  // Removing the selected entry also keeps an explicit disabled choice.
  await page.evaluate(async () => { window.modelOptions = window.modelOptions.filter(m => m.model !== "koinos-balanced"); await KaiNetwork.refresh(); });
  assert.equal(await page.locator("#model-pick").inputValue(), "koinos-network:koinos-balanced");
  assert.equal(await page.locator('#model-pick option[value="koinos-network:koinos-balanced"]').isDisabled(), true);
  await page.selectOption("#model-pick", "koinos-network:koinos-smart");
  await page.evaluate(() => { window.runOpening = KaiCreditRuns.begin("research"); });
  await page.locator("#credit-run-review").waitFor({ state: "visible" });
  await page.fill("#credit-run-budget", "2"); await page.locator("#credit-run-start").click();
  await page.waitForFunction(() => KaiCreditRuns.active?.model === "koinos-smart");
  assert.equal(await page.evaluate(() => window.paidCalls.find(c => c.action === "run-open").input.model), "koinos-smart");
  await page.evaluate(() => KaiCreditRuns.finish());
  await page.evaluate(async () => { window.modelExpiry = Date.now() + 150; await KaiNetwork.refresh(); });
  await page.waitForFunction(() => document.getElementById("network-model-price").textContent.includes("Checking availability"));
  assert.equal(await page.locator('#model-pick option[value="koinos-network:koinos-smart"]').isDisabled(), true);
  await page.evaluate(() => { window.modelExpiry = null; document.getElementById("model-pick").dispatchEvent(new FocusEvent("focus")); });
  await page.waitForFunction(() => !document.querySelector('#model-pick option[value="koinos-network:koinos-smart"]').disabled);
  await page.evaluate(async () => { window.catalogOutage = true; await refresh(); });
  assert.equal(await page.locator("#src-pick").inputValue(), "network", "catalog outage cannot switch to local AI");
  assert.equal(await page.locator("#model-pick").inputValue(), "koinos-network:koinos-smart");
  assert.equal(await page.locator("#network-recover").isVisible(), true, "saved recovery remains accessible without a fresh model catalog");
  assert.match(await page.locator("#network-model-price").textContent(), /Catalog temporarily unavailable/);
  await page.setViewportSize({ width: 480, height: 900 });
  assert.equal(await page.locator("#network-chat-account").evaluate(n => n.scrollWidth <= n.clientWidth), true);
  assert.deepEqual(errors, []);
});
