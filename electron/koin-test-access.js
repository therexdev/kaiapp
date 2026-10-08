"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
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
  constructor({ file, config, wallet, settings, safeStorage, fetchImpl = fetch }) { Object.assign(this, { file, config, wallet, settings, safeStorage, fetchImpl }); }
  install(value) {
    const v = validate(value, this.config), encrypted = this.safeStorage?.isEncryptionAvailable?.();
    if (!encrypted) throw Error("OS credential encryption must be available before importing Test access");
    let installation = crypto.randomBytes(32).toString("hex");
    if (fs.existsSync(this.file)) {
      const old = JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.file)));
      if (old.credential?.owner !== v.owner || old.credential?.schedulerUrl !== v.schedulerUrl) throw Error("Existing Test access belongs to another deployment");
      installation = P.digest(old.installation);
    }
    const bytes = this.safeStorage.encryptString(JSON.stringify({ credential: v, installation })); fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
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
    const stored = JSON.parse(this.safeStorage.decryptString(raw)), v = validate(stored.credential, this.config);
    return { sessionToken: v.token, accountId: v.accountId, grantId: v.grantId, owner: v.owner, installation: P.digest(stored.installation) };
  }
  async claimHost() {
    const a = this.authorize(this.config.schedulerUrl);
    const response = await this.fetchImpl(this.config.schedulerUrl + "/koin/test/lease", { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { "content-type": "application/json", authorization: "Bearer " + a.sessionToken }, body: JSON.stringify({ installation: a.installation }) });
    const parts = []; let size = 0; for await (const part of response.body) { size += part.length; if (size > 4096) throw Error("Invalid Test host response"); parts.push(part); }
    const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!response.ok || value.mode !== this.config.mode || value.chainId !== this.config.deployment.chainId || value.owner !== a.owner || value.installation !== a.installation || value.granted !== true)
      throw Error("Test wallet host lease unavailable. A wallet can sign from only one Test installation");
    return value;
  }
}
module.exports = { TestAccess, validate };
