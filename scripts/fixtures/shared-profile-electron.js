"use strict";

// Runs only in the temporary native-check apps, never against a user's data.
const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");
const { channelConfig, configureDesktop } = require(process.env.KAI_PROFILE_CHECK_CONFIG);
const report = value => {
  const destination = process.env.KAI_PROFILE_CHECK_RESULT;
  fs.writeFileSync(destination + ".tmp", JSON.stringify(value));
  fs.renameSync(destination + ".tmp", destination);
};
const fail = error => { report({ error: error.stack || String(error) }); app.exit(1); };

try {
  const role = process.env.KAI_PROFILE_CHECK_ROLE;
  const appData = process.env.KAI_PROFILE_CHECK_DATA;
  app.setPath("appData", appData);
  // Reproduce the unmodified live app's default path, before Test overrides it.
  app.setPath("userData", path.join(appData, app.getName()));
  if (role === "test") configureDesktop(app, channelConfig("test"));
  else if (process.platform === "win32") app.setAppUserModelId("io.koinosai.desktop");

  if (!app.requestSingleInstanceLock()) {
    report({ locked: false });
    app.quit();
  } else {
    app.whenReady().then(() => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Native OS encryption unavailable");
      const secretPath = path.join(app.getPath("userData"), "credential-probe.bin");
      const expected = "synthetic-live-wallet-session-secret";
      let decrypted;
      if (role === "stable") fs.writeFileSync(secretPath, safeStorage.encryptString(expected));
      else {
        decrypted = safeStorage.decryptString(fs.readFileSync(secretPath));
        if (decrypted !== expected) throw new Error("Test cannot decrypt Live's saved credential");
      }
      report({ locked: true, name: app.getName(), profile: app.getPath("userData"), decrypted });
      const timer = setInterval(() => {
        if (fs.existsSync(process.env.KAI_PROFILE_CHECK_STOP)) {
          clearInterval(timer);
          app.quit();
        }
      }, 30);
    }).catch(fail);
  }
} catch (error) { fail(error); }
