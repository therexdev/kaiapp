#!/usr/bin/env node
"use strict";

/*
 * Set the release version in both places at once.
 *
 * There are two package.json files and they must agree: installers and the
 * update feed read the root version, the UI's version badge reads core's. A
 * release that bumps one and not the other ships an app that misreports which
 * version it is — which is exactly the sort of thing a tester wastes an hour
 * on before anyone realises.
 *
 * core/test/version.test.js already catches the mismatch, and it did: v0.43.0
 * was tagged with only the root bumped, CI went red, and the installer jobs
 * never ran. That test is the safety net; this script is the reason not to
 * need it. Bumping by hand is a two-step operation with no reason to be one,
 * and the fix for "I did half of a two-step operation" is to make it one step,
 * not to try harder next time.
 *
 *   node core/scripts/set-version.js 0.43.1
 *
 * Prints what changed, then verifies the two files agree before exiting — so
 * a bad run fails here rather than in CI ten minutes later.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const FILES = [path.join(ROOT, "package.json"), path.join(ROOT, "core", "package.json")];

const next = String(process.argv[2] || "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error("usage: node core/scripts/set-version.js <x.y.z>");
  process.exit(2);
}

for (const file of FILES) {
  const raw = fs.readFileSync(file, "utf8");
  const pkg = JSON.parse(raw);
  const was = pkg.version;
  pkg.version = next;
  // Two spaces and a trailing newline: match what npm itself writes, so the
  // diff is one line rather than the whole file.
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`${path.relative(ROOT, file)}: ${was} -> ${next}`);
}

const versions = FILES.map((f) => JSON.parse(fs.readFileSync(f, "utf8")).version);
if (new Set(versions).size !== 1) {
  console.error(`\nthey still disagree: ${versions.join(" vs ")}`);
  process.exit(1);
}
console.log(`\nboth at ${next}. Run the tests before tagging [release].`);
