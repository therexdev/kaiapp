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
  assert.equal(hw.capabilities.cpuFallback, true);
});
