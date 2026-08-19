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
});
