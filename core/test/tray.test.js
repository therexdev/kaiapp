"use strict";

/*
 * The X closes the window to the notification area instead of quitting. That
 * behaviour lives in electron/main.js, which cannot be require()d without a
 * running Electron — so these are static proofs of the parts that fail
 * silently in a packaged build while working perfectly in a dev checkout:
 * an icon that never shipped, a bridge the UI asks for and never gets, and
 * (the one that would strand a tester) a hidden window with no way to quit.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

test("the tray icon the shell loads is actually shipped in the package", () => {
  const main = read("electron", "main.js");
  // Whatever main.js names, it must be a real file AND be packaged. Missing
  // either way the tray silently fails to build and only ever in a release.
  const names = [...main.matchAll(/"(icon\.(?:ico|png))"/g)].map((m) => m[1]);
  assert.ok(names.length >= 2, "main.js should pick a per-platform tray icon");

  const pkg = JSON.parse(read("package.json"));
  const files = pkg.build.files.join("\n");
  for (const name of new Set(names)) {
    assert.ok(
      fs.existsSync(path.join(root, "build", name)),
      `build/${name} is referenced by the shell but not in the repo`,
    );
    assert.ok(
      files.includes(`build/${name}`) || files.includes("build/**"),
      `build/${name} is loaded at runtime but electron-builder does not ship it`,
    );
  }
});

test("a window hidden in the tray can always still be quit", () => {
  const main = read("electron", "main.js");
  // Close is only allowed to hide while `quitting` is false, so every real
  // quit has to set it first — otherwise close-to-tray would swallow the
  // quit and the app could never be shut down.
  assert.match(
    main,
    /app\.on\("before-quit",\s*\(\)\s*=>\s*\{\s*quitting\s*=\s*true;?\s*\}\)/,
    "before-quit must set the quitting flag",
  );
  assert.match(main, /label:\s*"Quit Koinos AI"/, "the tray menu needs a Quit item");
  assert.match(
    main,
    /"Quit Koinos AI",\s*click:\s*\(\)\s*=>\s*\{\s*quitting\s*=\s*true;\s*app\.quit\(\);?\s*\}/,
    "the tray's Quit must force a real quit, not another trip to the tray",
  );
  // And the window must be shown again on relaunch — a second instance that
  // silently does nothing looks exactly like an app that will not start.
  assert.match(main, /second-instance[\s\S]{0,220}win\.show\(\)/, "second-instance must unhide the window");
});

test("closing to the tray is announced the first time, and declinable", () => {
  const main = read("electron", "main.js");
  assert.match(main, /trayNoticeSeen/, "the first-close notice must be remembered, not repeated");
  assert.match(
    main,
    /buttons:\s*\["Keep running",\s*"Close the app instead"\]/,
    "the notice must offer a way out on the spot",
  );
  // Declining sets the pref AND honours the press that triggered it.
  assert.match(
    main,
    /winState\.set\("closeToTray",\s*false\);[\s\S]{0,120}app\.quit\(\)/,
    "choosing 'Close the app instead' must both save the pref and quit now",
  );
});

test("Settings can reach the pref, and hides the switch when there is no tray", () => {
  const preload = read("electron", "preload.js");
  assert.match(preload, /windowPrefs:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("shell:window-prefs"\)/);
  assert.match(preload, /setCloseToTray:\s*\(on\)\s*=>\s*ipcRenderer\.invoke\("shell:set-close-to-tray",\s*on\)/);

  const main = read("electron", "main.js");
  assert.match(main, /ipcMain\.handle\("shell:window-prefs"/);
  assert.match(main, /ipcMain\.handle\("shell:set-close-to-tray"/);
  // The pref can never be true without a tray to make it survivable.
  assert.match(main, /winState\.set\("closeToTray",\s*!!on\s*&&\s*!!tray\)/);

  const html = read("ui", "index.html");
  const block = html.match(/<div id="settings-window"[\s\S]*?<\/button>/);
  assert.ok(block, "no #settings-window block in Settings");
  assert.match(block[0], /^<div id="settings-window" hidden>/, "the block must start hidden");
  assert.match(block[0], /id="btn-tray-toggle"[^>]*role="switch"/);
  // Same failure as v0.50.1's invisible switch: a .switch is its children.
  assert.match(block[0], /switch-track[\s\S]*switch-thumb/);

  const app = read("ui", "app.js");
  assert.match(app, /settings-window"\)\.hidden\s*=\s*!p\s*\|\|\s*!p\.trayAvailable/,
    "the section must stay hidden unless the shell reports a working tray");
});
