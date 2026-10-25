"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { navClick } = require("./ui-nav");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";

test("Earn local check works before service activation, reports progress, exports and cancels without changing network readiness", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-provider-check-ui-"));
  const core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  let browser; t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } }), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("kai-interface-language", "en");
    window.checkCalls = []; window.providerCalls = [];
    window.checkState = { state: "idle", stage: "", detail: "Check the installed model locally.", completed: 0, total: 0, passed: null, reportAvailable: false, model: null };
    const listeners = new Set();
    window.emitProviderCheck = change => { window.checkState = { ...window.checkState, ...change }; for (const fn of listeners) fn(window.checkState); };
    window.kaiProviderCheckBridge = {
      start: async () => {
        window.checkCalls.push("start");
        window.emitProviderCheck({ state: "running", stage: "hashing", detail: "Checking the installed model file…", completed: 0, total: 19, passed: 0, reportAvailable: false, model: { id: "koinos-fast", label: "Koinos Fast" } });
        if (window.holdStart) await new Promise(resolve => { window.finishStart = resolve; });
        return window.checkState;
      },
      status: async () => { window.checkCalls.push("status"); return window.checkState; },
      cancel: async () => { window.checkCalls.push("cancel"); window.emitProviderCheck({ state: "incomplete", stage: "cancelled", detail: "Check cancelled. Partial evidence is available.", reportAvailable: true }); return window.checkState; },
      copy: async () => { window.checkCalls.push("copy"); return { copied: true }; },
      save: async () => { window.checkCalls.push("save"); return { cancelled: window.cancelSave === true }; },
      onProgress: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    };
    window.kaiKoinTestBridge = { onProgress: () => () => {}, run: async action => {
      window.providerCalls.push(action);
      if (action === "status") return { enabled: true, configured: false, mode: "test-deployment" };
      if (action === "chat-info") return { enabled: true, configured: false, blocked: "Credit service not activated" };
      if (action === "provider-public-info") return { enabled: false, running: false, state: "unavailable", detail: "Credit service not activated" };
      throw Error("Credit service not activated");
    } };
  });
  await page.route("**/core/models", route => route.fulfill({ json: { aliases: [{ alias: "koinos-fast", label: "Koinos Fast", status: "ready" }], runtime: { runtime: { running: true }, activeAlias: "koinos-fast" } } }));
  await page.goto(`http://127.0.0.1:${await core.start()}`);
  await navClick(page, '#nav [data-view="earn"]');
  await page.locator("#product-provider-options > summary").click();
  const check = page.locator("#product-provider-check"), start = check.locator("[data-check-start]"), detail = check.locator("[data-check-detail]"), summary = check.locator("[data-check-summary]");
  await page.waitForFunction(() => document.getElementById("product-provider-setup").textContent.includes("not activated"));
  assert.equal(await start.isEnabled(), true, "local checks work without an account or activated service");
  assert.equal(await check.locator("[data-check-copy]").isVisible(), false);
  await page.evaluate(() => { window.holdStart = true; const b = document.querySelector("[data-check-start]"); b.click(); b.click(); });
  await page.waitForFunction(() => !!window.finishStart);
  assert.equal(await page.evaluate(() => window.checkCalls.filter(x => x === "start").length), 1);
  assert.equal(await start.isDisabled(), true); assert.equal(await check.locator("[data-check-cancel]").isVisible(), true);
  assert.equal(await check.locator("[data-check-progress]").isVisible(), true);
  await page.evaluate(() => window.emitProviderCheck({ stage: "tokenizer", detail: "Checking tokenizer agreement…", completed: 7, passed: 7 }));
  assert.match(await summary.textContent(), /7 of 19 checks completed/);
  await page.evaluate(() => { window.finishStart(); window.holdStart = false; });
  await page.waitForFunction(() => document.querySelector("[data-check-detail]").textContent.includes("tokenizer"));
  await page.locator('[data-product-action="provider-reload"]').click();
  assert.match(await detail.textContent(), /tokenizer/);
  await page.evaluate(() => window.emitProviderCheck({ state: "complete", stage: "complete", detail: "Local check complete. One case did not pass.", completed: 19, passed: 18, reportAvailable: true }));
  await check.locator("[data-check-copy]").waitFor({ state: "visible" });
  assert.equal(await check.locator("[data-check-progress]").isVisible(), false);
  assert.equal(await start.textContent(), "Run check again"); assert.match(await summary.textContent(), /18 candidate answers matched/);
  assert.notEqual(await page.locator("#product-provider-label").getAttribute("data-state"), "online");
  assert.equal(await page.locator("#product-provider-toggle").getAttribute("aria-checked"), "false");
  await check.locator("[data-check-copy]").click();
  await page.waitForFunction(() => document.querySelector("[data-check-export]").textContent.includes("Report copied"));
  await page.evaluate(() => { window.cancelSave = true; }); await check.locator("[data-check-save]").click();
  await page.waitForFunction(() => document.querySelector("[data-check-export]").textContent.includes("Save cancelled"));
  await page.evaluate(() => { window.cancelSave = false; }); await check.locator("[data-check-save]").click();
  await page.waitForFunction(() => document.querySelector("[data-check-export]").textContent === "Report saved.");
  await start.click(); await check.locator("[data-check-cancel]").waitFor({ state: "visible" });
  assert.equal(await check.locator("[data-check-save]").isVisible(), false);
  await page.evaluate(() => window.emitProviderCheck({ stage: "quality", detail: "Checking model responses…", completed: 10, passed: 9 }));
  await check.locator("[data-check-cancel]").click();
  await page.waitForFunction(() => document.querySelector("[data-check-detail]").textContent.includes("Check cancelled"));
  assert.equal(await check.locator("[data-check-copy]").isVisible(), true, "partial reports remain exportable");
  assert.equal(await check.locator("[data-check-cancel]").isVisible(), false); assert.equal(await start.isEnabled(), true);
  assert.deepEqual(await page.evaluate(() => window.checkCalls.filter(x => x !== "status")), ["start", "copy", "save", "save", "start", "cancel"]);
  assert.equal(await page.evaluate(() => window.providerCalls.some(x => /start|stop|download|purchase|reserve|sign/.test(x))), false);
  await page.setViewportSize({ width: 780, height: 560 });
  await start.scrollIntoViewIfNeeded(); assert.equal(await check.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  assert.deepEqual(errors, []);
});
