"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("compareFixture", {
  status: () => ipcRenderer.invoke("compare-fixture:invoke", "status"),
  install: () => ipcRenderer.invoke("compare-fixture:invoke", "install"),
  enable: () => ipcRenderer.invoke("compare-fixture:invoke", "enable"),
  disable: () => ipcRenderer.invoke("compare-fixture:invoke", "disable"),
  uninstall: () => ipcRenderer.invoke("compare-fixture:invoke", "uninstall"),
  select: models => ipcRenderer.invoke("compare-fixture:invoke", "select", { models }),
  approve: model => ipcRenderer.invoke("compare-fixture:invoke", "approve", { model }),
  revoke: model => ipcRenderer.invoke("compare-fixture:invoke", "revoke", { model }),
  run: prompt => ipcRenderer.invoke("compare-fixture:invoke", "run", { prompt }),
  stop: () => ipcRenderer.invoke("compare-fixture:invoke", "stop"),
});
