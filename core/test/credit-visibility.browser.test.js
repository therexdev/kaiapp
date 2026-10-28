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
        if (window.holdCreditRead) await new Promise(resolve => { window.finishCreditRead = resolve; });
        if (window.creditScenario === "inactive") throw Error("Error invoking remote method 'koin:test-payments': Error: " + reason);
        if (window.creditScenario === "offline") throw Error("Connection unavailable");
        const legacy = window.creditScenario === "legacy", zero = window.creditScenario === "zero", guest = window.creditScenario === "guest";
        return { product: legacy ? "prepaid-v1" : "prepaid-usd-v1", owner: guest ? "free-installation" : "fixture-account", ...(guest ? { accessKind: "device-free" } : {}), credits: {
          version: zero ? "2" : "1", unit: legacy ? "legacy-KOIN-1e-8" : "USD-1e-8", available: zero ? "0" : guest ? "25000000" : "125000000",
          purchased: { available: zero || guest ? "0" : "100000000" }, free: { state: "available", available: zero ? "0" : "25000000", resetAt: Date.now() + 3600000 },
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
  assert.equal(await refresh.isVisible(), false, "healthy credits update automatically without a Refresh button");
  await page.clock.pauseAt(new Date());
  const geometry = () => page.evaluate(() => {
    const box = document.querySelector(".product-sidebar-credits").getBoundingClientRect();
    const buy = document.querySelector('.product-sidebar-credits [data-product-view="buy-credits"]').getBoundingClientRect();
    return [box.height, buy.top, buy.height, document.getElementById("nav").getBoundingClientRect().top];
  });
  for (const width of [1440, 780]) {
    await page.setViewportSize({ width, height: 980 });
    const before = await geometry();
    await page.evaluate(() => {
      window.creditTextMutations = 0;
      window.creditObserver?.disconnect();
      window.creditObserver = new MutationObserver(records => { window.creditTextMutations += records.length; });
      window.creditObserver.observe(document.querySelector(".product-sidebar-credits"), { childList: true, characterData: true, subtree: true });
      window.savedHistoryRow = document.querySelector("#product-credit-history tr");
      window.holdCreditRead = true; window.finishCreditRead = null;
    });
    await page.clock.runFor(15001);
    await page.waitForFunction(() => !!window.finishCreditRead);
    await page.clock.runFor(4000);
    assert.equal(await total.textContent(), "1,250");
    assert.equal(await status.textContent(), "Updates automatically", "a normal in-flight poll does not show Checking or stale text");
    assert.equal(await page.evaluate(() => window.creditTextMutations), 0, "unchanged balance text nodes are not replaced every second");
    assert.equal(await page.evaluate(() => window.savedHistoryRow === document.querySelector("#product-credit-history tr")), true);
    assert.deepEqual(await geometry(), before, `a background read preserves sidebar layout at ${width}px`);
    await page.evaluate(() => { window.holdCreditRead = false; window.finishCreditRead(); });
    await page.waitForFunction(() => !window.KaiCredits.get().refreshing);
    assert.deepEqual(await geometry(), before, "completing the read does not move Buy credits or navigation");
  }
  await page.evaluate(() => window.creditObserver.disconnect());
  // The public service is still inactive in this fixture; an existing connected
  // USD deployment must nevertheless remain readable without changing setup.
  assert.equal(await page.evaluate(() => KaiNetwork.info.activation), "unavailable");
  const readyGeometry = await geometry();
  await page.evaluate(async () => { window.creditScenario = "offline"; await window.KaiCredits.refresh(); });
  await page.waitForFunction(() => document.querySelector(".product-sidebar-credits [data-credit-status]").textContent.includes("Last verified"));
  assert.equal(await total.textContent(), "1,250");
  assert.equal(await refresh.isVisible(), true, "Retry remains available after an actual failure");
  assert.deepEqual(await geometry(), readyGeometry, "stale status and Retry use reserved space instead of shifting the sidebar");
  await page.evaluate(() => { window.creditScenario = "zero"; }); await refresh.click();
  await page.waitForFunction(() => document.querySelector(".product-sidebar-credits [data-credit-total]").textContent === "0");
  assert.match(await page.locator(".product-sidebar-credits [data-credit-breakdown]").textContent(), /0 free.*0 purchased/);
  await page.evaluate(() => { window.holdCreditRead = true; window.creditScenario = "guest"; window.dispatchEvent(new Event("kai-account-signed-out")); });
  await page.waitForFunction(() => !!window.finishCreditRead);
  assert.equal(await total.textContent(), "…", "sign-out immediately hides the prior balance while automatic free access reconnects");
  assert.equal(await page.locator("#koin-available").textContent(), "—");
  await page.evaluate(() => { window.holdCreditRead = false; window.finishCreditRead(); });
  await page.waitForFunction(() => document.querySelector(".product-sidebar-credits [data-credit-total]").textContent === "250");
  assert.match(await page.locator(".product-sidebar-credits [data-credit-breakdown]").textContent(), /^250 free$/);
  assert.equal(await page.evaluate(() => window.KaiCredits.get().snapshot.owner), "free-installation");
  await page.evaluate(async () => { window.KaiCredits.clear(); document.getElementById("koin-available").textContent = "0.10000000"; window.creditScenario = "legacy"; await window.KaiCredits.refresh(); });
  await page.waitForFunction(() => document.querySelector(".product-sidebar-credits [data-credit-status]").textContent.includes("Earlier balance"));
  assert.equal(await total.textContent(), "—"); assert.equal(await page.locator("#koin-available").textContent(), "0.10000000");
  await page.locator(".product-sidebar-credits [data-credit-help]").click();
  assert.equal(await page.locator("#view-recovery").isVisible(), true);
  assert.equal(await page.locator("#product-legacy-account").evaluate(node => node.open), true);
  assert.deepEqual(errors, []);
});
