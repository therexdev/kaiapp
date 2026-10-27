"use strict";

// Native Electron lifecycle fixture. It opens only the harness's temporary
// profile, never Core, a wallet, a network service, or the user's profile.
const fs = require("node:fs"), path = require("node:path");
const { Writable } = require("node:stream");
const { app } = require("electron");
const config = JSON.parse(fs.readFileSync(process.env.KAI_LINUX_RELAUNCH_CONFIG, "utf8"));
const mode = process.env.KAI_LINUX_RELAUNCH_ROLE;
const requested = path.join(config.root, "restart-requested");
const role = mode === "update" && fs.existsSync(requested) ? "replacement" : mode;
const record = (name, extra = {}) => {
  fs.appendFileSync(path.join(config.root, "events.jsonl"), JSON.stringify({ name, role, pid: process.pid, at: Date.now(), ...extra }) + "\n");
};
const report = (name, value) => {
  const file = path.join(config.root, name + ".json");
  fs.writeFileSync(file + ".tmp", JSON.stringify(value)); fs.renameSync(file + ".tmp", file);
};
const fail = error => { record("fixture-error", { message: String(error.stack || error) }); app.exit(2); };
const logger = { error: (...args) => record("lifecycle-error", { message: args.map(String).join(" ") }) };
// This handler belongs only to the disposable acceptance fixture. An escaped
// asynchronous Writable error is a failed test, never a suppressed product error.
process.once("uncaughtException", fail);

app.setPath("appData", path.join(config.root, "app-data"));
const { configureDesktop, channelConfig } = require(config.releaseChannel);
configureDesktop(app, channelConfig("test"));
const locked = app.requestSingleInstanceLock();
record("lock-result", { locked });
if (role === "probe") {
  report(process.env.KAI_LINUX_RELAUNCH_PROBE, { locked, pid: process.pid });
  app.exit(locked ? 3 : 0);
} else if (!locked) {
  report(role, { locked, pid: process.pid }); app.exit(4);
} else {
  app.on("quit", () => record("quit"));
  app.whenReady().then(async () => {
    if (role === "failure") {
      const { createCleanup, failStartup } = require(config.lifecycle);
      const cleanup = createCleanup({ logger });
      cleanup.add("throwing fixture", () => { record("throwing-cleanup"); throw Error("synthetic cleanup failure"); });
      cleanup.add("delayed fixture", async () => { await new Promise(resolve => setTimeout(resolve, 150)); record("failure-cleanup-finished"); });
      report("failure", { locked, pid: process.pid });
      await failStartup({ app, dialog: { showErrorBox() { throw Error("synthetic unavailable dialog"); } },
        error: Error("synthetic startup failure"), cleanup, logger, timeoutMs: 1000 });
      return;
    }
    if (role === "replacement" || role === "reopen") {
      report(role, { locked, pid: process.pid, arch: process.arch, profile: app.getPath("userData"), launcher: process.env.KAI_LINUX_RELAUNCH_LAUNCHER || null });
      const timer = setInterval(() => {
        if (fs.existsSync(path.join(config.root, "stop-" + role))) { clearInterval(timer); app.quit(); }
      }, 20);
      return;
    }
    if (!["update", "install-failure"].includes(role)) throw Error("Unknown fixture role");
    let drained = false, drainStarted = false, installs = 0;
    app.on("before-quit", event => {
      if (role === "install-failure") return;
      if (drained) return;
      event.preventDefault();
      if (!drainStarted) {
        drainStarted = true; record("quit-delayed"); report("draining", { pid: process.pid });
        const deadline = setTimeout(() => { record("cleanup-gate-timeout"); app.exit(2); }, 30000);
        const gate = setInterval(() => {
          if (!fs.existsSync(path.join(config.root, "finish-cleanup"))) return;
          clearInterval(gate); clearTimeout(deadline); drained = true; record("cleanup-finished"); app.quit();
        }, 20);
      }
    });
    const { KaiAppImageUpdater } = require(config.updaterModule);
    const updater = new KaiAppImageUpdater(null, { version: "1.0.0", isPackaged: true,
      onQuit: callback => app.on("quit", (_event, code) => callback(code)) });
    updater.logger = null;
    updater.downloadedUpdateHelper = { file: config.downloadedExecutable, downloadedFileInfo: { isAdminRightsRequired: false } };
    updater.addQuitHandler();
    const install = updater.doInstall.bind(updater);
    updater.doInstall = options => {
      installs++; record("install", options);
      if (options.isSilent !== true || options.isForceRunAfter !== false) throw Error("The fixture must not launch before the original exits");
      return install(options);
    };
    process.env.APPIMAGE = config.originalExecutable;
    const restart = require(config.updateRestart).createUpdateRestart({ app, updater, platform: "linux",
      env: { APPIMAGE: config.originalExecutable }, logger });
    report(role, { locked, pid: process.pid, arch: process.arch, profile: app.getPath("userData") });
    const timer = setInterval(async () => {
      if (!fs.existsSync(path.join(config.root, "restart"))) return;
      clearInterval(timer); fs.writeFileSync(requested, "requested");
      const descriptor = Object.getOwnPropertyDescriptor(process, "stderr");
      let parentStderrWrites = 0;
      const brokenStderr = new Writable({ write(_chunk, _encoding, callback) {
        parentStderrWrites++;
        const error = Error("EFAULT: bad address in system call argument, write"); error.code = "EFAULT";
        callback(error);
      } });
      Object.defineProperty(process, "stderr", { configurable: true, value: brokenStderr });
      try {
        if (role === "install-failure") {
          const failed = restart();
          if (restart() !== failed) throw Error("Duplicate failed restart did not share its attempt");
          let rejected;
          try { await failed; } catch (error) { rejected = error; }
          if (rejected?.message !== require(config.updateRestart).RESTART_ERROR) throw Error("Failed integration was not rejected");
          await new Promise(resolve => setImmediate(resolve));
          report("restart-error", { expected: true, installs, parentStderrWrites, autoInstallOnAppQuit: updater.autoInstallOnAppQuit });
          const stop = setInterval(() => {
            if (fs.existsSync(path.join(config.root, "stop-install-failure"))) { clearInterval(stop); app.quit(); }
          }, 20);
        } else {
          const results = await Promise.all([restart(), restart()]);
          await new Promise(resolve => setImmediate(resolve));
          report("restart-result", { results, installs, parentStderrWrites });
        }
      } catch (error) { fail(error); }
      finally { Object.defineProperty(process, "stderr", descriptor); }
    }, 20);
  }).catch(fail);
}
