"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("kaiDesktop", {
  expand: open => ipcRenderer.invoke("mascot:expand", !!open),
  openMain: view => ipcRenderer.send("mascot:main", view),
  hide: () => ipcRenderer.send("mascot:hide"),
  regions: regions => ipcRenderer.send("mascot:regions", regions),
  startDrag: () => ipcRenderer.send("mascot:drag-start"),
  endDrag: () => ipcRenderer.send("mascot:drag-end"),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("mascot:event", listener);
    return () => ipcRenderer.removeListener("mascot:event", listener);
  },
});
