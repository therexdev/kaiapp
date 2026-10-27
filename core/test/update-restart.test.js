"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { EventEmitter } = require("node:events");
const { createUpdateRestart, RESTART_ERROR } = require("../../electron/update-restart");
const { AppImageUpdater } = require("electron-updater/out/AppImageUpdater");

function appFixture() {
  const events = [];
  const app = {
    relaunch(options) { events.push({ action: "relaunch", options }); },
    quit() { events.push({ action: "quit" }); },
    releaseSingleInstanceLock() { throw Error("The shared profile lock must never be released early"); },
  };
  return { app, events };
}

function realUpdater(t, { originalName = "Koinos AI 1.0.0.AppImage", fail = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai updater with spaces "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, originalName), cache = path.join(root, "download cache"), log = path.join(root, "launches.log");
  fs.mkdirSync(cache); fs.writeFileSync(original, "old image");
  const downloaded = path.join(cache, "Koinos AI 1.0.1.AppImage");
  // This reproduces the generated AppImage wrapper's EXIT_AFTER_INSTALL
  // contract without opening any user app, node, wallet or network service.
  const wrapper = `#!/bin/sh\nif [ "$APPIMAGE_EXIT_AFTER_INSTALL" = "true" ]; then\n  printf '%s\\n' "integration:$APPIMAGE_SILENT_INSTALL" >> "$KAI_UPDATE_TEST_LOG"\n  exit ${fail ? 7 : 0}\nfi\nprintf '%s\\n' 'gui-started' >> "$KAI_UPDATE_TEST_LOG"\n`;
  fs.writeFileSync(downloaded, wrapper, { mode: 0o755 });
  const saved = { APPIMAGE: process.env.APPIMAGE, KAI_UPDATE_TEST_LOG: process.env.KAI_UPDATE_TEST_LOG };
  process.env.APPIMAGE = original; process.env.KAI_UPDATE_TEST_LOG = log;
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const quitHandlers = [], adapter = { version: "1.0.0", onQuit: callback => quitHandlers.push(callback), isPackaged: true };
  const updater = new AppImageUpdater(null, adapter); updater.logger = null;
  updater.downloadedUpdateHelper = { file: downloaded, downloadedFileInfo: { isAdminRightsRequired: false } };
  let spawned = 0; updater.spawnLog = async () => { spawned++; return true; };
  return { root, original, downloaded, wrapper, log, updater, quitHandlers, get spawned() { return spawned; } };
}

test("the pinned AppImage updater installs without launching a replacement, then Electron relaunches the renamed path", { skip: process.platform !== "linux" }, async t => {
  const f = realUpdater(t), { app, events } = appFixture();
  const restart = createUpdateRestart({ app, updater: f.updater, platform: "linux", logger: { error() {} } });
  const a = restart(), b = restart(); assert.equal(a, b, "double clicks share one attempt");
  assert.deepEqual(await a, { state: "restarting" }); await b; await restart();
  const destination = path.join(f.root, path.basename(f.downloaded));
  assert.deepEqual(events, [{ action: "relaunch", options: { execPath: destination } }, { action: "quit" }]);
  assert.equal(f.spawned, 0, "the updater never directly launches the replacement");
  assert.equal(fs.readFileSync(f.log, "utf8"), "integration:true\n");
  assert.equal(fs.readFileSync(destination, "utf8"), f.wrapper); assert.equal(fs.existsSync(f.original), false);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.listenerCount("appimage-filename-updated"), 0);
  assert.equal(f.updater.listenerCount("error"), 1, "only the updater's own error listener remains");
});

test("a custom AppImage filename is preserved when the updater emits no rename", { skip: process.platform !== "linux" }, async t => {
  const f = realUpdater(t, { originalName: "My Koinos AI.AppImage" }), { app, events } = appFixture();
  await createUpdateRestart({ app, updater: f.updater, platform: "linux" })();
  assert.equal(events[0].options.execPath, f.original);
  assert.equal(fs.readFileSync(f.original, "utf8"), f.wrapper); assert.equal(f.spawned, 0);
});

