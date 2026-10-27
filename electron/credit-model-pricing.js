"use strict";
const { isUsd } = require("../core/lib/koin-network/product");
const { credits, dollars } = require("../core/lib/koin-network/purchase-quote");

// This is a price display, not a quote or a spending action. PrepaidChat.models
// checks the full canonical tariff set against the packaged policy before it
// returns. The catalog's short availability lifetime does not expire those
// immutable policy rates; this response makes no provider availability claim.
async function modelPricing(service, signal) {
  signal?.throwIfAborted();
  const c = await service.context(signal);
  if (!isUsd(c.config.deployment)) throw Error("Model credit prices require the USD credit service");
  signal?.throwIfAborted();
  const catalog = await c.flow.models(signal);
  signal?.throwIfAborted();
  const labels = new Map(catalog.models.map(row => [row.model, row.label]));
  return { schema: 1, product: "prepaid-usd-v1", policyHash: catalog.policyHash,
    observedAt: catalog.asOf, availabilityValidUntil: catalog.validUntil,
    models: catalog.tariffs.map(t => ({ model: t.model, label: labels.get(t.model),
      inputCreditsPerMillion: credits(t.inputAtomsPerMillion), outputCreditsPerMillion: credits(t.outputAtomsPerMillion),
      inputUsdPerMillion: dollars(t.inputAtomsPerMillion), outputUsdPerMillion: dollars(t.outputAtomsPerMillion) })) };
}
module.exports = { modelPricing };
