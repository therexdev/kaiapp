#!/usr/bin/env node
"use strict";

/*
 * Pin a runtime build's sha256 into core/runtimes/catalog.json (§27).
 *
 *   node core/scripts/pin-runtime.js llamacpp linux-x64-cpu           # print
 *   node core/scripts/pin-runtime.js llamacpp linux-x64-cpu --write   # update catalog
 *   node core/scripts/pin-runtime.js llamacpp --all --write           # every build
 *
 * Run on a machine with normal internet access; commit the updated catalog.
 * A 404 here means the release asset name in the catalog URL is wrong for
 * that llama.cpp tag — fix the URL and re-run.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CATALOG = path.join(__dirname, "..", "runtimes", "catalog.json");

async function hashUrl(label, url) {
  console.error(`Fetching ${url} …`);
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${label} — check the asset URL for this tag`);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  let lastLogged = 0;
  for await (const chunk of resp.body) {
    hash.update(chunk);
    bytes += chunk.length;
    if (bytes - lastLogged > 25e6) {
      lastLogged = bytes;
      console.error(`${label}: ${(bytes / 1e6).toFixed(0)} MB…`);
    }
  }
  return { sha256: hash.digest("hex"), sizeBytes: bytes };
}

async function pinOne(builds, key) {
  const b = builds[key];
  Object.assign(b, await hashUrl(key, b.url));
  for (let i = 0; i < (b.extras || []).length; i++) {
    Object.assign(b.extras[i], await hashUrl(`${key} extra ${i + 1}`, b.extras[i].url));
  }
  console.log(JSON.stringify({ key, sha256: b.sha256, sizeBytes: b.sizeBytes, extras: b.extras?.length ?? 0 }));
}

async function main() {
  const [kind, target, ...flags] = process.argv.slice(2);
  const all = target === "--all";
  const write = flags.includes("--write") || (all && process.argv.includes("--write"));
  if (!kind || !target) {
    console.error("Usage: node core/scripts/pin-runtime.js <kind> <buildKey|--all> [--write]");
    process.exit(1);
  }
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
  const rt = catalog[kind];
  if (!rt) {
    console.error(`Unknown runtime "${kind}". Known: ${Object.keys(catalog).filter((k) => k !== "comment").join(", ")}`);
    process.exit(1);
  }
  const keys = all ? Object.keys(rt.builds) : [target];
  for (const key of keys) {
    if (!rt.builds[key]) throw new Error(`Unknown build key ${key}. Known: ${Object.keys(rt.builds).join(", ")}`);
    await pinOne(rt.builds, key);
  }
  if (write) {
    fs.writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + "\n");
    console.error("catalog.json updated — commit it.");
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
