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

test("wallet card: receive address shown, sends demand a password and a second confirming click", { skip: !available, timeout: 120000 }, async () => {
  const { chromium } = require("playwright-core");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-walletui-"));
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");

  const { createCore } = require("../server");
  const core = await createCore({ dataDir: dir, port: 0, llamaBin: FAKE_BIN, onEvent: () => {} });
  const base = `http://127.0.0.1:${await core.start()}`;
  const PW = "correct horse 9";
  // Wallet by API — this test is about the wallet CARD, not creation.
  const made = await (await fetch(`${base}/core/earn/wallet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PW }),
  })).json();
  assert.ok(made.address, "wallet created");

  const browser = await chromium.launch({ executablePath: CHROMIUM });
  try {
    const page = await browser.newPage();
    await page.goto(base);
    await page.waitForSelector("#view-chat:not([hidden])");
    await page.click('.nav-item[data-view="earn"]');
    await page.waitForSelector("#earn-ready:not([hidden])");

    // Receive: the card carries this wallet's real address.
    await page.waitForFunction(
      (addr) => document.getElementById("wallet-address")?.value === addr,
      made.address
    );

    // Sending without a password is refused client-side, with words.
    await page.type("#wallet-send-to", "1K1AUovu5NjjPcaTxmde6wPB8Y8PQGFV3E");
    await page.type("#wallet-send-amt", "1");
    await page.click("#btn-wallet-send");
    assert.match(await page.textContent("#wallet-msg"), /password is required/);

    // With a password, the FIRST click only arms: it repeats the exact
    // amount, token and recipient and asks for a confirming second click.
    // Nothing has touched the chain yet.
    await page.type("#wallet-send-pass", PW);
    await page.click("#btn-wallet-send");
    const armed = await page.textContent("#wallet-msg");
    assert.match(armed, /About to send 1 KOIN to 1K1AUovu5NjjPcaTxmde6wPB8Y8PQGFV3E/);
    assert.match(armed, /MAINNET/);
    assert.match(armed, /Click Send again to confirm/);

    // Changing the amount DISARMS: the next click must arm again, not send.
    await page.fill("#wallet-send-amt", "2");
    await page.click("#btn-wallet-send");
    assert.match(await page.textContent("#wallet-msg"), /About to send 2 KOIN/);
  } finally {
    await browser.close();
    await core.stop();
  }
});

test("account card: signed-out state renders, and Local-Only privacy is explained in words", { skip: !available, timeout: 120000 }, async () => {
  const { chromium } = require("playwright-core");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-accountui-"));
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const { createCore } = require("../server");
  const core = await createCore({ dataDir: dir, port: 0, llamaBin: FAKE_BIN, onEvent: () => {} });
  const base = `http://127.0.0.1:${await core.start()}`;
  await fetch(`${base}/core/earn/wallet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "account ui 1" }),
  });
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  try {
    const page = await browser.newPage();
    await page.goto(base);
    await page.waitForSelector("#view-chat:not([hidden])");
    // The account card moved out of Earn and into Settings (v0.41.0) — it is
    // about who you are, not about earning.
    await page.click('[data-view="settings"]');
    await page.waitForSelector("#view-settings:not([hidden])");
    // Default privacy is Local-Only: the card must say so, in words, instead
    // of showing a broken sign-in button.
    await page.waitForFunction(() => {
      const el = document.getElementById("account-msg");
      return el && !el.hidden && /Local-Only/.test(el.textContent);
    });
  } finally {
    await browser.close();
    await core.stop();
  }
});

test("team mode: 'Write & review' runs through the real engine and lands a final answer in the chat", { skip: !available, timeout: 120000 }, async () => {
  const { chromium } = require("playwright-core");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-teamui-"));
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const { createCore } = require("../server");
  const core = await createCore({ dataDir: dir, port: 0, llamaBin: FAKE_BIN, onEvent: () => {} });
  const base = `http://127.0.0.1:${await core.start()}`;
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  try {
    const page = await browser.newPage();
    await page.goto(base);
    await page.waitForSelector("#view-chat:not([hidden])");
    await page.selectOption("#mode-pick", "team:review");
    await page.type("#input", "say hello");
    await page.click("#btn-send");
    // The fake model answers identically each stage; the critic's non-PASS
    // forces one revision — writer + critic + reviser = 3 calls, and the
    // final answer text lands in the assistant bubble.
    await page.waitForFunction(
      () => [...document.querySelectorAll(".msg.assistant, [class*='assistant']")].some((el) => /Hello from fake llama/.test(el.textContent)),
      undefined,
      { timeout: 60000 }
    );
    const trace = await page.textContent("body");
    assert.match(trace, /team finished in 3 model calls/);
  } finally {
    await browser.close();
    await core.stop();
  }
});

/*
 * v0.41.0 — the node is ONE sidebar entry with its seven screens on a rail
 * inside, the Koinos Code shape. Seven top-level entries made an optional
 * feature look like most of the app, and stayed in the way when only one was
 * ever in use.
 */
test("koinos node: one sidebar entry, seven screens on a rail, Dashboard first", { skip: !available, timeout: 120000 }, async () => {
  const { chromium } = require("playwright-core");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-nodenav-"));
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const { createCore } = require("../server");
  const core = await createCore({ dataDir: dir, port: 0, llamaBin: FAKE_BIN, onEvent: () => {} });
  const base = `http://127.0.0.1:${await core.start()}`;
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  try {
    const page = await browser.newPage();
    await page.goto(base);
    await page.waitForSelector("#view-chat:not([hidden])");

    // The switch moved to Settings along with everything else optional.
    await page.click('[data-view="settings"]');
    await page.waitForSelector("#view-settings:not([hidden])");
    assert.strictEqual(await page.$eval("#nav-koinos", (el) => el.hidden), true, "hidden while off");
    await page.click("#btn-koinos-toggle");
    await page.waitForSelector("#nav-koinos:not([hidden])");

    // Exactly one entry — not seven.
    assert.strictEqual(await page.$$eval(".nav-item.koinos-nav", (e) => e.length), 1);

    await page.click("#nav-koinos");
    await page.waitForSelector("#view-koinos:not([hidden])");
    const rail = await page.$$eval("#kn-rail [data-knode]", (els) =>
      els.map((e) => ({ v: e.dataset.knode, label: e.textContent.trim(), on: e.classList.contains("on") }))
    );
    assert.strictEqual(rail.length, 7, "all seven screens reachable");
    assert.strictEqual(rail[0].label, "Dashboard", "Dashboard is first");
    assert.strictEqual(rail[0].on, true, "and selected on arrival");

    // Picking another screen moves the highlight — the rail is the navigation.
    await page.click('#kn-rail [data-knode="koinos-wallet"]');
    await page.waitForFunction(
      () => document.querySelector('#kn-rail [data-knode="koinos-wallet"]').classList.contains("on")
    );
    assert.strictEqual(
      await page.$eval('#kn-rail [data-knode="koinos"]', (e) => e.classList.contains("on")),
      false,
      "one screen selected at a time"
    );

    // Switching the node off must not strand anyone on a view that is gone.
    await page.click('[data-view="settings"]');
    await page.click("#btn-koinos-toggle");
    await page.waitForFunction(() => document.getElementById("nav-koinos").hidden);
  } finally {
    await browser.close();
    await core.stop();
  }
});
