"use strict";

/*
 * Compare presets (v0.30.1) in a real Chromium: the chips render, and a
 * click puts the full preset prompt into the box without running anything.
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

test("compare view: preset chips fill the prompt box and never auto-run", { skip: !available, timeout: 120000 }, async () => {
  const { chromium } = require("playwright-core");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cmpui-"));
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

    await page.click('.nav-item[data-view="compare"]');
    await page.waitForSelector("#view-compare:not([hidden])");

    const chips = await page.$$("#cmp-presets .cmp-preset");
    assert.strictEqual(chips.length, 5, "five preset chips render");
    assert.strictEqual(await page.$eval("#cmp-input", (el) => el.value), "", "box starts empty");

    await chips[0].click();
    const filled = await page.$eval("#cmp-input", (el) => el.value);
    assert.match(filled, /17 sheep/, "clicking a chip fills the full preset prompt");
    assert.ok(await page.$eval("#cmp-panes", (el) => el.hidden), "filling a preset does not start a run");
  } finally {
    await browser.close();
    await core.stop();
  }
});
