"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

// §34 release hygiene: the UI's version badge reads the core engine's
// package version, while installers and the update feed read the root
// package version. A release that bumps one without the other ships an
// app that misreports itself (field finding, v0.10.0).
test("core package version matches the app version", () => {
  const app = require("../../package.json").version;
  const core = require("../package.json").version;
  assert.strictEqual(core, app, "bump package.json and core/package.json together");
});
