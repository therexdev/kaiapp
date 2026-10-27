"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium", options = { skip: !fs.existsSync(CHROMIUM), timeout: 90000 };
async function freezeClock(page) {
  // pauseAt installs and pauses together; a prior install() lets real time
  // overtake the separately sampled pause target under CI load.
  const frozenAt = new Date();
  await page.clock.pauseAt(frozenAt);
  assert.equal(await page.evaluate(() => Date.now()), frozenAt.getTime());
}
async function fixture(t, fakeClock = false, previewSupported = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-buy-wallet-"));
  const core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  const browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  t.after(async () => { await browser.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(previewSupported => {
    localStorage.setItem("kai-interface-language", "en");
    window.purchaseState = "ready"; window.purchaseCalls = []; window.previewSupported = previewSupported;
    window.kaiKoinTestBridge = { onProgress: () => () => {}, run: async (action, input) => {
      window.purchaseCalls.push({ action, input });
      if (action === "purchase-capabilities") { if (window.holdCapabilities) await new Promise(resolve => { window.finishCapabilities = resolve; }); return window.previewSupported ? { purchasePricePreview: true } : {}; }
      if (action === "purchase-info") {
        const saved = { activation: window.purchaseState, localPurchase: structuredClone(window.localPurchase || null), cancelledPurchases: window.cancelledPurchases || [], blocked: window.purchaseState === "signin-required" ? "Sign in to your credit account" : "The credit service is not activated yet" };
        if (window.holdInfo) await new Promise(resolve => { window.finishInfo = resolve; });
        return saved;
      }
      if (action === "chat-info") return { configured: true, enabled: true, product: "prepaid-v1", model: "fixture", maxOutput: 32, blocked: "" };
      if (action === "status") return { enabled: true, configured: false, mode: "test-deployment" };
      if (action === "credit-status") throw Error("Credit service fixture");
      if (action === "provider-public-info") return { state: "unavailable", detail: "Fixture" };
      if (["purchase-preview", "purchase-estimate"].includes(action)) {
        if (window.holdQuote && action === "purchase-preview") await new Promise(resolve => { window.finishQuote = resolve; });
        if (window.holdEstimate && action === "purchase-estimate") await new Promise(resolve => { window.finishEstimate = resolve; });
        if (window.quoteFailure) throw Error(window.quoteFailure);
        return { [action === "purchase-estimate" ? "estimate" : "quote"]: { ...(action === "purchase-preview" ? { id: "fixture-quote" } : {}), koin: String(Number(input.usd) * (window.quoteMultiplier || 2)), credits: String(Number(input.usd) * 1000), observedAt: Date.now() - 17 * 60000, expiresAt: Date.now() + (window.quoteLifetime || 60000), priceDetails: { usdPerKoin: "0.5", windowSeconds: 1800, referenceKind: "merchant-exchange-reference" } } };
      }
      if (action === "credit-purchase-retry") {
        if (window.holdRecovery) await new Promise(resolve => { window.finishRecovery = resolve; });
        window.localPurchase = { ...window.localPurchase, recovery: "resume-cancellation", cancellation: { txId: "0x1220" + "b".repeat(64) }, detail: "Cancellation saved; waiting for confirmation." };
        return { state: "pending" };
      }
      if (action === "purchase-approve") {
        if (window.holdApproval) await new Promise(resolve => { window.finishApproval = resolve; });
        if (window.purchaseFailure) throw Error(window.purchaseFailure);
        return { state: "cancelled" };
      }
      if (action === "purchase-stop") { if (window.holdStop) await new Promise(resolve => { window.finishStop = resolve; }); if (window.localPurchase) { window.localPurchase.busy = false; window.localPurchase.state = "pending"; } return { state: "stopped" }; }
      throw Error("Unexpected fixture action: " + action);
    } };
  }, previewSupported);
  let wallet = { address: "payment-wallet-a", network: "mainnet", tokenSymbol: "KOIN", koin: "1234.56789012", usd: 9999 }, offline = false;
  let pauseWallet = false, walletStarted, releaseWallet;
  await page.route("**/core/koinos/rpc", async route => {
    if (route.request().postDataJSON().channel !== "wallet:summary") return route.continue();
    const response = { status: offline ? 400 : 200, json: { ok: !offline, data: structuredClone(wallet), error: offline ? "RPC unavailable" : undefined } };
    if (pauseWallet) await new Promise(resolve => { releaseWallet = resolve; walletStarted?.(); });
    await route.fulfill(response);
  });
  await page.route("**/core/earn", route => route.fulfill({ json: { wallet: { exists: true, unlocked: true, address: wallet.address }, worker: { running: false } } }));
  if (fakeClock) await freezeClock(page);
  await page.goto(`http://127.0.0.1:${await core.start()}`);
  await page.locator('.product-sidebar-credits [data-product-view="buy-credits"]').click();
  const buy = page.locator("#product-quote-refresh"), status = page.locator("#product-quote-state");
  await page.waitForFunction(() => !document.getElementById("product-quote-refresh").disabled);
  if (previewSupported) await page.waitForFunction(() => document.getElementById("product-quote-koin").textContent === "2 KOIN");
  else await page.waitForFunction(() => document.getElementById("product-price-preview-support").textContent.includes("network service update"));
  return { page, buy, status, setWallet: value => { wallet = { ...wallet, ...value }; }, setOffline: value => { offline = value; },
    holdWallet: () => { pauseWallet = true; return new Promise(resolve => { walletStarted = resolve; }); },
    finishWallet: () => { pauseWallet = false; releaseWallet?.(); },
    count: action => page.evaluate(name => window.purchaseCalls.filter(c => c.action === name).length, action),
    refresh: async () => { await page.locator("#product-purchase-check").click(); await page.waitForFunction(() => !document.getElementById("product-purchase-check").disabled); } };
}

test("Buy credits uses one action for fresh pricing and wallet review, while guarding balance and changed identities", options, async t => {
  const { page, buy, status, setWallet, setOffline, count, refresh } = await fixture(t);
  assert.equal(await buy.textContent(), "Buy credits");
  assert.equal(await page.locator("#product-quote-approve").count(), 0);
  assert.equal(await page.locator("#product-wallet-balance").textContent(), "1,234.56789012 KOIN");
  assert.doesNotMatch(await page.locator("#view-buy-credits").textContent(), /9999/);
  await page.evaluate(() => { window.purchaseState = "unavailable"; }); await refresh();
  assert.equal(await buy.isDisabled(), true); assert.equal(await count("purchase-preview"), 0);
  await page.evaluate(() => { window.purchaseState = "signin-required"; }); await refresh();
  assert.equal(await page.locator("#product-purchase-signin").isVisible(), true);
  await page.evaluate(() => { window.purchaseState = "ready"; }); setWallet({ koin: "0" }); await refresh();
  await buy.click(); await page.waitForFunction(() => document.getElementById("product-quote-state").textContent.includes("Not enough KOIN"));
  assert.equal(await count("purchase-approve"), 0); assert.equal(await buy.isEnabled(), true);
  await page.locator("#product-quote-details summary").click();
  assert.equal(await page.locator("#product-quote-rate").textContent(), "1 KOIN = $0.5");
  assert.match(await page.locator("#product-quote-window").textContent(), /30 minutes/);
  setWallet({ koin: "10" }); await refresh();
  await page.evaluate(() => { window.holdQuote = true; }); await buy.click(); await page.waitForFunction(() => !!window.finishQuote);
  setWallet({ address: "payment-wallet-b" }); await page.evaluate(() => { window.holdQuote = false; window.finishQuote(); });
  await page.waitForFunction(() => !document.getElementById("product-quote-refresh").disabled);
  assert.equal(await count("purchase-approve"), 0, "changed wallet prevents the review");
  const failure = require("../../electron/koin-funding-failure").purchaseFailureMessage({ stage: "prepare", code: "rpc-unavailable" });
  await page.evaluate(value => { window.purchaseFailure = value; }, failure);
  await buy.click(); await page.waitForFunction(value => document.getElementById("product-quote-state").textContent === value, failure);
  assert.equal(await count("purchase-approve"), 1); const quotes = await count("purchase-estimate");
  await refresh(); await page.waitForFunction(() => document.getElementById("product-quote-state").textContent.includes("Price updates")); assert.equal(await count("purchase-estimate"), quotes + 1);
  await page.evaluate(() => { window.purchaseFailure = null; window.holdApproval = true; });
  await page.evaluate(() => { const b = document.getElementById("product-quote-refresh"); b.click(); b.click(); });
  await page.waitForFunction(() => !!window.finishApproval);
  assert.equal(await count("purchase-approve"), 2, "one click reaches wallet review once; duplicate clicks do not send again");
  assert.equal(await page.locator("#product-purchase-stop").isVisible(), true);
  await page.evaluate(() => window.finishApproval());
  await page.waitForFunction(() => document.getElementById("product-quote-state").textContent.includes("Payment cancelled"));
  await page.evaluate(() => { window.holdQuote = true; window.finishQuote = null; }); await buy.click(); await page.waitForFunction(() => !!window.finishQuote);
  await page.evaluate(() => { window.holdQuote = false; window.dispatchEvent(new Event("kai-credit-identity-changed")); window.finishQuote(); });
  await page.waitForFunction(() => !document.getElementById("product-quote-refresh").disabled);
  assert.equal(await count("purchase-approve"), 2, "late quote from old account cannot open review");
  await page.evaluate(() => { window.holdQuote = true; window.finishQuote = null; window.holdStop = true; }); await buy.click(); await page.waitForFunction(() => !!window.finishQuote);
  await page.locator("#product-purchase-stop").click(); await page.waitForFunction(() => !!window.finishStop);
  await page.evaluate(() => window.finishQuote());
  assert.equal(await count("purchase-approve"), 2, "Stop fences a late quote immediately, before its IPC acknowledgement");
  await page.evaluate(() => { window.holdStop = false; window.finishStop(); }); await page.waitForFunction(() => !document.getElementById("product-quote-refresh").disabled);
  setOffline(true); await refresh(); assert.equal(await buy.isDisabled(), true);
  setOffline(false); setWallet({ network: "harbinger", tokenSymbol: "tKOIN" }); await refresh();
  assert.equal(await buy.isDisabled(), true); assert.match(await page.locator("#product-wallet-note").textContent(), /Mainnet/);
  setWallet({ network: "mainnet", tokenSymbol: "KOIN", koin: "10" }); await refresh();
  await page.setViewportSize({ width: 780, height: 560 });
  assert.equal(await page.locator("#view-buy-credits").evaluate(n => n.scrollWidth <= n.clientWidth), true);
  await page.locator('[data-credit-pack="1"]').click();
  await page.locator("#view-buy-credits").evaluate(n => { n.scrollTop = 0; });
  const bounds = await buy.boundingBox(); assert.ok(bounds && bounds.y + bounds.height <= 560, "primary purchase action is visible at the minimum desktop height");
  if (process.env.KAI_PRODUCT_QA_DIR) { fs.mkdirSync(process.env.KAI_PRODUCT_QA_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.KAI_PRODUCT_QA_DIR, "buy-single-action.png"), animations: "disabled" }); }
});

