"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("kaiDesktop", {
  expand: open => ipcRenderer.invoke("mascot:expand", !!open),
  openMain: view => ipcRenderer.send("mascot:main", view),
  navigate: view => ipcRenderer.invoke("mascot:navigate", view),
  confirmTool: (name, args) => ipcRenderer.invoke("mascot:confirm-tool", name, args),
  hide: () => ipcRenderer.send("mascot:hide"),
  openFolder: folder => ipcRenderer.invoke("mascot:open-folder", folder),
  cancelAction: () => ipcRenderer.send("mascot:cancel-action"),
  regions: regions => ipcRenderer.send("mascot:regions", regions),
  windowsVoices: refresh => ipcRenderer.invoke("mascot:windows-voices", refresh === true),
  windowsSpeech: request => ipcRenderer.invoke("mascot:windows-speech", request),
  cancelWindowsSpeech: () => ipcRenderer.send("mascot:windows-speech-cancel"),
  windowsVoiceSettings: () => ipcRenderer.invoke("mascot:windows-voice-settings"),
  startDrag: () => ipcRenderer.send("mascot:drag-start"),
  endDrag: cancelled => ipcRenderer.send("mascot:drag-end", cancelled === true),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("mascot:event", listener);
    return () => ipcRenderer.removeListener("mascot:event", listener);
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
