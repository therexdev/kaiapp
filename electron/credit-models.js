"use strict";
// Model rates are usable only when the complete canonical tariff set matches
// the policy pinned in the packaged credit-service configuration.
const P = require("../core/lib/koin-network/job-protocol");
const labels = require("../core/models/catalog.json").aliases;
function tariffs(value, expected) {
  P.digest(expected);
  if (!Array.isArray(value) || !value.length || value.length > 64) throw Error("Bounded approved model catalog required");
  const seen = new Set();
  const entries = value.map(value => {
    const t = Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
    if (!t || seen.has(t.model) || t.model === "dev-tiny" || /^desktop[.:]/.test(t.model || "")) throw Error("Unique approved network models required");
    if (Object.keys(t).sort().join() !== "contextTokens,inputAtomsPerMillion,maxLatencyMs,maxOutputTokens,model,modelHash,outputAtomsPerMillion,templateHash,tokenizerHash,version" || typeof t.model !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(t.model)) throw Error("Invalid approved model tariff");
    P.integer(t.version, 1); P.integer(t.contextTokens, 1, 2000000); P.integer(t.maxOutputTokens, 1, t.contextTokens); P.integer(t.maxLatencyMs, 1, 300000);
    for (const key of ["modelHash", "tokenizerHash", "templateHash"]) P.digest(t[key]);
    for (const key of ["inputAtomsPerMillion", "outputAtomsPerMillion"]) {
      const n = t[key]; if (typeof n !== "string" || !/^[1-9]\d{0,19}$/.test(n) || BigInt(n) > (1n << 64n) - 1n) throw Error("Invalid approved model rate");
    }
    seen.add(t.model); return t;
  });
  entries.sort((a, b) => { const x = `${a.model}:${a.version}`, y = `${b.model}:${b.version}`; return x < y ? -1 : x > y ? 1 : 0; });
  if (P.hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", ...entries])) !== expected) throw Error("Network model prices differ from the approved policy");
  return entries;
}
function catalog(value, config, now = Date.now()) {
  if (!value || value.schema !== 1 || value.policyHash !== config.policyHash) throw Error("Approved network model catalog unavailable");
  const approved = tariffs(value.tariffs, config.policyHash);
  P.integer(value.asOf); P.integer(value.validUntil);
  if (value.asOf > now + 5000 || value.validUntil <= now || value.validUntil <= value.asOf || value.validUntil > value.asOf + 15000) throw Error("Network model availability is out of date. Refresh and try again");
  if (!Array.isArray(value.models) || value.models.length !== approved.length) throw Error("Incomplete network model availability");
  const rows = new Map();
  for (const row of value.models) {
    if (!row || rows.has(row.model) || !approved.some(t => t.model === row.model) || typeof row.available !== "boolean") throw Error("Invalid network model availability");
    P.integer(row.providers, 0, 1000000);
    if (row.available && row.providers === 0) throw Error("Available model has no qualified provider");
    rows.set(row.model, row);
  }
  const credits = require("../core/lib/koin-network/purchase-quote").credits;
  return { schema: 1, policyHash: config.policyHash, asOf: value.asOf, validUntil: value.validUntil, tariffs: approved,
    models: approved.map(t => ({ model: t.model, label: labels[t.model]?.label || t.model, available: rows.get(t.model).available,
      providers: rows.get(t.model).providers, inputCreditsPerMillion: credits(t.inputAtomsPerMillion), outputCreditsPerMillion: credits(t.outputAtomsPerMillion),
      maxOutput: Math.min(config.maxOutput, t.maxOutputTokens), version: t.version })) };
}
module.exports = { tariffs, catalog };