test("saved payment stays actionable during checks, stops a real review and confirms automatically without another purchase", options, async t => {
  const { page, buy, count, refresh } = await fixture(t);
  const previews = await count("purchase-preview");
  const txId = "0x1220" + "a".repeat(64);
  await page.evaluate(txId => { window.localPurchase = { state: "pending", txId, issue: "funding_simulation_failed", recovery: "cancel-expired", detail: "This payment quote expired. Continue to finish its cancellation." }; }, txId);
  await refresh(); assert.equal(await buy.textContent(), "Continue payment"); assert.equal(await buy.isEnabled(), true);
  assert.match(await page.locator("#product-local-payment").textContent(), /Transaction: 0x1220a{64}/);
  await page.evaluate(() => { window.localPurchase.busy = true; }); await refresh();
  assert.equal(await buy.isDisabled(), true); assert.equal(await page.locator("#product-purchase-stop").isEnabled(), true);
  await page.locator("#product-purchase-stop").click(); await page.waitForFunction(() => !document.getElementById("product-quote-refresh").disabled);
  assert.equal(await count("purchase-stop"), 1); assert.equal(await count("purchase-preview"), previews);
  await page.evaluate(() => { window.holdRecovery = true; }); await buy.click(); await page.waitForFunction(() => !!window.finishRecovery);
  assert.equal(await buy.isDisabled(), true);
  await page.evaluate(() => { window.holdRecovery = false; window.finishRecovery(); });
  await page.waitForFunction(() => !document.getElementById("product-quote-refresh").disabled);
  assert.equal(await buy.textContent(), "Continue payment"); assert.match(await page.locator("#product-local-payment").textContent(), /Cancellation: 0x1220b{64}/);
  assert.equal(await count("credit-purchase-retry"), 1); assert.equal(await count("purchase-preview"), previews);
  await freezeClock(page);
  await page.evaluate(() => { window.localPurchase = null; window.cancelledPurchases = [{ txId: "0x1220" + "a".repeat(64) }]; });
  await page.clock.runFor(5001); await page.waitForFunction(() => document.getElementById("product-quote-refresh").textContent === "Buy credits");
  await page.evaluate(() => window.KaiCredits.accept({ product: "prepaid-usd-v1", owner: "payment-wallet-a", credits: { available: "0", purchased: { available: "0" }, free: { available: "0", state: "available" }, version: "1", unit: "USD-1e-8" }, purchases: [{ id: "0x1220" + "a".repeat(64), state: "pending", createdAt: Date.now() }], usage: [] }));
  assert.match(await page.locator("#product-credit-history").textContent(), /Cancelled · no purchase/);
  assert.equal(await count("purchase-approve"), 0, "confirmation does not silently start a new purchase");
  const checks = await count("purchase-info"); await page.locator('#nav [data-view="chat"]').click(); await page.clock.runFor(30001);
  assert.equal(await count("purchase-info"), checks, "purchase polling stops while hidden");
});

