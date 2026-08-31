"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");

test("macOS package configuration ships updater-compatible arm64 and x64 artifacts", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(pkg.scripts["dist:mac"], /--mac\s+--x64\s+--arm64\s+--publish never/);
  assert.deepStrictEqual(pkg.build.mac.target, ["dmg", "zip"]);
  assert.strictEqual(pkg.build.mac.minimumSystemVersion, "12.0");
  assert.strictEqual(pkg.build.mac.hardenedRuntime, true);
  assert.strictEqual(pkg.build.mac.artifactName, "${name}-${version}-${arch}.${ext}", "updater URLs and uploaded filenames use the same space-free basename");
  assert.strictEqual(pkg.build.mac.entitlements, "build/entitlements.mac.plist");
  assert.strictEqual(pkg.build.mac.entitlementsInherit, "build/entitlements.mac.inherit.plist");
  assert.match(pkg.build.mac.extendInfo.NSMicrophoneUsageDescription, /microphone/i);

  const icon = fs.readFileSync(path.join(root, pkg.build.mac.icon));
  assert.strictEqual(icon.subarray(0, 4).toString("ascii"), "icns", "macOS icon is a real ICNS container");
});

test("macOS llama.cpp runtimes are official, pinned, and complete for both architectures", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "core", "runtimes", "catalog.json"), "utf8"));
  const builds = catalog.llamacpp.builds;
  const expected = {
    "darwin-arm64-metal": "83e7d54914f33e9dd902a62fcb75ce94c8d7ea7c21511e38375dc88ce22e05a5",
    "darwin-arm64-cpu": "83e7d54914f33e9dd902a62fcb75ce94c8d7ea7c21511e38375dc88ce22e05a5",
    "darwin-x64-cpu": "499fdfd8729d815afa2b75a32fa45a6c9214e392c21f0ec289ecdd8d5e2182c6",
  };
  for (const [key, sha256] of Object.entries(expected)) {
    assert.ok(builds[key], `${key} present`);
    assert.match(builds[key].url, /^https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download\/b10423\/llama-b10423-bin-macos-(arm64|x64)\.tar\.gz$/);
    assert.strictEqual(builds[key].sha256, sha256);
    assert.strictEqual(builds[key].binPath, "llama-b10423/llama-server");
    assert.ok(builds[key].sizeBytes > 10_000_000);
  }
  assert.strictEqual(builds["darwin-x64-metal"], undefined, "the official Intel archive has no Metal backend");
});

test("engine shared-library path is platform-specific", () => {
  const { engineEnv } = require("../lib/runtimes/llamacpp");
  const bin = path.join("", "opt", "kai", "llama-server");
  const linux = engineEnv(bin, { platform: "linux", env: { LD_LIBRARY_PATH: "/old-linux" } });
  const mac = engineEnv(bin, { platform: "darwin", env: { DYLD_LIBRARY_PATH: "/old-mac" } });
  const win = engineEnv(bin, { platform: "win32", env: { Path: "C:\\Windows" } });
  assert.strictEqual(linux.LD_LIBRARY_PATH, `${path.dirname(bin)}:/old-linux`);
  assert.strictEqual(mac.DYLD_LIBRARY_PATH, `${path.dirname(bin)}:/old-mac`);
  assert.strictEqual(win.LD_LIBRARY_PATH, undefined);
  assert.strictEqual(win.DYLD_LIBRARY_PATH, undefined);
});

test("macOS CI cross-builds both architectures without implicit publication", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /build-macos:/);
  assert.match(workflow, /runs-on:\s+macos-latest/);
  assert.match(workflow, /Install Chromium for macOS browser tests/);
  assert.match(workflow, /KAI_TEST_CHROMIUM=\$chromium/);
  assert.match(workflow, /--mac --x64 --arm64 --publish never/);
  assert.match(workflow, /latest-mac\.yml/);
  assert.match(workflow, /MAC_RELEASE_READY == 'true'/);
  assert.match(workflow, /xcrun stapler validate "\$app"/);
  assert.match(workflow, /gh release upload/);
});
