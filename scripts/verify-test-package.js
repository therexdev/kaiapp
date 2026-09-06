"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const asar = require("@electron/asar");
const yaml = require("js-yaml");
const { TEST_FEED } = require("../core/lib/release-channel");

const archives = fs.readdirSync("dist", { recursive: true }).filter(p => path.basename(p) === "app.asar");
assert.ok(archives.length, "No packaged app found");
for (const archive of archives) {
  const file = path.join("dist", archive);
  const pkg = JSON.parse(asar.extractFile(file, "package.json"));
  const core = JSON.parse(asar.extractFile(file, "core/package.json"));
  assert.equal(pkg.name, "koinos-ai-test");
  assert.equal(pkg.kaiChannel, "test");
  assert.equal(pkg.version, core.version);
  assert.match(pkg.version, /-test\./);
  const config = yaml.load(fs.readFileSync(path.join(path.dirname(file), "app-update.yml"), "utf8"));
  assert.equal(config.provider, "generic");
  assert.equal(config.url, TEST_FEED);
  assert.equal(config.channel, "test");
  console.log(`Verified ${file}: ${pkg.version}`);
}
