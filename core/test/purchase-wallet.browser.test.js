"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
test("Buy credits shows KOIN independently, explains activation and discards changed-wallet quotes", { skip: !fs.existsSync(CHROMIUM), timeout: 90000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-buy-wallet-"));
  const core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  let browser;
  t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("kai-interface-language", "en");
    window.thirtySecondTicks = []; const interval = window.setInterval;
    window.setInterval = (fn, delay, ...args) => { if (delay === 30000) window.thirtySecondTicks.push(fn); return interval(fn, delay, ...args); };
    window.purchaseState = "unavailable"; window.purchaseCalls = [];
    window.kaiKoinTestBridge = { onProgress: () => () => {}, run: async (action, input) => {
      window.purchaseCalls.push({ action, input });
      if (action === "purchase-info") return { activation: window.purchaseState, localPurchase: window.localPurchase || null, cancelledPurchases: window.cancelledPurchases || [], blocked: window.purchaseState === "signin-required" ? "Choose an online route to use network credits" : "The credit service is not activated yet" };
      // A legacy chat profile must never make public purchases appear ready.
      if (action === "chat-info") return { configured: true, enabled: true, product: "prepaid-v1", model: "fixture", maxOutput: 32, blocked: "" };
      if (action === "status") return { enabled: true, configured: false, mode: "test-deployment" };
      if (action === "credit-status") throw Error("The earlier KOIN account is preserved for recovery. Credit service activation is pending.");
      if (action === "provider-public-info") return { state: "unavailable", detail: "Fixture" };
      if (action === "purchase-preview") {
        if (window.pausePurchaseQuote) await new Promise(resolve => { window.finishPurchaseQuote = resolve; });
        return { quote: { id: "fixture-quote", koin: "2", credits: "1000", observedAt: Date.now() - 17 * 60000, expiresAt: Date.now() + 60000, priceDetails: { usdPerKoin: "0.5", windowSeconds: 1800, referenceKind: "merchant-exchange-reference" } } };
      }
      if (action === "credit-purchase-retry") {
        if (window.pauseRecovery) await new Promise(resolve => { window.finishRecovery = resolve; });
        window.localPurchase = { ...window.localPurchase, recovery: "resume-cancellation", cancellation: { txId: "0x1220" + "b".repeat(64) }, detail: "Cancellation saved; waiting for confirmation." };
        return { state: "pending" };
      }
      if (action === "purchase-approve") {
        if (window.purchaseFailure) throw Error(window.purchaseFailure);
        return { state: "cancelled" };
      }
      throw Error("Unexpected fixture action: " + action);
    } };
  });
  let wallet = { address: "payment-wallet-a", network: "mainnet", tokenSymbol: "KOIN", koin: "1234.56789012", usd: 9999, price: { usdPerKoin: 9999 } }, offline = false;
  await page.route("**/core/koinos/rpc", route => route.request().postDataJSON().channel === "wallet:summary"
    ? route.fulfill({ status: offline ? 400 : 200, json: { ok: !offline, data: wallet, error: offline ? "RPC unavailable" : undefined } }) : route.continue());
  await page.route("**/core/earn", route => route.fulfill({ json: { wallet: { exists: true, unlocked: true, address: wallet.address }, worker: { running: false } } }));
  await page.goto(`http://127.0.0.1:${await core.start()}`);
  const buy = () => page.locator('.product-sidebar-credits [data-product-view="buy-credits"]').click();
  await buy();
  await page.waitForFunction(() => document.getElementById("product-wallet-balance").textContent === "1,234.56789012 KOIN");
  assert.match(await page.locator("#product-wallet-address").textContent(), /payment-wallet-a.*Mainnet/);
  assert.equal(await page.locator("#product-purchase-title").textContent(), "Credit purchases are not activated yet");
  assert.equal(await page.locator("#product-quote-refresh").isDisabled(), true);
  assert.equal(await page.locator("#product-quote-refresh").textContent(), "Purchases not activated");
  assert.equal(await page.locator("#product-quote-koin").textContent(), "Quote required");
  assert.doesNotMatch(await page.locator("#view-buy-credits").textContent(), /9999/);
  assert.equal(await page.locator(".product-sidebar-credits [data-credit-total]").textContent(), "—");
  await page.locator('[data-credit-pack="1"]').click();
  assert.equal(await page.locator("#product-pack-credits").textContent(), "1,000");
  assert.equal(await page.evaluate(() => window.purchaseCalls.some(c => c.action === "purchase-preview")), false);
  if (process.env.KAI_PRODUCT_QA_DIR) {
    fs.mkdirSync(process.env.KAI_PRODUCT_QA_DIR, { recursive: true });
    await page.locator("#view-buy-credits").evaluate(n => { n.scrollTop = 0; });
    await page.screenshot({ animations: "disabled", path: path.join(process.env.KAI_PRODUCT_QA_DIR, "buy-wallet-unavailable.png") });
  }
  await page.locator('#view-buy-credits [data-product-action="payment-wallet"]').click();
  await page.locator("#wallet-address").waitFor({ state: "visible" });
  assert.equal(await page.inputValue("#wallet-address"), "payment-wallet-a");
  assert.equal(await page.locator("#wallet-address").evaluate(n => document.activeElement === n), true);
  await buy();
  offline = true; await page.locator("#product-wallet-refresh").click();
  await page.waitForFunction(() => document.getElementById("product-wallet-balance").textContent === "Balance unavailable");
  assert.equal(await page.locator("#product-wallet-address").textContent(), "Wallet address unconfirmed");
  assert.match(await page.locator("#product-wallet-note").textContent(), /RPC unavailable/);
  offline = false; wallet = { ...wallet, koin: "0" }; await page.locator("#product-wallet-refresh").click();
  await page.waitForFunction(() => document.getElementById("product-wallet-balance").textContent === "0 KOIN");
  await page.evaluate(() => { window.purchaseState = "signin-required"; }); await page.locator("#product-purchase-check").click();
  await page.waitForFunction(() => document.getElementById("product-purchase-title").textContent.includes("account needs attention"));
  assert.equal(await page.locator("#product-purchase-detail").textContent(), "Choose an online route to use network credits");
  assert.equal(await page.locator("#product-purchase-signin").isVisible(), true);
  await page.evaluate(() => { window.purchaseState = "ready"; }); await page.locator("#product-purchase-check").click();
  await page.waitForFunction(() => !document.getElementById("product-quote-refresh").disabled);
  await page.locator("#product-quote-refresh").click();
  await page.locator("#product-quote-approve").waitFor({ state: "visible" });
  assert.equal(await page.locator("#product-quote-approve").isDisabled(), true);
  assert.equal(await page.locator("#product-quote-approve").textContent(), "Not enough KOIN");
  assert.equal(await page.locator("#product-quote-details").evaluate(n => n.open), false);
  await page.locator("#product-quote-details summary").click();
  assert.equal(await page.locator("#product-quote-rate").textContent(), "1 KOIN = $0.5");
  assert.match(await page.locator("#product-quote-reference").textContent(), /vKOIN\/USDT exchange reference/);
  assert.match(await page.locator("#product-quote-window").textContent(), /30 minutes/);
  await page.locator("#product-quote-details summary").click();
  assert.equal(await page.locator("#product-quote-details").evaluate(n => n.open), false);
  wallet = { ...wallet, koin: "10" }; await page.locator("#product-wallet-refresh").click();
  await page.waitForFunction(() => !document.getElementById("product-quote-approve").disabled);
  // Changing the loaded wallet during the final read must stop approval.
  wallet = { ...wallet, address: "payment-wallet-b" };
  await page.locator("#product-quote-approve").click();
  await page.waitForFunction(() => document.getElementById("product-quote-approve").hidden);
  assert.equal(await page.evaluate(() => window.purchaseCalls.filter(c => c.action === "purchase-approve").length), 0);
  assert.match(await page.locator("#product-wallet-address").textContent(), /payment-wallet-b/);
  assert.equal(await page.locator("#product-quote-details").isVisible(), false);
  // A payment-stage failure remains visible across read-only refreshes and
  // never triggers another quote, native review or send by itself.
  const failure = require("../../electron/koin-funding-failure").purchaseFailureMessage({ stage: "prepare", code: "rpc-unavailable" });
  await page.evaluate(value => { window.purchaseFailure = value; }, failure);
  await page.locator("#product-quote-refresh").click();
  await page.waitForFunction(() => !document.getElementById("product-quote-approve").disabled);
  await page.locator("#product-quote-approve").click();
  await page.waitForFunction(value => document.getElementById("product-quote-state").textContent === value, failure);
  assert.equal(await page.locator("#product-quote-approve").isVisible(), false);
  assert.equal(await page.locator("#product-quote-refresh").isDisabled(), false);
  const quoteCount = await page.evaluate(() => window.purchaseCalls.filter(c => c.action === "purchase-preview").length);
  await page.locator("#product-purchase-check").click();
  await page.waitForFunction(() => !document.getElementById("product-purchase-check").disabled);
  assert.equal(await page.locator("#product-quote-state").textContent(), failure);
  assert.equal(await page.evaluate(() => window.purchaseCalls.filter(c => c.action === "purchase-approve").length), 1);
  assert.equal(await page.evaluate(() => window.purchaseCalls.filter(c => c.action === "purchase-preview").length), quoteCount);
  await page.evaluate(() => { window.localPurchase = { state: "pending", txId: "0x1220" + "a".repeat(64), issue: "funding_simulation_failed", recovery: "retry", detail: "The last payment attempt stopped during its pre-submission check. The saved payment needs review." }; });
  await page.locator("#product-purchase-check").click();
  await page.waitForFunction(() => document.getElementById("product-quote-refresh").disabled);
  assert.match(await page.locator("#product-quote-state").textContent(), /pre-submission check/);
  assert.doesNotMatch(await page.locator("#product-quote-state").textContent(), /fresh quote/);
  assert.match(await page.locator("#product-local-payment").textContent(), /Transaction: 0x1220a{64}/);
  assert.match(await page.locator("#product-local-payment").textContent(), /Reference: funding_simulation_failed/);
  assert.equal(await page.locator("#product-quote-refresh").textContent(), "Saved payment needs attention");
  assert.equal(await page.locator("#product-local-payment").evaluate(n => n.scrollWidth <= n.clientWidth), true);
  if (process.env.KAI_PRODUCT_QA_DIR) await page.screenshot({ path: path.join(process.env.KAI_PRODUCT_QA_DIR, "buy-saved-payment.png"), animations: "disabled" });
  assert.equal(await page.evaluate(() => window.purchaseCalls.filter(c => c.action === "purchase-preview").length), quoteCount);
  assert.equal(await page.locator("#product-purchase-recover").textContent(), "Review saved payment");
  assert.equal(await page.evaluate(() => window.purchaseCalls.filter(c => c.action === "credit-purchase-retry").length), 0);
  await page.evaluate(() => { window.localPurchase.recovery = "cancel-expired"; window.localPurchase.quoteExpired = true; window.localPurchase.detail = "This payment quote expired. Cancel it before making another purchase."; window.pauseRecovery = true; });
  await page.locator("#product-purchase-check").click();
  await page.waitForFunction(() => document.getElementById("product-purchase-recover").textContent === "Cancel expired payment");
  assert.equal(await page.locator("#product-purchase-recover").isDisabled(), false);
  if (process.env.KAI_PRODUCT_QA_DIR) await page.screenshot({ path: path.join(process.env.KAI_PRODUCT_QA_DIR, "buy-expired-recovery.png"), animations: "disabled" });
  await page.locator("#product-purchase-recover").click();
  await page.waitForFunction(() => !!window.finishRecovery);
  assert.equal(await page.locator("#product-purchase-recover").isDisabled(), true);
  assert.equal(await page.locator("#product-quote-refresh").isDisabled(), true);
  await page.evaluate(() => window.finishRecovery());
  await page.waitForFunction(() => document.getElementById("product-purchase-recover").textContent === "Resume cancellation");
  assert.match(await page.locator("#product-local-payment").textContent(), /Cancellation: 0x1220b{64}/);
  assert.equal(await page.evaluate(() => window.purchaseCalls.filter(c => c.action === "credit-purchase-retry").length), 1);
  assert.equal(await page.evaluate(() => window.purchaseCalls.filter(c => c.action === "purchase-preview").length), quoteCount);
  await page.evaluate(() => { window.localPurchase = null; window.cancelledPurchases = [{ txId: "0x1220" + "a".repeat(64) }]; }); await page.locator("#product-purchase-check").click();
  await page.waitForFunction(() => !document.getElementById("product-quote-refresh").disabled);
  await page.evaluate(() => window.KaiCredits.accept({ product: "prepaid-usd-v1", owner: "payment-wallet-b",
    credits: { available: "0", purchased: { available: "0" }, free: { available: "0", state: "available" }, version: "1", unit: "USD-1e-8" },
    purchases: [{ id: "0x1220" + "a".repeat(64), state: "pending", createdAt: Date.now() }], usage: [] }));
  assert.match(await page.locator("#product-credit-history").textContent(), /Cancelled · no purchase/);
  assert.equal(await page.locator("#product-pending-purchases").textContent(), "");
  assert.equal(await page.locator(".product-sidebar-credits [data-credit-total]").textContent(), "0");
  // Also discard a quote which arrives after account identity changed.
  await page.evaluate(() => { window.pausePurchaseQuote = true; }); await page.locator("#product-quote-refresh").click();
  await page.waitForFunction(() => !!window.finishPurchaseQuote);
  await page.evaluate(() => { window.dispatchEvent(new Event("kai-credit-identity-changed")); window.finishPurchaseQuote(); });
  await page.waitForFunction(() => !document.getElementById("product-quote-refresh").disabled);
  assert.equal(await page.locator("#product-quote-approve").isVisible(), false);
  wallet = { ...wallet, network: "harbinger", tokenSymbol: "tKOIN" }; await page.locator("#product-wallet-refresh").click();
  await page.waitForFunction(() => document.getElementById("product-wallet-balance").textContent === "10 tKOIN");
  assert.equal(await page.locator("#product-quote-refresh").isDisabled(), true);
  assert.match(await page.locator("#product-wallet-note").textContent(), /Mainnet/);
  wallet = { ...wallet, address: null, koin: null }; await page.locator("#product-wallet-refresh").click();
  await page.waitForFunction(() => document.getElementById("product-wallet-balance").textContent === "No wallet set up");
  assert.equal(await page.locator("#product-quote-refresh").isDisabled(), true);
  const checksBeforeHide = await page.evaluate(() => window.purchaseCalls.filter(c => c.action === "purchase-info").length);
  await page.locator('#nav [data-view="chat"]').click();
  await page.evaluate(async () => { for (const tick of window.thirtySecondTicks) tick(); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.equal(await page.evaluate(() => window.purchaseCalls.filter(c => c.action === "purchase-info").length), checksBeforeHide, "the purchase page does not poll when hidden");
  await buy();
  await page.waitForFunction(before => window.purchaseCalls.filter(c => c.action === "purchase-info").length > before, checksBeforeHide);
  const checksBeforeResume = await page.evaluate(() => window.purchaseCalls.filter(c => c.action === "purchase-info").length);
  await page.waitForFunction(() => !document.getElementById("product-purchase-check").disabled);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForFunction(before => window.purchaseCalls.filter(c => c.action === "purchase-info").length > before, checksBeforeResume);
  await page.setViewportSize({ width: 780, height: 560 });
  assert.equal(await page.locator("#view-buy-credits").evaluate(n => n.scrollWidth <= n.clientWidth), true);
  if (process.env.KAI_PRODUCT_QA_DIR) {
    await page.locator("#view-buy-credits").evaluate(n => { n.scrollTop = 0; });
    await page.screenshot({ animations: "disabled", path: path.join(process.env.KAI_PRODUCT_QA_DIR, "buy-wallet-narrow.png") });
  }
  assert.deepEqual(errors, []);
});
