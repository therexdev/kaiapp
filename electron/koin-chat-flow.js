"use strict";
// The ordinary desktop composer uses the existing reviewed payment clients.
// This coordinator cannot manufacture a transaction or approve spending itself.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const P = require("../core/lib/koin-network/job-protocol");
const terminal = s => ["finalized", "reverted", "consumed_elsewhere"].includes(s);
const delay = (ms, signal) => require("node:timers/promises").setTimeout(ms, undefined, { signal });
function request(value, config) {
  if (!value || Object.keys(value).some(k => !["model", "messages", "max_tokens", "stream"].includes(k))) throw Error("Unsupported network chat request");
  if (!["koinos-network", "koinos-network:" + config.model].includes(value.model)) throw Error("Choose the approved network model");
  if (value.stream !== undefined && typeof value.stream !== "boolean") throw Error("Invalid stream flag");
  const messages = P.messages(value.messages);
  // Leave room for private session authorization within the server body limit.
  if (Buffer.byteLength(JSON.stringify(messages)) > 24000) throw Error("This conversation is too long for the current network model. Start a new chat or shorten the message");
  const maxOutput = value.max_tokens === undefined ? config.maxOutput : P.integer(value.max_tokens, 1, config.maxOutput);
  return { messages, model: config.model, maxOutput };
}
class ChatFlow {
  constructor({ file, storage, payments, session, config, progress = () => {}, wait = delay, pollMs = 5000, attempts = 36 }) {
    Object.assign(this, { file, storage, payments, session, config, progress, wait, pollMs, attempts });
  }
  read() {
    if (!fs.existsSync(this.file)) return null;
    if (fs.statSync(this.file).size > 2000000) throw Error("Network request recovery file is too large");
    const r = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (r.schema !== 1 || r.owner !== this.config.owner || r.deployment !== P.hash(JSON.stringify(this.config)) ||
        !["pending", "answered", "delivered", "cancelled", "settled"].includes(r.state)) throw Error("Network request recovery identity changed");
    P.digest(r.id); P.digest(r.session); P.digest(r.requestHash);
    return r;
  }
  save(r) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + ".tmp", fd = fs.openSync(temp, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(r)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
    if (process.platform !== "win32") { const dir = fs.openSync(path.dirname(this.file), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
  }
  acknowledge(id) {
    P.digest(id); const r = this.read();
    if (r?.id === id && r.state === "answered") { const { answer, input, ...rest } = r; this.save({ ...rest, state: "delivered" }); }
  }
  async confirm(window, tx, signal) {
    if (!tx?.id) throw Error(tx?.error || "Payment approval was cancelled");
    for (let i = 0; i < this.attempts; i++) {
      signal.throwIfAborted();
      const result = await this.payments.run(window, "check", tx.id);
      signal.throwIfAborted();
      if (result.funding?.state === "funded" || result.state === "finalized" && !result.funding) return result;
      if (["reverted", "consumed_elsewhere"].includes(result.state)) throw Error("The payment did not complete. Open payment activity to review it");
      if (["credit_saved_review_required", "credit_insufficient_rc", "credit_nonce_changed"].includes(result.reason) ||
          ["funding_insufficient_rc", "funding_resume_review_required", "funding_user_stopped"].includes(result.funding?.reason))
        throw Error("Your saved payment needs review. Open payment activity; your existing KOIN and transaction are preserved");
      this.progress("Confirming your KOIN on the blockchain…");
      if (i + 1 < this.attempts) await this.wait(this.pollMs, signal);
    }
    throw Error("Confirmation is still pending. Try again shortly to continue the same payment; no additional deposit is needed");
  }
  async prepare(window, signal) {
    signal.throwIfAborted(); this.progress("Checking your network balance…");
    const status = await this.payments.status(); signal.throwIfAborted();
    if (status.paused) throw Error("The network has paused new spending. Your unused KOIN remains in your account");
    // Reconcile existing transactions before considering a new reservation.
    for (const tx of status.transactions || []) {
      const funding = status.deposits?.find(d => d.id === tx.id);
      if (!terminal(tx.state) || tx.state === "finalized" && funding && funding.state !== "funded") await this.confirm(window, tx, signal);
    }
    let pair = await this.session(); signal.throwIfAborted();
    if (!pair) {
      if (BigInt(status.balances.available) <= 0n) throw Error("Add KOIN to your network balance to start chatting. If KOIN is reserved in an expired session, use Release in payment activity");
      this.progress("Review your chat spending limit…");
      const tx = await this.payments.run(window, "reserve"); signal.throwIfAborted();
      if (tx.state === "cancelled") throw Object.assign(Error("Spending approval cancelled"), { name: "AbortError" });
      await this.confirm(window, tx, signal);
      pair = await this.session();
      if (!pair) throw Error("Your spending limit is still being confirmed. Try again shortly");
    }
    let state = pair.client.hasSavedApproval() ? await pair.client.retry(signal) : await pair.client.status(signal);
    if (state.state === "unapproved") {
      // Observation itself needs irreversible confirmation; retries are reads
      // until createSessionReview displays the exact native approval.
      for (let i = 0; i < this.attempts; i++) {
        signal.throwIfAborted(); this.progress("Preparing your spending approval…");
        state = await pair.run(window, "review");
        if (!/awaiting finality|funding changed|observed again/i.test(state.error || "")) break;
        await this.wait(this.pollMs, signal);
      }
    } else if (pair.client.hasSavedApproval() && state.state !== "active") {
      throw Error("Your spending approval is " + state.state.replaceAll("_", " ") + ". Review it in your network account");
    }
    signal.throwIfAborted();
    if (state.state === "cancelled") throw Object.assign(Error("Spending approval cancelled"), { name: "AbortError" });
    if (state.state !== "active") throw Error(state.error || "Your spending approval is not ready. Open your network account to continue");
    if (state.remainingJobs === 0 || BigInt(state.available) === 0n) throw Error("This chat spending allowance is used up. Review your allowance in the network account");
    return pair;
  }
  async chat(window, value, signal) {
    const input = request(value, this.config), requestHash = P.hash(JSON.stringify(input));
    if (!this.storage?.isEncryptionAvailable?.()) throw Error("Unlock secure storage to use network chat recovery");
    let record = this.read();
    if (record?.state === "answered" && record.requestHash === requestHash) {
      return JSON.parse(this.storage.decryptString(Buffer.from(record.answer, "base64")));
    }
    if (record?.state === "answered") throw Error("Recover your last reply in Chat before starting another request");
    // Preserve the old request ID after timeouts/restart. A new prompt cannot
    // spend around an unresolved request, even after choosing a new session.
    if (record?.state === "pending") {
      const pair = await this.session(record.session);
      if (!pair) throw Error("The original spending session could not be recovered. Your pending request is preserved");
      const old = await pair.client.requestStatus(record.id, signal);
      if (record.requestHash !== requestHash) {
        if (!["cancelled", "settled"].includes(old.state)) throw Error("Your previous request is still being checked. Send its original message to recover the response");
        this.save({ ...record, state: old.state }); record = null;
      } else if (old.state === "cancelled") {
        this.save({ ...record, state: "cancelled" });
        throw Error("The previous request was cancelled without a charge. Send again to start a new request");
      }
      if (record?.state === "pending") {
        if (pair.config.expires <= Date.now()) {
          if (old.state === "settled") this.save({ ...record, state: "settled" });
          throw Error(old.state === "settled" ? "Your previous request was charged once, but its answer is no longer available. Sending again starts a new paid request" : "Your previous session expired with a request still being checked. No new request was started");
        }
        await pair.client.retry(signal);
        return this.consume(pair, input, record, signal);
      }
    }
    const pair = await this.prepare(window, signal); signal.throwIfAborted();
    if (!record || record.state !== "pending") {
      record = { schema: 1, owner: this.config.owner, deployment: P.hash(JSON.stringify(this.config)),
        id: crypto.randomBytes(32).toString("hex"), session: pair.config.session, requestHash, state: "pending",
        input: this.storage.encryptString(JSON.stringify(value)).toString("base64") };
      this.save(record);
    }
    return this.consume(pair, input, record, signal);
  }
  async recover(window, signal) {
    const r = this.read();
    if (!r || !["pending", "answered"].includes(r.state) || !r.input) throw Error("No interrupted chat to recover");
    if (!this.storage?.isEncryptionAvailable?.()) throw Error("Unlock secure storage to recover this chat");
    const value = JSON.parse(this.storage.decryptString(Buffer.from(r.input, "base64")));
    if (P.hash(JSON.stringify(request(value, this.config))) !== r.requestHash) throw Error("Saved request changed");
    return { completion: await this.chat(window, value, signal), messages: value.messages };
  }
  async consume(pair, input, record, signal) {
    this.progress("The network is generating your answer…");
    const result = await pair.client.consume({ schedulerUrl: this.config.schedulerUrl, ...input, requestId: record.id, signal });
    // Save verified delivery before replying to the renderer; neither private
    // prompts nor plaintext answers are written into the payment journal.
    const answer = this.storage.encryptString(JSON.stringify(result)).toString("base64");
    this.save({ ...record, state: "answered", answer }); signal.throwIfAborted();
    this.progress("Answer verified. Updating your balance…");
    return result;
  }
}
module.exports = { ChatFlow, request };
