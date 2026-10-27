"use strict";
// Controlled native Windows acceptance fixture, never the user's profile.
// Optional --app-dir exercises modules from the actual candidate app.asar in a
// temporary copied package whose entry point alone is replaced by the harness.
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process"), { setTimeout: delay } = require("node:timers/promises");
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
async function main() {
  if (process.platform !== "win32") throw Error("Run native wallet/device protected-storage verification on Windows");
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--app-dir")) throw Error("Usage: node scripts/verify-wallet-device-storage.js [--app-dir dist/win-unpacked]");
  const original = args.length ? path.resolve(args[1]) : path.dirname(require("electron"));
  const originalArchive = path.join(original, "resources", "app.asar"), packaged = args.length > 0;
  if (packaged && !fs.existsSync(originalArchive)) throw Error("The candidate package must contain resources/app.asar");
  const archiveHash = packaged ? digest(originalArchive) : null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-native-wallet-device-")), children = [];
  try {
    const appDir = path.join(root, "controlled-copy"), profile = path.join(root, "app-data");
    fs.cpSync(original, appDir, { recursive: true }); fs.mkdirSync(profile);
    let sourceRoot = path.resolve(__dirname, "..");
    if (packaged) {
      sourceRoot = path.join(appDir, "resources", "tested-code.asar");
      fs.renameSync(path.join(appDir, "resources", "app.asar"), sourceRoot);
      const unpacked = path.join(appDir, "resources", "app.asar.unpacked");
      if (fs.existsSync(unpacked)) fs.renameSync(unpacked, sourceRoot + ".unpacked");
    }
    const application = path.join(appDir, "resources", "app"); fs.mkdirSync(application, { recursive: true });
    fs.writeFileSync(path.join(application, "package.json"), JSON.stringify({ name: "koinos-ai-native-wallet-fixture", productName: "Koinos AI", version: "1.0.0", main: "main.js" }));
    fs.copyFileSync(path.join(__dirname, "fixtures", "wallet-device-storage-electron.js"), path.join(application, "main.js"));
    const executable = path.join(appDir, packaged ? "Koinos AI Test.exe" : "electron.exe");
    if (!fs.existsSync(executable)) throw Error("Expected Windows candidate executable was not found");
    const configFile = path.join(root, "fixture.json"); fs.writeFileSync(configFile, JSON.stringify({ root, profile, sourceRoot, packaged, archiveHash }));
    async function phase(name) {
      const env = { ...process.env, KAI_NATIVE_WALLET_CONFIG: configFile, KAI_NATIVE_WALLET_PHASE: name };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(executable, [], { env, stdio: ["ignore", "pipe", "pipe"] });
      const record = { child, output: "", closed: false }; children.push(record);
      child.stdout.on("data", bytes => { record.output = (record.output + bytes).slice(-8000); });
      child.stderr.on("data", bytes => { record.output = (record.output + bytes).slice(-8000); });
      child.on("error", error => { record.error = error; });
      record.done = new Promise(resolve => child.on("close", code => { record.closed = true; record.code = code; resolve(); }));
      const deadline = Date.now() + 45000;
      while (!record.closed) {
        if (record.error) throw record.error;
        if (Date.now() > deadline) throw Error(`Native ${name} phase timed out: ${record.output}`);
        await delay(40);
      }
      const resultFile = path.join(root, name + ".json");
      if (!fs.existsSync(resultFile)) throw Error(`Native ${name} phase did not report: ${record.output}`);
      const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
      assert.equal(result.error, undefined, result.error); assert.equal(record.code, 0, record.output);
      assert.equal(result.walletLocked, true); assert.equal(result.walletSignerAbsent, true);
      assert.equal(result.offPreserved, true); assert.equal(result.protectedStorage, true); assert.equal(result.walletSigningRejected, true);
      return result;
    }
    const enrolled = await phase("enroll"), resumed = await phase("restart");
    assert.equal(enrolled.address, resumed.address); assert.equal(enrolled.deviceId, resumed.deviceId); assert.equal(enrolled.authorizationId, resumed.authorizationId);
    assert.equal(resumed.accountRestored, true); assert.equal(resumed.scopedProofVerified, true); assert.equal(resumed.walletSignCalls, 0); assert.equal(resumed.controlledApprovals, 0);
    if (packaged) assert.equal(digest(originalArchive), archiveHash, "The original candidate package must remain unchanged");
    console.log("PASS: native Windows safeStorage protects wallet-credit and provider-device credentials across Electron restart; the real wallet stays locked, its signer is absent, scoped device proof verifies, and saved Off prevents worker startup. Approvals and service replies are controlled fixtures; no network or funds are used.");
  } finally {
    for (const record of children) if (!record.closed) record.child.kill();
    await Promise.all(children.map(record => record.done));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
