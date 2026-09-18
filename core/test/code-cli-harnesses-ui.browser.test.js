"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
// One wait for the whole suite — see core/test/ui-wait.js for why it is not
// raised file by file.
const { UI_WAIT } = require("./ui-wait");
// Seeding a model makes the runtime autostart, so it must point at the fake
// server like every other browser test: a real llama-server is not installed,
// and its spawn ENOENT lands AFTER the test ends as an uncaughtException.
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

async function startCore(privacyMode) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-harness-ui-"));
  fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const { createCore } = require("../server");
  const core = await createCore({ dataDir, port: 0, llamaBin: FAKE_BIN, onEvent: () => {} });
  core.settings.set("network.privacyMode", privacyMode);
  const base = `http://127.0.0.1:${await core.start()}`;
  return { core, base, dataDir };
}

test("Settings harness cards: render, enable/disable, Local-Only, Code shortcut", {
  skip: !available,
  timeout: 180000,
}, async (t) => {
  const { chromium } = require("playwright-core");
  let browser;
  const { core, base, dataDir } = await startCore("local-first");
  t.after(async () => {
    await browser?.close();
    await core.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(base);
  await page.click('[data-view="settings"]');
  await page.waitForSelector("#code-cli-harnesses");
  await page.waitForSelector(".harness-card[data-harness=codex]");
  for (const id of ["codex", "claude", "grok"]) {
    assert.ok(await page.locator(`.harness-card[data-harness=${id}]`).count(), id);
  }
  assert.match(await page.textContent("#code-cli-harness-note"), /Off by default|Koinos Code/i);
  assert.equal(await page.isVisible("#desktop-providers"), false, "API cards stay desktop-only without the bridge");

  // Enable Claude from Settings.
  await page.check("#harness-claude-enabled");
  await page.waitForFunction(() => document.querySelector('#harness-claude-enabled')?.checked === true);
  await page.waitForFunction(() => /Enabled for Koinos Code/.test(document.querySelector('[data-harness=claude] [data-harness-state]')?.textContent || ""));
  const listed = await (await fetch(`${base}/core/code/providers`)).json();
  assert.equal(listed.providers.find((p) => p.provider === "claude").enabled, true);

  /*
   * Local-Only blocks ENABLING, not disabling. Claude is already on here, and
   * freezing its checkbox would strand the setting: saved as true, unusable,
   * and with no way to clear it without leaving Local-Only first. Codex is off,
   * so its checkbox is the one that must be frozen.
   */
  core.settings.set("network.privacyMode", "local-only");
  await page.click('[data-view="settings"]');
  await page.waitForFunction(() => /Local-Only/.test(document.getElementById("code-cli-harness-note")?.textContent || ""), null, { timeout: UI_WAIT });
  assert.equal(await page.isDisabled("#harness-codex-enabled"), true, "Local-Only must prevent enabling a disabled harness");
  assert.equal(await page.isDisabled("#harness-claude-enabled"), false, "Local-Only must still allow disabling an enabled harness");

  // The status line must not claim a blocked harness is available.
  const claudeState = await page.textContent("[data-harness=claude] [data-harness-state]");
  assert.match(claudeState, /Enabled, but blocked by Local-Only/, `Local-Only status must be truthful: ${claudeState}`);
  assert.ok(!/Enabled for Koinos Code/.test(claudeState), "a blocked harness must not read as available");

  // ...and disabling actually works, all the way through to Core.
  await page.uncheck("#harness-claude-enabled");
  await page.waitForFunction(() => document.querySelector("#harness-claude-enabled")?.checked === false, null, { timeout: UI_WAIT });
  const afterOff = await (await fetch(`${base}/core/code/providers`)).json();
  assert.equal(afterOff.providers.find((p) => p.provider === "claude").enabled, false, "disabling under Local-Only must persist");
  // Now that it is off, Local-Only must keep it off.
  await page.waitForFunction(() => document.querySelector("#harness-claude-enabled")?.disabled === true, null, { timeout: UI_WAIT });

  // Restore Local-First and open Code → Subscriptions shortcut.
  core.settings.set("network.privacyMode", "local-first");
  await page.click("#btn-code-toggle");
  await page.waitForSelector('[data-view="code"]:not([hidden]), #nav-code:not([hidden]), .nav-item[data-view="code"]');
  // Code nav appears after enabling the switch.
  await page.click('[data-view="code"]');
  await page.waitForSelector("#view-code:not([hidden])");
  // Need a project to see the gear — open start path via browse if needed.
  // Gear is in the chat header; create a temp project through Core then reload list.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "kai-harness-proj-"));
  await fetch(`${base}/core/code/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: project }),
  });
  await page.evaluate(() => window.KaiCode?.render?.());
  // Scope to #kc-projects: .kc-item alone also matches the Koinos node nav,
  // whose buttons live in a hidden view and never become visible.
  await page.waitForSelector("#kc-chat:not([hidden]), #kc-projects .kc-item", { timeout: UI_WAIT });
  // Select first project if on start screen.
  if (await page.isVisible("#kc-start:not([hidden])")) {
    await page.click("#kc-projects .kc-item");
    await page.waitForSelector("#kc-chat:not([hidden])");
  }
  /*
   * The composer's two selectors carried only a `title`, which is a tooltip,
   * not an accessible name — a screen reader announced them as bare combo
   * boxes. Run status was a plain div, so it changed silently.
   */
  const named = await page.evaluate(() => {
    const name = (el) => {
      if (!el) return null;
      if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
      const lab = el.id && document.querySelector(`label[for="${el.id}"]`);
      return lab ? lab.textContent.trim() : null;
    };
    const s = document.getElementById("kc-status");
    return {
      model: name(document.getElementById("kc-model")),
      effort: name(document.getElementById("kc-effort")),
      statusRole: s?.getAttribute("role") || null,
      statusLive: s?.getAttribute("aria-live") || null,
    };
  });
  assert.ok(named.model && named.model.length > 2, `the model selector needs an accessible name, got ${named.model}`);
  assert.ok(named.effort && named.effort.length > 2, `the thinking selector needs an accessible name, got ${named.effort}`);
  assert.equal(named.statusRole, "status", "run status must be announced, not silently swapped");
  assert.equal(named.statusLive, "polite");

  await page.click("#btn-kc-settings");
  await page.waitForSelector("#kc-settings-panel:not([hidden])");
  await page.click("#btn-kc-subs");
  await page.waitForSelector("#kc-subs-panel:not([hidden])");
  assert.match(await page.textContent("#kc-subs-note"), /Settings/i);
  await page.click("#btn-kc-subs-settings");
  await page.waitForSelector("#view-settings:not([hidden])");
  // The focus class is the whole point of the shortcut. The previous form of
  // this assertion also matched plain "#code-cli-harnesses", so it passed
  // whether or not the shortcut did anything.
  await page.waitForSelector("#code-cli-harnesses.harness-focus", { timeout: UI_WAIT });
  assert.equal(await page.locator("#code-cli-harnesses.harness-focus").count(), 1, "the Subscriptions shortcut must highlight the Settings section");
  assert.deepEqual(errors, []);
});

/*
 * /core/code/providers changes which vendor this machine's code may be sent to,
 * so it carries the same forwarded-caller refusal as /core/code/run. Core binds
 * loopback, so the only way to reach it from elsewhere is a reverse proxy the
 * operator put in front — and a proxy commonly strips origin/sec-fetch-site,
 * which is why the forwarded headers are the signal. Both verbs must refuse:
 * a GET discloses which subscriptions exist and whether they are signed in.
 */
test("gateway: /core/code/providers refuses forwarded GET and POST without a core token", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-harness-fwd-"));
  fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });
  const { createCore } = require("../server");
  const core = await createCore({ dataDir, port: 0, onEvent: () => {} });
  core.settings.set("network.privacyMode", "local-first");
  const base = `http://127.0.0.1:${await core.start()}`;
  try {
    for (const header of ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"]) {
      const get = await fetch(`${base}/core/code/providers`, { headers: { [header]: "203.0.113.7" } });
      assert.equal(get.status, 403, `forwarded GET via ${header} must be refused`);
      const getBody = await get.json();
      assert.equal(getBody.ok, false);
      assert.match(getBody.error, /KAI_CORE_TOKEN/);
      assert.ok(!("providers" in getBody), "a refused GET must not disclose the harness list");

      const post = await fetch(`${base}/core/code/providers`, {
        method: "POST",
        headers: { "content-type": "application/json", [header]: "203.0.113.7" },
        body: JSON.stringify({ provider: "grok", enabled: true }),
      });
      assert.equal(post.status, 403, `forwarded POST via ${header} must be refused`);
      assert.match((await post.json()).error, /KAI_CORE_TOKEN/);
    }
    // ...and the refusal is a refusal, not a slow yes: nothing was enabled.
    const local = await (await fetch(`${base}/core/code/providers`)).json();
    assert.equal(local.ok, true);
    assert.equal(local.providers.find((p) => p.provider === "grok").enabled, false);
  } finally {
    await core.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("gateway: /core/code/providers works while Koinos Code switch is off", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-harness-api-"));
  fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const { createCore } = require("../server");
  const core = await createCore({ dataDir, port: 0, onEvent: () => {} });
  core.settings.set("network.privacyMode", "local-first");
  // Ensure Code switch is off.
  core.settings.set("code.enabled", false);
  const base = `http://127.0.0.1:${await core.start()}`;
  try {
    const sw = await (await fetch(`${base}/core/code-switch`)).json();
    assert.equal(sw.enabled, false);
    const get = await (await fetch(`${base}/core/code/providers`)).json();
    assert.equal(get.ok, true);
    assert.ok(get.providers.some((p) => p.id === "cli:codex"));
    const post = await (
      await fetch(`${base}/core/code/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "grok", enabled: true }),
      })
    ).json();
    assert.equal(post.ok, true);
    assert.equal(post.providers.find((p) => p.provider === "grok").enabled, true);
    // Runs still require the switch.
    const run = await fetch(`${base}/core/code/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: dataDir, task: "x", model: "dev-tiny" }),
    });
    assert.equal(run.status, 403);
  } finally {
    await core.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
