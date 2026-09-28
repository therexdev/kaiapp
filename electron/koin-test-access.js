"use strict";
const fs = require("fs"), path = require("path");
const D = require("../core/lib/koin-network/session-delegation"), P = require("../core/lib/koin-network/job-protocol");
const { scheduler } = require("../core/lib/koin-network/grant-chat");
function validate(value, config, now = Date.now()) {
  if (!value || Object.keys(value).sort().join() !== "accountId,expiresAt,grantId,mode,owner,schedulerUrl,schema,token" ||
      value.schema !== 1 || value.mode !== "test-access" || value.owner !== config.owner || scheduler(value.schedulerUrl) !== config.schedulerUrl ||
      typeof value.token !== "string" || !/^test_[A-Za-z0-9_-]{43}$/.test(value.token)) throw Error("Test access must match this wallet and backend");
  D.identity(value.accountId); D.identity(value.grantId); P.integer(value.expiresAt, now + 1, now + 31 * 86400000);
  return structuredClone(value);
}
class TestAccess {
  constructor({ file, config, wallet, settings, safeStorage }) { Object.assign(this, { file, config, wallet, settings, safeStorage }); }
  install(value) {
    const v = validate(value, this.config), encrypted = this.safeStorage?.isEncryptionAvailable?.();
    if (!encrypted) throw Error("OS credential encryption must be available before importing Test access");
    const bytes = this.safeStorage.encryptString(JSON.stringify(v)); fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + ".tmp", fd = fs.openSync(temp, "w", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file); return { state: "access_imported" };
  }
  authorize(pin, signal) {
    signal?.throwIfAborted();
    if (this.settings.get("network.privacyMode", "local-only") === "local-only") throw Error("Test requests require online privacy mode");
    if (scheduler(pin) !== this.config.schedulerUrl || this.wallet.address !== this.config.owner) throw Error("Test wallet or backend changed");
    if (!this.safeStorage?.isEncryptionAvailable?.()) throw Error("Unlock OS credential storage");
    const raw = fs.readFileSync(this.file); if (raw.length > 16384) throw Error("Invalid stored Test credential");
    const v = validate(JSON.parse(this.safeStorage.decryptString(raw)), this.config);
    return { sessionToken: v.token, accountId: v.accountId, grantId: v.grantId, owner: v.owner };
  }
}
module.exports = { TestAccess, validate };
