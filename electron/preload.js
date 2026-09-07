"use strict";

/*
 * Minimal, allowlisted bridge (§22: the renderer gets capabilities, never
 * Node). Only window chrome controls cross it — the frameless shell draws
 * its own titlebar, so the page needs minimize/maximize/close and nothing
 * else. In a plain browser (dev, tests) this file never loads and the UI
 * hides its titlebar buttons.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("koinosShell", {
  minimize: () => ipcRenderer.send("win:minimize"),
  toggleMaximize: () => ipcRenderer.send("win:toggle-maximize"),
  close: () => ipcRenderer.send("win:close"),
  onMaximizeChanged: (cb) => {
    ipcRenderer.on("win:maximize-changed", (_e, maximized) => cb(maximized));
  },
  // Model import: a native picker is the only way a sandboxed renderer
  // can learn a file's real on-disk path.
  pickModelFile: () => ipcRenderer.invoke("dialog:pick-gguf"),
  // Folder-scoped tool servers ("Your files"): same reasoning, for folders.
  pickFolder: (title) => ipcRenderer.invoke("dialog:pick-folder", title),
  // Whether the X parks the app in the notification area or quits it. Only
  // the shell knows if there is a tray at all, so Settings has to ask.
  windowPrefs: () => ipcRenderer.invoke("shell:window-prefs"),
  setCloseToTray: (on) => ipcRenderer.invoke("shell:set-close-to-tray", on),
  launchMascot: options => ipcRenderer.invoke("mascot:launch", options),
  onMascotOpenView: callback => {
    const listener = (_event, view) => callback(view);
    ipcRenderer.on("mascot:open-view", listener);
    return () => ipcRenderer.removeListener("mascot:open-view", listener);
  },
});

// Private provider capability: no keys are returned to either renderer.
contextBridge.exposeInMainWorld("kaiProviderBridge", {
  status: () => ipcRenderer.invoke("providers:status"),
  save: (id, options) => ipcRenderer.invoke("providers:save", id, options),
  remove: id => ipcRenderer.invoke("providers:remove", id),
  refresh: id => ipcRenderer.invoke("providers:refresh", id),
  chat: (id, body) => ipcRenderer.invoke("providers:chat", id, body),
  cancel: id => ipcRenderer.invoke("providers:cancel", id),
  onDelta: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("providers:delta", listener);
    return () => ipcRenderer.removeListener("providers:delta", listener);
  },
  onChanged: callback => {
    const listener = () => callback();
    ipcRenderer.on("providers:changed", listener);
    return () => ipcRenderer.removeListener("providers:changed", listener);
  },
});
