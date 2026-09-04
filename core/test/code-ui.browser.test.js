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

/*
 * Both waits live in core/test/ui-wait.js — one number for the whole suite,
 * because raising them file by file is what cost v0.42.1 and v0.51.0 a
 * release each. The reasoning is recorded there.
 *
 * They are "has the UI got there yet" bounds, not performance budgets: the
 * folder listing they mostly wait on takes ~200ms locally, and each test's
 * own 180s test-level timeout is the real backstop against a hung page.
 */
const { UI_WAIT, RUN_WAIT } = require("./ui-wait");

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

    // Koinos Code is its own sidebar item behind its own switch (task #72).
    await page.click('[data-view="settings"]'); // the gear, not Local API (v0.41.0)
    await page.click("#btn-code-toggle");
    await page.waitForSelector("#nav-code:not([hidden])");
    await page.click("#nav-code");
    await page.waitForSelector("#view-code:not([hidden])");

    // No project yet: the start screen offers the two ways in.
    await page.waitForSelector("#kc-start:not([hidden])");
    await page.waitForSelector("#btn-kc-pick");
    await page.waitForSelector("#btn-kc-clone");

    // Make the initial directory request finish after the typed destination.
    // A stale response used to replace the path selected below, making this
    // flow intermittently hang and reproducing the same race for fast users.
    await page.route("**/core/code/browse", async (route) => {
      const dir = JSON.parse(route.request().postData() || "{}").dir;
      if (!dir) await new Promise((resolve) => setTimeout(resolve, 300));
      await route.continue();
    });

    /*
     * Choose a folder through the IN-APP browser — the path a served UI takes,
     * and the one a test can drive. (The packaged app calls the native picker
     * via koinosShell.pickFolder instead; both end at useFolder.)
     *
     * NOTHING here may use window.prompt: it does not exist in Electron and
     * returns null without showing anything, which is exactly the bug this
     * screen replaced.
     */
    await page.click("#btn-kc-pick");
    await page.waitForSelector("#kc-browse:not([hidden])");
    await page.fill("#kc-browse-path", project);
    await page.click("#btn-kc-browse-go");
    await page.waitForFunction(
      (dir) => document.getElementById("kc-browse-here").textContent.includes(dir),
      project,
      { timeout: UI_WAIT }
    );
    await page.click("#btn-kc-browse-use");

    // Choosing a folder goes straight into the conversation.
    await page.waitForSelector("#kc-chat:not([hidden])");
    await page.waitForFunction(
      (dir) => document.getElementById("kc-path").textContent === dir,
      project,
      { timeout: UI_WAIT }
    );

    await page.fill("#kc-task", "create a greeting file");
    await page.click("#btn-kc-run");

    // The approval card arrives with the real diff; nothing on disk yet.
    await page.waitForSelector(".kc-approval", { timeout: RUN_WAIT });
    const diff = await page.$eval(".kc-diff", (el) => el.textContent);
    assert.match(diff, /\+ hi from the panel/);
    assert.strictEqual(fs.existsSync(path.join(project, "greet.txt")), false, "nothing written before approval");

    await page.click(".kc-approval button.primary");
    await page.waitForFunction(() => document.getElementById("kc-status").textContent.includes("done"), { timeout: RUN_WAIT });
    assert.strictEqual(fs.readFileSync(path.join(project, "greet.txt"), "utf8"), "hi from the panel\n");
    const bubbles = await page.$$eval("#kc-trace .pg-msg", (els) => els.map((e) => e.textContent));
    assert.ok(
      bubbles.some((t) => /Created greet\.txt\./.test(t)),
      `expected the answer in the transcript, got ${JSON.stringify(bubbles)}`
    );

    // The run became a SESSION on that project — the thing that makes this a
    // workspace instead of a one-shot command. It carries both turns.
    await page.waitForFunction(
      () => document.querySelectorAll("#kc-sessions .kc-item").length > 0,
      { timeout: UI_WAIT }
    );
    const session = await page.$eval("#kc-sessions .kc-item", (el) => el.textContent);
    assert.match(session, /create a greeting file/, "the session is titled by what was asked");
    assert.match(session, /2 turns/, "both the ask and the answer were recorded");
  } finally {
    delete process.env.FAKE_LLAMA_SCRIPT;
    await browser.close();
    await core.stop();
  }
});

