"use strict";

// Native Electron lifecycle fixture. It opens only the harness's temporary
// profile, never Core, a wallet, a network service, or the user's profile.
const fs = require("node:fs"), path = require("node:path");
const { EventEmitter } = require("node:events");
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
      report(role, { locked, pid: process.pid, profile: app.getPath("userData"), launcher: process.env.KAI_LINUX_RELAUNCH_LAUNCHER || null });
      const timer = setInterval(() => {
        if (fs.existsSync(path.join(config.root, "stop-" + role))) { clearInterval(timer); app.quit(); }
      }, 20);
      return;
    }
    if (role !== "update") throw Error("Unknown fixture role");
    let drained = false, drainStarted = false, installs = 0;
    app.on("before-quit", event => {
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
    const updater = new EventEmitter();
    updater.install = (silent, forceRunAfter) => {
      installs++; record("install", { silent, forceRunAfter });
      if (silent !== true || forceRunAfter !== false) throw Error("The fixture must not launch before the original exits");
      updater.emit("appimage-filename-updated", config.replacementExecutable);
      return true;
    };
    const restart = require(config.updateRestart).createUpdateRestart({ app, updater, platform: "linux",
      env: { APPIMAGE: config.originalExecutable }, logger });
    report("update", { locked, pid: process.pid, profile: app.getPath("userData") });
    const timer = setInterval(async () => {
      if (!fs.existsSync(path.join(config.root, "restart"))) return;
      clearInterval(timer); fs.writeFileSync(requested, "requested");
      try {
        const results = await Promise.all([restart(), restart()]);
        report("restart-result", { results, installs });
      } catch (error) { fail(error); }
    }, 20);
  }).catch(fail);
}
