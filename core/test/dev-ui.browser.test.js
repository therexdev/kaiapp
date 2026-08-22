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

    // The switch lives in Settings (v0.41.0 — it used to be buried at the
    // bottom of Local API); the CONTENT lives in its own view.
    await page.click('[data-view="settings"]');
    await page.waitForSelector("#view-settings:not([hidden])");
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
    await page.click('[data-view="settings"]'); // the gear, not Local API (v0.41.0)
    await page.click("#btn-dev-toggle");
    await page.waitForSelector('#btn-dev-toggle[aria-checked="false"]');
    assert.strictEqual(await page.$eval("#nav-devtools", (el) => el.hidden), true);
  } finally {
    await browser.close();
    await core.stop();
  }
});

/*
 * v0.41.0 — the sidebar restructure, and the bug that prompted it.
 *
 * Field report: "Koinos Code and Developer Tools don't seem to pop up until I
 * click the earn tab." Both nav items start hidden and were only unhidden by
 * renderDev/renderCodeSwitch, which ran nowhere but inside renderApi() — so
 * the reveal was a side effect of VISITING A VIEW. A feature you had already
 * switched on looked switched off until you wandered somewhere unrelated.
 *
 * The regression guard is the reload: switch both on, reload, and they must be
 * there before the user touches anything.
 */
