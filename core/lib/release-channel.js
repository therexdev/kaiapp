"use strict";

const path = require("path");
const pkg = require("../../package.json");

const TEST_FEED = "https://github.com/therexdev/kaiapp/releases/download/test-build/";

function channelConfig(channel = process.env.KAI_CHANNEL || pkg.kaiChannel || "stable") {
  if (!["test", "stable"].includes(channel)) throw new Error(`Unknown KAI channel: ${channel}`);
  const isTest = channel === "test";
  return {
    channel, isTest,
    productName: isTest ? "Koinos AI Test" : "Koinos AI",
    appId: isTest ? "io.koinosai.desktop.test" : "io.koinosai.desktop",
    // Test exercises the owner's existing live node and profile.
    port: 41100,
    ollamaPort: 11434,
    homeDirName: ".koinos-ai",
  };
}

function configureDesktop(app, config) {
  if (config.isTest) {
    // Keep the live OS credential identity and singleton/profile path. The
    // installer, window/tray label and updater still use Test's own identity.
    // This must run before the single-instance lock or any session is created.
    app.setName("Koinos AI");
    const liveProfile = path.join(app.getPath("appData"), "Koinos AI");
    app.setPath("userData", liveProfile);
    app.setPath("sessionData", liveProfile);
  }
  if (process.platform === "win32") app.setAppUserModelId(config.appId);
}

function configureUpdater(updater, config) {
  if (config.isTest) {
    updater.setFeedURL({ provider: "generic", url: TEST_FEED, channel: "test" });
    updater.channel = "test";
  }
  updater.allowPrerelease = config.isTest;
  // Setting a channel enables downgrades in electron-updater; undo that.
  updater.allowDowngrade = false;
}

module.exports = { channelConfig, configureDesktop, configureUpdater, TEST_FEED };
