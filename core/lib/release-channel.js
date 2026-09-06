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
    port: isTest ? 41101 : 41100,
    ollamaPort: isTest ? 11435 : 11434,
    homeDirName: isTest ? ".koinos-ai-test" : ".koinos-ai",
  };
}

function configureDesktop(app, config) {
  if (config.isTest) {
    // Before Electron's single-instance lock or any session is created.
    // A fixed path also keeps development and installed test builds together.
    app.setName(config.productName);
    app.setPath("userData", path.join(app.getPath("appData"), config.productName));
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
