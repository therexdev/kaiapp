"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { navClick } = require("./ui-nav");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-provider-smooth-"));
  const core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  let browser;
  t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = [];
  page.on("pageerror", e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(() => {
    localStorage.setItem("kai-interface-language", "en"); window.providerCalls = []; window.earning = true;
    const models = ["Fast", "Smart"].map(name => ({ id: "koinos-" + name.toLowerCase(), label: "Koinos " + name, installed: true, compatible: true }));
    window.kaiKoinTestBridge = { onProgress: () => () => {}, run: async action => {
      window.providerCalls.push({ action, at: Date.now() });
      if (action === "status") return { enabled: true, configured: false, mode: "test-deployment" };
      if (action === "chat-info") return { enabled: true, configured: false, blocked: "Fixture" };
      if (action === "provider-public-info") {
        const info = { state: "ready", enabled: window.earning, running: window.earning, automatic: true, model: models[0], models,
          selection: { mode: "all", models: [] }, modelAvailability: models, offeredModels: models.map(m => m.id), detail: "Ready to share." };
        if (window.holdInfo) await new Promise(resolve => { window.finishInfo = resolve; });
        return info;
      }
      if (action === "provider-public-status") {
        const rows = models.map(model => ({ model: model.id, state: "online", label: "ONLINE", detail: "Connected and qualified.", validUntil: Date.now() + 15000,
          qualification: { kind: "runtime-readiness", state: "qualified", passed: 2, completed: 2, total: 2, required: 2, retryAt: null } }));
        window.lastProviderDeadline = rows[0].validUntil;
        const value = { ...rows[0], models: rows };
        if (window.holdStatus) await new Promise(resolve => { window.finishStatus = resolve; });
        return value;
      }
      if (action === "provider-public-stop") {
        if (window.holdStop) await new Promise(resolve => { window.finishStop = resolve; });
        window.earning = false; return { state: "offline" };
      }
      throw Error("Fixture unavailable");
    } };
  });
  await page.route("**/core/models", route => route.fulfill({ json: { aliases: [], runtime: { runtime: { running: false }, activeAlias: null } } }));
  await page.route("**/core/earn", route => route.fulfill({ json: { wallet: { exists: true, unlocked: false, address: "fixture-wallet" }, worker: { running: true } } }));
  await page.goto(`http://127.0.0.1:${await core.start()}`);
  // Install the clock before Earn creates its timeout-based refresh cycle.
  await page.clock.pauseAt(new Date());
  await navClick(page, '#nav [data-view="earn"]');
  await page.waitForFunction(() => document.getElementById("product-provider-label").textContent === "ONLINE");
  return page;
}

