"use strict";
const fs = require("fs"), path = require("path");
const USD = require("../core/lib/koin-network/purchase-quote");
const { CreditPurchaseQuotes } = require("./credit-purchase-quotes");
const { guardOtherJournals, purchaseDirectory } = require("./credit-purchase-journals");
const Access = require("./credit-purchase-access");
const { purchaseFailureMessage } = require("./koin-funding-failure");
class CreditPurchases {
  constructor({ dataDir, account, storage, dialog, fetchImpl = fetch, clock = Date.now, clientFactory = d => new (require("../core/lib/koin-network/chain").KoinChain)(d) }) {
    Object.assign(this, { dataDir, account, storage, dialog, fetchImpl, clientFactory, clock }); this.quotes = new CreditPurchaseQuotes({ clock }); this.active = null;
  }
  stop() { this.quotes.clear(); this.active?.stop(); }
  async preview(c, input, signal) { return this.quotes.preview(c, input, signal); }
  async status(c, signal) {
    if (this.active) return { state: "checking", detail: "A payment check or review is in progress." };
    return await this.use(c, signal, payments => {
      const p = payments.pendingPurchase();
      if (!p) return null;
      const quoteExpired = Number.isSafeInteger(p.quoteExpiresAt) && this.clock() > p.quoteExpiresAt;
      const issue = p.submissionIssue || p.reason;
      const detail = quoteExpired ? "The saved payment is unconfirmed and its quote time has expired. Keep this transaction for recovery; do not start another purchase." :
        issue === "funding_insufficient_rc" ? "The last payment attempt reported insufficient Mana for its transaction limit. The saved payment needs review." :
        issue === "funding_simulation_failed" ? "The last payment attempt stopped during its pre-submission check. The saved payment needs review." :
        issue === "funding_submission_uncertain" ? "The last submission response was unavailable. This payment has not been confirmed; keep its original transaction." :
        "This saved payment has not been confirmed. Check its status before starting another purchase.";
      return { state: "pending", txId: p.txId, paymentState: p.state, issue: issue || null, quoteExpired, detail };
    }, false) ?? null;
  }
  async use(c, signal, fn, create = true) {
    if (this.active) throw Error("Finish the current payment check or review first");
    const wallet = this.account.wallet;
    if (!wallet || wallet.address !== c.config.owner) throw Error("Unlock the payment wallet linked to this account");
    signal?.throwIfAborted(); this.account.assertCreditAuthorization(c.auth, c.config.schedulerUrl);
    const directory = purchaseDirectory(this.dataDir, c.directory, c.config);
    if (!create && !fs.existsSync(path.join(directory, "funding-recovery.sqlite"))) return;
    if (create) guardOtherJournals(this.dataDir, directory, c.config);
    const client = this.clientFactory(c.config.deployment);
    const journal = new (require("./koin-funding-recovery").FundingRecovery)(directory, { mode: c.config.mode, client, clock: this.clock, maxRcPerDay: c.config.maxRcPerDay });
    let approved;
    try {
      const payments = this.active = new (require("./koin-test-payments").TestPayments)({ config: c.config, client, journal, wallet, dialog: this.dialog, clock: this.clock,
        authorizeHost: () => Access.claimHost({ c, account: this.account, wallet, signal, fetchImpl: this.fetchImpl,
          installation: Access.installation({ dataDir: this.dataDir, directory: c.directory, config: c.config, storage: this.storage }) }),
        purchaseQuote: async (amount, owner, quoteSignal) => {
          quoteSignal.throwIfAborted(); this.account.assertCreditAuthorization(c.auth, c.config.schedulerUrl);
          guardOtherJournals(this.dataDir, directory, c.config);
          if (!approved || approved.amount !== amount || owner !== c.config.owner) throw Error("A reviewed exchange quote is required");
          return structuredClone(approved);
        } });
      return await fn(payments, value => { approved = value; });
    }
    finally { this.active = null; journal.close(); }
  }
  async run(c, window, action, input, signal) {
    const args = action === "purchase-approve" ? await this.quotes.consume(c, input, signal) : null;
    if (!args && (action !== "purchase-retry" || input !== undefined)) throw Error("Invalid payment recovery action");
    return this.use(c, signal, async (payments, setApproved) => {
      setApproved(args);
      const result = await payments.run(window, args ? "purchase" : "purchase-retry", args ? USD.dollars(args.amount) : undefined, signal);
      if (!result.deposit && !["cancelled", "complete"].includes(result.status)) throw Error(purchaseFailureMessage(result.failure, !args));
      // If confirmation registration is interrupted, the durable original
      // transaction is registered again on the next read-only synchronization.
      if (result.deposit?.txId) try { await c.flow.call("purchase", { txId: result.deposit.txId }, signal); } catch {}
      return { state: result.status === "cancelled" ? "cancelled" : result.status === "complete" ? "complete" : "pending", ...(result.deposit ? { purchase: result.deposit } : {}) };
    });
  }
  async sync(c, signal) { return this.use(c, signal, payments => payments.syncPurchases((txId, nextSignal) => c.flow.call("purchase", { txId }, nextSignal), signal), false); }
}
module.exports = { CreditPurchases };
