"use strict";

/*
 * Koinos AI desktop shell. Deliberately thin: it boots Core in-process and
 * opens a window onto the gateway's own UI (http://127.0.0.1:<port>). All
 * app logic lives in core/ and ui/ — the same Core runs headless (spec §9),
 * the same UI runs in a plain browser during development.
 */

const path = require("path");
const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell, ipcMain } = require("electron");

const { createCore } = require("../core/server");
const { JsonStore } = require("../core/lib/store");

let core = null;
let win = null;
let tray = null;
// Set the moment a real quit begins, so the close handler below knows the
// difference between "the user pressed X" and "the app is going down".
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // The window may be parked in the tray rather than merely minimized —
    // launching the app again is a request to see it, either way.
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
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

  // Tool servers that take a folder ("Your files"): a native picker is the
  // only honest way to choose one — window.prompt() does not exist in
  // Electron, which is why the old flow died silently (field report).
  ipcMain.handle("dialog:pick-folder", async (_e, title) => {
    const r = await dialog.showOpenDialog(win, {
      title: typeof title === "string" && title ? title : "Choose a folder",
      properties: ["openDirectory"],
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

  function showWindow() {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  /*
   * The notification-area icon. It is what makes closing-to-tray honest: hide
   * the window with no icon to bring it back and the app is simply gone while
   * still running. So the tray comes first, and if the platform will not give
   * us one, closing keeps its old meaning and quits.
   */
  try {
    let iconPath = path.join(
      __dirname, "..", "build",
      process.platform === "win32" ? "icon.ico" : "icon.png",
    );
    // Some Linux tray backends hand the path to another process, which cannot
    // see inside the asar — prefer the unpacked copy when there is one.
    const unpacked = iconPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    if (unpacked !== iconPath && require("fs").existsSync(unpacked)) iconPath = unpacked;

    let image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) throw new Error(`no usable icon at ${iconPath}`);
    // Windows picks the right size out of the .ico itself; everywhere else a
    // 512px PNG becomes a smear in a 22px slot.
    if (process.platform !== "win32") image = image.resize({ width: 22, height: 22 });
    if (process.platform === "darwin") image.setTemplateImage(true);

    tray = new Tray(image);
    tray.setToolTip("Koinos AI");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open Koinos AI", click: showWindow },
      { type: "separator" },
      { label: "Quit Koinos AI", click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on("click", showWindow);
    tray.on("double-click", showWindow);
  } catch (e) {
    console.error("[tray] no notification-area icon, X will quit:", String(e?.message || e));
    tray = null;
  }

  // macOS: the dock icon stays after hiding, and clicking it means "come back".
  app.on("activate", showWindow);

  const closeHidesWindow = () => !!tray && winState.get("closeToTray") !== false;

  let noticeOpen = false;
  async function hideToTray() {
    /*
     * First close only: an app that keeps running after you close it has to
     * say so out loud. This one holds a power-save blocker and earns in the
     * background — staying alive silently is precisely the behavior testers
     * report as malware-adjacent, and the fix is one sentence at the moment
     * it first happens, plus a way to decline it on the spot.
     */
    if (winState.get("trayNoticeSeen")) return void win.hide();
    if (noticeOpen) return; // X pressed again while the notice is up
    noticeOpen = true;
    let response = 0;
    try {
      ({ response } = await dialog.showMessageBox(win, {
        type: "info",
        title: "Koinos AI is still running",
        message: "Closing the window doesn\u2019t stop Koinos AI",
        detail:
          "It keeps running down by the clock, so your node stays connected and keeps earning. " +
          "Click the Koinos AI icon there to bring this window back \u2014 if you don\u2019t see it, " +
          "click the \u2303 arrow to show hidden icons. To stop the app for real, right-click that " +
          "icon and choose Quit.\n\n" +
          "Prefer the X to close the app outright? Choose that below \u2014 you can change it later " +
          "under Settings \u203a Closing the window.",
        buttons: ["Keep running", "Close the app instead"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }));
    } finally {
      noticeOpen = false;
    }
    winState.set("trayNoticeSeen", true);
    if (response === 1) {
      // They just told the X to mean "quit" — so honour it for this press too.
      winState.set("closeToTray", false);
      quitting = true;
      return void app.quit();
    }
    win.hide();
  }

  win.on("close", (e) => {
    winState.set("bounds", win.getBounds());
    if (quitting || !closeHidesWindow()) return;
    e.preventDefault();
    hideToTray();
  });
  win.on("closed", () => (win = null));

  // Settings reads and writes this; in a plain browser the bridge is absent
  // and the section stays hidden, which is correct — there is no tray there.
  ipcMain.handle("shell:window-prefs", () => ({
    trayAvailable: !!tray,
    closeToTray: closeHidesWindow(),
  }));
  ipcMain.handle("shell:set-close-to-tray", (_e, on) => {
    winState.set("closeToTray", !!on && !!tray);
    return { trayAvailable: !!tray, closeToTray: closeHidesWindow() };
  });

  // Any external link opens in the system browser, never inside the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  await win.loadURL(`http://127.0.0.1:${port}/`);

  // OS wake is the earliest possible recovery signal: the moment Windows
  // resumes from standby, re-register with the network — seconds instead
  // of waiting out a timer (field finding: an idle laptop's standby took
  // the node off the roster; recovery must be wake-instant).
  {
    const { powerMonitor } = require("electron");
    powerMonitor.on("resume", () => {
      fetch(`http://127.0.0.1:${port}/core/earn/nudge`, { method: "POST" }).catch(() => {});
    });
    powerMonitor.on("unlock-screen", () => {
      fetch(`http://127.0.0.1:${port}/core/earn/nudge`, { method: "POST" }).catch(() => {});
    });
  }

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

  /*
   * Where "What's new" goes. The popup tells someone a version number; this
   * tells them what is in it. Anchored per release so they land on the entry
   * for the build they are actually installing, not the top of a list.
   */
  const notesUrl = (version) =>
    `https://koinosai.com/updates${version ? `#v${encodeURIComponent(String(version))}` : ""}`;

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
          buttons: ["Restart now", "What's new", "Later"],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        });
        // Silent install + relaunch: the app closes, updates, and reopens.
        if (response === 0) return autoUpdater.quitAndInstall(true, true);
        // Reading the notes is not declining the update — open them and leave
        // the install queued for quit, exactly as "Later" would.
        if (response === 1) shell.openExternal(notesUrl(info.version));
      });
      /*
       * Log why a check failed instead of discarding it. A silent catch is how
       * "the Pi never offers an update" went unnoticed: on arm64 the updater
       * asks for latest-linux-arm64.yml, there was no arm64 build publishing
       * one, every check 404'd, and the error went straight into an empty
       * function. Still non-fatal — an unreachable update feed must never
       * block the app — but now it leaves a trace.
       */
      const check = () =>
        autoUpdater.checkForUpdates().catch((e) => {
          console.error("[update] check failed:", String(e?.message || e));
        });
      check();
      setInterval(check, 4 * 3600 * 1000);
    } catch {
      /* updater unavailable (e.g. unpacked build) — never block the app */
    }
  } else {
    /*
     * Installed from source — the case electron-updater cannot serve.
     *
     * A git checkout has no update feed and no installer, so the block above
     * is skipped entirely and nothing ever mentions a new version. A Pi ran
     * eighteen versions behind for weeks on exactly this, and the reason it
     * went unnoticed is that `git pull` was being run faithfully and reporting
     * success — the checkout was on a TAG, so HEAD was detached and there was
     * no branch to pull into.
     *
     * So this asks git where it stands and says so out loud. When it is a
     * clean fast-forward it offers to do it; when it is not — detached, or
     * local edits — it explains which, because that is the part no amount of
     * `git pull` would have revealed.
     */
    const repoDir = app.getAppPath();
    const { inspect, apply, isGitCheckout } = require("../core/lib/source-update");
    if (isGitCheckout(repoDir)) {
      // Never ask twice about the same target in one session: "Later" should
      // mean later, not again in four hours' time about the same commit.
      let declined = null;

      const runNpmInstall = () =>
        new Promise((resolve, reject) => {
          const { execFile } = require("child_process");
          execFile(
            process.platform === "win32" ? "npm.cmd" : "npm",
            ["install", "--no-audit", "--no-fund"],
            { cwd: repoDir, timeout: 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
            (err, _out, errOut) => (err ? reject(new Error(String(errOut || err.message).slice(0, 500))) : resolve()),
          );
        });

      const checkSource = async () => {
        let state;
        try {
          state = await inspect(repoDir, { fetch: true });
        } catch (e) {
          console.error("[update] source check failed:", e.message);
          return;
        }
        if (!win || !state.behind) return;

        if (!state.canApply) {
          // Behind, but not safely fast-forwardable. Saying nothing here is
          // what let the Pi rot; the reason IS the actionable part.
          if (declined === state.head) return;
          declined = state.head;
          await dialog.showMessageBox(win, {
            type: "warning",
            title: "This copy is out of date",
            message: `Koinos AI is ${state.behind} update${state.behind === 1 ? "" : "s"} behind`,
            detail: `${state.reason}\n\nIt was installed from source, so updates come from git rather than an installer. In a terminal:\n\n  cd ${repoDir}\n  git checkout ${state.upstream ? state.upstream.replace(/^origin\//, "") : "<branch>"}\n  git pull && npm install`,
            buttons: ["OK", "What's new"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          }).then((r) => { if (r.response === 1) shell.openExternal(notesUrl(null)); });
          return;
        }

        if (declined === state.head) return;
        const { response } = await dialog.showMessageBox(win, {
          type: "info",
          title: "Update available",
          message: `Koinos AI is ${state.behind} update${state.behind === 1 ? "" : "s"} behind`,
          detail: `You're on ${app.getVersion()}. This copy runs from source, so updating means fast-forwarding the checkout and restarting.`,
          buttons: ["Update and restart", "What's new", "Later"],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        });
        if (response === 1) {
          // Show the notes and ask again next cycle, rather than treating a
          // request for information as a refusal.
          shell.openExternal(notesUrl(null));
          return;
        }
        if (response !== 0) { declined = state.head; return; }

        try {
          const result = await apply(repoDir, { install: true });
          if (result.depsChanged) {
            await dialog.showMessageBox(win, {
              type: "info",
              title: "Installing dependencies",
              message: "This update changes dependencies",
              detail: "Installing them now — on a Raspberry Pi this can take several minutes. The app will restart on its own when it finishes.",
              buttons: ["OK"],
              noLink: true,
            });
            await runNpmInstall();
          }
          app.relaunch();
          app.quit();
        } catch (e) {
          /*
           * The code may already be fast-forwarded while npm install failed,
           * which leaves new code against old dependencies — the one state
           * that must never be reported as "something went wrong". Name the
           * command that finishes the job.
           */
          await dialog.showMessageBox(win, {
            type: "error",
            title: "Update could not finish",
            message: "Koinos AI could not finish updating itself",
            detail: `${e.message}\n\nFinish it in a terminal:\n\n  cd ${repoDir}\n  git pull && npm install\n\nThen restart the app.`,
            buttons: ["OK"],
            noLink: true,
          });
        }
      };

      // A moment after boot, so it never competes with the first paint.
      setTimeout(() => { checkSource().catch(() => {}); }, 8000);
      setInterval(() => { checkSource().catch(() => {}); }, 4 * 3600 * 1000);
    }
  }
}

// Anything that quits — the tray menu, Cmd+Q, the updater's relaunch, the OS
// logging out — passes through here first, which is what lets the close
// handler above tell a quit apart from a trip to the tray.
app.on("before-quit", () => { quitting = true; });

app.on("window-all-closed", () => app.quit());

app.on("quit", () => {
  // Stop the llama-server child with the app; nothing keeps running hidden.
  if (core) core.runtime.stop();
});
