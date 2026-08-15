"use strict";

/*
 * The Earn tab's wallet forms in a real Chromium: create (typed, confirmed),
 * backup shown, lock, unlock (typed + Enter), then restore-from-backup-code
 * and unlock again. Guards the exact field-report: "the unlock button sent
 * 0 characters" — every submit here goes through real keystrokes.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
const FAKE_BIN = path.join(__dirname, "fixtures", "fake-llama-server");

const available = (() => {
  try {
    require.resolve("playwright-core");
    fs.accessSync(CHROMIUM, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
})();

test("earn wallet UI: create -> lock -> unlock -> restore -> unlock (real browser, real keystrokes)", { skip: !available, timeout: 120000 }, async () => {
  const { chromium } = require("playwright-core");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-earnui-"));
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");

  const { createCore } = require("../server");
  const core = await createCore({ dataDir: dir, port: 0, llamaBin: FAKE_BIN, onEvent: () => {} });
  const base = `http://127.0.0.1:${await core.start()}`;
  const PW = "correct horse 9";

  const browser = await chromium.launch({ executablePath: CHROMIUM });
  try {
    const page = await browser.newPage();
    await page.goto(base);
    await page.waitForSelector("#view-chat:not([hidden])");
    await page.click('.nav-item[data-view="earn"]');
    await page.waitForSelector("#earn-setup:not([hidden])");

    // Create: typed keystrokes, both fields, mismatch first (guard works),
    // then matching.
    await page.type("#earn-pass", PW);
    await page.type("#earn-pass2", "something else 9");
    await page.click("#btn-earn-create");
    assert.match(await page.textContent("#earn-error"), /don't match/);
    await page.fill("#earn-pass2", "");
    await page.type("#earn-pass2", PW);
    await page.click("#btn-earn-create");
    await page.waitForSelector("#earn-wif:not([hidden])");
    const wif = (await page.textContent("#earn-wif-value")).trim();
    assert.ok(wif.length > 40, "backup code shown once");
    await page.click("#btn-earn-wif-done");
    await page.waitForSelector("#earn-ready:not([hidden])");

    // Lock -> unlock card names the account and file time.
    await page.click("#btn-earn-lock");
    await page.waitForSelector("#earn-unlock:not([hidden])");
    assert.match(await page.textContent("#earn-unlock-hint"), /Account 1/);

    // Unlock with typed keystrokes submitted via Enter (commits any pending
    // input-method composition, same as the Koinos-Node modal).
    await page.type("#earn-unlock-pass", PW);
    await page.press("#earn-unlock-pass", "Enter");
    await page.waitForSelector("#earn-ready:not([hidden])");

    // Restore: lock again, forgot-password path, backup code + new password.
    await page.click("#btn-earn-lock");
    await page.waitForSelector("#earn-unlock:not([hidden])");
    await page.click("#btn-earn-show-restore");
    await page.waitForSelector("#earn-restore:not([hidden])");
    const NEW_PW = "fresh password 7";
    await page.type("#earn-restore-wif", wif);
    await page.type("#earn-restore-pass", NEW_PW);
    await page.type("#earn-restore-pass2", NEW_PW);
    await page.click("#btn-earn-restore");
    await page.waitForSelector("#earn-ready:not([hidden])");

    // The restored wallet unlocks with the new password — via click this time.
    await page.click("#btn-earn-lock");
    await page.waitForSelector("#earn-unlock:not([hidden])");
    await page.type("#earn-unlock-pass", NEW_PW);
    await page.click("#btn-earn-unlock");
    await page.waitForSelector("#earn-ready:not([hidden])");

    const errVisible = await page.$eval("#earn-error", (el) => !el.hidden && el.textContent.trim() !== "").catch(() => false);
    assert.equal(errVisible, false, "no lingering error after the full journey");
  } finally {
    await browser.close();
    await core.stop();
  }
});
