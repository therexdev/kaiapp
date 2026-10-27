"use strict";

const path = require("node:path");
const { unlinkSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { newError } = require("builder-util-runtime");
const { AppImageUpdater } = require("electron-updater/out/AppImageUpdater");

/**
 * Keep electron-updater's verified download/cache and BaseUpdater install
 * lifecycle. Its AppImage integration child needs explicit captured stdio:
 * execFileSync otherwise replays stderr through the parent Writable, where a
 * write failure is an asynchronous stream error outside install's try/catch.
 * This applies to both Restart now and the inherited install-on-quit path.
 * Filename and integration behavior follows electron-updater 6.8.9.
 */
class KaiAppImageUpdater extends AppImageUpdater {
  doInstall(options) {
    const appImageFile = process.env.APPIMAGE;
    if (appImageFile == null) throw newError("APPIMAGE env is not defined", "ERR_UPDATER_OLD_FILE_NOT_FOUND");
    if (!path.isAbsolute(appImageFile) || appImageFile.includes("\0")) {
      throw newError("APPIMAGE env is not a valid absolute path", "ERR_UPDATER_OLD_FILE_NOT_FOUND");
    }
    const installerPath = this.installerPath;
    if (installerPath == null) {
      this.dispatchError(new Error("No update filepath provided, can't quit and install"));
      return false;
    }
    const existingBaseName = path.basename(appImageFile);
    const destination = path.basename(installerPath) === existingBaseName || !/\d+\.\d+\.\d+/.test(existingBaseName)
      ? appImageFile : path.join(path.dirname(appImageFile), path.basename(installerPath));
    unlinkSync(appImageFile);
    execFileSync("mv", ["-f", installerPath, destination], { stdio: "pipe" });
    if (destination !== appImageFile) this.emit("appimage-filename-updated", destination);
    const env = { ...process.env, APPIMAGE_SILENT_INSTALL: "true" };
    if (options.isForceRunAfter) {
      this.spawnLog(destination, [], env);
    } else {
      env.APPIMAGE_EXIT_AFTER_INSTALL = "true";
      // Capturing stderr still retains it on any synchronous child error and
      // still rejects nonzero status; it only avoids writing it to fd 2 here.
      execFileSync(destination, [], { env, stdio: "pipe" });
    }
    return true;
  }
}

module.exports = { KaiAppImageUpdater };
