"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { EventEmitter } = require("node:events");
const { createUpdateRestart, RESTART_ERROR } = require("../../electron/update-restart");
const { KaiAppImageUpdater } = require("../../electron/appimage-updater");

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
  const updater = new KaiAppImageUpdater(null, adapter); updater.logger = null;
  updater.downloadedUpdateHelper = { file: downloaded, downloadedFileInfo: { isAdminRightsRequired: false } };
  let spawned = 0; updater.spawnLog = async () => { spawned++; return true; };
  return { root, original, downloaded, wrapper, log, updater, quitHandlers, get spawned() { return spawned; } };
}

test("the app's AppImage updater installs without launching a replacement, then Electron relaunches the renamed path", { skip: process.platform !== "linux" }, async t => {
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

test("real AppImage integration stderr cannot become an uncaught parent stream error on restart or normal quit", { skip: process.platform !== "linux" }, t => {
  const { spawnSync } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai updater stderr "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modulePath = path.resolve(__dirname, "../../electron/appimage-updater.js");
  const restartPath = path.resolve(__dirname, "../../electron/update-restart.js");
  for (const mode of ["restart", "quit"]) for (const status of [0, 7]) {
    const folder = path.join(root, mode + status); fs.mkdirSync(folder);
    const original = path.join(folder, "Koinos AI 1.0.0.AppImage"), cache = path.join(folder, "cache");
    fs.mkdirSync(cache); fs.writeFileSync(original, "previous image");
    const downloaded = path.join(cache, "Koinos AI 1.0.1.AppImage");
    fs.writeFileSync(downloaded, `#!/bin/sh\ntest "$APPIMAGE_EXIT_AFTER_INSTALL" = true || exit 20\nprintf 'integration diagnostic' >&2\nexit ${status}\n`, { mode: 0o755 });
    // Use an isolated process: Writable emits this write failure after the
    // synchronous install() try/catch has returned. Never install an app-wide
    // uncaughtException handler to conceal that asynchronous failure.
    const script = `
      const fs = require('node:fs'), { Writable } = require('node:stream');
      const { KaiAppImageUpdater } = require(${JSON.stringify(modulePath)});
      const { createUpdateRestart } = require(${JSON.stringify(restartPath)});
      const streamErrors = [], installerErrors = [], events = [], handlers = [];
      let parentWrites = 0, rejected = false;
      Object.defineProperty(process, 'stderr', { value: new Writable({ write(chunk, encoding, callback) {
        parentWrites++; const error = Error('fixture parent stderr is unavailable'); error.code = 'EFAULT'; callback(error);
      } }) });
      process.on('uncaughtException', error => streamErrors.push(error.code || error.message));
      process.env.APPIMAGE = ${JSON.stringify(original)};
      const updater = new KaiAppImageUpdater(null, { version: '1.0.0', isPackaged: true, onQuit: callback => handlers.push(callback) });
      updater.logger = null;
      updater.on('error', error => installerErrors.push({ status: error.status, stderr: String(error.stderr || '') }));
      updater.downloadedUpdateHelper = { file: ${JSON.stringify(downloaded)}, downloadedFileInfo: { isAdminRightsRequired: false } };
      const app = { relaunch() { events.push('relaunch'); }, quit() { events.push('quit'); } };
      (async () => {
        if (${JSON.stringify(mode)} === 'quit') { updater.addQuitHandler(); handlers[0](0); }
        else { try { await createUpdateRestart({ app, updater, platform: 'linux', logger: { error() {} } })(); } catch { rejected = true; } }
        setImmediate(() => fs.writeSync(1, JSON.stringify({ parentWrites, streamErrors, installerErrors, events, rejected, installedOnce: updater.quitAndInstallCalled })));
      })();`;
    const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.error, undefined);
    const result = JSON.parse(child.stdout);
    assert.equal(result.parentWrites, 0, "integration diagnostics never replay into the GUI's stderr");
    assert.deepEqual(result.streamErrors, [], "the asynchronous EFAULT cannot escape installation");
    assert.equal(result.installedOnce, true);
    assert.deepEqual(result.installerErrors, status ? [{ status: 7, stderr: "integration diagnostic" }] : [], "a genuine child failure retains its status and diagnostic");
    assert.deepEqual(result.events, mode === "restart" && status === 0 ? ["relaunch", "quit"] : []);
    assert.equal(result.rejected, mode === "restart" && status !== 0);
  }
});

test("the stderr failure fixture reproduces the uncaught execFileSync replay the AppImage fix prevents", { skip: process.platform !== "linux" }, () => {
  const { spawnSync } = require("node:child_process");
  const child = spawnSync(process.execPath, ["-e", `
    const fs = require('node:fs'), { Writable } = require('node:stream');
    const errors = []; let caught = false;
    Object.defineProperty(process, 'stderr', { value: new Writable({ write(chunk, encoding, callback) {
      const error = Error('fixture stderr'); error.code = 'EFAULT'; callback(error);
    } }) });
    process.on('uncaughtException', error => errors.push(error.code));
    try { require('node:child_process').execFileSync('/bin/sh', ['-c', 'printf integration-diagnostic >&2']); }
    catch { caught = true; }
    setImmediate(() => fs.writeSync(1, JSON.stringify({ errors, caught })));
  `], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { errors: ["EFAULT"], caught: false });
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
