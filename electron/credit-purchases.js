"use strict";
const fs = require("fs"), path = require("path"), crypto = require("node:crypto");
const USD = require("../core/lib/koin-network/purchase-quote");
const { CreditPurchaseQuotes } = require("./credit-purchase-quotes");
const { guardOtherJournals, purchaseDirectory } = require("./credit-purchase-journals");
const Access = require("./credit-purchase-access");
const { purchaseFailureMessage } = require("./koin-funding-failure");
function purchaseClient(d) {
  const { KoinChain } = require("../core/lib/koin-network/chain");
  const { PinnedRpcProvider } = require("../core/lib/koin-network/rpc-provider");
  // Public USD purchases do not use the legacy same-block balance snapshot.
  // Pace their requests so repeated checks cannot flood the public RPCs.
  return new KoinChain(d, new PinnedRpcProvider(d.rpc, d.chainId, { requestIntervalMs: 250, readHedgeMs: 750 }));
}
class CreditPurchases {
  constructor({ dataDir, account, storage, dialog, fetchImpl = fetch, clock = Date.now, clientFactory = purchaseClient, marketReader, progress = () => {} }) {
    Object.assign(this, { dataDir, account, storage, dialog, fetchImpl, clientFactory, clock }); this.quotes = new CreditPurchaseQuotes({ clock, fetchImpl, marketReader }); this.active = null; this.progress = progress;
  }
  beginProgress(c, stage) {
    const now = this.clock(), op = this.purchaseOperation = { key: this.key(c), closed: false,
      value: { operationId: crypto.randomBytes(32).toString("hex"), stage, startedAt: now, updatedAt: now } };
    this.report(op, stage); return op;
  }
  report(op, stage, detail = {}) {
    if (!op || op !== this.purchaseOperation || op.closed) return;
    const allowed = ["txId", "blockHeight", "irreversibleHeight", "outcome"], safe = {};
    for (const key of allowed) if (detail[key] !== undefined) safe[key] = detail[key];
    if (detail.state) {
      op.confirmation = structuredClone(detail);
      delete op.value.blockHeight; delete op.value.irreversibleHeight;
    }
    op.value = { ...op.value, ...safe, stage, updatedAt: this.clock() };
    try { this.progress(structuredClone(op.value)); } catch {}
    if (["complete", "failed", "stopped"].includes(stage)) op.closed = true;
  }
  progressSnapshot(c) { return this.purchaseOperation && this.purchaseOperation.key === this.key(c) ? structuredClone(this.purchaseOperation.value) : null; }
  stop() { this.report(this.purchaseOperation, "stopped"); this.quotes.clear(); this.background?.abort.abort(); this.active?.stop(); }
  async pauseSync() {
    const pending = this.background;
    if (pending) { pending.abort.abort(); await pending.promise.catch(() => {}); }
  }
  async estimateCapabilities(c, signal) { return this.quotes.capabilities(c, signal); }
  async estimate(c, input, signal) { return this.quotes.estimate(c, input, signal); }
  async preview(c, input, signal) {
    const op = this.beginProgress(c, "getting-price");
    try { const result = await this.quotes.preview(c, input, signal); op.quoteId = result.quote.id; return result; }
    catch (error) { this.report(op, signal?.aborted ? "stopped" : "failed"); throw error; }
  }
  async status(c, signal) {
    return this.read(c, signal, payments => {
      const p = payments.pendingPurchase();
      const busy = this.activeKind === "review" && this.activeKey === this.key(c);
      if (!p) return busy ? { state: "reviewing", busy: true, detail: "Confirm or cancel the payment in the desktop approval window." } : null;
      const quoteExpired = Number.isSafeInteger(p.quoteExpiresAt) && this.clock() > p.quoteExpiresAt;
      const issue = p.cancellation ? p.cancellation.issue : p.submissionIssue || p.reason;
      const last = this.purchaseOperation?.key === this.key(c) && this.purchaseOperation.confirmation?.txId === p.txId ? this.purchaseOperation.confirmation : null;
      const observation = p.confirmation || (last && Number.isSafeInteger(last.checkedAt) && this.clock() >= last.checkedAt && this.clock() - last.checkedAt <= 30000 ? last : null);
      const credited = this.purchaseOperation?.key === this.key(c) && this.purchaseOperation.value.txId === p.txId && this.purchaseOperation.value.outcome === "credited";
      const included = credited || observation?.state === "included" || observation?.state === "finalized";
      const detail = credited ? "Your credits have been added. Finishing the saved payment confirmation." : included ? "Your payment is included in a block. Waiting for irreversible confirmation before adding credits." : p.cancellation ? (["funding_insufficient_rc", "funding_simulation_failed"].includes(issue) ? "The cancellation stopped during its pre-submission check. Its signature is saved; use Continue payment to retry it." : p.cancellation.attempts === 0 ? "The zero-transfer cancellation is signed but has not been submitted. Use Continue payment to finish sending it." : "The cancellation submission is unconfirmed. Confirmation is checked automatically. A new purchase becomes available when this finishes.") : quoteExpired && p.attempts > 0 ? "Checking confirmation of the saved payment. Quote expiry does not cancel a payment already included in a block." : quoteExpired ? "This payment quote expired before submission. Use Continue payment to recover the saved transaction. Confirmation is checked automatically." :
        issue === "funding_insufficient_rc" ? "The last payment attempt reported insufficient Mana for its transaction limit. The saved payment needs review." :
        issue === "funding_simulation_failed" ? "The last payment attempt stopped during its pre-submission check. The saved payment needs review." :
        issue === "funding_submission_uncertain" ? "The last submission response was unavailable. This payment has not been confirmed; keep its original transaction." :
        "This saved payment has not been confirmed. Check its status before starting another purchase.";
      return { state: "pending", ...(busy ? { busy: true } : {}), txId: p.txId, paymentState: p.state, issue: issue || null, quoteExpired, cancellation: p.cancellation || null, confirmation: observation, recovery: included ? null : p.cancellation ? "resume-cancellation" : quoteExpired && p.attempts === 0 ? "cancel-expired" : issue === "funding_insufficient_rc" ? "correct-mana" : "retry", detail };
    }) ?? null;
  }
  async cancelled(c, signal) {
    return this.read(c, signal, payments => payments.purchaseHistory()
      .filter(p => p.state === "conflicted" && p.reason === "expired_purchase_cancelled" && ["finalized", "reverted"].includes(p.cancellation?.state) && p.cancellation.txId === p.finality?.txId)
      .map(p => ({ txId: p.txId, cancellationTxId: p.cancellation.txId, finality: p.finality }))) ?? [];
  }
  key(c) { return JSON.stringify([c.directory, c.auth.accountId, c.config]); }
  read(c, signal, fn) {
    signal?.throwIfAborted(); this.account.assertCreditAuthorization(c.auth, c.config.schedulerUrl);
    if (this.account.wallet?.address !== c.config.owner) throw Error("Unlock the payment wallet linked to this account");
    if (this.active && this.activeKey === this.key(c)) return fn(this.active);
    const opened = this.open(c, signal, false); if (!opened) return;
    try { return fn(opened.payments); } finally { opened.journal.close(); }
  }
  open(c, signal, create, op = null) {
    const wallet = this.account.wallet;
    if (!wallet || wallet.address !== c.config.owner) throw Error("Unlock the payment wallet linked to this account");
    signal?.throwIfAborted(); this.account.assertCreditAuthorization(c.auth, c.config.schedulerUrl);
    const directory = purchaseDirectory(this.dataDir, c.directory, c.config);
    if (!create && !fs.existsSync(path.join(directory, "funding-recovery.sqlite"))) return;
    if (create) guardOtherJournals(this.dataDir, directory, c.config);
    // Keep the working RPC fallback across confirmation polls. Recreating the
    // provider on every read repeatedly spends the whole timeout on an outage.
    const deployment = JSON.stringify(c.config.deployment);
    if (this.clientDeployment !== deployment) {
      this.client = this.clientFactory(c.config.deployment); this.clientDeployment = deployment;
    }
    const client = this.client;
    const journal = new (require("./koin-funding-recovery").FundingRecovery)(directory, { mode: c.config.mode, client, clock: this.clock, maxRcPerDay: c.config.maxRcPerDay });
    let approved, purchaseUsd;
    try {
      const payments = new (require("./koin-test-payments").TestPayments)({ config: c.config, client, journal, wallet, dialog: this.dialog, clock: this.clock, progress: (stage, detail) => this.report(op, stage, detail),
        purchaseDollars: () => purchaseUsd,
        authorizeHost: () => Access.claimHost({ c, account: this.account, wallet, signal, fetchImpl: this.fetchImpl,
          installation: Access.installation({ dataDir: this.dataDir, directory: c.directory, config: c.config, storage: this.storage }) }),
        purchaseQuote: async (amount, owner, quoteSignal, { fresh = false } = {}) => {
          quoteSignal.throwIfAborted(); this.account.assertCreditAuthorization(c.auth, c.config.schedulerUrl);
          guardOtherJournals(this.dataDir, directory, c.config);
          if (!approved || owner !== c.config.owner || (!purchaseUsd && approved.amount !== amount)) throw Error("A reviewed exchange quote is required");
          // Refresh only an unused quote, before opening wallet approval. A
          // signed saved payment never enters this branch or changes its price.
          if (purchaseUsd && (fresh || Number(approved.purchase_quote.expires_at) - this.clock() < 45000)) {
            this.report(op, "getting-price");
            const fresh = await this.quotes.preview(c, { usd: purchaseUsd }, quoteSignal, { fresh: true });
            approved = await this.quotes.consume(c, fresh.quote.id, quoteSignal);
          }
          return structuredClone(approved);
        } });
      return { payments, journal, setApproved: (value, usd) => { approved = value; purchaseUsd = usd; } };
    } catch (error) { journal.close(); throw error; }
  }
  async use(c, signal, fn, create = true, kind = "review", op = null) {
    if (this.active) throw Error("Finish or cancel the open payment approval first");
    const opened = this.open(c, signal, create, op); if (!opened) return;
    this.active = opened.payments; this.activeKind = kind; this.activeKey = this.key(c);
    try { return await fn(opened.payments, opened.setApproved); }
    finally {
      this.active = null; this.activeKind = null; this.activeKey = null;
      const staging = opened.payments.drain();
      if (staging) staging.finally(() => opened.journal.close()).catch(() => {});
      else opened.journal.close();
    }
  }
  async run(c, window, action, input, signal) {
    if (!["purchase-approve", "purchase-retry"].includes(action) || (action === "purchase-retry" && input !== undefined)) throw Error("Invalid payment recovery action");
    // A user click takes priority over read-only confirmation polling. Wait for
    // its aborted reads to unwind before opening the same durable journals.
    const op = action === "purchase-approve" && this.purchaseOperation?.key === this.key(c) && this.purchaseOperation.quoteId === input && !this.purchaseOperation.closed
      ? this.purchaseOperation : this.beginProgress(c, "checking-payment");
    this.report(op, "checking-payment");
    this.foregroundWaiting = (this.foregroundWaiting || 0) + 1;
    try {
      await this.pauseSync(); signal?.throwIfAborted();
      return await this.use(c, signal, async (payments, setApproved) => {
        // Consume only after owning the foreground action. A poll or competing
        // review must never discard a valid quote that has not been approved.
        const selection = action === "purchase-approve" ? await this.quotes.consumeSelection(c, input, signal, { allowExpired: true }) : null;
        const args = selection?.args; setApproved(args, selection?.usd);
        const result = await payments.run(window, args ? "purchase" : "purchase-retry", args ? USD.dollars(args.amount) : undefined, signal);
        // A timeout or window lifecycle failure can be labelled cancelled by
        // the guarded funding controller. Only an explicit native Cancel has
        // no failure: never turn a failed pre-review check into silent success.
        if (!result.deposit && (result.failure || !["cancelled", "complete"].includes(result.status))) throw Error(purchaseFailureMessage(result.failure, !args));
        // If confirmation registration is interrupted, the durable original
        // transaction is registered again on the next read-only synchronization.
        let credited = false;
        if (result.deposit?.txId && !["conflicted", "reverted"].includes(result.deposit.state)) try {
          const txId = result.registrationTxId || result.deposit.finality?.txId || result.deposit.txId;
          this.report(op, "updating-credits", { txId });
          const registration = await c.flow.call("purchase", { txId }, signal); credited = registration?.purchase?.state === "confirmed";
        } catch {}
        this.report(op, result.status === "cancelled" ? "stopped" : credited || result.status === "complete" ? "complete" : "awaiting-confirmation", {
          ...(result.deposit?.txId ? { txId: result.deposit.txId } : {}), ...(credited ? { outcome: "credited" } : result.status === "complete" ? { outcome: result.deposit?.reason === "expired_purchase_cancelled" ? "cancelled" : "checked" } : {}) });
        return { state: result.status === "cancelled" ? "cancelled" : result.status === "complete" ? "complete" : "pending", ...(result.deposit ? { purchase: result.deposit } : {}) };
      }, true, "review", op);
    } catch (error) { this.report(op, signal?.aborted ? "stopped" : "failed"); throw error; }
    finally { this.foregroundWaiting--; }
  }
  async sync(c, signal) {
    if (this.active || this.foregroundWaiting) return;
    if (this.background) return this.background.promise;
    const pending = this.background = { abort: new AbortController(), promise: null };
    const combined = AbortSignal.any([pending.abort.signal, ...(signal ? [signal] : []), AbortSignal.timeout(30000)]);
    pending.promise = Promise.resolve().then(() => {
      combined.throwIfAborted();
      const pendingPurchase = this.read(c, combined, payments => payments.pendingPurchase());
      const op = pendingPurchase ? (this.purchaseOperation?.key === this.key(c) && (!this.purchaseOperation.closed || this.purchaseOperation.value.txId === pendingPurchase.txId && this.purchaseOperation.value.outcome === "credited") ? this.purchaseOperation : this.beginProgress(c, "awaiting-confirmation")) : null;
      return this.use(c, combined, payments => payments.syncPurchases((txId, nextSignal) => c.flow.call("purchase", { txId }, nextSignal), combined), false, "sync", op);
    }).finally(() => { if (this.background === pending) this.background = null; });
    return pending.promise;
  }
}
module.exports = { CreditPurchases };
