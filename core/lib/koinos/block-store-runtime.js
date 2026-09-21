"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const PATCH = "missing-record-v1";
const VERSION = `2bb94558-kai-${PATCH}`;
const UPSTREAM = "2bb94558df61c71eb241002635444cdddce0843c";
const FILES = ["koinos_block_store", "start.sh", "LICENSE.md"];

function defaultBundle() {
  return __dirname.includes("app.asar")
    ? path.resolve(__dirname, "../../../..", "node-runtime")
    : path.resolve(__dirname, "../../..", "build/node-runtime");
}
function verifyBundle(root, { required = true } = {}) {
  if (!required && !fs.existsSync(path.join(root, "manifest.json"))) return null;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.patch !== PATCH || manifest.version !== VERSION ||
      manifest.upstreamCommit !== UPSTREAM || manifest.platform !== "linux/amd64" ||
      !Array.isArray(manifest.files) || manifest.files.length !== FILES.length) throw new Error("Invalid block-store runtime manifest. Reinstall Master.");
  for (const name of FILES) {
    const record = manifest.files.find(file => file.name === name);
    const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex");
    if (!record || record.sha256 !== hash) throw new Error(`Block-store runtime checksum failed: ${name}. Reinstall Master.`);
  }
  return manifest;
}
function stageRuntime(root, nodeRoot, { required = __dirname.includes("app.asar") } = {}) {
  const manifest = verifyBundle(root, { required });
  if (!manifest) return false; // Source checkout: build the runtime before using the patched service.
  const target = path.join(nodeRoot, "block-store-runtime");
  fs.mkdirSync(target, { recursive: true });
  for (const name of [...FILES, "manifest.json"]) fs.copyFileSync(path.join(root, name), path.join(target, name));
  return true;
}
function patchedCompose(source) {
  // Windows checkouts can package CRLF templates. Normalize before matching
  // service boundaries; line endings do not change the Compose configuration.
  source = String(source).replace(/\r\n?/g, "\n");
  const original = "   block_store:\n      image: koinos/koinos-block-store:${BLOCK_STORE_TAG:-latest}\n";
  if (!source.includes(original)) throw new Error("Unexpected block-store Compose template");
  const start = source.indexOf(original), end = source.indexOf("\n   p2p:", start);
  if (end < 0) throw new Error("Missing Compose service boundary");
  let service = source.slice(start, end).replace(original, original +
    `      entrypoint: ["/bin/sh", "/kai-block-store/start.sh"]\n      labels:\n         io.koinosai.block-store.patch: ${PATCH}\n`);
  service = service.replace("      volumes:\n", "      volumes:\n         - \"./block-store-runtime:/kai-block-store:ro\"\n");
  return source.slice(0, start) + service + source.slice(end);
}
module.exports = { PATCH, VERSION, UPSTREAM, FILES, defaultBundle, verifyBundle, stageRuntime, patchedCompose };
