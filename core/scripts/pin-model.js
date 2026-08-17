#!/usr/bin/env node
"use strict";

/*
 * Pin model package hashes (spec §27: package identity = its hash).
 *
 *   node core/scripts/pin-model.js <packageId> [--write]
 *   node core/scripts/pin-model.js --all [--catalog <path>] [--write]
 *
 * Default catalog is core/models/catalog.json; --catalog points at another
 * (e.g. the benchmark candidates). Streams each package, computes SHA-256 +
 * size, prints the values, and with --write updates the catalog in place.
 * Run on a machine with normal internet access; commit the updated catalog.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

async function hashUrl(url, id) {
  console.error(`Fetching ${url} …`);
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${id} — check the URL`);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  let lastLogged = 0;
  for await (const chunk of resp.body) {
    hash.update(chunk);
    bytes += chunk.length;
    if (bytes - lastLogged > 25e6) {
      lastLogged = bytes;
      console.error(`${id}: ${(bytes / 1e6).toFixed(0)} MB…`);
    }
  }
  return { sha256: hash.digest("hex"), sizeBytes: bytes };
}

async function pinOne(pkg, id, { mmprojOnly = false } = {}) {
  if (!mmprojOnly) {
    const r = await hashUrl(pkg.url, id);
    pkg.sha256 = r.sha256;
    pkg.sizeBytes = r.sizeBytes;
    console.log(JSON.stringify({ id, sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }));
  }
  // Vision packages carry a projector (--mmproj) — same identity-by-hash rule.
  if (pkg.mmproj && pkg.mmproj.url) {
    const r = await hashUrl(pkg.mmproj.url, `${id}#mmproj`);
    pkg.mmproj.sha256 = r.sha256;
    pkg.mmproj.sizeBytes = r.sizeBytes;
    console.log(JSON.stringify({ id: `${id}#mmproj`, sha256: r.sha256, sizeBytes: r.sizeBytes }));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const mmprojOnly = args.includes("--mmproj-only"); // pin just the projector (skip the big weights re-download)
  const catIdx = args.indexOf("--catalog");
  const catalogPath =
    catIdx >= 0 ? path.resolve(args[catIdx + 1]) : path.join(__dirname, "..", "models", "catalog.json");
  const targets = args.filter((a, i) => !a.startsWith("--") && (catIdx < 0 || i !== catIdx + 1));
  const all = args.includes("--all");
  if (!all && targets.length === 0) {
    console.error("Usage: node core/scripts/pin-model.js <packageId>|--all [--catalog <path>] [--write]");
    process.exit(1);
  }

  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const ids = all ? Object.keys(catalog.packages) : targets;
  for (const id of ids) {
    const pkg = catalog.packages[id];
    if (!pkg) {
      console.error(`Unknown package "${id}". Known: ${Object.keys(catalog.packages).join(", ")}`);
      process.exit(1);
    }
    await pinOne(pkg, id, { mmprojOnly });
  }
  if (write) {
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
    console.error(`${path.basename(catalogPath)} updated — commit it.`);
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
