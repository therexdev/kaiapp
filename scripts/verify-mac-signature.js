"use strict";

// Publish gate: every packaged macOS .app under dist/ must carry an internally
// valid code signature before its DMG/ZIP can be released. This is deliberately
// independent of whether the build is Developer ID signed or ad-hoc signed:
//
//   signed   -> codesign --verify passes, Sealed Resources present, a team is set
//   ad-hoc   -> codesign --verify passes, Sealed Resources present, no team
//   BROKEN   -> the v0.54.8 state: Identifier=Electron, Sealed Resources=none
//
// It exists so the exact artifact that shipped in v0.54.8 (a bundle carrying the
// prebuilt Electron ad-hoc seal that no longer matched its mutated contents) can
// never be published again. Run after `electron-builder --mac`.

const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { execFileSync, spawnSync } = require("child_process");

// `codesign -dvv` prints its report to stderr; capture both streams.
function codesignInfo(appPath) {
  const r = spawnSync("codesign", ["-dvv", appPath], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`codesign -dvv failed for ${appPath}: ${r.stderr || r.stdout}`);
  return `${r.stdout}${r.stderr}`;
}

if (process.platform !== "darwin") {
  console.error("verify-mac-signature: must run on macOS (codesign required)");
  process.exit(1);
}

const distDir = process.argv[2] || "dist";
const apps = fs
  .readdirSync(distDir, { recursive: true })
  .filter(p => path.basename(p).endsWith(".app"))
  // recursive listing yields nested entries too; keep only the bundle roots.
  .filter(p => !p.slice(0, -".app".length).includes(".app" + path.sep))
  .map(p => path.join(distDir, p));

assert.ok(apps.length, `No packaged .app bundles found under ${distDir}/`);

for (const app of apps) {
  // Non-zero exit if the seal is broken — the whole point of the gate. codesign
  // prints the concrete reason to stderr; add one line and stop without a noisy
  // Node stack trace.
  try {
    execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
  } catch {
    console.error(`verify-mac-signature: ${app} has an invalid code signature (see codesign output above)`);
    process.exit(1);
  }

  const info = codesignInfo(app);
  const identifier = (info.match(/^Identifier=(.*)$/m) || [])[1];
  const sealed = (info.match(/^Sealed Resources.*$/m) || [])[0];

  // Identifier=Electron means electron-builder never re-signed after mutating the
  // prebuilt bundle: the exact v0.54.8 signature. A real build derives the
  // identifier from our appId (io.koinosai.desktop).
  assert.notEqual(identifier, "Electron", `${app}: still carries the prebuilt Electron identity — bundle was not re-signed`);
  assert.ok(identifier, `${app}: no code signing identifier`);
  assert.ok(sealed && !/none/.test(sealed), `${app}: no sealed resources (${sealed || "missing"})`);

  console.log(`Verified ${app}: Identifier=${identifier}, ${sealed}`);
}

console.log(`macOS signature check passed for ${apps.length} bundle(s)`);
