"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { navClick } = require("./ui-nav");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";

test("Earn review preview is desktop-only, disables repeat clicks and explains every outcome", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-review-ui-"));
  const core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  const base = `http://127.0.0.1:${await core.start()}`;
  let browser;
  t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage();
  await page.addInitScript(() => { localStorage.setItem("kai-interface-language", "en"); });
  await page.goto(base);
  await navClick(page, '.nav-item[data-view="earn"]');
  assert.equal(await page.locator("#koin-review-preview").isVisible(), false);
  assert.equal(await page.locator("#koin-session-rehearsal").isVisible(), false);
  await page.addInitScript(() => {
    window.previewCalls = 0;
    window.kaiKoinReviewBridge = { preview() {
      window.previewCalls++;
      return new Promise((resolve, reject) => { window.finishPreview = resolve; window.failPreview = reject; });
    } };
  });
  await page.reload();
  await navClick(page, '.nav-item[data-view="earn"]');
  const button = page.locator("#btn-koin-review-preview"), status = page.locator("#koin-review-status");
  assert.equal(await button.isVisible(), true);
  for (const [result, message] of [
    [{ status: "reviewed", mode: "shadow", paymentsEnabled: false }, "Example reviewed. No request was signed or sent."],
    [{ status: "cancelled", mode: "shadow", paymentsEnabled: false }, "Preview cancelled. No KOIN was spent."],
    [{ status: "reviewed", mode: "funded", paymentsEnabled: true }, "Preview unavailable. Please try again."],
    [null, "Preview unavailable. Please try again."],
  ]) {
    await button.click();
    assert.equal(await button.isDisabled(), true);
    const calls = await page.evaluate(() => window.previewCalls);
    await page.evaluate(() => document.getElementById("btn-koin-review-preview").click());
    assert.equal(await page.evaluate(() => window.previewCalls), calls);
    await page.evaluate(result => result ? window.finishPreview(result) : window.failPreview(Error("broken bridge")), result);
    await page.waitForFunction(message => document.getElementById("koin-review-status").textContent === message, message);
    assert.equal(await status.textContent(), message);
    assert.equal(await button.isDisabled(), false);
  }
  assert.equal(await page.locator("#btn-koin-purchase").isDisabled(), true);
  assert.equal(await page.locator("#btn-koin-claim").count(), 0);
  assert.equal(await page.locator("#koin-test-payments").isVisible(), false);
  await page.addInitScript(() => {
    window.sessionCalls = [];
    const base = { enabled: true, mode: "funded-rehearsal", paymentsEnabled: false };
    window.kaiKoinSessionBridge = {
      status: async () => ({ ...base, state: "unapproved" }),
      review: () => { window.sessionCalls.push("review"); return new Promise(r => { window.finishSession = r; }); },
      retry: async () => ({ ...base, state: "active" }), revoke: async () => ({ ...base, state: "revoked" }),
    };
  });
  await page.reload(); await navClick(page, '.nav-item[data-view="earn"]');
  const sessionButton = page.locator("#btn-koin-session-review");
  assert.equal(await sessionButton.isVisible(), true); await sessionButton.click();
  assert.equal(await sessionButton.isDisabled(), true);
  await page.evaluate(() => document.getElementById("btn-koin-session-review").click());
  assert.equal(await page.evaluate(() => window.sessionCalls.length), 1);
  await page.evaluate(() => window.finishSession({ enabled: true, mode: "funded-rehearsal", paymentsEnabled: false, state: "uncertain", error: "<img src=x onerror=alert(1)>" }));
  await page.waitForFunction(() => document.getElementById("koin-session-status").textContent.includes("uncertain"));
  assert.equal(await page.locator("#koin-session-status img").count(), 0);
  await page.locator("#btn-koin-session-retry").click();
  await page.waitForFunction(() => document.getElementById("koin-session-status").textContent.includes("Paid chat remains disabled"));
  await page.locator("#btn-koin-session-revoke").click();
  await page.waitForFunction(() => document.getElementById("koin-session-status").textContent.includes("revoked"));
  assert.equal(await page.locator("#btn-koin-purchase").isDisabled(), true);
  await page.addInitScript(() => {
    window.testPaymentCalls = [];
    window.kaiKoinTestBridge = { run: async (action, input) => {
      window.testPaymentCalls.push({ action, input });
      if (action === "status") return { enabled: true, mode: "test-deployment", configured: false };
      if (action === "stop") return { state: "stopped" };
      if (action === "chat-status") return { state: "request_cancelled", amount: "0" };
      return new Promise(r => { window.finishTestPayment = r; });
    } };
  });
  await page.reload(); await navClick(page, '.nav-item[data-view="earn"]');
  assert.equal(await page.locator("#koin-test-payments").isVisible(), true);
  assert.equal(await page.locator("#koin-network-badge").textContent(), "Not connected");
  assert.equal(await page.locator('[data-koin-test="purchase"]').isDisabled(), true);
  assert.equal(await page.locator("#koin-available").textContent(), "—");
  assert.equal(await page.locator("#koin-review-preview").isVisible(), false);
  assert.equal(await page.locator("#koin-answer-wrap").isVisible(), false);
  await page.evaluate(() => {
    const previous = window.kaiKoinTestBridge.run;
    window.paymentSnapshot = { enabled: true, mode: "mainnet-pilot", configured: true, accessReady: true, owner: "1FixturePublicWallet",
      balances: { available: "100000000", reserved: "10000000" }, transactions: [], worker: null,
      session: { session: "a".repeat(64), amount: "10000000", perJob: "1000000", maxJobs: 10, model: "Qwen 2.5 · 7B" } };
    window.kaiKoinTestBridge.run = (action, input) => action === "status" ? Promise.resolve(window.paymentSnapshot) : previous(action, input);
  });
  await page.locator('[data-koin-test="status"]').click();
  await page.waitForFunction(() => document.getElementById("koin-network-badge").textContent.includes("Mainnet"));
  assert.match(await page.locator("#koin-test-network-notice").textContent(), /REAL KOIN/);
  assert.equal(await page.locator('[data-koin-test="purchase"]').textContent(), "Add credits");
  assert.equal(await page.locator("#koin-available").textContent(), "1.00000000");
  assert.match(await page.locator("#koin-test-balances").textContent(), /mainnet KOIN/);
  assert.equal(await page.locator("#koin-connection").getAttribute("open"), null);
  assert.equal(await page.locator('[data-koin-test="fund-rewards"]').isVisible(), false);
  assert.equal(await page.locator('[data-koin-test="worker-start"]').isVisible(), false);
  const qa = process.env.KAI_MASCOT_QA_DIR;
  if (qa) { fs.mkdirSync(qa, { recursive: true }); await page.setViewportSize({ width: 1280, height: 1800 }); await page.locator("#koin-test-payments").screenshot({ path: path.join(qa, "koin-payments-mainnet.png") }); }

  await page.fill("#koin-test-amount", "0.12345678");
  const purchase = page.locator('[data-koin-test="purchase"]'); await purchase.click();
  assert.equal(await purchase.isDisabled(), true);
  assert.equal(await page.locator('[data-koin-test="stop"]').isDisabled(), false);
  await page.evaluate(() => document.querySelector('[data-koin-test="purchase"]').click());
  assert.deepEqual(await page.evaluate(() => window.testPaymentCalls.filter(c => c.action === "purchase")), [{ action: "purchase", input: "0.12345678" }]);
  await page.locator('[data-koin-test="stop"]').click();
  await page.evaluate(() => window.finishTestPayment({ state: "uncertain", error: "<img src=x onerror=alert(1)>" }));
  await page.waitForFunction(() => !document.querySelector('[data-koin-test="purchase"]').disabled);
  assert.equal(await page.locator("#koin-test-payment-status img").count(), 0);
  await page.locator("#koin-advanced > summary").click();
  await page.locator('[data-koin-test="chat-status"]').click();
  await page.waitForFunction(() => document.getElementById("koin-test-payment-status").textContent.includes("cancelled before dispatch"));

  // The reward pool has its own amount; buyer credit entry must not leak into it.
  await page.fill("#koin-reward-amount", "0.25");
  await page.locator('[data-koin-test="fund-rewards"]').click();
  assert.deepEqual(await page.evaluate(() => window.testPaymentCalls.filter(c => c.action === "fund-rewards")), [{ action: "fund-rewards", input: "0.25" }]);
  await page.evaluate(() => window.finishTestPayment({ state: "cancelled" }));
  await page.waitForFunction(() => !document.querySelector('[data-koin-test="fund-rewards"]').disabled);
  await page.locator("#koin-advanced > summary").click();

  await page.locator("#koin-earn-tab").click();
  assert.equal(await page.locator("#koin-use-panel").isVisible(), false);
  await page.locator('[data-koin-test="worker-start"]').click();
  await page.evaluate(() => { window.paymentSnapshot.worker = { running: true }; window.finishTestPayment({ state: "test_worker_running" }); });
  await page.waitForFunction(() => !document.querySelector('[data-koin-test="worker-stop"]').hidden);
  assert.equal(await page.locator('[data-koin-test="worker-start"]').isVisible(), false);
  await page.locator('[data-koin-test="payouts"]').click();
  await page.evaluate(() => window.finishTestPayment({ payouts: [{ epoch: "12", state: "finalized", availability: "10000000", work: "2000000" }] }));
  await page.waitForFunction(() => document.getElementById("koin-payout-summary").textContent.includes("0.12000000 mainnet KOIN"));
  assert.equal(await page.locator("#koin-test-payments img").count(), 0);
  if (qa) await page.locator("#koin-test-payments").screenshot({ path: path.join(qa, "koin-payments-provider.png") });
  await page.locator("#koin-earn-tab").focus(); await page.keyboard.press("ArrowLeft");
  assert.equal(await page.locator("#koin-use-tab").getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#koin-use-tab").evaluate(node => node === document.activeElement), true);

  await page.evaluate(() => { window.paymentSnapshot.mode = "test-deployment"; window.paymentSnapshot.session = null; window.paymentSnapshot.balances = { available: "bad", reserved: "0" }; });
  await page.locator('[data-koin-test="status"]').click();
  await page.waitForFunction(() => document.getElementById("koin-network-badge").textContent.includes("Testnet"));
  assert.equal(await page.locator("#koin-available").textContent(), "—");
  assert.equal(await page.locator('[data-koin-test="chat"]').isDisabled(), true);
  await page.setViewportSize({ width: 480, height: 900 });
  assert.equal(await page.locator("#koin-test-payments").evaluate(node => node.scrollWidth <= node.clientWidth), true);
  if (qa) { await page.setViewportSize({ width: 480, height: 2800 }); await page.locator("#koin-test-payments").screenshot({ path: path.join(qa, "koin-payments-narrow.png") }); }
});
