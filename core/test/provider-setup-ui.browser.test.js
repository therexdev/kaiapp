"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { navClick } = require("./ui-nav");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";

test("Earn setup clicks acknowledge pending checks, show current blockers and recover after a lost reply", { skip: !fs.existsSync(CHROMIUM), timeout: 90000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-provider-setup-ui-"));
  const core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  let browser; t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1911, height: 1138 } }), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("kai-interface-language", "en"); window.providerCalls = [];
    window.providerInfo = { state: "wallet-required", enabled: false, running: false,
      blocked: "Unlock your wallet using Reward wallet, then check setup again.",
      detail: 'Unexpected token "<", "<!DOCTYPE" is not valid JSON',
      model: { id: "koinos-smart", label: "Koinos Smart", requiredRamGb: 8, installed: true } };
    window.kaiKoinTestBridge = { onProgress: () => () => {}, run: async action => {
      window.providerCalls.push(action);
      if (action === "status") return { enabled: true, configured: false, mode: "test-deployment" };
      if (action === "chat-info") return { enabled: true, configured: false, blocked: "Fixture not activated" };
      if (action === "provider-public-info") {
        const info = structuredClone(window.providerInfo);
        if (window.holdInfo) await new Promise(resolve => { window.finishInfo = resolve; });
        return info;
      }
      if (action === "provider-public-start") { window.providerInfo = { ...window.providerInfo, enabled: true, running: true }; return { state: "running" }; }
      if (action === "provider-public-stop") { window.providerInfo = { ...window.providerInfo, enabled: false, running: false }; return { state: "offline" }; }
      if (action === "provider-public-status") return { state: "qualifying", label: "CHECKING MODEL", detail: "Waiting for fresh signed qualification." };
      throw Error("Fixture unavailable");
    } };
  });
  await page.route("**/core/models", route => route.fulfill({ json: { aliases: [{ alias: "koinos-smart", label: "Koinos Smart", status: "ready" }], runtime: { runtime: { running: true }, activeAlias: "koinos-smart" } } }));
  await page.route("**/core/earn", route => route.fulfill({ json: { wallet: { exists: true, unlocked: false, address: "fixture-wallet" }, worker: { running: false } } }));
  await page.goto(`http://127.0.0.1:${await core.start()}`);
  await navClick(page, '#nav [data-view="earn"]');
  const reload = page.locator("#product-provider-reload"), toggle = page.locator("#product-provider-toggle"), notice = page.locator("#product-provider-refresh");
  await page.waitForFunction(() => document.getElementById("product-provider-detail").textContent.includes("Unlock"));
  assert.equal(await toggle.isDisabled(), true); assert.match(await page.locator("#product-provider-setup").textContent(), /Unlock/);
  assert.doesNotMatch(await page.locator("#product-provider-setup").textContent(), /DOCTYPE/);
  if (process.env.KAI_PREPAID_QA_DIR) {
    fs.mkdirSync(process.env.KAI_PREPAID_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.KAI_PREPAID_QA_DIR, "provider-setup-required.png"), animations: "disabled" });
  }
  await page.evaluate(() => { window.holdInfo = true; });
  const before = await page.evaluate(() => window.providerCalls.filter(x => x === "provider-public-info").length);
  await reload.click(); await page.waitForFunction(() => !!window.finishInfo);
  assert.equal(await reload.textContent(), "Checking setup…"); assert.match(await notice.textContent(), /Checking account/);
  await reload.click();
  assert.equal(await page.evaluate(() => window.providerCalls.filter(x => x === "provider-public-info").length), before + 1, "clicks join the pending read");
  await page.evaluate(() => { window.holdInfo = false; window.finishInfo(); });
  await page.waitForFunction(() => document.getElementById("product-provider-refresh").textContent.startsWith("Setup checked at"));
  assert.equal(await reload.textContent(), "Reload setup");
  await page.evaluate(() => { window.providerInfo = { ...window.providerInfo, state: "unavailable", blocked: "" }; });
  await reload.click();
  await page.waitForFunction(() => document.getElementById("product-provider-detail").textContent.includes("web page instead of setup data"));
  assert.equal(await toggle.isDisabled(), true, "an HTML response cannot enable sharing");
  await page.locator('#view-earn [data-product-action="payment-wallet"]').click();
  await page.locator("#earn-unlock").waitFor({ state: "visible" });
  assert.equal(await page.locator("#view-payment-wallet").isVisible(), true);
  await navClick(page, '#nav [data-view="earn"]');
  await page.locator('#view-earn [data-product-action="signin"]').click();
  assert.equal(await page.locator("#view-settings").isVisible(), true);
  await navClick(page, '#nav [data-view="earn"]');
  await page.waitForFunction(() => !document.getElementById("product-provider-reload").hasAttribute("aria-busy"));
  // Pause timers: exercise the real deadline without a 15-second wall wait.
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await page.evaluate(() => { window.holdInfo = true; window.finishInfo = null; });
  await reload.click(); await page.waitForFunction(() => !!window.finishInfo);
  await page.clock.runFor(15001);
  await page.waitForFunction(() => document.getElementById("product-provider-setup").textContent.includes("timed out"));
  assert.equal(await reload.isEnabled(), true); assert.equal(await toggle.isDisabled(), true);
  await page.evaluate(() => { window.lateInfo = window.finishInfo; window.holdInfo = false; window.providerInfo = { ...window.providerInfo, state: "ready", blocked: "", detail: "Ready to connect and check model quality." }; });
  await reload.click(); await page.waitForFunction(() => !document.getElementById("product-provider-toggle").disabled);
  await page.evaluate(() => window.lateInfo());
  assert.match(await page.locator("#product-provider-setup").textContent(), /Ready to connect/, "late timed-out reads cannot restore an old blocker");
  assert.equal(await page.evaluate(() => window.providerCalls.some(x => x === "provider-public-start")), false);
  await toggle.click(); await page.waitForFunction(() => document.getElementById("product-provider-label").textContent === "CHECKING MODEL");
  assert.equal(await toggle.textContent(), "On"); assert.equal(await toggle.isEnabled(), true);
  await toggle.click(); await page.waitForFunction(() => document.getElementById("product-provider-toggle").textContent === "Off");
  assert.equal(await page.evaluate(() => window.providerCalls.filter(x => x === "provider-public-start").length), 1);
  assert.equal(await page.evaluate(() => window.providerCalls.filter(x => x === "provider-public-stop").length), 1);
  assert.deepEqual(errors, []);
});