test("sidebar: switches live in Settings, and what they reveal survives a reload", { skip: !available, timeout: 180000 }, async () => {
  const { chromium } = require("playwright-core");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-navboot-"));
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

    // Network is an icon now, not a sidebar row.
    assert.strictEqual(await page.$$eval('.nav-item[data-view="network"]', (e) => e.length), 0);
    await page.click('[data-view="network"]');
    await page.waitForSelector("#view-network:not([hidden])");

    // Both switches are in one findable place.
    await page.click('[data-view="settings"]');
    await page.waitForSelector("#view-settings:not([hidden])");
    for (const id of ["#btn-dev-toggle", "#btn-code-toggle", "#btn-koinos-toggle", "#account-signedout"]) {
      assert.ok(await page.$(id), `${id} moved into Settings`);
    }
    await page.click("#btn-dev-toggle");
    await page.click("#btn-code-toggle");
    await page.waitForSelector("#nav-devtools:not([hidden])");
    await page.waitForSelector("#nav-code:not([hidden])");

    // THE BUG: reload and look at the sidebar without going anywhere first.
    await page.reload();
    await page.waitForSelector("#view-chat:not([hidden])");
    await page.waitForFunction(
      () => !document.getElementById("nav-devtools").hidden && !document.getElementById("nav-code").hidden,
      { timeout: 20000 }
    );
    // Nothing was clicked between the reload and now — that is the whole point.
    assert.strictEqual(await page.$eval("#view-chat", (el) => el.hidden), false, "still on the view we booted onto");

    /*
     * Field report: "when you scroll down on the settings page it scrolls the
     * whole sidebar too." A view outside the scrolling rule grows the PAGE
     * rather than scrolling itself, and the window takes the sidebar with it.
     * Squeeze the window so Settings certainly overflows, then scroll it.
     */
    await page.setViewportSize({ width: 1000, height: 420 });
    await page.click('[data-view="settings"]');
    await page.waitForSelector("#view-settings:not([hidden])");
    const before = await page.$eval("#sidebar", (el) => el.getBoundingClientRect().top);
    await page.$eval("#view-settings", (el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForFunction(() => document.getElementById("view-settings").scrollTop > 0, { timeout: 5000 });
    const after = await page.$eval("#sidebar", (el) => el.getBoundingClientRect().top);
    assert.strictEqual(after, before, "the sidebar must not move when Settings scrolls");
    assert.strictEqual(
      await page.evaluate(() => window.scrollY),
      0,
      "the PAGE must not scroll — the view scrolls inside itself"
    );
  } finally {
    await browser.close();
    await core.stop();
  }
});

/*
 * The multi-agent tool picker, with a real MCP server's worth of tools
 * (field report, v0.42.0).
 *
 * A 29-tool server rendered 29 rows of `mcp:srvmsxqbdxy249df8:health` — the
 * internal storage id, repeated on every line — which the tester described,
 * accurately, as a wall of noise. Core now sends the name the server calls
 * itself; this asserts the list actually uses it, groups by server, and can
 * still be wired by the id nobody should have to read.
 */
test("tool picker groups by server and shows readable names, not internal ids", { skip: !available, timeout: 180000 }, async () => {
  const { chromium } = require("playwright-core");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-toolpick-"));
  fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");

  const { createCore } = require("../server");
  const core = await createCore({ dataDir, port: 0, llamaBin: FAKE_BIN, onEvent: () => {} });
  const base = `http://127.0.0.1:${await core.start()}`;
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const SRV_ID = "srvmsxqbdxy249df8";
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // Answer the view's REAL fetch — no test hook in the shipping code.
    await page.route("**/core/tools", async (route) => {
      const names = ["health", "balance", "transfer", "block", "tx", "account", "models", "status", "peers"];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          tools: [
            { name: "web_search", label: "web_search", server: null, serverId: null, sensitive: false, description: "", params: {} },
            ...names.map((n) => ({
              name: `mcp:${SRV_ID}:${n}`, label: `koinos-ai:${n}`,
              server: "koinos-ai-mcp", serverId: SRV_ID,
              sensitive: n === "transfer", description: "", params: {},
            })),
          ],
        }),
      });
    });
    await page.goto(base);
    await page.waitForSelector("#view-chat:not([hidden])");
    await page.click('[data-view="settings"]');
    await page.click("#btn-dev-toggle");
    await page.waitForSelector("#nav-devtools:not([hidden])");
    await page.click("#nav-devtools");
    await page.waitForSelector("#view-devtools:not([hidden])");
    await page.waitForSelector(".tool-group");

    // Nothing a person reads carries the internal id.
    // Scoped to the FIRST agent card. The example team ships two agents and
    // each carries its own independent picker, so an unscoped selector sees
    // every group twice and the assertions read as duplicates.
    const CARD = ".agent-card:nth-of-type(1)";
    const shown = await page.$$eval(`${CARD} .ag-tools .check`, (els) => els.map((e) => e.textContent.trim()));
    assert.ok(shown.length > 0, "the picker rendered tools");
    assert.ok(!shown.some((t) => t.includes(SRV_ID)), `no label should contain the server id, got ${JSON.stringify(shown.slice(0, 3))}`);
    assert.ok(shown.some((t) => t.startsWith("koinos-ai:health")), `expected koinos-ai:health, got ${JSON.stringify(shown)}`);

    // Two groups, built-ins first, each headed by a name.
    const heads = await page.$$eval(`${CARD} .ag-tools .tool-group-name`, (els) => els.map((e) => e.textContent.trim()));
    assert.deepStrictEqual(heads, ["Built-in", "koinos-ai-mcp"], "grouped and ordered by server");

    // The id is reachable, just not shouted: it lives in the header tooltip.
    const tip = await page.$eval(`${CARD} .ag-tools .tool-group:nth-of-type(2) .tool-group-name`, (el) => el.title);
    assert.ok(tip.includes(SRV_ID), `the id belongs in a tooltip, got "${tip}"`);

    // Enable-all flips the whole server on, and the checkbox VALUE is still
    // the wiring key — a display change must never rewrite what gets saved.
    const group = `${CARD} .ag-tools .tool-group:nth-of-type(2)`;
    await page.click(`${group} .tool-group-all`);
    const checked = await page.$$eval(`${group} .ag-tool:checked`, (els) => els.map((e) => e.dataset.tool));
    assert.strictEqual(checked.length, 9, "every tool in the group turned on");
    assert.ok(checked.every((n) => n.startsWith(`mcp:${SRV_ID}:`)), "values are still the registry ids");
    assert.strictEqual(
      await page.$eval(`${group} .tool-group-all`, (el) => el.textContent.trim()), "None",
      "and the button now offers the opposite action");

    // Built-ins untouched: an enable-all is scoped to its own server.
    const builtinOn = await page.$$eval(`${CARD} .ag-tools .tool-group:nth-of-type(1) .ag-tool:checked`, (els) => els.length);
    assert.strictEqual(builtinOn, 1, "the other group kept its own state (web_search was preselected)");

    await page.click(`${group} .tool-group-all`);
    assert.strictEqual(
      await page.$$eval(`${group} .ag-tool:checked`, (els) => els.length), 0,
      "clicking again turns the group back off");
  } finally {
    await browser.close();
    await core.stop();
  }
});
