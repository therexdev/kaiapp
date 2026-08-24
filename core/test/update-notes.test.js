"use strict";

/*
 * The update popup has to answer "what changed?" — the question it raises and
 * never used to answer. These are source assertions rather than a running
 * Electron test because dialog buttons cannot be clicked headlessly, and the
 * failure mode is a button that silently is not there.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const MAIN = fs.readFileSync(path.join(__dirname, "..", "..", "electron", "main.js"), "utf8");
const APP = fs.readFileSync(path.join(__dirname, "..", "..", "ui", "app.js"), "utf8");

test("the notes link is built in exactly one place", () => {
  // Two dialogs and a warning share it. Three hand-written URLs is three
  // chances for one of them to rot into a 404 nobody notices.
  assert.match(MAIN, /const notesUrl = \(version\) =>/);
  const literals = MAIN.match(/koinosai\.com\/updates/g) || [];
  assert.equal(literals.length, 1, `expected one literal URL in main.js, found ${literals.length}`);
});

test("the link is anchored to the version being offered", () => {
  assert.match(MAIN, /#v\$\{encodeURIComponent\(String\(version\)\)\}/);
  // The packaged updater knows the exact version it downloaded — use it.
  assert.match(MAIN, /shell\.openExternal\(notesUrl\(info\.version\)\)/);
});

test("every update dialog offers What's new", () => {
  const dialogs = MAIN.match(/buttons: \[[^\]]*\]/g) || [];
  const update = dialogs.filter((d) => /Restart now|Update and restart|OK", "What's new/.test(d));
  assert.ok(update.length >= 3, `expected 3 update dialogs, found ${update.length}`);
  for (const d of update) assert.match(d, /What's new/, `dialog without notes: ${d}`);
});

test("reading the notes is not the same as declining the update", () => {
  /*
   * The trap: "What's new" sits where "Later" used to, so a careless wiring
   * makes curiosity mark the update declined and it never asks again. The
   * packaged path must still queue the install; the source path must return
   * WITHOUT setting `declined`.
   */
  assert.match(MAIN, /if \(response === 0\) return autoUpdater\.quitAndInstall/);
  const src = MAIN.slice(MAIN.indexOf('buttons: ["Update and restart"'));
  const notesBranch = src.slice(src.indexOf("if (response === 1)"), src.indexOf("if (response !== 0)"));
  assert.ok(!/declined = state\.head/.test(notesBranch),
    "asking what changed must not count as declining the update");
});

test("cancelId points at Later, not at the notes button", () => {
  // Escape must dismiss, never open a browser window.
  for (const m of MAIN.matchAll(/buttons: \[([^\]]*What's new[^\]]*)\][\s\S]{0,120}?cancelId: (\d+)/g)) {
    const buttons = m[1].split(",").map((b) => b.trim().replace(/^"|"$/g, ""));
    assert.notEqual(buttons[Number(m[2])], "What's new",
      `cancelId lands on the notes button: ${m[1]}`);
  }
});

test("the Settings row links to the notes for the running version", () => {
  assert.match(APP, /koinosai\.com\/updates\$\{semver \? `#v\$\{semver\}` : ""\}/);
  assert.match(APP, /target="_blank"/);
  // Every branch of the status row goes through say(), so none of them can
  // quietly drop the link by using textContent again.
  assert.ok(!/host\.textContent =/.test(APP.slice(APP.indexOf("async function renderUpdateStatus"),
    APP.indexOf("$(\"btn-update-check\")"))
    .replace(/host\.textContent = "Couldn't check[^;]*;/, "")),
    "a status branch still writes textContent and would lose the link");
});
