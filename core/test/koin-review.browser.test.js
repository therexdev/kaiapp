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
  assert.equal(await page.locator("#btn-koin-claim").isDisabled(), true);
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
});
