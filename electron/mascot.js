"use strict";

const path = require("path");
const SIZE = { compact: { width: 248, height: 304 }, chat: { width: 660, height: 560 } };

function fitBounds(anchor, expanded, area) {
  const size = expanded ? SIZE.chat : SIZE.compact;
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  return {
    x: Math.round(Math.max(area.x, Math.min(anchor.x - width, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(anchor.y - height, area.y + area.height - height))),
    width, height,
  };
}

function trustedFrame(event, window, origin) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
}

// A second view of the same running Core. Hiding either window never stops the
// node, changes the wallet, or creates another model/runtime process.
function createMascotController({ BrowserWindow, screen, ipcMain, shell, prefs, origin, getMainWindow, hasTray = () => true }) {
  let window = null, loading = null, expanded = false, dragging = null, timer = null;
  let regions = [], ignored = false, disposed = false, shaped = false;
  const handles = [], listeners = [];
  const send = (type, value) => {
    if (window && !window.isDestroyed()) window.webContents.send("mascot:event", { type, value });
  };
  function savePosition() {
    if (!window || window.isDestroyed()) return;
    const b = window.getBounds();
    prefs.set("mascot.position", { x: b.x + b.width, y: b.y + b.height });
  }
  function ignore(value) {
    if (!window || window.isDestroyed() || ignored === value) return;
    ignored = value;
    window.setIgnoreMouseEvents(value, { forward: true });
  }
  function tick() {
    if (!window || window.isDestroyed() || !window.isVisible()) return;
    if (shaped && !dragging) return;
    const cursor = screen.getCursorScreenPoint();
    if (dragging) {
      const dx = cursor.x - dragging.cursor.x, dy = cursor.y - dragging.cursor.y;
      window.setPosition(Math.round(dragging.bounds.x + dx), Math.round(dragging.bounds.y + dy));
      ignore(false);
      return;
    }
    const b = window.getBounds();
    // Polling also restores hit testing on Linux, where forwarded mouse events
    // are unavailable, and on Windows when another app swallows mouse moves.
    const x = cursor.x - b.x, y = cursor.y - b.y;
    ignore(regions.length > 0 && !regions.some(r => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height));
  }
  function resize(open) {
    if (!window || window.isDestroyed()) return;
    const b = window.getBounds();
    const anchor = { x: b.x + b.width, y: b.y + b.height };
    const area = screen.getDisplayMatching(b).workArea;
    expanded = !!open;
    regions = [];
    ignore(false);
    if (shaped) { window.setShape([]); shaped = false; }
    window.setBounds(fitBounds(anchor, expanded, area));
    send("expanded", expanded);
    savePosition();
  }
  async function launch(options = {}) {
    if (disposed) throw new Error("KAI is shutting down");
    if (!window || window.isDestroyed()) {
      const saved = prefs.get("mascot.position");
      const valid = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y);
      const point = valid ? saved : screen.getCursorScreenPoint();
      const area = screen.getDisplayNearestPoint(point).workArea;
      const anchor = valid ? saved : { x: area.x + area.width - 24, y: area.y + area.height - 16 };
      expanded = false;
      window = new BrowserWindow({
        ...fitBounds(anchor, false, area), title: "KAI · Desktop companion",
        frame: false, transparent: true, backgroundColor: "#00000000",
        hasShadow: false, alwaysOnTop: true, skipTaskbar: true, show: false,
        resizable: false, maximizable: false, fullscreenable: false,
        autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, "mascot-preload.js"),
          contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true },
      });
      const created = window;
      created.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return { action: "deny" };
      });
      created.webContents.on("will-navigate", (event, url) => {
        if (url !== origin + "/mascot.html") {
          event.preventDefault();
          if (/^https?:\/\//i.test(url) && new URL(url).origin !== origin) shell.openExternal(url);
        }
      });
      created.on("hide", () => { dragging = null; send("suspend", true); });
      created.on("show", () => send("suspend", false));
      created.webContents.on("render-process-gone", () => showMain());
      created.on("closed", () => {
        clearInterval(timer); timer = null;
        window = null; loading = null; dragging = null; regions = []; ignored = false; shaped = false;
      });
      loading = created.loadURL(origin + "/mascot.html").catch(error => {
        if (!created.isDestroyed()) created.destroy();
        throw error;
      });
      timer = setInterval(tick, 50);
      timer.unref?.();
    }
    await loading;
    if (disposed || !window || window.isDestroyed()) return { ok: false };
    ignore(false);
    window.show();
    send("launch", { model: typeof options.model === "string" ? options.model.slice(0, 160) : null, expanded });
    const main = getMainWindow();
    if (main && !main.isDestroyed()) main.hide();
    return { ok: true };
  }
  function showMain(view = "chat") {
    if (window && !window.isDestroyed()) { savePosition(); window.hide(); }
    const main = getMainWindow();
    if (!main || main.isDestroyed()) return;
    if (main.isMinimized()) main.restore();
    main.show(); main.focus();
    main.webContents.send("mascot:open-view", ["chat", "models", "settings"].includes(view) ? view : "chat");
  }
  function on(channel, fn) {
    const listener = (event, ...args) => {
      if (trustedFrame(event, window, origin)) fn(...args);
    };
    ipcMain.on(channel, listener); listeners.push([channel, listener]);
  }
  function handle(channel, getWindow, fn) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!trustedFrame(event, getWindow(), origin)) throw new Error("Untrusted KAI window");
      return fn(...args);
    });
    handles.push(channel);
  }
  handle("mascot:launch", getMainWindow, options => launch(options || {}));
  handle("mascot:expand", () => window, open => { resize(open); return { expanded }; });
  on("mascot:main", showMain);
  on("mascot:regions", value => {
    if (!Array.isArray(value)) return;
    regions = value.slice(0, 12).filter(r => r && ["x", "y", "width", "height"].every(k => Number.isFinite(r[k])) &&
      r.width > 0 && r.height > 0 && r.width <= 2000 && r.height <= 2000);
    if (process.platform !== "darwin" && typeof window.setShape === "function" && regions.length) {
      try {
        // Native hit regions avoid a polling delay on the first click and let
        // the desktop receive clicks through the large empty part of chat mode.
        window.setShape(regions.map(r => ({
          x: Math.floor(r.x), y: Math.floor(r.y),
          width: Math.ceil(r.width), height: Math.ceil(r.height),
        })));
        shaped = true; ignore(false);
      } catch { shaped = false; }
    }
    tick();
  });
  on("mascot:drag-start", () => {
    dragging = { bounds: window.getBounds(), cursor: screen.getCursorScreenPoint() };
    ignore(false);
  });
  on("mascot:drag-end", () => {
    dragging = null;
    resize(expanded); // clamp to the current monitor's usable area
  });
  on("mascot:hide", () => { if (!hasTray()) return showMain(); savePosition(); window.hide(); });
  const onDisplayChange = () => {
    if (window && !window.isDestroyed()) resize(expanded);
  };
  screen.on("display-removed", onDisplayChange);
  screen.on("display-metrics-changed", onDisplayChange);
  return {
    launch, showMain, getWindow: () => window,
    hide() { if (window && !window.isDestroyed()) { savePosition(); window.hide(); } },
    dispose() {
      if (disposed) return;
      disposed = true; clearInterval(timer);
      screen.removeListener("display-removed", onDisplayChange);
      screen.removeListener("display-metrics-changed", onDisplayChange);
      for (const channel of handles) ipcMain.removeHandler(channel);
      for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener);
      if (window && !window.isDestroyed()) { savePosition(); window.destroy(); }
    },
  };
}

module.exports = { createMascotController, fitBounds, trustedFrame, SIZE };
