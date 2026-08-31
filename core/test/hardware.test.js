"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const hardware = require("../lib/hardware");

test("detect() reports platform/cpu/ram and never throws without a GPU", async () => {
  const hw = await hardware.detect({});
  assert.equal(hw.platform, process.platform);
  assert.ok(hw.cpu.cores >= 1);
  assert.ok(hw.ramBytes > 0);
  assert.ok(Array.isArray(hw.gpus));
  assert.equal(typeof hw.capabilities.cudaEligible, "boolean");
  assert.equal(typeof hw.capabilities.vulkanEligible, "boolean");
  assert.equal(typeof hw.capabilities.metalEligible, "boolean");
  assert.equal(hw.capabilities.metalEligible, process.platform === "darwin" && process.arch === "arm64");
  assert.equal(hw.capabilities.cpuFallback, true);
});

test("capability mapping enables Metal only on Apple Silicon macOS", () => {
  const { capabilitiesFor } = hardware;
  assert.strictEqual(capabilitiesFor({ platform: "darwin", arch: "arm64", gpus: [] }).metalEligible, true);
  assert.strictEqual(capabilitiesFor({ platform: "darwin", arch: "x64", gpus: [] }).metalEligible, false);
  assert.strictEqual(capabilitiesFor({ platform: "linux", arch: "arm64", gpus: [] }).metalEligible, false);
  assert.strictEqual(capabilitiesFor({ platform: "win32", arch: "x64", gpus: [] }).metalEligible, false);
});
