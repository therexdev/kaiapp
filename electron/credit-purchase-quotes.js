"use strict";
const { utils } = require("koilib"), P = require("../core/lib/koin-network/job-protocol");
const USD = require("../core/lib/koin-network/purchase-quote");
const Provenance = require("../core/lib/koin-network/purchase-provenance");
const crypto = require("node:crypto");
const MarketEstimate = require("../core/lib/koin-network/purchase-market-estimate");
// Private main-process cache. Renderer approval supplies only the opaque ID,
// never a replacement price, wallet, transaction or scheduler endpoint.
class CreditPurchaseQuotes {
  constructor({ clock = Date.now, fetchImpl = fetch, marketReader } = {}) { this.clock = clock; this.quotes = new Map(); this.market = marketReader || new MarketEstimate.PurchaseMarketEstimate({ clock, fetchImpl }); this.previewCapability = null; }
  scope(c) { return P.hash(JSON.stringify([c.auth.accountId, P.hash(c.auth.sessionToken || ""), c.config])); }
  clear() { this.quotes.clear(); this.intent = null; }
  async capabilities(c, signal) {
    const scope = this.scope(c), now = this.clock();
    if (this.previewCapability?.scope === scope && now < this.previewCapability.expiresAt) return { ...this.previewCapability.value };
    let servicePreview = false;
    try {
      const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(2500)]);
      const response = await c.flow.call("capabilities", {}, deadline);
      servicePreview = response?.capabilities?.purchasePricePreview === true;
    } catch { signal?.throwIfAborted(); /* Display-only market reads also work with the older service. */ }
    signal?.throwIfAborted();
    const fallback = MarketEstimate.supports(c.config), value = { purchasePricePreview: servicePreview || fallback,
      purchasePriceSource: servicePreview ? "service" : fallback ? "market-estimate" : "unavailable" };
    this.previewCapability = { scope, value, expiresAt: this.clock() + 30000 }; return { ...value };
  }
  // Read-only display estimate. It never issues a signed purchase quote,
  // consumes a quote authorization budget, or changes the approval cache.
  async estimate(c, input, signal) {
    if (!input || Object.keys(input).join() !== "usd") throw Error("Select a USD credit amount");
    USD.nativeForDollars(input.usd, "100000000");
    if (typeof c.config.pricingPolicyHash !== "string" || !/^[0-9a-f]{64}$/.test(c.config.pricingPolicyHash)) throw Error("Purchasing needs the approved pricing configuration");
    const capability = await this.capabilities(c, signal);
    let price, independent = false;
    if (capability.purchasePriceSource === "service") {
      const response = await c.flow.call("purchase-price", {}, signal);
      signal?.throwIfAborted(); price = Provenance.summary(response?.price);
      if (price.pricingPolicyHash !== c.config.pricingPolicyHash || price.expiresAt <= this.clock() || price.marketObservedAt > this.clock() + 5000) throw Error("The current purchase price could not be verified");
    } else {
      if (!MarketEstimate.supports(c.config)) throw Error("Automatic price preview is unavailable for this pricing policy");
      price = await this.market.read(signal); independent = true; signal?.throwIfAborted();
      if (!price || price.referenceKind !== "market-estimate" || price.windowSeconds !== 0 || price.source !== "uniswap-v4:vKOIN/USDT" ||
          typeof price.usdPerKoinAtoms !== "string" || !/^[1-9]\d{0,19}$/.test(price.usdPerKoinAtoms) || BigInt(price.usdPerKoinAtoms) >= 1n << 64n ||
          !Number.isSafeInteger(price.observedAt) || price.observedAt > this.clock() || this.clock() - price.observedAt >= MarketEstimate.MAX_PRICE_AGE_MS ||
          !Number.isSafeInteger(price.expiresAt) || price.expiresAt <= this.clock() || price.expiresAt > this.clock() + 60000 || !/^0x[0-9a-f]{64}$/.test(price.anchorHash)) throw Error("The market estimate could not be verified");
    }
    const amount = USD.nativeForDollars(input.usd, price.usdPerKoinAtoms), credited = String(BigInt(amount) * BigInt(price.usdPerKoinAtoms) / USD.USD_ATOMS);
    const withinPaymentLimit = BigInt(amount) <= BigInt(c.config.limits.amount);
    if (!independent && (BigInt(amount) > BigInt(price.maxPurchaseKoinAtoms) || BigInt(credited) > BigInt(price.maxPurchaseUsdAtoms))) throw Error("Choose a smaller amount for the currently available purchase liquidity");
    return { estimate: { koin: USD.dollars(amount), credits: USD.credits(credited), usd: USD.dollars(credited), withinPaymentLimit, paymentLimitKoin: USD.dollars(c.config.limits.amount), observedAt: independent ? price.observedAt : price.marketObservedAt, expiresAt: price.expiresAt,
      priceDetails: { usdPerKoin: USD.dollars(price.usdPerKoinAtoms), windowSeconds: price.windowSeconds, referenceKind: price.referenceKind,
        ...(independent ? { source: price.source, anchorHash: price.anchorHash } : {}) } } };
  }
  async preview(c, input, signal) {
    if (!input || Object.keys(input).join() !== "usd") throw Error("Select a USD credit amount");
    // Validate decimal syntax before making a network request.
    USD.nativeForDollars(input.usd, "100000000");
    let wallet = false; try { wallet = utils.isChecksumAddress(c.config.owner); } catch {}
    if (!wallet) throw Error("Connect a payment wallet to buy credits. Free credits do not require a wallet.");
    if (typeof c.config.pricingPolicyHash !== "string" || !/^[0-9a-f]{64}$/.test(c.config.pricingPolicyHash)) throw Error("Purchasing needs the approved pricing configuration. Existing credits remain usable.");
    const scope = this.scope(c);
    if (!this.intent || this.intent.scope !== scope || this.intent.usd !== input.usd) this.intent = { scope, usd: input.usd, id: crypto.randomBytes(32).toString("hex") };
    const intent = this.intent, response = await c.flow.call("quote-usd", { dollars: input.usd, intentId: intent.id }, signal);
    signal?.throwIfAborted();
    if (this.intent !== intent) throw Error("Purchase selection changed. Get a fresh quote.");
    const args = response.args, q = await USD.verify(c.config.deployment, args, { now: this.clock(), version: c.config.version });
    const provenance = Provenance.verify(q, response.priceDetails, { expectedPricingPolicyHash: c.config.pricingPolicyHash }), price = provenance.summary;
    if (q.account !== utils.encodeBase64url(utils.decodeBase58(c.config.owner)) || q.amount !== USD.nativeForDollars(input.usd, q.usd_per_koin)) throw Error("The quote does not match the selected account and USD amount");
    if (BigInt(q.amount) > BigInt(c.config.limits.amount)) throw Error("This purchase exceeds the configured payment limit");
    signal?.throwIfAborted();
    const id = Buffer.from(q.id, "base64url").toString("hex");
    for (const [key, saved] of this.quotes) if (saved.scope !== scope || Number(saved.args.purchase_quote.expires_at) <= this.clock()) this.quotes.delete(key);
    // One current quote per account scope, with no durable authorization.
    this.quotes.clear(); this.quotes.set(id, { scope, args: structuredClone(args), provenance, intentId: intent.id });
    return { quote: { id, koin: USD.dollars(q.amount), credits: USD.credits(q.credits), usd: USD.dollars(q.credits), observedAt: price.marketObservedAt, expiresAt: Number(q.expires_at),
      priceDetails: { usdPerKoin: USD.dollars(price.usdPerKoinAtoms), windowSeconds: price.windowSeconds, referenceKind: price.referenceKind } } };
  }
  async consume(c, id, signal) {
    P.digest(id); const saved = this.quotes.get(id); this.quotes.delete(id);
    if (saved && this.intent?.id === saved.intentId) this.intent = null;
    if (!saved || saved.scope !== this.scope(c)) throw Error("Refresh the exchange quote before reviewing payment");
    signal?.throwIfAborted();
    const q = await USD.verify(c.config.deployment, saved.args, { now: this.clock(), version: c.config.version });
    Provenance.verify(q, saved.provenance, { expectedPricingPolicyHash: c.config.pricingPolicyHash });
    return structuredClone(saved.args);
  }
}
module.exports = { CreditPurchaseQuotes };
