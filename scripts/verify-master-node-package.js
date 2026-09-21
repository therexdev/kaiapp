"use strict";
// Run the actual packaged Windows executable and its ASAR-loaded NodeManager.
// Generate only a temporary node configuration. Never invoke Docker, open the
// app profile, start Core, read a wallet or connect to a node.
const fs = require("fs"), os = require("os"), path = require("path");
const { execFileSync } = require("child_process");
const assert = require("node:assert/strict"), yaml = require("js-yaml");

function verify(dir = path.resolve("dist/win-unpacked")) {
  if (process.platform !== "win32") throw new Error("Run the packaged node startup check on Windows");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-packaged-node-"));
  try {
    const script = path.join(temp, "check.js"), output = path.join(temp, "result.json");
    fs.copyFileSync(path.join(__dirname, "fixtures/master-node-package.js"), script);
    execFileSync(path.join(dir, "Master Koinos AI Node.exe"), [script, path.join(dir, "resources/app.asar"), temp, output], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, timeout: 30000, stdio: "inherit",
    });
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(result.packaged, true);
    assert.equal(result.bundleVerified, true);
    assert.deepEqual(result.commands, [["mainnet", "start", ["up", "-d", "--remove-orphans"]]]);
    const compose = yaml.load(result.compose), config = yaml.load(result.config);
    assert.deepEqual(compose.services.block_store.entrypoint, ["/bin/sh", "/kai-block-store/start.sh"]);
    assert.equal(compose.services.block_store.labels["io.koinosai.block-store.patch"], "missing-record-v1");
    assert.ok(compose.services.block_store.volumes.includes("./block-store-runtime:/kai-block-store:ro"));
    assert.ok(compose.services.block_store.volumes.includes("${BASEDIR}:/koinos"));
    assert.equal(config.chain["verify-blocks"], true);
    assert.ok(!result.env.includes("account_history"));
    assert.equal(result.retainedData, "existing node data fixture");
    console.log(`PASS: packaged Windows startup generates the patched node configuration; template line endings: ${result.lineEndings}.`);
  } finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
if (require.main === module) verify(path.resolve(process.argv[2] || "dist/win-unpacked"));
module.exports = { verify };