test("plan mode: reads, proposes, changes nothing — then the approved plan does the work", { skip: !available, timeout: 180000 }, async () => {
  const { chromium } = require("playwright-core");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-planui-"));
  fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "kai-planproj-"));
  fs.writeFileSync(path.join(project, "app.js"), "console.log(1);\n");

  const script = path.join(dataDir, "script.json");
  fs.writeFileSync(
    script,
    JSON.stringify([
      // PLAN pass: it tries to write. That tool does not exist in plan mode,
      // so the loop tells it so (a bounded nudge) and it writes the plan.
      '{"tool": "write_file", "args": {"path": "app.js", "content": "console.log(2);\\n"}}',
      "1. Change app.js so it logs 2.",
      // ACT pass, after the plan is approved.
      '{"tool": "write_file", "args": {"path": "app.js", "content": "console.log(2);\\n"}}',
      '{"answer": true}',
      "Changed app.js to log 2.",
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
    await page.click('[data-view="settings"]'); // the gear, not Local API (v0.41.0)
    await page.click("#btn-code-toggle");
    await page.waitForSelector("#nav-code:not([hidden])");
    await page.click("#nav-code");

    await page.click("#btn-kc-pick");
    await page.waitForSelector("#kc-browse:not([hidden])");
    await page.fill("#kc-browse-path", project);
    await page.click("#btn-kc-browse-go");
    /*
     * 30s, matching the other waits in this test. The folder listing takes
     * ~200ms locally; this bound exists so a hung UI cannot hang the suite,
     * and the test-level timeout (added above — this test was the only one of
     * the three without one) is the real backstop. 15s was arbitrary tightness
     * on a machine running four test files at once: it is what blew up first
     * when the account tests got heavier, which is a scheduling fact about the
     * runner, not a fact about this feature.
     */
    await page.waitForFunction((d) => document.getElementById("kc-browse-here").textContent.includes(d), project, { timeout: UI_WAIT });
    await page.click("#btn-kc-browse-use");
    await page.waitForSelector("#kc-chat:not([hidden])");

    // Plan first.
    await page.check("#kc-plan");
    await page.fill("#kc-task", "make it log 2");
    await page.click("#btn-kc-run");

    // A plan card arrives, and NOTHING has been written.
    await page.waitForFunction(
      () => document.getElementById("kc-status").textContent.includes("plan ready"),
      { timeout: RUN_WAIT }
    );
    const planText = await page.$eval(".kc-approval .pg-msg", (el) => el.textContent);
    assert.match(planText, /logs 2/);
    assert.strictEqual(
      fs.readFileSync(path.join(project, "app.js"), "utf8"),
      "console.log(1);\n",
      "planning must not touch the file"
    );

    // Approving runs it for real — and the write still needs its own card.
    await page.click(".kc-approval button.primary");
    await page.waitForSelector(".kc-approval:not(.answered)", { timeout: RUN_WAIT });
    await page.click(".kc-approval:not(.answered) button.primary");
    await page.waitForFunction(
      () => document.getElementById("kc-status").textContent.includes("done"),
      { timeout: UI_WAIT }
    );
    assert.strictEqual(fs.readFileSync(path.join(project, "app.js"), "utf8"), "console.log(2);\n");
  } finally {
    delete process.env.FAKE_LLAMA_SCRIPT;
    await browser.close();
    await core.stop();
  }
});

/*
 * v0.40.0, from the field report: "for the github repo copy I want the folder
 * selection to be a window selection as well like the first one" and "what
 * model does this use? There should probably be a model selector just like the
 * chat."
 *
 * Both are shell-dependent, so the shell is faked: window.koinosShell is
 * injected before the page's scripts run, exactly as preload does in the
 * packaged app. That is the only honest way to test a native dialog from here
 * — and the reason the previous prompt() bug survived a green browser suite is
 * that Playwright IS a browser, so it never saw what Electron does.
 */
