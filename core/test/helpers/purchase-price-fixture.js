"use strict";
const crypto = require("node:crypto"), P = require("../../lib/koin-network/job-protocol");
const USD = require("../../lib/koin-network/purchase-quote"), Provenance = require("../../lib/koin-network/purchase-provenance");
const { MARKET } = require("../../lib/koin-network/purchase-market");
const pricingPolicyHash = P.hash("fixture-pricing-policy");
async function issue(options) {
  const priceDetails = { schema: 1, kind: Provenance.KIND, nonce: crypto.randomBytes(32).toString("hex"), evidenceHash: P.hash("fixture-price-evidence"), summary: {
    schema: 1, market: { chainId: MARKET.chainId, protocol: MARKET.protocol, poolId: MARKET.poolId }, referenceKind: "merchant-exchange-reference",
    usdPerKoinAtoms: options.usdPerKoin, marketObservedAt: Math.max(1, options.now - 17 * 60000), expiresAt: options.now + USD.MAX_QUOTE_MS,
    windowSeconds: 1800, anchorHash: "0x" + P.hash("fixture-anchor"), pricingPolicyHash: options.pricingPolicyHash || pricingPolicyHash, referenceHash: P.hash("fixture-reference"),
    maxPurchaseUsdAtoms: "10000000000", maxPurchaseKoinAtoms: "100000000000" } };
  const args = await USD.issue({ ...options, id: Provenance.quoteId(priceDetails) });
  return { args, priceDetails };
}
module.exports = { pricingPolicyHash, issue };
