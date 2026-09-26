"use strict";
// Private main-process client. This is not exposed through Core, tools or IPC
// arguments. It signs one bounded rehearsal certificate, never a transaction.
const fs = require("fs"), path = require("path");
const P = require("../core/lib/koin-network/job-protocol"), D = require("../core/lib/koin-network/session-delegation");
const { scheduler } = require("../core/lib/koin-network/grant-chat");
function configuration(value) {
  if (!value || Object.keys(value).sort().join() !== "amount,expires,maxJobs,maxOutput,model,perJob,schedulerUrl,session,target,version") throw Error("Exact funded rehearsal configuration required");
  const c = structuredClone(value);
  c.schedulerUrl = scheduler(c.schedulerUrl); c.target = D.target(c.target); P.digest(c.session);
  D.amount(c.amount); D.amount(c.perJob); P.integer(c.maxJobs, 1, 10000); P.integer(c.maxOutput, 1, 2000000);
  P.integer(c.version, 1); P.integer(c.expires);
  return c;
}
class FundedSessionClient {
  #config; #file; #authorize; #sign; #fetch; #clock; #record; #observation = null; #configHash;
  constructor({ config, file, authorize, sign, fetchImpl = fetch, clock = Date.now }) {
    this.#config = configuration(config); this.#file = file; this.#authorize = authorize; this.#sign = sign; this.#fetch = fetchImpl; this.#clock = clock;
    this.#configHash = P.hash(JSON.stringify(Object.fromEntries(Object.entries(this.#config).sort(([a], [b]) => a.localeCompare(b)))));
    try {
      this.#record = JSON.parse(fs.readFileSync(file, "utf8"));
      if (this.#record.configHash !== this.#configHash) throw Error("Saved session belongs to a different rehearsal configuration");
      const t = D.verify(this.#record.terms, this.#record.signature), c = this.#config;
      if (JSON.stringify(t.target) !== JSON.stringify(c.target) || ["session", "model", "version", "maxOutput", "amount", "perJob", "maxJobs", "expires"].some(k => t[k] !== c[k])) throw Error("Saved approval differs from configured limits");
      if (this.#record.id !== D.id(this.#record.terms)) throw Error("Saved session approval is damaged");
    } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  #save(record) {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const temp = this.#file + ".tmp";
    const fd = fs.openSync(temp, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.#file);
    if (process.platform !== "win32") {
      const directory = fs.openSync(path.dirname(this.#file), "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    this.#record = structuredClone(record);
  }
  async #auth(signal, history = false) {
    signal?.throwIfAborted();
    const auth = await this.#authorize(this.#config.schedulerUrl, signal, { grantId: this.#record?.terms.grantId, allowInactive: history });
    D.identity(auth.accountId); D.identity(auth.grantId);
    return auth;
  }
  async #call(action, body, auth, signal) {
    const response = await this.#fetch(this.#config.schedulerUrl + "/koin/funded/rehearsal/" + action, {
      method: "POST", redirect: "error", signal, headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ ...body, sessionToken: auth.sessionToken }),
    });
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 65536) throw Error("Session response too large"); chunks.push(chunk); }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok || result.ok !== true) throw Error(typeof result.error === "string" ? result.error.split(auth.sessionToken).join("[redacted]").slice(0, 220) : "Session request failed");
    if (result.mode !== "funded-rehearsal" || result.paymentsEnabled !== false) throw Error("Invalid session rehearsal response");
    return result;
  }
  #matching(t, auth) {
    const c = this.#config;
    if (JSON.stringify(t.target) !== JSON.stringify(c.target) || t.session !== c.session || t.owner !== auth.owner ||
        t.accountId !== auth.accountId || t.grantId !== auth.grantId ||
        ["model", "version", "maxOutput", "amount", "perJob", "maxJobs", "expires"].some(k => t[k] !== c[k])) throw Error("Session terms or account changed");
    if (this.#clock() < t.issuedAt || this.#clock() >= Math.min(t.expires, t.issuedAt + 300000)) throw Error("Session review expired");
  }
  async prepare(signal) {
    if (this.#record) throw Error("Use the saved session approval or revoke it; a second approval is not created");
    const auth = await this.#auth(signal), c = this.#config;
    if (!this.#observation) {
      const result = await this.#call("observe", { grantId: auth.grantId, session: c.session }, auth, signal);
      this.#observation = P.digest(result.observationId);
    }
    const proposal = Object.fromEntries(["model", "version", "maxOutput", "amount", "perJob", "maxJobs", "expires"].map(k => [k, c[k]]));
    let result;
    try { result = await this.#call("review", { grantId: auth.grantId, observationId: this.#observation, proposal }, auth, signal); }
    catch (e) { this.#observation = null; throw e; }
    if (result.state === "reversible") throw Error("Session funding is awaiting finality. Retry this review in a moment");
    if (result.state) { this.#observation = null; throw Error("Session funding changed. Review it again"); }
    const t = D.terms(result.terms); this.#matching(t, auth);
    if (D.id(t) !== result.delegationId) throw Error("Session commitment mismatch");
    return { terms: t, tariff: D.tariff(t, result.tariffs), id: result.delegationId, observationId: this.#observation };
  }
  async approve(review, signal) {
    if (this.#record) throw Error("Session approval already saved");
    const auth = await this.#auth(signal), terms = D.terms(review.terms); this.#matching(terms, auth);
    if (D.id(terms) !== review.id || review.observationId !== this.#observation) throw Error("Session review changed");
    const signature = await this.#sign(D.hash(terms)); D.verify(terms, signature);
    signal?.throwIfAborted();
    const current = await this.#auth(signal); this.#matching(terms, current);
    if (current.sessionToken !== auth.sessionToken) throw Error("Account session changed during review");
    this.#save({ configHash: this.#configHash, id: review.id, terms, signature, observationId: review.observationId, phase: "pending" });
    return this.#submit(signal);
  }
  #owner(auth) {
    const r = this.#record;
    if (!r || r.terms.owner !== auth.owner || r.terms.accountId !== auth.accountId || r.terms.grantId !== auth.grantId) throw Error("Saved approval belongs to another account or grant");
    return r;
  }
  #status(result, r) {
    if (result.id !== r.id || result.session !== r.terms.session || result.owner !== r.terms.owner ||
        !["active", "revoked", "expired", "account_unavailable", "reconciliation_required"].includes(result.state) ||
        ["amount", "perJob", "maxJobs", "expires", "model", "version", "maxOutput"].some(k => result[k] !== r.terms[k])) throw Error("Session acknowledgment mismatch");
    for (const k of ["held", "spent", "available"]) if (typeof result[k] !== "string" || !/^(0|[1-9]\d{0,19})$/.test(result[k])) throw Error("Invalid session accounting");
    if (BigInt(result.held) + BigInt(result.spent) + BigInt(result.available) !== BigInt(r.terms.amount)) throw Error("Session accounting mismatch");
    P.integer(result.remainingJobs, 0, r.terms.maxJobs);
    return { enabled: true, mode: "funded-rehearsal", paymentsEnabled: false,
      ...Object.fromEntries(["id", "session", "owner", "state", "amount", "perJob", "held", "spent", "available", "remainingJobs", "maxJobs", "expires", "model", "version", "maxOutput"].map(k => [k, result[k]])) };
  }
  async retry(signal) {
    // Recover an accepted response even after funding has since changed or
    // the account grant expired. Only a missing record needs retransmission.
    try {
      const status = await this.status(signal);
      if (this.#record) this.#save({ ...this.#record, phase: status.state });
      return status;
    } catch (e) { if (e.message !== "Session delegation is unavailable") throw e; }
    return this.#submit(signal);
  }
  async #submit(signal) {
    const auth = await this.#auth(signal), r = this.#owner(auth);
    // The identical certificate is retried; no new signature, nonce or budget.
    let result;
    try { result = await this.#call("authorize", { grantId: auth.grantId, observationId: r.observationId, terms: r.terms, signature: r.signature }, auth, signal); }
    catch (e) {
      // A server restart drops private funding snapshots. Keep the approval,
      // observe again, and let a later explicit retry await that finality.
      if (/Unknown or expired observation/.test(e.message)) {
        const observation = await this.#call("observe", { grantId: auth.grantId, session: r.terms.session }, auth, signal);
        this.#save({ ...r, observationId: P.digest(observation.observationId) });
        throw Error("Funding was observed again. Retry the saved approval after finality");
      }
      throw e;
    }
    const status = this.#status(result, r); this.#save({ ...r, phase: status.state }); return status;
  }
  async status(signal) {
    if (!this.#record) return { enabled: true, mode: "funded-rehearsal", paymentsEnabled: false, state: "unapproved" };
    const auth = await this.#auth(signal, true), r = this.#owner(auth);
    const result = await this.#call("status", { id: r.id }, auth, signal);
    return this.#status(result, r);
  }
  hasSavedApproval() { return !!this.#record; }
  async revoke(signal) {
    const auth = await this.#auth(signal, true), r = this.#owner(auth);
    const status = this.#status(await this.#call("revoke", { id: r.id }, auth, signal), r);
    if (status.state !== "revoked") throw Error("Session revocation was not confirmed");
    this.#save({ ...r, phase: "revoked" }); return status;
  }
}
module.exports = { FundedSessionClient, configuration };
