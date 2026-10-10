"use strict";
const fs = require("fs"), path = require("path"), { DatabaseSync } = require("node:sqlite");
const { Signer, utils } = require("koilib");
const { KoinChain } = require("../core/lib/koin-network/chain");
const { FundingObserver, intent } = require("../core/lib/koin-network/funding-observer");
const { hash, digest, integer } = require("../core/lib/koin-network/job-protocol");
const { uint, DAY } = require("../core/lib/koin-network/policy");
const { WalletNonceCoordinator, nonce } = require("../core/lib/koinos/wallet-nonce");
const { JournalSet } = require("../core/lib/koin-network/journal-set");
const { assertPaymentMode } = require("../core/lib/koin-network/payment-mode");
const terminal = s => ["funded", "reverted", "conflicted"].includes(s);

// No wallet keys, IPC, timer or broadcast transport. Callers must explicitly
// configure an isolated rehearsal or Foundation Test deployment.
class FundingRecovery {
  #db; #client; #observer; #clock; #identity; #policy; #nonces; #guard;
  constructor(directory, { mode, client, clock = Date.now, maxRcPerDay, maxAttempts = 3, minRetryMs = 1000 }) {
    assertPaymentMode(mode, client);
    if (typeof maxRcPerDay !== "string" || !uint(maxRcPerDay)) throw Error("Positive daily funding RC budget required");
    this.#policy = { maxRcPerDay, maxAttempts: integer(maxAttempts, 1, 20), minRetryMs: integer(minRetryMs, 1000, 3600000) };
    this.#client = client; this.#clock = clock; this.#observer = new FundingObserver(client, { clock });
    this.#identity = JSON.stringify({ schema: 1, mode, deployment: client.d, policy: this.#policy });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#guard = new JournalSet(directory);
    try {
      const file = path.join(directory, "funding-recovery.sqlite"); this.#db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
      this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, clock INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS deposits(id TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL, tx_id TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mana(day TEXT NOT NULL, owner TEXT NOT NULL, id TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY(day,id));`);
      this.#guard.attach(this.#db);
      const existing = this.#db.prepare("SELECT data FROM identity WHERE id=1").get();
      if (existing && existing.data !== this.#identity) throw Error("Funding deployment or policy changed");
      if (!existing) this.#tx(() => {
        const prior = this.#db.prepare("SELECT data FROM identity WHERE id=1").get();
        if (prior && prior.data !== this.#identity) throw Error("Funding deployment or policy changed");
        if (!prior) {
          if (["deposits", "mana"].some(t => this.#db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get())) throw Error("Missing funding identity");
          this.#db.prepare("INSERT INTO identity VALUES(1,?,?)").run(this.#identity, integer(clock()));
        }
      }, false);
      if (this.#db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw Error("Corrupt funding journal");
      if (this.#db.prepare("SELECT 1 FROM deposits LIMIT 1").get() && !fs.existsSync(path.join(directory, "wallet-nonces.sqlite")))
        throw Error("Shared wallet nonce journal missing; restore both journals before recovery");
      this.#nonces = new WalletNonceCoordinator(directory, { mode, client, clock });
    } catch (e) { this.#db?.close(); this.#guard.close(); throw e; }
  }
  assertMode(mode) { assertPaymentMode(mode, this.#client); if (JSON.parse(this.#identity).mode !== mode) throw Error("Funding mode changed"); }
  get paymentsEnabled() { return JSON.parse(this.#identity).mode === "mainnet-pilot"; }
  get nonceCoordinator() { return this.#nonces; }
  #time() {
    const row = this.#db.prepare("SELECT data,clock FROM identity WHERE id=1").get(), now = integer(this.#clock());
    if (row?.data !== this.#identity) throw Error("Funding identity mismatch");
    if (now < row.clock) throw Error("Funding clock moved backwards");
    return now;
  }
  #tx(fn, check = true) {
    return this.#guard.write(this.#db, () => {
      if (check) this.#db.prepare("UPDATE identity SET clock=? WHERE id=1").run(this.#time());
      return fn();
    });
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
        !["signing", "staged", "unknown", "needs_review", "funded", "reverted", "conflicted"].includes(r.state) ||
        JSON.stringify(intent(r.intent)) !== JSON.stringify(r.intent) || r.draftHash !== hash(JSON.stringify(r.draft))) throw Error("Damaged funding binding");
    nonce(r.draft.header.nonce); integer(r.createdAt); integer(r.updatedAt, r.createdAt);
    const reviewedAt = r.reviewedAt ?? r.createdAt;
    integer(reviewedAt, r.createdAt, r.updatedAt); integer(r.expires, reviewedAt + 180000, reviewedAt + 180000);
    if (r.held !== undefined && typeof r.held !== "boolean") throw Error("Damaged funding hold");
    integer(r.holdVersion ?? 0);
    integer(r.attempts, 0, this.#policy.maxAttempts);
    if (r.transaction && (r.transaction.id !== r.draft.id || r.transactionHash !== hash(JSON.stringify(r.transaction)))) throw Error("Damaged funding envelope");
    if (!r.transaction && !["signing", "conflicted"].includes(r.state)) throw Error("Missing signed funding envelope");
    if (r.lastAttemptAt !== null) integer(r.lastAttemptAt, r.createdAt, r.updatedAt);
    if ((r.attempts === 0) !== (r.lastAttemptAt === null) || !Array.isArray(r.days) || new Set(r.days).size !== r.days.length ||
        r.days.length > r.attempts || (r.attempts === 0) !== (r.days.length === 0)) throw Error("Damaged funding attempts");
    for (const day of r.days) {
      const m = this.#db.prepare("SELECT owner,amount FROM mana WHERE day=? AND id=?").get(day, id);
      if (uint(day) > BigInt(Math.floor(r.lastAttemptAt / DAY)) || m?.owner !== r.intent.actor || m?.amount !== r.intent.maxRc) throw Error("Funding Mana journal mismatch");
    }
    this.#nonces.assertReservation(id, r.draft);
    return r;
  }
  status(id) {
    const r = this.#row(id);
    return { id, state: r.state, reason: r.reason, txId: r.draft.id, attempts: r.attempts, kind: r.intent.kind,
      amount: r.intent.args.amount, actor: r.intent.actor, held: r.held === true, finality: structuredClone(r.finality), paymentsEnabled: this.paymentsEnabled };
  }
  assertClient(client) { if (client !== this.#client) throw Error("Funding review must use the journal's client"); }
  list() { return this.#db.prepare("SELECT id FROM deposits ORDER BY rowid DESC LIMIT 200").all().map(r => this.status(r.id)); }
  saved(id) {
    digest(id); this.#time();
    if (!this.#db.prepare("SELECT 1 FROM deposits WHERE id=?").get(id)) return null;
    const r = this.#row(id);
    return structuredClone({ intent: r.intent, draft: r.draft, policyHash: r.policyHash, holdVersion: r.holdVersion ?? 0, signed: !!r.transaction, ...this.status(id) });
  }
  hold(id) {
    return this.#tx(() => {
      if (!this.saved(id)) return false;
      const r = this.#row(id);
      if (!terminal(r.state)) { r.held = true; r.holdVersion = integer((r.holdVersion ?? 0) + 1); this.#save(r); } return true;
    });
  }
  #review(review, draft, policyHash, active) {
    const now = this.#time();
    if (!review || review.txId !== draft.id || review.policyHash !== policyHash ||
        !Number.isSafeInteger(review.startedAt) || review.startedAt < 0 || now < review.startedAt ||
        review.expires !== review.startedAt + 180000 || now >= review.expires || !active()) throw Error("Funding review changed or expired");
  }
  // Internal trusted-main-process boundary, never an IPC approval receipt.
  async beginReviewed(id, value, review, active) {
    if (!review || typeof active !== "function") throw Error("Native funding review required");
    return this.#begin(id, value, structuredClone(review), active);
  }
  async begin(id, value) { return this.#begin(id, value); }
  async #begin(id, value, review, active) {
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
    if (this.#db.prepare("SELECT 1 FROM deposits WHERE owner=? AND id<>? AND state NOT IN ('funded','reverted','conflicted')").get(request.actor, id))
      throw Error("Another deposit owns this wallet nonce; recover it first");
    if (review) this.#review(review, draft, hash(JSON.stringify(state)), active);
    const reservation = await this.#nonces.reserve(id, "funding", draft, () => !review || (active() && this.#time() < review.expires));
    return this.#tx(() => {
      if (this.#db.prepare("SELECT 1 FROM deposits WHERE id=?").get(id)) {
        if (JSON.stringify(this.#row(id).intent) !== JSON.stringify(request)) throw Error("Cannot replace funding intent");
        return { action: "recover_existing", ...this.status(id) };
      }
      if (this.#db.prepare("SELECT 1 FROM deposits WHERE owner=? AND state NOT IN ('funded','reverted','conflicted')").get(request.actor))
        throw Error("Another deposit owns this wallet nonce; recover it first");
      for (const prior of this.#db.prepare("SELECT id FROM deposits WHERE owner=?").all(request.actor))
        if (nonce(draft.header.nonce) <= nonce(this.#row(prior.id).draft.header.nonce)) throw Error("Funding nonce did not advance");
      const now = this.#time();
      if (review) this.#review(review, draft, hash(JSON.stringify(state)), active);
      this.#save({ id, intent: request, state: "signing", reason: null, draft, draftHash: hash(JSON.stringify(draft)),
        policyHash: hash(JSON.stringify(state)), transaction: null, transactionHash: null, createdAt: now, expires: now + 180000,
        held: false, attempts: 0, lastAttemptAt: null, days: [], finality: null });
      if (reservation.action !== "sign_original") return { action: "recover_existing", ...this.status(id) };
      return { action: "prepare_funding", id, transaction: structuredClone(draft), intent: request, paymentsEnabled: this.paymentsEnabled };
    });
  }
  async resumeReviewed(id, review, active) {
    review = structuredClone(review);
    const initial = this.#row(id);
    if (!initial.transaction) throw Error("Recover the original signed funding envelope first");
    await this.#validate(initial.transaction, initial);
    const config = await this.#client.verify(), next = await this.#client.provider.getNextNonce(initial.intent.actor);
    return this.#tx(() => {
      const r = this.#row(id);
      if (terminal(r.state)) return this.status(id);
      this.#review(review, r.draft, r.policyHash, active);
      if (review.holdVersion !== (r.holdVersion ?? 0)) throw Error("Funding was stopped or resumed during this review");
      if (config.paused || hash(JSON.stringify(config)) !== r.policyHash || next !== r.draft.header.nonce ||
          (r.state === "needs_review" && r.reason !== "funding_review_expired")) throw Error("Funding cannot resume with changed policy, nonce or exhausted attempts");
      r.held = false; r.holdVersion = integer((r.holdVersion ?? 0) + 1); r.reviewedAt = this.#time(); r.expires = r.reviewedAt + 180000;
      if (r.state === "needs_review") { r.state = "staged"; r.reason = null; }
      this.#save(r); return this.status(id);
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
    await this.#nonces.stage(id, tx);
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
  async advance(id, { allowSubmit = true } = {}) {
    if (typeof allowSubmit !== "boolean") throw Error("Explicit funding submission mode required");
    let initial = this.#row(id);
    if (terminal(initial.state)) { await this.#nonces.reconcile(id); return { action: "done", ...this.status(id) }; }
    const nonceState = this.#nonces.status(id);
    const correction = this.#nonces.correction(id);
    const correctedWinner = nonceState.state === "consumed_elsewhere" && correction?.transaction && ["finalized", "reverted"].includes(correction.state);
    if (nonceState.state === "consumed_elsewhere" && !correctedWinner) return this.#tx(() => {
      const r = this.#row(id); r.state = "conflicted"; r.reason = "nonce_consumed_by_other_transaction"; r.finality = nonceState.finality;
      this.#save(r); return { action: "done", ...this.status(id) };
    });
    // A crash between the two envelope writes can recover the first durable
    // copy. It must never invoke the signer again.
    if (!initial.transaction && this.#nonces.envelope(id)) { await this.stage(id, this.#nonces.envelope(id)); initial = this.#row(id); }
    if (!initial.transaction) return { action: "review", ...this.status(id), reason: "recover_signing_envelope" };
    // The original envelope stays immutable. A reviewed correction can count as
    // this deposit only after its exact same-nonce transaction wins irreversibly,
    // and the funding observer independently verifies its transfer and balance.
    const observed = correctedWinner ? { ...initial, draft: correction.draft, transaction: correction.transaction,
      intent: { ...initial.intent, maxRc: correction.draft.header.rc_limit } } : initial;
    await this.#validate(observed.transaction, observed);
    const finality = await this.#observer.finality(observed.transaction, observed.intent);
    const confirmed = ["finalized", "reverted"].includes(finality.state);
    const evidence = await this.#observer.inspect(initial.intent, confirmed ? finality.height : "0");
    const nextNonce = confirmed ? null : await this.#client.provider.getNextNonce(initial.intent.actor);
    const result = this.#tx(() => {
      const r = this.#row(id);
      if (terminal(r.state)) return { action: "done", ...this.status(id) };
      if (evidence.state !== "verified") return { action: "wait", reason: "funding_" + evidence.state, paymentsEnabled: this.paymentsEnabled };
      if (this.#time() - evidence.checkedAt > 5000 || this.#time() < evidence.checkedAt) throw Error("Stale funding evidence");
      if (confirmed && uint(evidence.height) >= uint(finality.height)) {
        if (finality.state === "finalized" && evidence.allowance !== "0") return { action: "review", reason: "residual_allowance", paymentsEnabled: this.paymentsEnabled };
        r.finality = finality; r.state = finality.state === "finalized" ? "funded" : "reverted"; r.reason = null; this.#save(r);
        return { action: "done", ...this.status(id) };
      }
      if (correction) return { action: "review", ...this.status(id), reason: "funding_mana_correction_pending" };
      if (r.held) return { action: "review", ...this.status(id), reason: "funding_user_stopped" };
      if (r.state === "needs_review") return { action: "review", ...this.status(id) };
      if (finality.state !== "unknown") return { action: "wait", reason: "funding_" + finality.state, paymentsEnabled: this.paymentsEnabled };
      if (!allowSubmit) return { action: "review", ...this.status(id), reason: "funding_resume_review_required" };
      let reason = null;
      if (hash(JSON.stringify(evidence.config)) !== r.policyHash) reason = "funding_policy_changed";
      else if (nonce(nextNonce) !== nonce(r.draft.header.nonce)) reason = "wallet_nonce_changed";
      else if (r.attempts === 0 && this.#time() >= r.expires) reason = "funding_review_expired";
      else if (r.attempts >= this.#policy.maxAttempts) reason = "funding_attempt_limit";
      if (reason) { r.state = "needs_review"; r.reason = reason; this.#save(r); return { action: "review", ...this.status(id) }; }
      if (evidence.config.paused || evidence.allowance !== "0") return { action: "wait", reason: "funding_paused_or_allowance", paymentsEnabled: this.paymentsEnabled };
      const now = this.#time();
      if (r.lastAttemptAt !== null && now - r.lastAttemptAt < this.#policy.minRetryMs) return { action: "wait", reason: "funding_retry_delay", paymentsEnabled: this.paymentsEnabled };
      const day = String(Math.floor(now / DAY));
      if (!r.days.includes(day)) {
        const used = this.#db.prepare("SELECT amount FROM mana WHERE day=? AND owner=?").all(day, r.intent.actor).reduce((sum, m) => sum + uint(m.amount), 0n);
        if (used + uint(r.intent.maxRc) > uint(this.#policy.maxRcPerDay)) return { action: "wait", reason: "funding_daily_rc_budget", paymentsEnabled: this.paymentsEnabled };
        this.#db.prepare("INSERT INTO mana VALUES(?,?,?,?)").run(day, r.intent.actor, id, r.intent.maxRc); r.days.push(day);
      }
      r.attempts++; r.lastAttemptAt = now; r.state = "unknown"; this.#save(r);
      return { action: "submit_exact_transaction", id, transaction: structuredClone(r.transaction), intent: structuredClone(r.intent), paymentsEnabled: this.paymentsEnabled };
    });
    if (result.action === "done") await this.#nonces.reconcile(id);
    return result;
  }
  close() { this.#db.close(); this.#nonces.close(); this.#guard.close(); }
}

class FundingRecoveryRunner {
  #journal; #sign; #submit; #timeout;
  constructor({ mode, journal, sign, submit, timeoutMs = 5000 }) {
    if (!(journal instanceof FundingRecovery) || typeof sign !== "function" || typeof submit !== "function")
      throw Error("Explicit funding callbacks required");
    journal.assertMode(mode);
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
    let reason = null;
    try { await this.#invoke(this.#submit, { transaction: d.transaction, intent: d.intent }); }
    catch (error) {
      // Report a bounded category, never raw transport data, signatures or
      // credentials. A rejection/timeout still cannot resolve the saved nonce.
      reason = /insufficient rc|compute bandwidth limit|insufficient mana|rc limit/i.test(String(error?.message || ""))
        ? "funding_insufficient_rc" : "funding_submission_uncertain";
    }
    return { action: "await_finality", ...this.#journal.status(id), reason };
  }
}
module.exports = { FundingRecovery, FundingRecoveryRunner };
