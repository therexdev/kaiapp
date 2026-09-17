"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { downloadFile } = require("../core/lib/download");
const catalog = require("../core/runtimes/smart-turn.json");

const root = path.join(__dirname, "..");

function modelPath(rootDir = root) {
  return path.join(rootDir, "node_modules", ".cache", "kai-live-senses", "turn", catalog.file.path);
}

function valid(file) {
  try {
    if (fs.statSync(file).size !== catalog.file.sizeBytes) return false;
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") === catalog.file.sha256;
  } catch {
    return false;
  }
}

async function prepare(rootDir = root) {
  const dest = modelPath(rootDir);
  if (valid(dest)) return { downloaded: false, path: dest };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { force: true });
  await downloadFile(catalog.file.url, dest, {
    sha256: catalog.file.sha256,
    sizeBytes: catalog.file.sizeBytes,
    idleMs: 60000,
  });
  if (!valid(dest)) throw new Error("Prepared Smart-Turn model did not match its pinned catalog entry.");
  return { downloaded: true, path: dest };
}

if (require.main === module) {
  prepare().then(result => {
    console.log(`${result.downloaded ? "Downloaded" : "Verified"} ${catalog.engine} (${catalog.file.sizeBytes} bytes)`);
  }).catch(error => {
    console.error("Could not prepare KAI Live Senses:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { prepare, modelPath, valid };
