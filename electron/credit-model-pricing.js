"use strict";
const { isUsd } = require("../core/lib/koin-network/product");
const { credits, dollars } = require("../core/lib/koin-network/purchase-quote");
const { tariffs } = require("./credit-models");
const labels = require("../core/models/catalog.json").aliases;
const bundled = require("../core/lib/koin-network/credit-model-prices.json");

// Configured rates are public, immutable policy data. Verify the complete
// canonical set against the deployment's pinned policy before displaying it;
// no account, live provider catalog or connection proof is needed. This does
// not authorize spending or claim that any model currently has a provider.
function configuredModelPricing(config, value, now = Date.now()) {
  if (!isUsd(config?.deployment)) throw Error("Model credit prices require the USD credit service");
  if (value?.schema !== 1 || value.product !== "prepaid-usd-v1" || value.policyHash !== config.policyHash) throw Error("Configured model prices do not match the approved network policy");
  const approved = tariffs(value.tariffs, config.policyHash);
  if (!Number.isSafeInteger(now) || now < 0) throw Error("Model pricing verification time is invalid");
  return { schema: 1, product: "prepaid-usd-v1", policyHash: config.policyHash,
    observedAt: now, availabilityValidUntil: null,
    models: approved.map(t => ({ model: t.model, label: labels[t.model]?.label || t.model,
      inputCreditsPerMillion: credits(t.inputAtomsPerMillion), outputCreditsPerMillion: credits(t.outputAtomsPerMillion),
      inputUsdPerMillion: dollars(t.inputAtomsPerMillion), outputUsdPerMillion: dollars(t.outputAtomsPerMillion) })) };
}
async function modelPricing(service, signal) {
  signal?.throwIfAborted();
  if (service.service?.state !== "ready") throw Error(service.service?.reason || "Configured model prices are unavailable");
  const result = configuredModelPricing(service.service.config, bundled);
  signal?.throwIfAborted(); return result;
}
module.exports = { modelPricing, configuredModelPricing };
