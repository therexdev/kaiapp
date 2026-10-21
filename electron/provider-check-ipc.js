"use strict";
const fs = require("node:fs"), path = require("node:path"), { LocalProviderCheck, MAX_REPORT } = require("./provider-check");
const { trustedMainDocument } = require("./window-security");
function registerProviderCheckIPC({ ipcMain, core, getMainWindow, origin, appVersion, channel, dialog, clipboard, downloadsDirectory, createCheck = options => new LocalProviderCheck(options) }) {
  const name = "provider:local-check", progress = "provider:local-check-progress";
  const check = createCheck({ core, appVersion, channel, onProgress: value => {
    const window = getMainWindow();
    if (window && !window.isDestroyed() && trustedMainDocument({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, window, origin)) window.webContents.send(progress, value);
  } });
  const guard = event => { if (!trustedMainDocument(event, getMainWindow(), origin)) throw Error("Desktop window access denied"); };
  const initialWindow = getMainWindow(), stop = () => check.cancel();
  initialWindow?.on("closed", stop);
  initialWindow?.webContents.on("did-start-navigation", stop);
  ipcMain.handle(name, async (event, action, input) => {
    guard(event);
    if (input !== undefined || !["start", "status", "cancel", "copy", "save"].includes(action)) throw Error("Unknown local check action");
    if (["start", "status", "cancel"].includes(action)) return check[action]();
    const text = check.reportText();
    if (Buffer.byteLength(text) > MAX_REPORT) throw Error("Local check report is too large");
    if (action === "copy") { clipboard.writeText(text); return { copied: true }; }
    const result = await dialog.showSaveDialog(getMainWindow(), { title: "Save local provider check", defaultPath: path.join(downloadsDirectory,
      "kai-provider-check-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json"), filters: [{ name: "Provider check JSON", extensions: ["json"] }] });
    guard(event);
    if (result.canceled || !result.filePath) return { cancelled: true };
    const file = result.filePath;
    if (!path.isAbsolute(file)) throw Error("Choose a local report filename");
    let fd;
    try {
      const parent = fs.lstatSync(path.dirname(file));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error("Invalid directory");
      fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, text); fs.fsyncSync(fd);
    } catch { throw Error("The report could not be saved. Choose a new filename in an existing folder."); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    return { saved: true };
  });
  return { check, dispose() { check.dispose(); initialWindow?.removeListener("closed", stop); initialWindow?.webContents.removeListener("did-start-navigation", stop); ipcMain.removeHandler(name); } };
}
module.exports = { registerProviderCheckIPC };
