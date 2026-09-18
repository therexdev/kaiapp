"use strict";

const path = require("path");
const pkg = require("../../package.json");

const TEST_FEED = "https://github.com/therexdev/kaiapp/releases/download/test-build/";
const MASTER_FEED = "https://github.com/therexdev/kaiapp/releases/download/master-build/";

function channelConfig(channel = process.env.KAI_CHANNEL || pkg.kaiChannel || "stable") {
  if (!["test", "stable", "master"].includes(channel)) throw new Error(`Unknown KAI channel: ${channel}`);
  if (channel === "master") return { channel, isTest: false, isMaster: true, productName: "Master Koinos AI Node", appId: "io.koinosai.desktop.master", port: 41101, ollamaPort: 11434, homeDirName: ".master-koinos-ai" };
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
  if (config.isMaster) { app.setName(config.productName); const profile = path.join(app.getPath("appData"), config.productName); app.setPath("userData", profile); app.setPath("sessionData", profile); }
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
  if (config.isMaster) { updater.setFeedURL({ provider: "generic", url: MASTER_FEED, channel: "master" }); updater.channel = "master"; }
  if (config.isTest) {
    updater.setFeedURL({ provider: "generic", url: TEST_FEED, channel: "test" });
    updater.channel = "test";
  }
  updater.allowPrerelease = config.isTest || !!config.isMaster;
  // Setting a channel enables downgrades in electron-updater; undo that.
  updater.allowDowngrade = false;
}

module.exports = { channelConfig, configureDesktop, configureUpdater, TEST_FEED, MASTER_FEED };
