"use strict";
const fs = require("fs"), path = require("path"), { DatabaseSync } = require("node:sqlite");
const { Signer, utils } = require("koilib");
const { KoinChain } = require("../core/lib/koin-network/chain");
const { FundingObserver, intent } = require("../core/lib/koin-network/funding-observer");
const { hash, digest, integer } = require("../core/lib/koin-network/job-protocol");
const { uint, DAY } = require("../core/lib/koin-network/policy");
const terminal = s => ["funded", "reverted"].includes(s);
function nonce(value) {
  if (typeof value !== "string") throw Error("Canonical funding nonce required");
  const b = Buffer.from(value, "base64url"); let n = 0n;
  if (b.length < 2 || b.length > 11 || b[0] !== 40) throw Error("Invalid funding nonce");
  for (let i = 1; i < b.length; i++) n |= BigInt(b[i] & 127) << BigInt(7 * (i - 1));
  uint(n); if (!n) throw Error("Positive funding nonce required");
  let rest = n; const canonical = [40];
  do { const byte = Number(rest & 127n); rest >>= 7n; canonical.push(byte | (rest ? 128 : 0)); } while (rest);
  if (utils.encodeBase64url(Uint8Array.from(canonical)) !== value) throw Error("Noncanonical funding nonce");
  return n;
}

