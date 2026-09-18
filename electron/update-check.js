"use strict";

/*
 * Turn electron-updater's result into the small, serializable status the
 * renderer needs. Keeping this outside main.js makes the manual Settings
 * path exercise the exact same updater as the automatic boot-time check,
 * without exposing electron-updater (or its download promises) to the page.
 */

const CHECK_ERROR = "Couldn't reach the update service. Check your connection and try again.";

async function checkForDesktopUpdate(updater, { currentVersion = "", logger = console } = {}) {
  try {
    const result = await updater.checkForUpdates();
    if (!result) {
      return {
        kind: "unavailable",
        currentVersion,
        reason: "Update checking isn't available in this copy of Koinos AI.",
      };
    }

    const version = String(result.updateInfo?.version || "");
    if (!result.isUpdateAvailable) return { kind: "current", currentVersion, version };

    if (result.downloadPromise) {
      // checkForUpdates resolves when metadata is found, while the installer
      // keeps downloading. Observe that second promise so a failed download
      // is logged instead of becoming an unhandled rejection.
      void Promise.resolve(result.downloadPromise).catch((error) => {
        logger.error("[update] download failed:", String(error?.message || error));
      });
      return { kind: "downloading", currentVersion, version };
    }
    return { kind: "available", currentVersion, version };
  } catch (error) {
    logger.error("[update] check failed:", String(error?.message || error));
    return { kind: "error", currentVersion, reason: CHECK_ERROR };
  }
}

module.exports = { CHECK_ERROR, checkForDesktopUpdate };
