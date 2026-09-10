"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), P = require("./protocol");
const clone = x => JSON.parse(JSON.stringify(x));
class Store {
  constructor(file, storage) {
    this.file = file; this.storage = storage; this.locked = false;
    this.data = { version: 1, enabled: false, identity: null, agents: [], cards: [], jobs: [], quotes: [], inbox: [], outbox: [], activity: [], endpoints: [] };
    if (fs.existsSync(file)) {
      try { this.requireStorage(); this.data = JSON.parse(storage.decryptString(Buffer.from(JSON.parse(fs.readFileSync(file, "utf8")).encrypted, "base64"))); if (this.data.version !== 1) throw new Error(); }
      catch { this.locked = true; }
    }
  }
  available() { return this.storage.isEncryptionAvailable() && this.storage.getSelectedStorageBackend?.() !== "basic_text"; }
  requireStorage() { if (this.locked || !this.available()) P.fail("STORE_LOCKED", "Unlock your original keychain to use Agent Network."); }
  change(fn) {
    this.requireStorage(); const d = clone(this.data), result = fn(d), raw = JSON.stringify(d);
    if (Buffer.byteLength(raw) > 32 * 1024 * 1024) P.fail("STORAGE_LIMIT", "Agent Network storage is full. Export and remove finished jobs.");
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 }); const tmp = this.file + "." + P.random() + ".tmp";
    try {
      const fd = fs.openSync(tmp, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, encrypted: this.storage.encryptString(raw).toString("base64") })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file); this.data = d;
    } finally { fs.rmSync(tmp, { force: true }); }
    return result === undefined ? undefined : clone(result);
  }
}
// Headless installations use an operator-owned 32-byte key file, separate from the encrypted state.
function fileStorage(keyPath) {
  const stat = fs.statSync(keyPath); if (process.platform !== "win32" && (stat.mode & 0o077)) P.fail("KEY_PERMISSIONS", "Restrict the installation key file to its owner (chmod 600).");
  const key = fs.readFileSync(keyPath); if (key.length !== 32) P.fail("KEY_INVALID", "Installation key must contain exactly 32 bytes.");
  return { isEncryptionAvailable: () => true, encryptString(raw) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, c.update(raw), c.final(), c.getAuthTag()]); }, decryptString(raw) { const c = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12)); c.setAuthTag(raw.subarray(-16)); return Buffer.concat([c.update(raw.subarray(12, -16)), c.final()]).toString(); } };
}
module.exports = { Store, fileStorage, clone };
