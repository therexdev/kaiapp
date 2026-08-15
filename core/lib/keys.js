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

  _month() {
    return new Date().toISOString().slice(0, 7); // calendar month, e.g. "2026-08"
  }

  list() {
    const month = this._month();
    return Object.entries(this._all()).map(([id, k]) => ({
      id,
      name: k.name,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt ?? null,
      budgetUsdMonthly: k.budgetUsdMonthly ?? null,
      usage:
        k.usage && k.usage.month === month
          ? { requests: k.usage.requests, inTok: k.usage.inTok, outTok: k.usage.outTok, costUsd: (k.usage.costMicro / 1e6).toFixed(6) }
          : { requests: 0, inTok: 0, outTok: 0, costUsd: "0.000000" },
    }));
  }

  /** §8 usage accounting: attribute tokens (and network cost) to a key.
   *  Local inference records tokens with zero cost — local is free (§24). */
  recordUsage(id, { inTok = 0, outTok = 0, costMicro = 0 } = {}) {
    const all = this._all();
    const k = all[id];
    if (!k) return;
    const month = this._month();
    if (!k.usage || k.usage.month !== month) {
      k.usage = { month, requests: 0, inTok: 0, outTok: 0, costMicro: 0 };
    }
    k.usage.requests += 1;
    k.usage.inTok += Math.max(0, Math.floor(inTok) || 0);
    k.usage.outTok += Math.max(0, Math.floor(outTok) || 0);
    k.usage.costMicro += Math.max(0, Math.round(costMicro) || 0);
    this.store.set("apiKeys." + id, k);
  }

  /** §8 budgets: monthly USD cap on NETWORK spend through this key. */
  setBudget(id, budgetUsdMonthly) {
    const all = this._all();
    if (!all[id]) throw new Error("Unknown key id");
    const v = budgetUsdMonthly == null || budgetUsdMonthly === "" ? null : Math.max(0, Number(budgetUsdMonthly));
    if (v != null && !Number.isFinite(v)) throw new Error("Budget must be a number of dollars");
    all[id].budgetUsdMonthly = v;
    this.store.set("apiKeys", all);
    return { id, budgetUsdMonthly: v };
  }

  /** Remaining monthly network budget in µ$ (Infinity when no budget set). */
  budgetRemainingMicro(id) {
    const k = this._all()[id];
    if (!k || k.budgetUsdMonthly == null) return Infinity;
    const spent = k.usage?.month === this._month() ? k.usage.costMicro : 0;
    return Math.max(0, Math.round(k.budgetUsdMonthly * 1e6) - spent);
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
