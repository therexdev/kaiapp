"use strict";

const fs = require("fs");
const path = require("path");

// A restore point for configuration and encrypted wallet/session files, once
// per Test version. Models, chats and the node database stay in their original
// locations. There is deliberately no automatic restore of live chain state.
function backupLiveProfile(dataDir, version) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,99}$/.test(version)) throw new Error("Invalid backup version");
  dataDir = path.resolve(dataDir);
  const root = path.join(dataDir, "test-profile-backups");
  const target = path.join(root, version);
  const manifestPath = path.join(target, "manifest.json");
  if (fs.existsSync(target)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.version !== version || manifest.source !== dataDir) throw new Error("Invalid profile backup");
    return target;
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("Backup directory must not be a symbolic link");
  const staging = fs.mkdtempSync(path.join(root, ".pending-"));
  const files = [];
  try {
    for (const relative of ["", "wallet", "koinos-node"]) {
      const source = path.join(dataDir, relative);
      if (!fs.existsSync(source)) continue;
      if (fs.lstatSync(source).isSymbolicLink()) throw new Error(`Cannot back up symbolic link: ${source}`);
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (entry.isDirectory()) continue;
        if (relative !== "wallet" && !/\.(json|cfg)$/.test(entry.name) && entry.name !== "machine-secret.bin") continue;
        if (!entry.isFile()) throw new Error(`Cannot back up non-file: ${path.join(source, entry.name)}`);
        const name = path.join(relative, entry.name);
        const destination = path.join(staging, name);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(source, entry.name), destination, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(destination, 0o600);
        files.push(name);
      }
    }
    fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify({
      version, source: dataDir, createdAt: new Date().toISOString(), files,
    }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(staging, target);
    return target;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { backupLiveProfile };
