"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
test("credits load on open, explain inactive service, retry existing USD accounts and never relabel legacy balances", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-credit-visible-")), core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  let browser; t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("kai-interface-language", "en");
    window.creditReads = 0; window.creditScenario = "inactive";
    const reason = "The upgraded credit service is not activated yet. Your existing account data and earlier balances are preserved. Local AI is available.";
    window.kaiKoinTestBridge = { onProgress: () => () => {}, run: async action => {
      if (action === "chat-info") return { enabled: true, configured: true, product: "prepaid-usd-v1", activation: "unavailable", blocked: reason };
      if (action === "status") return { enabled: true, mode: "test-deployment", configured: false };
      if (action === "credit-status") {
        window.creditReads++;
        if (window.creditScenario === "inactive") throw Error("Error invoking remote method 'koin:test-payments': Error: " + reason);
        if (window.creditScenario === "offline") throw Error("Connection unavailable");
        const legacy = window.creditScenario === "legacy", zero = window.creditScenario === "zero";
        return { product: legacy ? "prepaid-v1" : "prepaid-usd-v1", owner: "fixture-account", credits: {
          version: zero ? "2" : "1", unit: legacy ? "legacy-KOIN-1e-8" : "USD-1e-8", available: zero ? "0" : "125000000",
          purchased: { available: zero ? "0" : "100000000" }, free: { state: "available", available: zero ? "0" : "25000000", resetAt: Date.now() + 3600000 },
        }, purchases: [], usage: [] };
      }
      if (action === "provider-public-info") return { state: "unavailable", detail: reason };
      throw Error("Unavailable fixture action: " + action);
    } };
  });
  await page.goto(`http://127.0.0.1:${await core.start()}`);
  const total = page.locator(".product-sidebar-credits [data-credit-total]"), status = page.locator(".product-sidebar-credits [data-credit-status]"), refresh = page.locator(".product-sidebar-credits [data-credit-refresh]");
  await page.waitForFunction(() => document.querySelector(".product-sidebar-credits [data-credit-status]").textContent.includes("not activated yet"));
  assert.equal(await total.textContent(), "—"); assert.equal(await total.isVisible(), true);
  assert.equal(await refresh.textContent(), "Retry"); assert.ok(await page.evaluate(() => window.creditReads) >= 1);
  assert.doesNotMatch(await status.textContent(), /remote method/);
  await page.evaluate(() => { window.creditScenario = "ready"; }); await refresh.click();
  await page.waitForFunction(() => document.querySelector(".product-sidebar-credits [data-credit-total]").textContent === "1,250");
  assert.match(await page.locator(".product-sidebar-credits [data-credit-breakdown]").textContent(), /250 free.*1,000 purchased/);
  // The public service is still inactive in this fixture; an existing connected
  // USD deployment must nevertheless remain readable without changing setup.
  assert.equal(await page.evaluate(() => KaiNetwork.info.activation), "unavailable");
  await page.evaluate(() => { window.creditScenario = "offline"; }); await refresh.click();
  await page.waitForFunction(() => document.querySelector(".product-sidebar-credits [data-credit-status]").textContent.includes("Last verified"));
  assert.equal(await total.textContent(), "1,250");
  await page.evaluate(() => { window.creditScenario = "zero"; }); await refresh.click();
  await page.waitForFunction(() => document.querySelector(".product-sidebar-credits [data-credit-total]").textContent === "0");
  assert.match(await page.locator(".product-sidebar-credits [data-credit-breakdown]").textContent(), /0 free.*0 purchased/);
  await page.evaluate(() => { window.dispatchEvent(new Event("kai-account-signed-out")); });
  assert.equal(await total.textContent(), "—");
  assert.equal(await page.locator("#koin-available").textContent(), "—");
  await page.evaluate(() => { document.getElementById("koin-available").textContent = "0.10000000"; window.creditScenario = "legacy"; }); await refresh.click();
  await page.waitForFunction(() => document.querySelector(".product-sidebar-credits [data-credit-status]").textContent.includes("Earlier balance"));
  assert.equal(await total.textContent(), "—"); assert.equal(await page.locator("#koin-available").textContent(), "0.10000000");
  await page.locator(".product-sidebar-credits [data-credit-help]").click();
  assert.equal(await page.locator("#product-legacy-account").evaluate(node => node.open), true);
  assert.deepEqual(errors, []);
});
