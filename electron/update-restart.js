"use strict";

const path = require("node:path");

const RESTART_ERROR = "The update could not finish restarting Koinos AI. Your existing app is still open. Quit it before opening the updated app again.";

function appImagePath(value, directory) {
  if (typeof value !== "string" || !value || value.includes("\0") || !path.isAbsolute(value) ||
      directory && path.dirname(value) !== directory) throw Error("Invalid AppImage restart destination");
  return value;
}

/**
 * One downloaded update gets one installation/relaunch attempt. Electron's
 * AppImage updater otherwise spawns the replacement BEFORE quitting this
 * process, which still owns the shared Live/Test profile lock at that point.
 * Never release that lock early: Electron relaunch waits for this process exit.
 */
function createUpdateRestart({ app, updater, platform = process.platform, env = process.env, logger = console }) {
  let attempt;
  return function restart() {
    if (attempt) return attempt;
    attempt = Promise.resolve().then(() => {
      if (platform !== "linux") {
        updater.quitAndInstall(true, true);
        return { state: "restarting" };
      }

      const original = appImagePath(env.APPIMAGE), directory = path.dirname(original);
      if (typeof updater.install !== "function") throw Error("AppImage installation is unavailable");
      let destination = original, installError = null;
      const renamed = value => { destination = appImagePath(value, directory); };
      const failed = error => { installError = error; };
      updater.on("appimage-filename-updated", renamed);
      updater.on("error", failed);
      try {
        // A failed public install() can leave a partially moved AppImage. Do
        // not silently repeat that operation on quit or a second button click.
        updater.autoInstallOnAppQuit = false;
        const installed = updater.install(true, false);
        if (installed !== true || installError) throw installError || Error("AppImage installation did not complete");
      } finally {
        updater.removeListener("appimage-filename-updated", renamed);
        updater.removeListener("error", failed);
      }

      // With forceRunAfter=false the AppImage wrapper updates integration and
      // exits; it never opens a second GUI. Relaunch starts it after app exit,
      // including any delayed shutdown. No lock deletion or early unlock.
      app.relaunch({ execPath: destination });
      app.quit();
      return { state: "restarting" };
    }).catch(error => {
      try { logger.error("[update] restart failed:", String(error?.stack || error)); } catch { /* logging cannot hide the error */ }
      throw new Error(RESTART_ERROR, { cause: error });
    });
    return attempt;
  };
}

module.exports = { createUpdateRestart, RESTART_ERROR };