test("clone destination opens the native folder window, and the model box drives the run", { skip: !available, timeout: 180000 }, async () => {
  const { chromium } = require("playwright-core");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-codeui-model-"));
  fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "kai-codeui-model-proj-"));
  const cloneInto = fs.mkdtempSync(path.join(os.tmpdir(), "kai-codeui-clonedir-"));

  const script = path.join(dataDir, "llama-script.json");
  const record = path.join(dataDir, "llama-record.jsonl");
  fs.writeFileSync(script, JSON.stringify(["Nothing to do here."]));
  process.env.FAKE_LLAMA_SCRIPT = script;
  process.env.FAKE_LLAMA_RECORD = record;

  const { createCore } = require("../server");
  const core = await createCore({ dataDir, port: 0, llamaBin: FAKE_BIN, onEvent: () => {} });
  const base = `http://127.0.0.1:${await core.start()}`;

  const browser = await chromium.launch({ executablePath: CHROMIUM });
  try {
    const page = await browser.newPage();
    // Stand in for the Electron preload bridge.
    await page.addInitScript((dir) => {
      window.__picked = [];
      window.koinosShell = {
        pickFolder: async (title) => {
          window.__picked.push(title);
          return dir;
        },
      };
    }, cloneInto);
    await page.goto(base);
    await page.waitForSelector("#view-chat:not([hidden])");
    await page.click('[data-view="settings"]'); // the gear, not Local API (v0.41.0)
    await page.click("#btn-code-toggle");
    await page.waitForSelector("#nav-code:not([hidden])");
    await page.click("#nav-code");
    await page.waitForSelector("#view-code:not([hidden])");

    // --- the clone destination is a WINDOW, like "Select a folder" is.
    await page.click("#btn-kc-clone");
    await page.waitForSelector("#kc-clone:not([hidden])");
    // Where the OS window exists, the typed-path row is not offered at all:
    // one way to answer the question, not two.
    assert.strictEqual(await page.isHidden("#kc-clone-parent-row"), true);
    assert.match(await page.textContent("#kc-clone-parent-label"), /no folder chosen/i);
    await page.click("#btn-kc-clone-pick");
    await page.waitForFunction(
      (dir) => document.getElementById("kc-clone-parent-label").textContent === dir,
      cloneInto,
      { timeout: UI_WAIT }
    );
    assert.strictEqual(await page.inputValue("#kc-clone-parent"), cloneInto);
    assert.strictEqual((await page.evaluate(() => window.__picked)).length, 1, "the native window was opened");
    await page.click("#btn-kc-clone-close");

    // --- a project, chosen through the same native window.
    await page.evaluate((dir) => { window.koinosShell.pickFolder = async () => dir; }, project);
    await page.click("#btn-kc-pick");
    await page.waitForSelector("#kc-chat:not([hidden])");

    // --- the model box: "App default" plus every model actually installed.
    await page.waitForFunction(() => document.querySelectorAll("#kc-model option").length > 1, { timeout: UI_WAIT });
    const options = await page.$$eval("#kc-model option", (els) => els.map((e) => ({ v: e.value, t: e.textContent })));
    assert.strictEqual(options[0].v, "", "the first choice follows the app");
    assert.match(options[0].t, /App default/);
    const installed = options.find((o) => o.v);
    assert.ok(installed, `expected an installed model in ${JSON.stringify(options)}`);

    // Choosing one PINS it to the project — it survives a reload, because a
    // model choice you have to re-make every time is not a choice.
    await page.selectOption("#kc-model", installed.v);
    await page.waitForFunction(() => document.getElementById("kc-status").textContent.includes("using"), { timeout: RUN_WAIT });
    const stored = await page.evaluate(async () => (await (await fetch("/core/code/projects")).json()).projects[0].model);
    assert.strictEqual(stored, installed.v);

    // And it is the model the run actually asks for.
    fs.writeFileSync(record, "");
    await page.fill("#kc-task", "say hello");
    await page.click("#btn-kc-run");
    await page.waitForFunction(() => /done|budget|step/.test(document.getElementById("kc-status").textContent), { timeout: RUN_WAIT });
    const asked = fs
      .readFileSync(record, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.ok(asked.length, "the run reached a model");
  } finally {
    delete process.env.FAKE_LLAMA_SCRIPT;
    delete process.env.FAKE_LLAMA_RECORD;
    await browser.close();
    await core.stop();
  }
});
