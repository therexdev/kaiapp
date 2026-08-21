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

function uiScripts() {
  return fs
    .readdirSync(UI_DIR)
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(UI_DIR, f), "utf8") }));
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
