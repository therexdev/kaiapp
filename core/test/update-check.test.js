"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CHECK_ERROR, checkForDesktopUpdate } = require("../../electron/update-check");

test("desktop update checks report an installed build as current", async () => {
  const status = await checkForDesktopUpdate({
    checkForUpdates: async () => ({
      isUpdateAvailable: false,
      updateInfo: { version: "0.54.10-test.124.1" },
    }),
  }, { currentVersion: "0.54.10-test.124.1" });
  assert.deepEqual(status, {
    kind: "current",
    currentVersion: "0.54.10-test.124.1",
    version: "0.54.10-test.124.1",
  });
});

test("desktop update checks report and observe an automatic download", async () => {
  const errors = [];
  const status = await checkForDesktopUpdate({
    checkForUpdates: async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: "0.54.10-test.125.1" },
      downloadPromise: Promise.reject(new Error("fixture download failure")),
    }),
  }, { currentVersion: "0.54.10-test.124.1", logger: { error: (...args) => errors.push(args.join(" ")) } });
  assert.deepEqual(status, {
    kind: "downloading",
    currentVersion: "0.54.10-test.124.1",
    version: "0.54.10-test.125.1",
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(errors.join("\n"), /fixture download failure/);
});

test("desktop update failures return safe actionable text", async () => {
  const errors = [];
  const status = await checkForDesktopUpdate({
    checkForUpdates: async () => { throw new Error("private proxy details"); },
  }, { currentVersion: "1.2.3", logger: { error: (...args) => errors.push(args.join(" ")) } });
  assert.deepEqual(status, { kind: "error", currentVersion: "1.2.3", reason: CHECK_ERROR });
  assert.doesNotMatch(JSON.stringify(status), /private proxy details/);
  assert.match(errors.join("\n"), /private proxy details/);
});

test("Settings reaches the packaged updater through trusted shell IPC", () => {
  const root = path.join(__dirname, "..", "..");
  const preload = fs.readFileSync(path.join(root, "electron", "preload.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "electron", "main.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "ui", "app.js"), "utf8");
  assert.match(preload, /checkForUpdates:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("shell:check-for-updates"\)/);
  assert.match(main, /ipcMain\.handle\("shell:check-for-updates"/);
  assert.match(main, /requireMain\(event\)/);
  assert.match(main, /downloadedVersion\s*=\s*String\(info\.version/);
  assert.match(main, /kind:\s*"downloaded"/);
  assert.match(app, /window\.koinosShell\.checkForUpdates\(\)/);
  assert.match(app, /up to date\. Checked just now\./);
  assert.match(app, /downloading it now/);
  assert.match(app, /ready and will install when you close the app/);
});
