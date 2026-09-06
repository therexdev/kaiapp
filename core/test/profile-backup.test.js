"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { backupLiveProfile } = require("../lib/profile-backup");
const { WalletService } = require("../lib/wallet");
const { JsonStore } = require("../lib/store");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-profile-backup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("Test's restore point preserves encrypted wallet sessions and live earning/node settings without copying bulk data", t => {
  const dir = fixture(t);
  const wallet = new WalletService(path.join(dir, "wallet"));
  const { address } = wallet.create({ password: "synthetic fixture password" });
  wallet.saveSession("synthetic-machine-secret");
  const settings = new JsonStore(path.join(dir, "settings.json"), {});
  settings.set("earn.autoStart", true);
  const nodeSettings = new JsonStore(path.join(dir, "koinos-node/settings.json"), {});
  nodeSettings.set("node.dataDir", path.join(dir, "existing-node-drive"));
  const originals = new Map();
  for (const relative of ["models/weights.gguf", "chats/conversation.json", "koinos-node/node/db/blocks", "core.log"]) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), "keep in place");
  }
  for (const relative of ["wallet/wallet.json", "wallet/session.bin", "settings.json", "koinos-node/settings.json"]) {
    originals.set(relative, fs.readFileSync(path.join(dir, relative)));
  }
  const snapshot = backupLiveProfile(dir, "0.54.2-test.3.1");
  for (const [relative, bytes] of originals) {
    assert.deepEqual(fs.readFileSync(path.join(snapshot, relative)), bytes);
    assert.deepEqual(fs.readFileSync(path.join(dir, relative)), bytes, "live files unchanged");
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(snapshot, relative)).mode & 0o777, 0o600);
  }
  for (const relative of ["models", "chats", "koinos-node/node", "core.log"]) assert.equal(fs.existsSync(path.join(snapshot, relative)), false);
  const restored = new WalletService(path.join(snapshot, "wallet"));
  assert.equal(restored.tryResumeSession("synthetic-machine-secret"), true);
  assert.equal(restored.address, address);
  assert.equal(new JsonStore(path.join(snapshot, "settings.json"), {}).get("earn.autoStart"), true);
  assert.equal(new JsonStore(path.join(snapshot, "koinos-node/settings.json"), {}).get("node.dataDir"), path.join(dir, "existing-node-drive"));
});

test("Restart keeps the original restore point; a new Test version records current configuration", t => {
  const dir = fixture(t);
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, '{"before":true}');
  const original = backupLiveProfile(dir, "1.0.0-test.1");
  fs.writeFileSync(file, '{"after":true}');
  assert.equal(backupLiveProfile(dir, "1.0.0-test.1"), original);
  assert.equal(fs.readFileSync(path.join(original, "settings.json"), "utf8"), '{"before":true}');
  const next = backupLiveProfile(dir, "1.0.0-test.2");
  assert.equal(fs.readFileSync(path.join(next, "settings.json"), "utf8"), '{"after":true}');
  assert.throws(() => backupLiveProfile(dir, "../escape"), /Invalid backup version/);
});

test("A failed backup is not marked complete and leaves live configuration intact", t => {
  const dir = fixture(t);
  const settings = path.join(dir, "settings.json");
  fs.writeFileSync(settings, '{"keep":true}');
  fs.writeFileSync(path.join(dir, "wallet"), "not a wallet directory");
  assert.throws(() => backupLiveProfile(dir, "1.0.0-test.1"));
  assert.equal(fs.readFileSync(settings, "utf8"), '{"keep":true}');
  assert.deepEqual(fs.readdirSync(path.join(dir, "test-profile-backups")), []);
  fs.unlinkSync(path.join(dir, "wallet"));
  assert.ok(fs.existsSync(path.join(backupLiveProfile(dir, "1.0.0-test.1"), "manifest.json")));
});
