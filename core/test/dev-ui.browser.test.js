"use strict";

/*
 * The Developer Tools VIEW (task #64) in a real Chromium: the switch in
 * Local API reveals a sidebar item (node-style), the view opens with its
 * sub-menu, the Pipelines tab still runs a custom spec end-to-end, and the
 * Playground runs a two-agent round-robin — including a human-in-the-loop
 * turn typed into the real input box.
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

test("developer tools view: nav reveal, tabs, a pipeline run, and a playground chat with a human turn", { skip: !available, timeout: 180000 }, async () => {
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

    // The switch lives in Local API; the CONTENT lives in its own view.
    await page.click('.nav-item[data-view="api"]');
    await page.waitForSelector("#view-api:not([hidden])");
    assert.strictEqual(await page.$eval("#nav-devtools", (el) => el.hidden), true, "sidebar item hidden while the switch is off");
    await page.click("#btn-dev-toggle");
    await page.waitForSelector("#nav-devtools:not([hidden])");

    // Open the view: Multi-agent tab is active, prefilled with a VALID spec.
    await page.click("#nav-devtools");
    await page.waitForSelector("#view-devtools:not([hidden])");
    await page.waitForFunction(() => document.getElementById("ag-json").value.trim().length > 0);
    const agSpec = JSON.parse(await page.$eval("#ag-json", (el) => el.value));
    assert.ok(Array.isArray(agSpec.agents) && agSpec.agents.length >= 2, "the example group spec is valid as shipped");
    assert.ok((await page.$$("#ag-list .agent-card")).length >= 2, "the builder shows the example's agent cards");

    // ---- Pipelines tab: the simple track still runs end-to-end ----
    await page.click('.subtab[data-tab="pipelines"]');
    await page.waitForSelector("#devtab-pipelines:not([hidden])");
    await page.fill("#dev-spec", JSON.stringify({ label: "ui spec", stages: ["write"] }));
    await page.fill("#dev-question", "say hello");
    await page.click("#btn-dev-run");
    await page.waitForFunction(() => document.getElementById("dev-team-out").textContent.includes("Hello from fake llama"), { timeout: 30000 });

    // ---- Playground: two model agents, then a HUMAN turn typed live ----
    await page.click('.subtab[data-tab="agents"]');
    await page.fill(
      "#ag-json",
      JSON.stringify({
        label: "trio",
        agents: [{ name: "Ana", human: true }, { name: "Bot" }, { name: "Cleo" }],
        termination: { maxMessages: 3, textMention: "" },
      })
    );
    await page.click('.subtab[data-tab="playground"]');
    await page.waitForSelector("#devtab-playground:not([hidden])");
    await page.fill("#pg-task", "collaborate on a greeting");
    await page.click("#btn-pg-run");
    // The human turn pauses the run and asks in the real input box.
    await page.waitForSelector("#pg-input-row:not([hidden])", { timeout: 30000 });
    await page.fill("#pg-input", "hello from the person");
    await page.click("#btn-pg-send");
    await page.waitForFunction(() => document.getElementById("pg-status").textContent.includes("ended:"), { timeout: 30000 });
    const names = await page.$$eval("#pg-convo .pg-msg .pg-name", (els) => els.map((e) => e.textContent));
    assert.deepStrictEqual(names, ["Ana", "Bot", "Cleo"], "named bubbles in speaking order");
    const first = await page.$eval("#pg-convo .pg-msg", (el) => el.textContent);
    assert.match(first, /hello from the person/, "the typed words became Ana's turn");

    // The switch closes the whole area again.
    await page.click('.nav-item[data-view="api"]');
    await page.click("#btn-dev-toggle");
    await page.waitForSelector('#btn-dev-toggle[aria-checked="false"]');
    assert.strictEqual(await page.$eval("#nav-devtools", (el) => el.hidden), true);
  } finally {
    await browser.close();
    await core.stop();
  }
});