// No wallet keys, IPC, timer or broadcast transport. Only the isolated driver
// may supply a fixture signer. Production approvals remain disconnected.
class FundingRecovery {
  #db; #client; #observer; #clock; #identity; #policy;
  constructor(directory, { mode, client, clock = Date.now, maxRcPerDay, maxAttempts = 3, minRetryMs = 1000 }) {
    if (mode !== "isolated-rehearsal" || !(client instanceof KoinChain) || client.d.network !== "isolated")
      throw Error("Explicit isolated funding client required");
    if (typeof maxRcPerDay !== "string" || !uint(maxRcPerDay)) throw Error("Positive daily funding RC budget required");
    this.#policy = { maxRcPerDay, maxAttempts: integer(maxAttempts, 1, 20), minRetryMs: integer(minRetryMs, 1000, 3600000) };
    this.#client = client; this.#clock = clock; this.#observer = new FundingObserver(client, { clock });
    this.#identity = JSON.stringify({ schema: 1, mode, deployment: client.d, policy: this.#policy });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "funding-recovery.sqlite"); this.#db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
    try {
      this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, clock INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS deposits(id TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL, tx_id TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mana(day TEXT NOT NULL, owner TEXT NOT NULL, id TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY(day,id));`);
      this.#tx(() => {
        const prior = this.#db.prepare("SELECT data FROM identity WHERE id=1").get();
        if (prior && prior.data !== this.#identity) throw Error("Funding deployment or policy changed");
        if (!prior) {
          if (["deposits", "mana"].some(t => this.#db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get())) throw Error("Missing funding identity");
          this.#db.prepare("INSERT INTO identity VALUES(1,?,?)").run(this.#identity, integer(clock()));
        }
      }, false);
      if (this.#db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw Error("Corrupt funding journal");
    } catch (e) { this.#db.close(); throw e; }
  }
  #time() {
    const row = this.#db.prepare("SELECT data,clock FROM identity WHERE id=1").get(), now = integer(this.#clock());
    if (row?.data !== this.#identity) throw Error("Funding identity mismatch");
    if (now < row.clock) throw Error("Funding clock moved backwards");
    return now;
  }
  #tx(fn, check = true) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (check) this.#db.prepare("UPDATE identity SET clock=? WHERE id=1").run(this.#time());
      const r = fn(); this.#db.exec("COMMIT"); return r;
    } catch (e) { this.#db.exec("ROLLBACK"); throw e; }
  }
  #save(r) {
    r.updatedAt = this.#time(); const data = JSON.stringify(r);
    this.#db.prepare("INSERT OR REPLACE INTO deposits VALUES(?,?,?,?,?,?)").run(r.id, r.intent.actor, r.state, r.draft.id, hash(data), data);
  }
  #row(id) {
    digest(id); this.#time(); const saved = this.#db.prepare("SELECT * FROM deposits WHERE id=?").get(id);
    if (!saved || saved.hash !== hash(saved.data)) throw Error("Missing or damaged funding journal");
    const r = JSON.parse(saved.data);
    if (r.id !== id || r.intent.actor !== saved.owner || r.draft.id !== saved.tx_id || r.state !== saved.state ||
        !["signing", "staged", "unknown", "needs_review", "funded", "reverted"].includes(r.state) ||
        JSON.stringify(intent(r.intent)) !== JSON.stringify(r.intent) || r.draftHash !== hash(JSON.stringify(r.draft))) throw Error("Damaged funding binding");
    nonce(r.draft.header.nonce); integer(r.createdAt); integer(r.updatedAt, r.createdAt); integer(r.expires, r.createdAt + 180000, r.createdAt + 180000);
    integer(r.attempts, 0, this.#policy.maxAttempts);
    if (r.transaction && (r.transaction.id !== r.draft.id || r.transactionHash !== hash(JSON.stringify(r.transaction)))) throw Error("Damaged funding envelope");
    if (!r.transaction && r.state !== "signing") throw Error("Missing signed funding envelope");
    if (r.lastAttemptAt !== null) integer(r.lastAttemptAt, r.createdAt, r.updatedAt);
    if ((r.attempts === 0) !== (r.lastAttemptAt === null) || !Array.isArray(r.days) || new Set(r.days).size !== r.days.length ||
        r.days.length > r.attempts || (r.attempts === 0) !== (r.days.length === 0)) throw Error("Damaged funding attempts");
    for (const day of r.days) {
      const m = this.#db.prepare("SELECT owner,amount FROM mana WHERE day=? AND id=?").get(day, id);
      if (uint(day) > BigInt(Math.floor(r.lastAttemptAt / DAY)) || m?.owner !== r.intent.actor || m?.amount !== r.intent.maxRc) throw Error("Funding Mana journal mismatch");
    }
    return r;
  }
  status(id) {
    const r = this.#row(id);
    return { id, state: r.state, reason: r.reason, txId: r.draft.id, attempts: r.attempts, kind: r.intent.kind,
      amount: r.intent.args.amount, actor: r.intent.actor, finality: structuredClone(r.finality), paymentsEnabled: false };
  }
  async begin(id, value) {
    digest(id); const request = intent(value);
    if (uint(request.maxRc) > uint(this.#policy.maxRcPerDay)) throw Error("Funding exceeds daily RC budget");
    if (this.#db.prepare("SELECT 1 FROM deposits WHERE id=?").get(id)) {
      const r = this.#row(id);
      if (JSON.stringify(r.intent) !== JSON.stringify(request)) throw Error("Cannot replace funding intent");
      return { action: "recover_existing", ...this.status(id) };
    }
    const state = await this.#client.verify();
    if (state.paused) throw Error("Funding is paused");
    const draft = await this.#client.prepare(request.kind, request.method, request.args, { actor: request.actor, rcLimit: request.maxRc });
    await this.#client.verifyTransaction(draft, request); nonce(draft.header.nonce);
    return this.#tx(() => {
      if (this.#db.prepare("SELECT 1 FROM deposits WHERE id=?").get(id)) {
        if (JSON.stringify(this.#row(id).intent) !== JSON.stringify(request)) throw Error("Cannot replace funding intent");
        return { action: "recover_existing", ...this.status(id) };
      }
      if (this.#db.prepare("SELECT 1 FROM deposits WHERE owner=? AND state NOT IN ('funded','reverted')").get(request.actor))
        throw Error("Another deposit owns this wallet nonce; recover it first");
      for (const prior of this.#db.prepare("SELECT id FROM deposits WHERE owner=?").all(request.actor))
        if (nonce(draft.header.nonce) <= nonce(this.#row(prior.id).draft.header.nonce)) throw Error("Funding nonce did not advance");
      const now = this.#time();
      this.#save({ id, intent: request, state: "signing", reason: null, draft, draftHash: hash(JSON.stringify(draft)),
        policyHash: hash(JSON.stringify(state)), transaction: null, transactionHash: null, createdAt: now, expires: now + 180000,
        attempts: 0, lastAttemptAt: null, days: [], finality: null });
      return { action: "prepare_funding", id, transaction: structuredClone(draft), intent: request, paymentsEnabled: false };
    });
  }
  async #validate(tx, r) {
    await this.#client.verifyTransaction(tx, r.intent);
    if (tx.id !== r.draft.id || tx.header.payee !== undefined || tx.header.rc_limit !== r.intent.maxRc ||
        !Array.isArray(tx.signatures) || tx.signatures.length !== 1) throw Error("Exact owner signature and funding draft required");
    nonce(tx.header.nonce); const sig = tx.signatures[0];
    if (typeof sig !== "string" || Buffer.from(sig, "base64url").length !== 65 || utils.encodeBase64url(Buffer.from(sig, "base64url")) !== sig ||
        Signer.recoverAddress(Buffer.from(tx.id.slice(6), "hex"), Buffer.from(sig, "base64url")) !== r.intent.actor) throw Error("Wrong funding signer");
  }
  async stage(id, transaction) {
    const tx = structuredClone(transaction), r = this.#row(id); await this.#validate(tx, r);
    this.#tx(() => {
      const current = this.#row(id);
      if (current.transaction) {
        if (current.transactionHash !== hash(JSON.stringify(tx))) throw Error("Cannot replace signed funding envelope");
        return;
      }
      if (current.state !== "signing") throw Error("Missing funding signing fence");
      current.transaction = tx; current.transactionHash = hash(JSON.stringify(tx)); current.state = "staged"; this.#save(current);
    });
    return this.status(id);
  }
  async advance(id) {
    const initial = this.#row(id);
    if (terminal(initial.state)) return { action: "done", ...this.status(id) };
    if (!initial.transaction) return { action: "review", ...this.status(id), reason: "recover_signing_envelope" };
    await this.#validate(initial.transaction, initial);
    const finality = await this.#observer.finality(initial.transaction, initial.intent);
    const confirmed = ["finalized", "reverted"].includes(finality.state);
    const evidence = await this.#observer.inspect(initial.intent, confirmed ? finality.height : "0");
    const nextNonce = confirmed ? null : await this.#client.provider.getNextNonce(initial.intent.actor);
    return this.#tx(() => {
      const r = this.#row(id);
      if (terminal(r.state)) return { action: "done", ...this.status(id) };
      if (evidence.state !== "verified") return { action: "wait", reason: "funding_" + evidence.state, paymentsEnabled: false };
      if (this.#time() - evidence.checkedAt > 5000 || this.#time() < evidence.checkedAt) throw Error("Stale funding evidence");
      if (confirmed && uint(evidence.height) >= uint(finality.height)) {
        if (finality.state === "finalized" && evidence.allowance !== "0") return { action: "review", reason: "residual_allowance", paymentsEnabled: false };
        r.finality = finality; r.state = finality.state === "finalized" ? "funded" : "reverted"; r.reason = null; this.#save(r);
        return { action: "done", ...this.status(id) };
      }
      if (r.state === "needs_review") return { action: "review", ...this.status(id) };
      if (finality.state !== "unknown") return { action: "wait", reason: "funding_" + finality.state, paymentsEnabled: false };
      let reason = null;
      if (hash(JSON.stringify(evidence.config)) !== r.policyHash) reason = "funding_policy_changed";
      else if (nonce(nextNonce) !== nonce(r.draft.header.nonce)) reason = "wallet_nonce_changed";
      else if (r.attempts === 0 && this.#time() >= r.expires) reason = "funding_review_expired";
      else if (r.attempts >= this.#policy.maxAttempts) reason = "funding_attempt_limit";
      if (reason) { r.state = "needs_review"; r.reason = reason; this.#save(r); return { action: "review", ...this.status(id) }; }
      if (evidence.config.paused || evidence.allowance !== "0") return { action: "wait", reason: "funding_paused_or_allowance", paymentsEnabled: false };
      const now = this.#time();
      if (r.lastAttemptAt !== null && now - r.lastAttemptAt < this.#policy.minRetryMs) return { action: "wait", reason: "funding_retry_delay", paymentsEnabled: false };
      const day = String(Math.floor(now / DAY));
      if (!r.days.includes(day)) {
        const used = this.#db.prepare("SELECT amount FROM mana WHERE day=? AND owner=?").all(day, r.intent.actor).reduce((sum, m) => sum + uint(m.amount), 0n);
        if (used + uint(r.intent.maxRc) > uint(this.#policy.maxRcPerDay)) return { action: "wait", reason: "funding_daily_rc_budget", paymentsEnabled: false };
        this.#db.prepare("INSERT INTO mana VALUES(?,?,?,?)").run(day, r.intent.actor, id, r.intent.maxRc); r.days.push(day);
      }
      r.attempts++; r.lastAttemptAt = now; r.state = "unknown"; this.#save(r);
      return { action: "submit_exact_transaction", id, transaction: structuredClone(r.transaction), intent: structuredClone(r.intent), paymentsEnabled: false };
    });
  }
  close() { this.#db.close(); }
}

class FundingRecoveryRunner {
  #journal; #sign; #submit; #timeout;
  constructor({ mode, journal, sign, submit, timeoutMs = 5000 }) {
    if (mode !== "isolated-rehearsal" || !(journal instanceof FundingRecovery) || typeof sign !== "function" || typeof submit !== "function")
      throw Error("Explicit isolated funding callbacks required");
    this.#journal = journal; this.#sign = sign; this.#submit = submit; this.#timeout = integer(timeoutMs, 50, 30000);
  }
  async #invoke(callback, value) {
    const controller = new AbortController(); let timer;
    try { return await Promise.race([Promise.resolve().then(() => callback(structuredClone(value), { signal: controller.signal })),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("Funding response lost; recover the original envelope")); }, this.#timeout); })]); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async start(id, request) {
    const d = await this.#journal.begin(id, request);
    if (d.action === "prepare_funding") await this.#journal.stage(id, await this.#invoke(this.#sign, d));
    return this.tick(id);
  }
  async tick(id) {
    const d = await this.#journal.advance(id);
    if (d.action !== "submit_exact_transaction") return d;
    try { await this.#invoke(this.#submit, { transaction: d.transaction, intent: d.intent }); } catch { /* Saved attempt remains uncertain. */ }
    return { action: "await_finality", ...this.#journal.status(id) };
  }
}
module.exports = { FundingRecovery, FundingRecoveryRunner };