test("lost payment-status reply times out and permits a fresh read without accepting the late reply", options, async t => {
  const { page, buy } = await fixture(t);
  await freezeClock(page);
  await page.evaluate(() => { window.holdInfo = true; }); await page.locator("#product-purchase-check").click();
  await page.waitForFunction(() => !!window.finishInfo); await page.clock.runFor(12001);
  await page.waitForFunction(() => !document.getElementById("product-purchase-check").disabled);
  assert.match(await page.locator("#product-purchase-detail").textContent(), /could not be reached/);
  await page.evaluate(() => { window.lateInfo = window.finishInfo; window.holdInfo = false; });
  assert.equal(await buy.textContent(), "Try again"); await buy.click(); await page.waitForFunction(() => document.getElementById("product-quote-refresh").textContent === "Buy credits");
  await page.evaluate(() => window.lateInfo()); assert.equal(await buy.textContent(), "Buy credits");
});

test("shared purchase refresh stays busy until the wallet read finishes, then reads a changed wallet afresh", options, async t => {
  const { page, buy, setWallet, setOffline, holdWallet, finishWallet, refresh } = await fixture(t);
  const check = page.locator("#product-purchase-check");
  setOffline(true);
  const started = holdWallet();
  await check.click(); await started;
  assert.equal(await check.isDisabled(), true, "the completed account read must not enable Check again while the wallet read is still pending");
  setOffline(false); setWallet({ network: "harbinger", tokenSymbol: "tKOIN" });
  finishWallet();
  await page.waitForFunction(() => !document.getElementById("product-purchase-check").disabled);
  assert.match(await page.locator("#product-wallet-note").textContent(), /RPC unavailable/);
  await refresh();
  assert.match(await page.locator("#product-wallet-note").textContent(), /Mainnet/);
  assert.match(await page.locator("#product-wallet-balance").textContent(), /tKOIN/);
  assert.equal(await buy.isDisabled(), true, "the new network is checked before purchases become available");
});


