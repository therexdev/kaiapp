"use strict";
const path = require("path");
const { app, BrowserWindow, screen, ipcMain, shell } = require("electron");
const { JsonStore } = require("../../core/lib/store");
const { createMascotController } = require("../../electron/mascot");
const { startMascotServer } = require("../../core/test/fixtures/mascot-server");
const fs = require("fs");
const dir = process.env.KAI_MASCOT_NATIVE_DATA;
if (!dir) throw new Error("The mascot check requires a temporary profile.");
fs.mkdirSync(path.join(dir, "electron"), { recursive: true });
app.setPath("userData", path.join(dir, "electron"));
app.whenReady().then(async () => {
  const fixture = await startMascotServer(dir);
  const main = new BrowserWindow({ width: 800, height: 650, webPreferences: {
    preload: path.join(__dirname, "../../electron/preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  const controller = createMascotController({ BrowserWindow, screen, ipcMain, shell,
    prefs: new JsonStore(path.join(dir, "window.json"), {}), origin: fixture.origin, getMainWindow: () => main });
  globalThis.__kaiMain = main; globalThis.__kaiController = controller;
  await main.loadURL(fixture.origin + "/main-fixture");
  app.on("before-quit", () => { controller.dispose(); fixture.server.close(); fixture.server.closeAllConnections(); });
});
app.on("window-all-closed", () => app.quit());