test("a real failed AppImage integration never relaunches, repeats installation or silently installs on quit", { skip: process.platform !== "linux" }, async t => {
  const f = realUpdater(t, { fail: true }), { app, events } = appFixture(), errors = [];
  f.updater.addQuitHandler(); assert.equal(f.quitHandlers.length, 1);
  const restart = createUpdateRestart({ app, updater: f.updater, platform: "linux", logger: { error: (...args) => errors.push(args) } });
  const failed = restart(); await assert.rejects(failed, { message: RESTART_ERROR });
  assert.equal(restart(), failed); await assert.rejects(restart(), { message: RESTART_ERROR });
  f.quitHandlers[0](0);
  assert.deepEqual(events, []); assert.equal(f.spawned, 0);
  assert.equal(fs.readFileSync(f.log, "utf8"), "integration:true\n", "failed integration is not executed twice");
  assert.equal(f.updater.autoInstallOnAppQuit, false); assert.equal(errors.length, 1);
  assert.equal(f.updater.listenerCount("appimage-filename-updated"), 0);
});

test("invalid AppImage paths stop before installation or relaunch", async () => {
  for (const APPIMAGE of [undefined, "", "relative.AppImage", "/tmp/invalid\0.AppImage"]) {
    const { app, events } = appFixture(); let installs = 0;
    const updater = Object.assign(new EventEmitter(), { install() { installs++; return true; } });
    const restart = createUpdateRestart({ app, updater, platform: "linux", env: { APPIMAGE }, logger: { error() {} } });
    await assert.rejects(restart(), { message: RESTART_ERROR });
    assert.equal(installs, 0); assert.deepEqual(events, []);
  }
});

test("a changed destination cannot redirect relaunch outside the original AppImage directory", async () => {
  for (const destination of ["relative.AppImage", "/different/Koinos.AppImage", "/tmp/bad\0.AppImage"]) {
    const { app, events } = appFixture();
    const updater = Object.assign(new EventEmitter(), { install() { this.emit("appimage-filename-updated", destination); return true; } });
    const restart = createUpdateRestart({ app, updater, platform: "linux", env: { APPIMAGE: "/tmp/Koinos.AppImage" }, logger: { error() {} } });
    await assert.rejects(restart(), { message: RESTART_ERROR }); assert.deepEqual(events, []);
    assert.equal(updater.listenerCount("appimage-filename-updated"), 0); assert.equal(updater.listenerCount("error"), 0);
  }
});

test("false installation and synchronous installer errors cannot schedule relaunch", async () => {
  for (const behavior of ["false", "throw", "event"]) {
    const { app, events } = appFixture(); let installs = 0;
    const updater = Object.assign(new EventEmitter(), { install() { installs++;
      if (behavior === "throw") throw Error("fixture private details");
      if (behavior === "event") this.emit("error", Error("fixture private details"));
      return behavior === "event";
    } });
    const restart = createUpdateRestart({ app, updater, platform: "linux", env: { APPIMAGE: "/tmp/Koinos.AppImage" }, logger: { error() {} } });
    await assert.rejects(restart(), { message: RESTART_ERROR }); await assert.rejects(restart(), { message: RESTART_ERROR });
    assert.equal(installs, 1); assert.deepEqual(events, []);
  }
});

test("Windows and macOS retain their existing installer restart path with duplicate protection", async () => {
  for (const platform of ["win32", "darwin"]) {
    const { app, events } = appFixture(), calls = [];
    const updater = { quitAndInstall: (...args) => calls.push(args), install() { throw Error("Not an AppImage"); } };
    const restart = createUpdateRestart({ app, updater, platform });
    await Promise.all([restart(), restart()]); await restart();
    assert.deepEqual(calls, [[true, true]]); assert.deepEqual(events, []);
  }
});

test("a relaunch failure after successful installation cannot repeat installation or schedule a second restart", async () => {
  let installs = 0, relaunches = 0, quits = 0;
  const updater = Object.assign(new EventEmitter(), { install() { installs++; return true; } });
  const app = { relaunch() { relaunches++; throw Error("fixture relaunch failure"); }, quit() { quits++; } };
  const restart = createUpdateRestart({ app, updater, platform: "linux", env: { APPIMAGE: "/tmp/Koinos.AppImage" }, logger: { error() {} } });
  await assert.rejects(restart(), { message: RESTART_ERROR }); await assert.rejects(restart(), { message: RESTART_ERROR });
  assert.equal(installs, 1); assert.equal(relaunches, 1); assert.equal(quits, 0);
  assert.equal(updater.autoInstallOnAppQuit, false);
});
