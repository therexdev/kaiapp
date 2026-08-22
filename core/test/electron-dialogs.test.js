"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/*
 * window.prompt() DOES NOT EXIST IN ELECTRON.
 *
 * It returns null without ever showing anything, so any button that depends on
 * it silently does nothing in the packaged app. This has now bitten the project
 * TWICE: once in the MCP "Your files" catalog entry (field report), and again
 * in the first Koinos Code workspace UI, where nine prompt() calls made every
 * button in the view dead on the desktop while the Chromium test passed
 * happily — because Playwright is a real browser and prompt() works there.
 *
 * That is why this test is STATIC rather than behavioural: no browser test can
 * catch it, because no browser reproduces the missing API. A grep is the only
 * thing that fails in the same environment where the bug is written.
 *
 * alert() and confirm() DO work in Electron and are allowed.
 */

const UI_DIR = path.join(__dirname, "..", "..", "ui");

/*
 * Every script under ui/, not just the top level. This used to stop at the
 * first directory, which left ui/knode/bridge.js — the file that adapts the
 * embedded node app, and the one place dialogs get ADDED to it — outside the
 * net the whole test exists to cast.
 */
function uiScripts(dir = UI_DIR, prefix = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...uiScripts(path.join(dir, e.name), rel));
    else if (e.name.endsWith(".js")) out.push({ file: rel, text: fs.readFileSync(path.join(dir, e.name), "utf8") });
  }
  return out;
}

/** Strip comments so the warning ABOUT prompt() does not read as a use of it. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no UI script calls window.prompt() — it is a no-op in Electron", () => {
  const offenders = [];
  for (const { file, text } of uiScripts()) {
    const code = stripComments(text);
    const lines = code.split("\n");
    lines.forEach((line, i) => {
      // `prompt(` as a call, whether or not it is reached through window.
      if (/(^|[^.\w])(window\s*\.\s*)?prompt\s*\(/.test(line)) {
        offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepStrictEqual(
    offenders,
    [],
    "window.prompt() is a no-op in Electron — use an inline form, or koinosShell.pickFolder for folders:\n" +
      offenders.join("\n")
  );
});

test("the Koinos Code view reaches for the native folder picker, and degrades without it", () => {
  const src = fs.readFileSync(path.join(UI_DIR, "code-view.js"), "utf8");
  // The packaged app must get the real OS dialog...
  assert.match(src, /koinosShell\?\.pickFolder/, "the native picker is used when the shell offers one");
  // ...and the served UI, which has no shell, must still be able to choose.
  assert.match(src, /\/core\/code\/browse/, "an in-app browser exists for the served UI");
});

test("the preload actually exposes the picker the view depends on", () => {
  // A view calling koinosShell.pickFolder is only correct while the bridge
  // still exports it; this pins the two together.
  const preload = fs.readFileSync(path.join(__dirname, "..", "..", "electron", "preload.js"), "utf8");
  assert.match(preload, /pickFolder:\s*\(/);
  const main = fs.readFileSync(path.join(__dirname, "..", "..", "electron", "main.js"), "utf8");
  assert.match(main, /ipcMain\.handle\("dialog:pick-folder"/);
  assert.match(main, /openDirectory/);
});

/*
 * v0.41.1 — two field reports from the same screen, both invisible to every
 * test we had because both are pure CSS reachability.
 *
 * 1. "when you scroll down on the settings page it scrolls the whole sidebar
 *    too." A .view that is not in the scrolling rule does not merely fail to
 *    scroll — it GROWS THE PAGE, so the window scrolls and takes the sidebar
 *    with it. #view-settings shipped without it.
 * 2. "make the toggle switch for koinos code justified to the right like the
 *    rest and separate it from the developer tools toggles with a line." That
 *    block carried class="switch-row" — a class this stylesheet has NEVER
 *    defined. It got no flex, no justification and no rule above it, and it
 *    had been that way since it was written; moving it into Settings just put
 *    it next to correct rows where the difference finally showed.
 *
 * Both are the same underlying failure: markup naming a class that does not
 * exist, or a view missing from a list it had to be added to by hand. So the
 * guard is mechanical — every class the markup uses must be defined somewhere.
 */
test("every card view scrolls itself, so the page never scrolls the sidebar", () => {
  const html = fs.readFileSync(path.join(UI_DIR, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(UI_DIR, "styles.css"), "utf8");
  // Views that are deliberately not scroll-and-pad: onboarding centres itself,
  // chat scrolls #messages, docs/compare/code manage their own inner panes.
  const SELF_MANAGED = new Set(["onboarding", "chat", "docs", "compare", "code", "koinos"]);
  const views = [...html.matchAll(/id="view-([a-z-]+)" class="view/g)].map((m) => m[1]);
  assert.ok(views.length > 8, `expected the full view list, got ${views.length}`);
  for (const v of views) {
    if (SELF_MANAGED.has(v)) continue;
    assert.ok(
      new RegExp(`#view-${v}[ ,{]`).test(css),
      `#view-${v} is in no scrolling rule — it will grow the page and scroll the sidebar with it`
    );
  }
});

test("no markup names a class the stylesheet never defines", () => {
  const html = fs.readFileSync(path.join(UI_DIR, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(UI_DIR, "styles.css"), "utf8");
  const used = new Set();
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  }
  /*
   * Behavioural hooks, exempt on purpose: these are markers the SCRIPTS select
   * on and nothing else. Styling them would be the mistake. Anything not on
   * this list that the stylesheet does not define is markup asking for a look
   * it will never get — which is precisely how the Koinos Code switch spent
   * its whole life un-justified with no rule above it.
   */
  const HOOKS = new Set(["koinos-view", "showpw"]);
  for (const h of HOOKS) used.delete(h);
  const missing = [...used].filter((c) => !new RegExp(`\\.${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s,.:>{)\\[]`).test(css));
  assert.deepStrictEqual(missing, [], `these classes are styled nowhere: ${missing.join(", ")}`);
});
