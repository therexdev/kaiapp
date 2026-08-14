"use strict";

const crypto = require("crypto");

// Scoped API credentials for the local gateway (spec §8): application keys,
// never wallet keys. Plaintext is shown exactly once at creation; only a
// SHA-256 digest is stored.
const KEY_PREFIX = "kai_sk_";

class ApiKeys {
  constructor(store) {
    this.store = store; // JsonStore; keys live under "apiKeys"
  }

  _all() {
    return this.store.get("apiKeys", {});
  }

  list() {
    return Object.entries(this._all()).map(([id, k]) => ({
      id,
      name: k.name,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt ?? null,
    }));
  }

  create({ name }) {
    const label = String(name || "").trim() || "unnamed key";
    const id = "key_" + crypto.randomBytes(6).toString("hex");
    const secret = KEY_PREFIX + crypto.randomBytes(24).toString("base64url");
    const all = this._all();
    all[id] = {
      name: label,
      digest: crypto.createHash("sha256").update(secret).digest("hex"),
      createdAt: new Date().toISOString(),
    };
    this.store.set("apiKeys", all);
    // The only time the plaintext secret ever leaves this module.
    return { id, name: label, secret };
  }

  revoke(id) {
    const all = this._all();
    if (!all[id]) throw new Error("Unknown key id");
    delete all[id];
    this.store.set("apiKeys", all);
    return { revoked: true };
  }

  /** True when at least one key exists — the gateway then requires auth. */
  required() {
    return Object.keys(this._all()).length > 0;
  }

  /** Constant-time verification of a presented bearer secret. */
  verify(secret) {
    if (typeof secret !== "string" || !secret.startsWith(KEY_PREFIX)) return null;
    const digest = crypto.createHash("sha256").update(secret).digest();
    for (const [id, k] of Object.entries(this._all())) {
      const stored = Buffer.from(String(k.digest), "hex");
      if (stored.length === digest.length && crypto.timingSafeEqual(stored, digest)) {
        k.lastUsedAt = new Date().toISOString();
        this.store.set("apiKeys." + id, k);
        return { id, name: k.name };
      }
    }
    return null;
  }
}

module.exports = { ApiKeys, KEY_PREFIX };
