"use strict";

/*
 * The developer-tools panel (task #61) in a real Chromium: the switch in
 * Local API reveals the panel, the spec box arrives prefilled with a valid
 * example, and a custom write-only spec runs end-to-end — UI -> gateway ->
 * loopback -> fake engine -> SSE back into the trace box.
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

test("developer tools UI: toggle reveals panel, a custom JSON spec runs to an answer", { skip: !available, timeout: 120000 }, async () => {
  const { chromium } = require("playwright-core");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-devui-"));
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
    await page.click('.nav-item[data-view="api"]');
    await page.waitForSelector("#view-api:not([hidden])");

    // Ships hidden: the switch is off and the panel is not in the way.
    await page.waitForSelector('#btn-dev-toggle[aria-checked="false"]');
    assert.strictEqual(await page.$eval("#dev-panel", (el) => el.hidden), true);

    // One click on the switch reveals the panel, prefilled with a VALID example.
    await page.click("#btn-dev-toggle");
    await page.waitForSelector("#dev-panel:not([hidden])");
    const prefill = await page.$eval("#dev-spec", (el) => el.value);
    assert.doesNotThrow(() => JSON.parse(prefill), "the example spec is valid JSON as shipped");

    // The visual builder writes valid JSON into the box: registry tools
    // appear as checkboxes, and the form round-trips into a runnable spec.
    await page.waitForSelector('#devb-tools input[data-tool="write_file"]');
    await page.uncheck('#devb-stages input[data-stage="plan"]');
    await page.check('#devb-tools input[data-tool="read_file"]');
    await page.fill("#devb-label", "built by form");
    await page.click("#btn-devb-apply");
    const built = JSON.parse(await page.$eval("#dev-spec", (el) => el.value));
    assert.strictEqual(built.label, "built by form");
    assert.ok(!built.stages.includes("plan"), "unchecked stage left out");
    assert.ok(built.stages.includes("write"), "write always survives (disabled checkbox)");
    assert.deepStrictEqual(built.tools, ["read_file"]);
    assert.strictEqual(built.maxSubtasks, 2, "budget fields carried through");

    // Run a write-only custom spec end-to-end through the real stack.
    await page.fill("#dev-spec", JSON.stringify({ label: "ui spec", stages: ["write"] }));
    await page.fill("#dev-question", "say hello");
    await page.click("#btn-dev-run");
    await page.waitForFunction(
      () => document.getElementById("dev-team-out").textContent.includes("Hello from fake llama"),
      { timeout: 30000 }
    );
    const out = await page.textContent("#dev-team-out");
    assert.match(out, /\[writer\]/, "the live trace rendered the stage");
    assert.match(out, /1 model calls/, "the summary line landed");
    const errVisible = await page.$eval("#dev-error", (el) => !el.hidden && el.textContent.trim() !== "");
    assert.strictEqual(errVisible, false, "no error surfaced");

    // The switch closes the panel again.
    await page.click("#btn-dev-toggle");
    await page.waitForSelector('#btn-dev-toggle[aria-checked="false"]');
    assert.strictEqual(await page.$eval("#dev-panel", (el) => el.hidden), true);
  } finally {
    await browser.close();
    await core.stop();
  }
});
