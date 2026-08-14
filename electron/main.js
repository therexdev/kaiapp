"use strict";

/*
 * Koinos AI desktop shell. Deliberately thin: it boots Core in-process and
 * opens a window onto the gateway's own UI (http://127.0.0.1:<port>). All
 * app logic lives in core/ and ui/ — the same Core runs headless (spec §9),
 * the same UI runs in a plain browser during development.
 */

const path = require("path");
const { app, BrowserWindow, shell } = require("electron");

const { createCore } = require("../core/server");
const { JsonStore } = require("../core/lib/store");

let core = null;
let win = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(start);
}

async function start() {
  const dataDir = process.env.KAI_CORE_DATA || path.join(app.getPath("userData"), "core");
  const winState = new JsonStore(path.join(dataDir, "window.json"), {
    bounds: { width: 1100, height: 760 },
  });

  core = await createCore({ dataDir });
  const port = await core.start();

  win = new BrowserWindow({
    ...winState.get("bounds"),
    minWidth: 780,
    minHeight: 560,
    backgroundColor: "#07090c",
    autoHideMenuBar: true,
    webPreferences: {
      // The renderer is plain same-origin web content; it gets no Node access.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.on("close", () => winState.set("bounds", win.getBounds()));
  win.on("closed", () => (win = null));

  // Any external link opens in the system browser, never inside the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  await win.loadURL(`http://127.0.0.1:${port}/`);

  // Auto-update (§34; M1 ships the stable channel only): silent download,
  // install on quit — no interruptions mid-chat. Packaged builds only.
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require("electron-updater");
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      const check = () => autoUpdater.checkForUpdates().catch(() => {});
      check();
      setInterval(check, 4 * 3600 * 1000);
    } catch {
      /* updater unavailable (e.g. unpacked build) — never block the app */
    }
  }
}

app.on("window-all-closed", () => app.quit());

app.on("quit", () => {
  // Stop the llama-server child with the app; nothing keeps running hidden.
  if (core) core.runtime.stop();
});
