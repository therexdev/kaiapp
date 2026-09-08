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
  globalThis.__folderApprovals = []; globalThis.__openedFolders = []; globalThis.__approveFolder = false;
  // Deterministic DIP cursor for the native drag check; all monitor queries
  // and BrowserWindow operations still use Electron on the real desktop.
  const fixtureScreen = new Proxy(screen, { get(target, key) {
    if (key === "getCursorScreenPoint") return () => globalThis.__kaiCursor || screen.getCursorScreenPoint();
    return typeof target[key] === "function" ? target[key].bind(target) : target[key];
  } });
  const controller = createMascotController({ BrowserWindow, screen: fixtureScreen, ipcMain, app,
    shell: { ...shell, openPath: async target => { globalThis.__openedFolders.push(target); return ""; } },
    dialog: { showMessageBox: async (_win, options) => { globalThis.__folderApprovals.push(options); return { response: globalThis.__approveFolder ? 1 : 0 }; } },
    prefs: new JsonStore(path.join(dir, "window.json"), {}), origin: fixture.origin, getMainWindow: () => main });
  const { DesktopProviders, registerProviderIPC } = require("../../electron/providers");
  const providerService = new DesktopProviders({ dataDir: dir, safeStorage: require("electron").safeStorage,
    privacyMode: () => "local-first", fetchImpl: async (url, options) => {
      if (url.includes("/models")) return Response.json({ data: [{ id: url.includes("openai") ? "gpt-fixture" : "claude-fixture" }] });
      const openai = url.includes("openai"), delta = openai ? { type: "response.output_text.delta", delta: "Native private reply." } :
        { type: "content_block_delta", delta: { type: "text_delta", text: "Native private reply." } };
      return new Response("data: " + JSON.stringify(delta) + "\n\ndata: " + JSON.stringify({ type: openai ? "response.completed" : "message_stop" }) + "\n\n");
    } });
  const providerIPC = registerProviderIPC({ ipcMain, service: providerService, origin: fixture.origin,
    getMainWindow: () => main, getMascotWindow: () => controller.getWindow() });
  globalThis.__providerService = providerService;
  globalThis.__providerFixture = fixture;
  globalThis.__kaiMain = main; globalThis.__kaiController = controller;
  await main.loadURL(fixture.origin + "/main-fixture");
  app.on("before-quit", () => { providerIPC.dispose(); controller.dispose(); fixture.server.close(); fixture.server.closeAllConnections(); });
});
app.on("window-all-closed", () => app.quit());