test("KOIN preview follows amount changes and refreshes periodically only on the visible purchase page without approving a payment", options, async t => {
  const { page, buy, count } = await fixture(t, true);
  assert.equal(await count("purchase-approve"), 0);
  assert.equal(await page.locator("#product-quote-koin").textContent(), "2 KOIN");
  const initial = await count("purchase-estimate");
  await page.fill("#product-usd-amount", "5"); await page.clock.runFor(200);
  await page.fill("#product-usd-amount", "10"); await page.clock.runFor(351);
  await page.waitForFunction(() => document.getElementById("product-quote-koin").textContent === "20 KOIN");
  assert.equal(await count("purchase-estimate"), initial + 1, "typing is debounced to the final amount");
  assert.equal(await count("purchase-approve"), 0);
  await page.evaluate(() => { window.quoteMultiplier = 3; });
  await page.clock.runFor(30001);
  await page.waitForFunction(() => document.getElementById("product-quote-koin").textContent === "30 KOIN");
  const refreshed = await count("purchase-estimate");
  await page.locator('#nav [data-view="chat"]').click(); await page.clock.runFor(60001);
  assert.equal(await count("purchase-estimate"), refreshed, "leaving Buy credits stops price polling");
  await page.locator('.product-sidebar-credits [data-product-view="buy-credits"]').click(); await page.clock.runFor(1);
  await page.waitForFunction(() => document.getElementById("product-quote-koin").textContent === "30 KOIN");
  assert.equal(await count("purchase-approve"), 0);
  await page.fill("#product-usd-amount", "invalid"); await page.clock.runFor(1000);
  assert.equal(await page.locator("#product-quote-koin").textContent(), "—");
  assert.equal(await count("purchase-estimate"), refreshed + 1);
});

