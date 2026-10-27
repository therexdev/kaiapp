"use strict";

// An AppImage has no package-manager installation step. Keep its own launchers
// current after electron-updater replaces a versioned filename. No profile,
// channel, command-line or sandbox overrides are passed to the app.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const MARKER = "X-KoinosAI-Managed=true";
const validPath = value => typeof value === "string" && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
const shellArgument = value => "'" + value.replace(/'/g, "'\\''") + "'";
const entryString = value => value.replace(/\\/g, "\\\\");
function execArgument(value) {
  return '"' + entryString(value.replace(/[\\"$`]/g, "\\$&").replace(/%/g, "%%")) + '"';
}
function regular(file) {
  try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink(); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function owned(file) {
  if (!exists(file)) return true;
  return regular(file) && fs.statSync(file).size < 65536 && fs.readFileSync(file, "utf8").split(/\r?\n/).some(line => line === MARKER || line === "# " + MARKER || line === "<!-- " + MARKER + " -->");
}
function write(file, content, mode) {
  if (regular(file) && fs.readFileSync(file, "utf8") === content) {
    if ((fs.statSync(file).mode & 0o777) !== mode) fs.chmodSync(file, mode);
    return;
  }
  const temp = path.join(path.dirname(file), ".kai-launcher-" + crypto.randomBytes(12).toString("hex"));
  let fd;
  try {
    fd = fs.openSync(temp, "wx", mode); fs.writeFileSync(fd, content); fs.fchmodSync(fd, mode); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined; fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
function installLinuxShortcut({ platform = process.platform, packaged = false, appImage = process.env.APPIMAGE,
  home, desktop, dataHome = process.env.XDG_DATA_HOME, channel = "stable", uid = process.getuid?.() } = {}) {
  if (platform !== "linux" || !packaged || !appImage || uid === 0) return { installed: false, reason: "not-appimage-desktop" };
  if (!["stable", "test"].includes(channel)) throw Error("Unknown desktop shortcut channel");
  if (!validPath(home) || !validPath(appImage) || !regular(appImage)) throw Error("The running AppImage path could not be verified");
  appImage = fs.realpathSync(appImage);
  if (!validPath(appImage)) throw Error("The running AppImage path could not be verified");
  fs.accessSync(appImage, fs.constants.X_OK);
  dataHome ||= path.join(home, ".local/share");
  if (!validPath(dataHome)) throw Error("The application-menu directory could not be verified");
  const name = channel === "test" ? "Koinos AI Test" : "Koinos AI";
  const directory = path.join(dataHome, channel === "test" ? "koinos-ai-test/launcher" : "koinos-ai/launcher");
  const launcher = path.join(directory, "launch.sh"), icon = path.join(directory, "icon.svg"), stateFile = path.join(directory, "installation.json");
  const menu = path.join(dataHome, "applications", channel === "test" ? "io.koinosai.appimage.test.desktop" : "io.koinosai.appimage.desktop");
  const hasDesktop = validPath(desktop) && path.resolve(desktop) !== path.resolve(home) && fs.existsSync(desktop) && fs.statSync(desktop).isDirectory();
  const desktopFile = hasDesktop ? path.join(desktop, name + ".desktop") : null;
  let state = { schema: 1, channel, desktopCreated: false };
  if (exists(stateFile)) {
    if (!regular(stateFile) || fs.statSync(stateFile).size > 4096) throw Error("An unrelated launcher state was left unchanged");
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (state.schema !== 1 || state.channel !== channel || typeof state.desktopCreated !== "boolean") throw Error("An unrelated launcher state was left unchanged");
  }
  // Preserve removal of the desktop icon. Existing managed icons still follow
  // the new AppImage path, while a newly configured Desktop can get its first.
  const installDesktop = desktopFile && (!state.desktopCreated || exists(desktopFile));
  for (const file of [launcher, icon, menu, ...(installDesktop ? [desktopFile] : [])]) {
    if (!owned(file)) throw Error("An unrelated desktop shortcut was left unchanged");
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(menu), { recursive: true, mode: 0o700 });
  const script = `#!/bin/bash\n# ${MARKER}\ncd -- ${shellArgument(path.dirname(appImage))} || exit 1\nexec -- ${shellArgument(appImage)}\n`;
  const svg = `<!-- ${MARKER} -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><g fill="none" stroke="#0874f9" stroke-width="10" stroke-linecap="round"><path d="M11 10v7M11 38V28L35 9M26 29l12 10"/></g></svg>\n`;
  const entry = `[Desktop Entry]\nType=Application\nVersion=1.0\nName=${name}\nComment=Open ${name}\nExec=/bin/bash -- ${execArgument(launcher)}\nIcon=${entryString(icon)}\nTerminal=false\nCategories=Utility;\nStartupNotify=true\n${MARKER}\n`;
  write(launcher, script, 0o755); write(icon, svg, 0o644); write(menu, entry, 0o644);
  if (installDesktop) { write(desktopFile, entry, 0o755); state.desktopCreated = true; }
  write(stateFile, JSON.stringify(state) + "\n", 0o600);
  return { installed: true, menu, desktop: installDesktop ? desktopFile : null };
}
module.exports = { installLinuxShortcut };
