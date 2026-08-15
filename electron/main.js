"use strict";

/*
 * Koinos AI desktop shell. Deliberately thin: it boots Core in-process and
 * opens a window onto the gateway's own UI (http://127.0.0.1:<port>). All
 * app logic lives in core/ and ui/ — the same Core runs headless (spec §9),
 * the same UI runs in a plain browser during development.
 */

const path = require("path");
const { app, BrowserWindow, dialog, shell, ipcMain } = require("electron");

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

// Machine secret for wallet sessions: 32 random bytes, stored encrypted by
// the OS credential store (safeStorage → DPAPI/Keychain). Lets the wallet
// stay unlocked across restarts without ever writing a plaintext key.
function machineSecret(dataDir) {
  try {
    const { safeStorage } = require("electron");
    if (!safeStorage.isEncryptionAvailable()) return null;
    const fs = require("fs");
    const p = path.join(dataDir, "machine-secret.bin");
    if (fs.existsSync(p)) return safeStorage.decryptString(fs.readFileSync(p));
    const secret = require("crypto").randomBytes(32).toString("hex");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(p, safeStorage.encryptString(secret));
    return secret;
  } catch {
    return null; // wallet still works, it just asks for the password again
  }
}

async function start() {
  const dataDir = process.env.KAI_CORE_DATA || path.join(app.getPath("userData"), "core");
  const winState = new JsonStore(path.join(dataDir, "window.json"), {
    bounds: { width: 1100, height: 760 },
  });

  core = await createCore({ dataDir, sessionSecret: machineSecret(dataDir) });
  const port = await core.start();

  win = new BrowserWindow({
    ...winState.get("bounds"),
    minWidth: 780,
    minHeight: 560,
    backgroundColor: "#07090c",
    autoHideMenuBar: true,
    // Frameless: the UI draws its own titlebar so the whole app reads as
    // one designed surface instead of web content in an OS frame.
    frame: false,
    webPreferences: {
      // The renderer is plain same-origin web content; it gets no Node
      // access — only the allowlisted window-chrome bridge.
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Native file picker for model import — the sandboxed renderer can't
  // learn a file's real path any other way.
  ipcMain.handle("dialog:pick-gguf", async () => {
    const r = await dialog.showOpenDialog(win, {
      title: "Choose a GGUF model file",
      filters: [{ name: "GGUF models", extensions: ["gguf"] }],
      properties: ["openFile"],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.on("win:minimize", () => win?.minimize());
  ipcMain.on("win:toggle-maximize", () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on("win:close", () => win?.close());
  const sendMax = () => win?.webContents.send("win:maximize-changed", win.isMaximized());
  win.on("maximize", sendMax);
  win.on("unmaximize", sendMax);

  win.on("close", () => winState.set("bounds", win.getBounds()));
  win.on("closed", () => (win = null));

  // Any external link opens in the system browser, never inside the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  await win.loadURL(`http://127.0.0.1:${port}/`);

  // Earning machines must not doze off: a sleeping laptop was the whole
  // network's "no providers" (field finding — the only provider walked
  // away and the lid logic took the network down). While earning is on,
  // hold a power-save blocker; release it the moment earning stops.
  {
    const { powerSaveBlocker } = require("electron");
    let blockerId = null;
    const syncKeepAwake = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/core/earn`);
        const j = await r.json();
        const earning = !!(j.worker && j.worker.running);
        if (earning && blockerId === null) {
          blockerId = powerSaveBlocker.start("prevent-app-suspension");
        } else if (!earning && blockerId !== null) {
          powerSaveBlocker.stop(blockerId);
          blockerId = null;
        }
      } catch { /* core briefly unreachable — retry next tick */ }
    };
    syncKeepAwake();
    const keepAwakeTimer = setInterval(syncKeepAwake, 30000);
    win.on("closed", () => clearInterval(keepAwakeTimer));
  }

  // Auto-launch at login is opt-in, not default: silently installing into
  // the user's startup list is exactly the kind of behavior alpha testers
  // report as malware-adjacent. A Settings toggle ships it properly later;
  // earners who want always-on can add the app to startup themselves.

  // Auto-update (§34; M1 ships the stable channel only): download in the
  // background, then ask — one dialog when the update is ready to apply,
  // with "Later" falling back to install-on-quit. Packaged builds only.
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require("electron-updater");
      // 0.x releases may be flagged pre-release on GitHub; take them anyway —
      // updaters that ignore the flag see no updates at all (field finding).
      autoUpdater.allowPrerelease = true;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on("update-downloaded", async (info) => {
        if (!win) return;
        const { response } = await dialog.showMessageBox(win, {
          type: "info",
          title: "Update ready",
          message: `Koinos AI ${info.version} is ready to install`,
          detail: `You're on ${app.getVersion()}. Restart now to update, or keep working — it installs when you close the app.`,
          buttons: ["Restart now", "Later"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        // Silent install + relaunch: the app closes, updates, and reopens.
        if (response === 0) autoUpdater.quitAndInstall(true, true);
      });
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
