#!/usr/bin/env node
"use strict";

/*
 * Pin a catalog package (spec §27: package identity = its hash).
 *
 *   node core/scripts/pin-model.js <packageId>            # download, print hash
 *   node core/scripts/pin-model.js <packageId> --write    # also update catalog.json
 *
 * Downloads to a temp file, computes SHA-256 + size, and emits the catalog
 * values. Run on a machine with normal internet access; commit the updated
 * catalog so every other install verifies against the pinned hash.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const CATALOG = path.join(__dirname, "..", "models", "catalog.json");

async function main() {
  const [packageId, ...flags] = process.argv.slice(2);
  if (!packageId) {
    console.error("Usage: node core/scripts/pin-model.js <packageId> [--write]");
    process.exit(1);
  }
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
  const pkg = catalog.packages[packageId];
  if (!pkg) {
    console.error(`Unknown package "${packageId}". Known: ${Object.keys(catalog.packages).join(", ")}`);
    process.exit(1);
  }

  console.error(`Downloading ${pkg.url} …`);
  const resp = await fetch(pkg.url, { redirect: "follow" });
  if (!resp.ok) {
    console.error(`Download failed: HTTP ${resp.status}`);
    process.exit(1);
  }
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kai-pin-")), pkg.filename);
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(tmp);
  let bytes = 0;
  for await (const chunk of resp.body) {
    hash.update(chunk);
    out.write(chunk);
    bytes += chunk.length;
    process.stderr.write(`\r${(bytes / 1e6).toFixed(1)} MB`);
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  process.stderr.write("\n");

  const sha256 = hash.digest("hex");
  console.log(JSON.stringify({ packageId, sha256, sizeBytes: bytes, tempFile: tmp }, null, 2));

  if (flags.includes("--write")) {
    pkg.sha256 = sha256;
    pkg.sizeBytes = bytes;
    fs.writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + "\n");
    console.error(`catalog.json updated — commit it. Verified artifact left at ${tmp}`);
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
