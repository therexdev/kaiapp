"use strict";
const fs = require("node:fs"), path = require("node:path");

// Only a genuinely new desktop profile starts with online access available.
// An existing profile, even an empty or unreadable one, retains the historical
// fail-closed Local-Only default until the user changes its privacy setting.
// This is called before backup/window/core initialization can create files.
function initializeDesktopProfile(dataDir) {
  try { fs.lstatSync(dataDir); return false; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, "settings.json"); let fd;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") return false; throw error; }
  try { fs.writeFileSync(fd, JSON.stringify({ network: { privacyMode: "local-first" } }) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return true;
}
module.exports = { initializeDesktopProfile };
