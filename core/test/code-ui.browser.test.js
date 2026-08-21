"use strict";

/*
 * The Koinos Code panel (task #60 v3) in a real Chromium: the sub-tab
 * renders, a run streams, the approval card shows the diff, clicking
 * "Apply edit" writes the file, and the final answer lands as a bubble.
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

test("code panel: run -> diff card -> approve -> file written -> answer bubble", { skip: !available, timeout: 180000 }, async () => {
  const { chromium } = require("playwright-core");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-codeui-"));
  fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "kai-codeui-proj-"));

  const script = path.join(dataDir, "llama-script.json");
  fs.writeFileSync(
    script,
    JSON.stringify([
      '{"tool": "write_file", "args": {"path": "greet.txt", "content": "hi from the panel\\n"}}',
      '{"answer": true}',
      "Created greet.txt.",
    ])
  );
  process.env.FAKE_LLAMA_SCRIPT = script;

  const { createCore } = require("../server");
  const core = await createCore({ dataDir, port: 0, llamaBin: FAKE_BIN, onEvent: () => {} });
  const base = `http://127.0.0.1:${await core.start()}`;

  const browser = await chromium.launch({ executablePath: CHROMIUM });
  try {
    const page = await browser.newPage();
    await page.goto(base);
    await page.waitForSelector("#view-chat:not([hidden])");

    await page.click('.nav-item[data-view="api"]');
    await page.click("#btn-dev-toggle");
    await page.waitForSelector("#nav-devtools:not([hidden])");
    await page.click("#nav-devtools");
    await page.waitForSelector("#view-devtools:not([hidden])");

    await page.click('.subtab[data-tab="code"]');
    await page.waitForSelector("#devtab-code:not([hidden])");

    await page.fill("#kc-dir", project);
    await page.fill("#kc-task", "create a greeting file");
    await page.click("#btn-kc-run");

    // The approval card arrives with the real diff; nothing on disk yet.
    await page.waitForSelector(".kc-approval", { timeout: 30000 });
    const diff = await page.$eval(".kc-diff", (el) => el.textContent);
    assert.match(diff, /\+ hi from the panel/);
    assert.strictEqual(fs.existsSync(path.join(project, "greet.txt")), false, "nothing written before approval");

    await page.click(".kc-approval button.primary");
    await page.waitForFunction(() => document.getElementById("kc-status").textContent.includes("done"), { timeout: 30000 });
    assert.strictEqual(fs.readFileSync(path.join(project, "greet.txt"), "utf8"), "hi from the panel\n");
    const answer = await page.$eval("#kc-trace .pg-msg", (el) => el.textContent);
    assert.match(answer, /Created greet\.txt\./);
  } finally {
    delete process.env.FAKE_LLAMA_SCRIPT;
    await browser.close();
    await core.stop();
  }
});
