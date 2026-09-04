"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
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
  assert.match(workflow, /playwright-core"\)\.chromium\.executablePath\(\)/);
  assert.match(workflow, /KAI_TEST_CHROMIUM=\$chromium/);
  assert.match(workflow, /--mac --x64 --arm64 --publish never/);
  assert.match(workflow, /latest-mac\.yml/);
  assert.match(workflow, /MAC_RELEASE_READY == 'true'/);
  assert.match(workflow, /xcrun stapler validate "\$app"/);
  assert.match(workflow, /gh release upload/);
});

test("macOS node files avoid Docker Desktop nested config mounts", (t) => {
  const { NodeManager } = require("../lib/koinos/node-manager");
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kai-macos-node-"));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

  const manager = new NodeManager({
    templateRoot: path.join(root, "core", "koinos-node-template"),
    dataRoot,
    platform: "darwin",
  });
  const dirs = manager.ensureFiles("mainnet", null);
  const compose = fs.readFileSync(path.join(dirs.root, "docker-compose.yml"), "utf8");
  const env = fs.readFileSync(path.join(dirs.root, ".env"), "utf8");

  assert.doesNotMatch(compose, /^configs:/m, "top-level Compose configs are removed on macOS");
  assert.doesNotMatch(compose, /^\s{6}configs:/m, "service config mounts are removed on macOS");
  assert.match(compose, /\$\{BASEDIR\}:\/koinos/, "the durable node data mount remains");
  assert.match(env, /^JSONRPC_PORT=8085$/m, "mainnet RPC follows the current official default");

  const staged = [
    [path.join(dirs.config, "config.yml"), path.join(dirs.basedir, "config.yml")],
    [path.join(dirs.config, "genesis_data.json"), path.join(dirs.basedir, "chain", "genesis_data.json")],
    [
      path.join(dirs.config, "koinos_descriptors.pb"),
      path.join(dirs.basedir, "jsonrpc", "descriptors", "koinos_descriptors.pb"),
    ],
  ];
  for (const [source, destination] of staged) {
    assert.deepStrictEqual(fs.readFileSync(destination), fs.readFileSync(source), destination);
  }
});

test("non-macOS node generation keeps the upstream Compose config mounts", (t) => {
  const { NodeManager } = require("../lib/koinos/node-manager");
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kai-linux-node-"));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const manager = new NodeManager({
    templateRoot: path.join(root, "core", "koinos-node-template"),
    dataRoot,
    platform: "linux",
  });
  const dirs = manager.ensureFiles("mainnet", null);
  const compose = fs.readFileSync(path.join(dirs.root, "docker-compose.yml"), "utf8");
  assert.match(compose, /^configs:/m);
  assert.match(compose, /^\s{6}configs:/m);
  assert.strictEqual(fs.existsSync(path.join(dirs.basedir, "config.yml")), false);
});

test("Apple Silicon onboarding names Metal instead of reporting CPU-only", () => {
  const app = fs.readFileSync(path.join(root, "ui", "app.js"), "utf8");
  assert.match(app, /metalEligible[\s\S]{0,120}Apple Silicon · Metal acceleration/);
});