test("Earn refreshes ahead of readiness expiry without changing stable text or showing background checking", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const page = await fixture(t);
  await page.evaluate(() => {
    window.providerTextChanges = [];
    const ids = ["product-provider-label", "product-provider-detail", "product-provider-model", "product-provider-readiness", "product-provider-qualification", "product-provider-model-summary"];
    for (const id of ids) new MutationObserver(() => window.providerTextChanges.push(id)).observe(document.getElementById(id), { childList: true, characterData: true, subtree: true });
    window.holdInfo = true;
  });
  const before = await page.evaluate(() => window.providerCalls.filter(c => c.action === "provider-public-info").length);
  await page.clock.runFor(10500);
  assert.equal(await page.evaluate(() => window.providerCalls.filter(c => c.action === "provider-public-info").length), before + 1, "read starts before the 15-second validity boundary");
  assert.equal(await page.locator("#product-provider-label").textContent(), "ONLINE");
  assert.equal(await page.locator("#product-provider-reload").textContent(), "Reload setup", "background work has no flashing checking button");
  await page.evaluate(() => { window.KaiProduct.render("earn"); window.KaiProduct.render("earn"); });
  assert.equal(await page.evaluate(() => window.providerCalls.filter(c => c.action === "provider-public-info").length), before + 1, "visible refresh requests join one in-flight read");
  await page.clock.runFor(1500);
  await page.evaluate(() => { window.holdInfo = false; window.finishInfo(); });
  await page.waitForFunction(() => window.providerCalls.filter(c => c.action === "provider-public-status").length >= 2);
  await page.clock.runFor(30001);
  assert.equal(await page.locator("#product-provider-label").textContent(), "ONLINE");
  assert.deepEqual(await page.evaluate(() => window.providerTextChanges), [], "same observations preserve text nodes and never temporarily replace the model/readiness summary");
  assert.match(await page.locator("#product-provider-readiness").textContent(), /2 of 2/);
  await navClick(page, '#nav [data-view="chat"]');
  const away = await page.evaluate(() => window.providerCalls.filter(c => c.action === "provider-public-info").length);
  await page.clock.runFor(40001);
  assert.equal(await page.evaluate(() => window.providerCalls.filter(c => c.action === "provider-public-info").length), away, "hidden Earn pauses automatic reads");
  await navClick(page, '#nav [data-view="earn"]');
  await page.waitForFunction(n => window.providerCalls.filter(c => c.action === "provider-public-info").length > n, away);
  await page.waitForFunction(() => document.getElementById("product-provider-label").textContent === "ONLINE");
});

test("Earn still expires unconfirmed evidence and ignores a delayed status after the account changes", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const page = await fixture(t);
  await page.evaluate(() => { window.holdStatus = true; });
  await page.clock.runFor(10500); await page.waitForFunction(() => !!window.finishStatus);
  await page.clock.runFor(5500);
  assert.equal(await page.locator("#product-provider-label").textContent(), "CONNECTION UNCONFIRMED", "smooth polling cannot extend network evidence");
  assert.equal(await page.locator('.product-model-status[data-state="online"]').count(), 0);
  await page.evaluate(() => { window.holdStatus = false; window.finishStatus(); });
  await page.waitForFunction(() => document.getElementById("product-provider-label").textContent === "ONLINE");
  await page.evaluate(() => { window.holdStatus = true; window.finishStatus = null; });
  await page.clock.runFor(5001); await page.waitForFunction(() => !!window.finishStatus);
  await page.evaluate(() => {
    window.earning = false;
    window.dispatchEvent(new Event("kai-credit-identity-changed"));
  });
  await page.waitForFunction(() => document.getElementById("product-provider-label").textContent === "OFFLINE");
  await page.evaluate(() => { window.holdStatus = false; window.finishStatus(); });
  await page.clock.runFor(1);
  assert.equal(await page.locator("#product-provider-label").textContent(), "OFFLINE");
  assert.equal(await page.locator('.product-model-status[data-state="online"]').count(), 0, "old-account readiness cannot return after a late reply");
});


test("Stopping earning cannot leave ONLINE visible while its old readiness evidence expires", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const page = await fixture(t);
  await page.evaluate(() => { window.holdStop = true; });
  await page.locator("#product-provider-toggle").click();
  await page.waitForFunction(() => !!window.finishStop);
  assert.equal(await page.locator("#product-provider-label").textContent(), "STOPPING");
  assert.equal(await page.locator('.product-model-status[data-state="online"]').count(), 0);
  const reads = await page.evaluate(() => window.providerCalls.filter(c => c.action === "provider-public-info").length);
  await page.clock.runFor(30001);
  assert.equal(await page.locator("#product-provider-label").textContent(), "STOPPING");
  assert.equal(await page.evaluate(() => window.providerCalls.filter(c => c.action === "provider-public-info").length), reads, "background reads do not overwrite an unfinished action");
  await page.evaluate(() => { window.holdStop = false; window.finishStop(); });
  await page.waitForFunction(() => document.getElementById("product-provider-label").textContent === "OFFLINE");
  assert.equal(await page.locator("#product-provider-toggle").textContent(), "Start earning");
});
