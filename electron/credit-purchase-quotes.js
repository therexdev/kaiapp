"use strict";
const { utils } = require("koilib"), P = require("../core/lib/koin-network/job-protocol");
const USD = require("../core/lib/koin-network/purchase-quote");
// Private main-process cache. Renderer approval supplies only the opaque ID,
// never a replacement price, wallet, transaction or scheduler endpoint.
class CreditPurchaseQuotes {
  constructor({ clock = Date.now } = {}) { this.clock = clock; this.quotes = new Map(); }
  scope(c) { return P.hash(JSON.stringify([c.auth.accountId, P.hash(c.auth.sessionToken || ""), c.config])); }
  clear() { this.quotes.clear(); }
  async preview(c, input, signal) {
    if (!input || Object.keys(input).join() !== "usd") throw Error("Select a USD credit amount");
    // Validate decimal syntax before making a network request.
    USD.nativeForDollars(input.usd, "100000000");
    let wallet = false; try { wallet = utils.isChecksumAddress(c.config.owner); } catch {}
    if (!wallet) throw Error("Connect a payment wallet to buy credits. Free credits do not require a wallet.");
    const scope = this.scope(c), response = await c.flow.call("quote-usd", { dollars: input.usd }, signal);
    signal?.throwIfAborted();
    const args = response.args, q = await USD.verify(c.config.deployment, args, { now: this.clock(), version: c.config.version });
    if (q.account !== utils.encodeBase64url(utils.decodeBase58(c.config.owner)) || q.amount !== USD.nativeForDollars(input.usd, q.usd_per_koin)) throw Error("The quote does not match the selected account and USD amount");
    if (BigInt(q.amount) > BigInt(c.config.limits.amount)) throw Error("This purchase exceeds the configured payment limit");
    signal?.throwIfAborted();
    const id = Buffer.from(q.id, "base64url").toString("hex");
    for (const [key, saved] of this.quotes) if (saved.scope !== scope || Number(saved.args.purchase_quote.expires_at) <= this.clock()) this.quotes.delete(key);
    // One current quote per account scope, with no durable authorization.
    this.clear(); this.quotes.set(id, { scope, args: structuredClone(args) });
    return { quote: { id, koin: USD.dollars(q.amount), credits: USD.credits(q.credits), usd: USD.dollars(q.credits), observedAt: Number(q.issued_at), expiresAt: Number(q.expires_at) } };
  }
  async consume(c, id, signal) {
    P.digest(id); const saved = this.quotes.get(id); this.quotes.delete(id);
    if (!saved || saved.scope !== this.scope(c)) throw Error("Refresh the exchange quote before reviewing payment");
    signal?.throwIfAborted();
    await USD.verify(c.config.deployment, saved.args, { now: this.clock(), version: c.config.version });
    return structuredClone(saved.args);
  }
}
module.exports = { CreditPurchaseQuotes };
