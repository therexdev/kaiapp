"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { navClick } = require("./ui-nav");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";

test("Model sharing switches keep keyboard focus and draft choices through unchanged background reads", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-provider-switches-"));
  const core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  let browser;
  t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("kai-interface-language", "en"); window.switchCalls = [];
    window.switchSelection = { mode: "all", models: [] };
    const models = [
      { id: "koinos-smart", label: "Koinos Smart", installed: true, compatible: true, requiredRamGb: 8 },
      { id: "koinos-fast", label: "Koinos Fast", installed: true, compatible: true, requiredRamGb: 4 },
      { id: "gemma3-4b", label: "Gemma 3 4B", installed: true, compatible: true, requiredRamGb: 8 },
      { id: "koinos-large", label: "Koinos Large", installed: true, compatible: false, reason: "Needs 64 GB of memory." }
    ];
    window.kaiKoinTestBridge = { onProgress: () => () => {}, run: async (action, input) => {
      window.switchCalls.push({ action, input });
      if (action === "status") return { enabled: true, configured: false, mode: "test-deployment" };
      if (action === "chat-info") return { enabled: true, configured: false, blocked: "Fixture" };
      if (action === "provider-public-info") return { state: "ready", enabled: true, running: true, model: models[0], models, modelAvailability: models,
        selection: structuredClone(window.switchSelection), offeredModels: models.filter(model => model.compatible).map(model => model.id), detail: "Sharing is on." };
      if (action === "provider-public-status") return { state: "online", label: "ONLINE", model: "koinos-smart", detail: "Selected models are ready.", validUntil: Date.now() + 60000,
        models: models.filter(model => model.compatible).map(model => ({ model: model.id, state: "online", validUntil: Date.now() + 60000 })) };
      if (action === "provider-public-models") { window.switchSelection = structuredClone(input); return { state: "models-selected", selection: input, running: true }; }
      if (action === "provider-public-earnings") return { walletAddress: "fixture-wallet", scope: "a".repeat(64), observedAt: Date.now(), lastCycleCheck: Date.now(), payouts: [] };
      throw Error("Fixture action unavailable");
    } };
  });
  await page.route("**/core/models", route => route.fulfill({ json: { aliases: [{ alias: "koinos-smart", label: "Koinos Smart", status: "ready" }], runtime: { runtime: { running: false }, activeAlias: null } } }));
  await page.route("**/core/earn", route => route.fulfill({ json: { wallet: { exists: true, unlocked: false, address: "fixture-wallet" }, worker: { running: true } } }));
  await page.goto(`http://127.0.0.1:${await core.start()}`); await navClick(page, '#nav [data-view="earn"]');
  const all = page.locator("#product-provider-share-all"), smart = page.locator('[data-provider-shared-model="koinos-smart"]'), apply = page.locator("#product-provider-models-apply");
  await page.waitForFunction(() => document.querySelectorAll('[data-provider-shared-model][role="switch"]').length === 4);
  assert.equal(await all.getAttribute("role"), "switch"); assert.equal(await all.isChecked(), true);
  assert.equal(await smart.isChecked(), true);
  assert.equal(await page.locator('[data-provider-shared-model="koinos-large"]').isDisabled(), true);
  assert.deepEqual(await smart.evaluate(node => ({ width: getComputedStyle(node).width, height: getComputedStyle(node).height, radius: getComputedStyle(node).borderRadius })), { width: "44px", height: "26px", radius: "999px" });
  await smart.focus(); await page.keyboard.press("Space");
  assert.equal(await smart.isChecked(), false); assert.equal(await all.isChecked(), false); assert.equal(await apply.isVisible(), true);
  assert.equal(await smart.evaluate(node => document.activeElement === node), true, "changing the draft must keep the same focused switch");
  assert.equal(await page.evaluate(() => window.switchCalls.some(call => call.action === "provider-public-models")), false, "draft switches retain explicit Apply selection");
  await page.evaluate(() => {
    window.heldSwitch = document.querySelector('[data-provider-shared-model="koinos-smart"]');
    window.heldModelRow = window.heldSwitch.closest("[data-shared-model]"); window.modelMutations = 0;
    window.modelObserver = new MutationObserver(changes => { window.modelMutations += changes.filter(change => change.type === "childList" || change.type === "characterData").length; });
    window.modelObserver.observe(document.getElementById("product-provider-model-list"), { subtree: true, childList: true, characterData: true });
    window.beforeStatusReads = window.switchCalls.filter(call => call.action === "provider-public-status").length;
    window.KaiProduct.render("earn");
  });
  await page.waitForFunction(() => window.switchCalls.filter(call => call.action === "provider-public-status").length > window.beforeStatusReads);
  await page.waitForFunction(() => !document.getElementById("product-provider-reload").hasAttribute("aria-busy"));
  assert.equal(await smart.evaluate(node => node === window.heldSwitch && node.closest("[data-shared-model]") === window.heldModelRow && document.activeElement === node), true, "identical reads preserve row, switch and keyboard focus");
  assert.equal(await page.evaluate(() => window.modelMutations), 0, "identical row text is not rebuilt during background reads");
  assert.equal(await smart.isChecked(), false); assert.match(await page.locator('[data-shared-model="koinos-smart"]').textContent(), /Will stop sharing after Apply/);
  await page.evaluate(() => window.modelObserver.disconnect());
  await apply.click(); await page.waitForFunction(() => document.getElementById("product-provider-selection-actions").hidden);
  assert.deepEqual(await page.evaluate(() => window.switchCalls.filter(call => call.action === "provider-public-models").map(call => call.input)), [{ mode: "selected", models: ["koinos-fast", "gemma3-4b"] }]);
  await all.focus(); await page.keyboard.press("Space"); assert.equal(await all.isChecked(), true);
  assert.equal(await page.locator('[data-provider-shared-model]:checked').count(), 3);
  await page.locator("#product-provider-models-reset").click(); assert.equal(await all.isChecked(), false); assert.equal(await smart.isChecked(), false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await smart.evaluate(node => getComputedStyle(node, "::before").transitionDuration), "0s");
  if (process.env.KAI_PREPAID_QA_DIR) {
    fs.mkdirSync(process.env.KAI_PREPAID_QA_DIR, { recursive: true });
    await page.locator("#product-provider-models").evaluate(node => node.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: path.join(process.env.KAI_PREPAID_QA_DIR, "model-switches-desktop.png"), animations: "disabled" });
    await page.setViewportSize({ width: 780, height: 900 });
    await page.locator("#product-provider-models").evaluate(node => node.scrollIntoView({ block: "center" }));
    assert.equal(await page.locator("#view-earn").evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ path: path.join(process.env.KAI_PREPAID_QA_DIR, "model-switches-narrow.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.locator("#product-sidebar-close").isVisible()) await page.locator("#product-sidebar-close").click();
    await page.locator("#product-provider-models").evaluate(node => node.scrollIntoView({ block: "center" }));
    assert.equal(await page.locator("#view-earn").evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ path: path.join(process.env.KAI_PREPAID_QA_DIR, "model-switches-small.png"), animations: "disabled" });
  }
  assert.deepEqual(errors, []);
});
