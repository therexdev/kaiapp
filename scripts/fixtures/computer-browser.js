"use strict";
// Separate Chromium process: the desktop helper must never control KAI itself.
const { app, BrowserWindow } = require("electron");
const path = require("path");
if (!process.env.KAI_COMPUTER_QA_PROFILE) throw new Error("An isolated QA profile is required.");
app.setPath("userData", path.join(process.env.KAI_COMPUTER_QA_PROFILE, "browser"));
app.commandLine.appendSwitch("force-renderer-accessibility");
app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true);
  const window = new BrowserWindow({ x: 50, y: 50, width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  globalThis.__qaWindow = window;
  await window.loadFile(path.join(__dirname, "computer-browser.html"));
  window.show(); window.focus();
});
app.on("window-all-closed", () => app.quit());
