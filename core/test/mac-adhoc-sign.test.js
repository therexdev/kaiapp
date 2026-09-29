"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const { shouldAdhocSign, adhocSign, verifySignature } = require("../../scripts/mac-adhoc-sign.js");

// Signing selection is pure and runs everywhere.
test("shouldAdhocSign selects the ad-hoc path only when no real identity is supplied", () => {
  // Explicit unsigned build (the Alpha CI default and the documented local build).
  assert.equal(shouldAdhocSign({ CSC_IDENTITY_AUTO_DISCOVERY: "false" }), true);
  // Nothing configured at all -> still produce an internally-valid ad-hoc seal.
  assert.equal(shouldAdhocSign({}), true);
  // A real Developer ID is being supplied -> leave signing to electron-builder.
  assert.equal(shouldAdhocSign({ CSC_LINK: "certs.p12" }), false);
  assert.equal(shouldAdhocSign({ CSC_IDENTITY: "Developer ID Application: Someone" }), false);
  // An explicit certificate wins even if auto-discovery is also disabled:
  // electron-builder still signs with CSC_LINK, so we must defer to it.
  assert.equal(shouldAdhocSign({ CSC_IDENTITY_AUTO_DISCOVERY: "false", CSC_LINK: "certs.p12" }), false);
});

// The re-sign behavior needs a real codesign, so it is macOS-only.
test("adhocSign repairs a bundle whose seal was invalidated by post-sign edits", { skip: process.platform !== "darwin" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-adhoc-"));
  try {
    const app = path.join(dir, "Demo.app");
    fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
    fs.copyFileSync("/bin/echo", path.join(app, "Contents", "MacOS", "Demo"));
    fs.writeFileSync(
      path.join(app, "Contents", "Info.plist"),
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        "<plist version=\"1.0\"><dict>" +
        "<key>CFBundleExecutable</key><string>Demo</string>" +
        "<key>CFBundleIdentifier</key><string>io.koinosai.desktop</string>" +
        "<key>CFBundleName</key><string>Demo</string>" +
        "</dict></plist>\n"
    );
    fs.writeFileSync(path.join(app, "Contents", "Resources", "seed.txt"), "seed");

    // 1) Seal it, as the prebuilt Electron.app arrives ad-hoc signed.
    adhocSign(app);
    // 2) Mutate the bundle the way electron-builder injects app.asar and rewrites
    //    Info.plist, without re-signing — the exact v0.54.8 sequence.
    fs.writeFileSync(path.join(app, "Contents", "Resources", "app.asar"), "payload");
    execFileSync("/usr/libexec/PlistBuddy", ["-c", "Add :Injected string x", path.join(app, "Contents", "Info.plist")]);
    assert.throws(() => verifySignature(app), "stale seal should fail verification");

    // 3) The fix: ad-hoc re-sign, then the bundle is internally valid.
    adhocSign(app);
    verifySignature(app); // throws if still broken

    // `codesign -dvv` prints its report to stderr; capture both streams.
    const shown = spawnSync("codesign", ["-dvv", app], { encoding: "utf8" });
    const info = `${shown.stdout}${shown.stderr}`;
    // Internally valid, and honest: ad-hoc, no team, proper identifier.
    assert.match(info, /Identifier=io\.koinosai\.desktop/);
    assert.match(info, /Signature=adhoc/);
    assert.match(info, /TeamIdentifier=not set/);
    assert.doesNotMatch(info, /Sealed Resources.*none/);

    // The ad-hoc bundle must NOT carry the hardened-runtime flag: it would enable
    // library validation with no Team ID to satisfy it, risking framework/helper
    // load failures, and offers no benefit without notarization. Guard against a
    // future `--options runtime` creeping into adhocSign.
    const flags = (info.match(/^CodeDirectory .*flags=\S+/m) || [""])[0];
    assert.match(flags, /adhoc/);
    assert.doesNotMatch(flags, /runtime/);
    const ent = spawnSync("codesign", ["-d", "--entitlements", "-", app], { encoding: "utf8" });
    const entText = `${ent.stdout}${ent.stderr}`;
    assert.doesNotMatch(entText, /allow-jit|allow-unsigned-executable-memory/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
