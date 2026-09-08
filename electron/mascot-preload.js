"use strict";
const { contextBridge, ipcRenderer } = require("electron");
async function computerInvoke(channel, ...args) {
  try { return await ipcRenderer.invoke(channel, ...args); }
  catch (error) {
    const message = String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: |AbortError: )?/, "");
    const clean = new Error(message); if (/stopped|declined|task ended/i.test(message)) clean.name = "AbortError"; throw clean;
  }
}
contextBridge.exposeInMainWorld("kaiDesktop", {
  computerStatus: () => computerInvoke("mascot:computer-status"),
  computerBegin: request => computerInvoke("mascot:computer-begin", request),
  computerCall: (token, name, args) => computerInvoke("mascot:computer-call", token, name, args),
  computerEnd: () => computerInvoke("mascot:computer-end"),
  openWebsite: text => computerInvoke("mascot:open-website", text),
  expand: open => ipcRenderer.invoke("mascot:expand", !!open),
  openMain: view => ipcRenderer.send("mascot:main", view),
  navigate: view => ipcRenderer.invoke("mascot:navigate", view),
  confirmTool: (name, args) => ipcRenderer.invoke("mascot:confirm-tool", name, args),
  hide: () => ipcRenderer.send("mascot:hide"),
  openFolder: folder => ipcRenderer.invoke("mascot:open-folder", folder),
  cancelAction: () => ipcRenderer.send("mascot:cancel-action"),
  regions: regions => ipcRenderer.send("mascot:regions", regions),
  windowsVoices: refresh => ipcRenderer.invoke("mascot:windows-voices", refresh === true),
  windowsSpeech: async request => {
    try { return await ipcRenderer.invoke("mascot:windows-speech", request); }
    catch (error) {
      // Electron decorates rejected IPC calls with its internal method name.
      // Preserve the actionable voice message without exposing that wrapper.
      throw new Error(String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
    }
  },
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
