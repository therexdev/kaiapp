"use strict";

/*
 * The Tasks screen while a task is running, in a real browser.
 *
 * The unit tests prove Core reports `running`. This proves the screen SHOWS
 * it, and — the whole point — that it still shows it after the list repaints.
 * The reported bug was invisible to every test that looked at one render:
 * the first paint after the click was correct, and the second one, five
 * seconds later, silently threw it away.
 *
 * The run is held open here rather than left to the engine's real speed. What
 * matters is what the screen does WHILE waiting, and a fixture engine that
 * answers instantly is exactly the condition under which this bug hides.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
const FAKE_BIN = path.join(__dirname, "fixtures", "fake-llama-server");
const UI_WAIT = 30000;

// Longer than the Tasks list's own repaint interval, so the wait necessarily
// spans at least one full re-render — that repaint is the bug.
const HOLD_MS = 9000;

const available = (() => {
  try {
    require.resolve("playwright-core");
    fs.accessSync(CHROMIUM, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
})();

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-tasksui-"));
  const catalogPath = path.join(dir, "catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({
    aliases: { "koinos-fast": { label: "Koinos Fast", package: "f@1", minRamGb: 1 } },
    packages: { "f@1": { filename: "f.gguf", url: "http://127.0.0.1:1/x", sha256: "1".repeat(64), sizeBytes: 4096, runtime: "llamacpp" } },
  }));
  const modelsDir = path.join(dir, "models");
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.writeFileSync(path.join(modelsDir, "f.gguf"), "x".repeat(4096));

  const { createCore } = require("../server");
  const core = await createCore({ dataDir: dir, port: 0, llamaBin: FAKE_BIN, onEvent: () => {} });
  const { ModelManager } = require("../lib/model-manager");
  const { JsonStore } = require("../lib/store");
  const swapped = new ModelManager({
    catalogPath, modelsDir,
    state: new JsonStore(path.join(dir, "state.json"), {}), onEvent: () => {},
  });
  core.models.catalog = swapped.catalog;
  core.models.modelsDir = swapped.modelsDir;
  core.runtime.models = core.models;
  core.gateway.models = core.models;
  const port = await core.start();
  return { core, base: `http://127.0.0.1:${port}` };
}

const rowText = (page) =>
  page.evaluate(() => document.querySelector(".task-row")?.innerText.replace(/\s+/g, " ").trim() || null);

test("a running task keeps saying so through the list's own repaints",
  { skip: !available, timeout: 180000 }, async (t) => {
    const { core, base } = await boot();
    const { chromium } = require("playwright-core");
    const browser = await chromium.launch({ executablePath: CHROMIUM });
    t.after(async () => { await browser.close(); core.tasks?.stop?.(); core.runtime?.stop?.(); await core.stop?.(); });

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // Stand in for a model that has to load before it can answer.
    await page.route("**/core/tasks/*/run", async (route) => {
      await new Promise((r) => setTimeout(r, HOLD_MS));
      await route.continue();
    });

    await page.goto(base);
    await page.waitForSelector("#view-chat:not([hidden]), #view-onboarding:not([hidden])", { timeout: UI_WAIT });
    await page.evaluate(() => document.querySelector('[data-view="tasks"]').click());
    await page.waitForSelector("#view-tasks:not([hidden])", { timeout: UI_WAIT });

    // Build it through the form, the way a person does.
    await page.fill("#task-name", "Night");
    await page.fill("#task-prompt", "Anything I should know?");
    await page.click("#task-form button[type=submit], #task-form .primary");
    await page.waitForFunction(() => document.querySelectorAll(".task-row").length === 1, { timeout: UI_WAIT });
    assert.match(await rowText(page), /hasn't run yet/, "a fresh task says so");

    await page.evaluate(() => document.querySelector("[data-run]").click());

    // Immediately, and then well past a repaint. Both must look the same.
    await page.waitForTimeout(300);
    assert.match(await rowText(page), /running now/i, "the click is acknowledged at once");

    await page.waitForTimeout(6500); // >5s: at least one full repaint has landed
    const during = await rowText(page);
    assert.match(during, /running now/i,
      `still shows the run after a repaint — got: ${during}`);
    assert.doesNotMatch(during, /hasn't run yet/i,
      "and must never claim it has not run while it is running");
    assert.equal(
      await page.evaluate(() => document.querySelector("[data-run]").disabled), true,
      "the button stays disabled, so a second click cannot pile on another run",
    );

    // And it resolves to a result rather than sticking on Running… forever.
    await page.waitForFunction(
      () => /last result/i.test(document.querySelector(".task-row")?.innerText || ""),
      { timeout: UI_WAIT },
    );
    assert.equal(await page.evaluate(() => document.querySelector("[data-run]").disabled), false,
      "and the button is usable again once it is done");
  });