test("late previews, expiry and quote errors never show a stale amount or prevent a deliberate Buy click", options, async t => {
  const { page, buy, count } = await fixture(t, true);
  await page.evaluate(() => { window.holdEstimate = true; });
  await page.fill("#product-usd-amount", "5"); await page.clock.runFor(351);
  await page.waitForFunction(() => !!window.finishEstimate);
  assert.equal(await buy.isEnabled(), true, "read-only price preview never locks the purchase button");
  await page.fill("#product-usd-amount", "10"); await page.clock.runFor(351);
  await page.evaluate(() => { window.holdEstimate = false; window.finishEstimate(); }); await page.clock.runFor(1);
  await page.waitForFunction(() => document.getElementById("product-quote-koin").textContent === "20 KOIN");
  assert.equal(await count("purchase-approve"), 0);
  await page.evaluate(() => { window.quoteLifetime = 1000; });
  await page.fill("#product-usd-amount", "1"); await page.clock.runFor(351);
  await page.waitForFunction(() => document.getElementById("product-quote-koin").textContent === "2 KOIN");
  await page.evaluate(() => { window.quoteFailure = "Price service unavailable"; }); await page.clock.runFor(2001);
  await page.waitForFunction(() => document.getElementById("product-quote-koin").textContent === "Price unavailable");
  assert.equal(await buy.isEnabled(), true);
  await page.evaluate(() => { window.quoteFailure = null; window.quoteLifetime = 60000; });
  await buy.click(); await page.waitForFunction(() => window.purchaseCalls.some(c => c.action === "purchase-approve"));
  assert.equal(await count("purchase-approve"), 1, "Buy retries the price and opens exactly one native review");
});

test("Buy does not wait for a background price read and a late estimate cannot replace payment or hidden-page state", options, async t => {
  const { page, buy, count } = await fixture(t, true);
  await page.evaluate(() => { window.holdEstimate = true; });
  await page.fill("#product-usd-amount", "5"); await page.clock.runFor(351);
  await page.waitForFunction(() => !!window.finishEstimate);
  await buy.click();
  await page.waitForFunction(() => document.getElementById("product-quote-state").textContent.includes("Payment cancelled"));
  assert.equal(await count("purchase-preview"), 1, "only Buy requests a signed purchase quote");
  assert.equal(await count("purchase-approve"), 1, "a stalled estimate cannot block or duplicate approval");
  await page.evaluate(() => { window.holdEstimate = false; window.finishEstimate(); });
  assert.match(await page.locator("#product-quote-state").textContent(), /Payment cancelled/);
  await page.evaluate(() => { window.holdEstimate = true; window.finishEstimate = null; });
  await page.fill("#product-usd-amount", "10"); await page.clock.runFor(351);
  await page.waitForFunction(() => !!window.finishEstimate);
  await page.locator('#nav [data-view="chat"]').click();
  await page.evaluate(() => { window.holdEstimate = false; window.finishEstimate(); });
  assert.equal(await page.locator("#product-quote-koin").textContent(), "Calculating…", "late hidden-page price is discarded");
  await page.locator('.product-sidebar-credits [data-product-view="buy-credits"]').click();
  await page.waitForFunction(() => document.getElementById("product-quote-koin").textContent === "20 KOIN");
  assert.equal(await count("purchase-preview"), 1); assert.equal(await count("purchase-approve"), 1);
});


test("older servers keep Buy working without automatic signed quotes or repeated unsupported price requests", options, async t => {
  const { page, buy, count } = await fixture(t, true, false);
  assert.match(await page.locator("#product-price-preview-support").textContent(), /Automatic price previews will be available after the network service update/);
  assert.equal(await buy.isEnabled(), true);
  await page.fill("#product-usd-amount", "5"); await page.clock.runFor(60001);
  assert.equal(await count("purchase-estimate"), 0);
  assert.equal(await count("purchase-preview"), 0);
  assert.equal(await count("purchase-approve"), 0);
  await buy.click(); await page.waitForFunction(() => window.purchaseCalls.some(c => c.action === "purchase-approve"));
  assert.equal(await count("purchase-preview"), 1); assert.equal(await count("purchase-approve"), 1);
  await page.waitForFunction(() => document.getElementById("product-quote-state").textContent.includes("Payment cancelled"));
  await page.evaluate(() => { window.holdCapabilities = true; });
  await page.locator("#product-purchase-check").click(); await page.waitForFunction(() => !!window.finishCapabilities);
  await page.waitForFunction(() => !document.getElementById("product-quote-refresh").disabled);
  await buy.click(); await page.waitForFunction(() => window.purchaseCalls.filter(c => c.action === "purchase-approve").length === 2);
  assert.equal(await count("purchase-estimate"), 0, "capability outage cannot trigger signed preview fallback or hold Buy");
  await page.evaluate(() => { window.holdCapabilities = false; window.finishCapabilities(); });
});
