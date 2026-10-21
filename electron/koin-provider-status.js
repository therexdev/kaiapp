"use strict";
const labels = { online: "ONLINE", offline: "OFFLINE", connecting: "CONNECTING", preparing: "PREPARING MODEL",
  qualifying: "CHECKING MODEL", "qualification-failed": "MODEL CHECK REQUIRED",
  "qualification-expired": "RENEWAL REQUIRED", "review-required": "REVIEW REQUIRED", "update-required": "UPDATE REQUIRED",
  "model-required": "MODEL REQUIRED", "network-paused": "NETWORK RECONNECTING" };
async function readProviderAccount({ config, access, signal, fetchImpl = fetch }) {
  const auth = access.authorize(config.schedulerUrl);
  const response = await fetchImpl(config.schedulerUrl + "/koin/test/status", { redirect: "error", signal,
    headers: { authorization: "Bearer " + auth.sessionToken } });
  const chunks = []; let size = 0;
  for await (const part of response.body) { size += part.length; if (size > 65536) throw Error("Provider status response too large"); chunks.push(part); }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!response.ok || value.mode !== config.mode || value.mainnetPaymentsEnabled !== (config.mode === "mainnet-pilot")) throw Error("Provider status could not be verified");
  access.authorize(config.schedulerUrl); signal.throwIfAborted(); return value;
}
async function readProviderStatus(options) {
  const { config, access, signal, clock = Date.now } = options, value = await readProviderAccount(options), now = clock();
  const approved = options.approvedModels === undefined ? [config.model] : options.approvedModels;
  if (!Array.isArray(approved) || !approved.length || approved.length > 64 || new Set(approved).size !== approved.length || approved.some(m => typeof m !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(m))) throw Error("Approved provider model identities required");
  if (value.providers !== undefined && (!Array.isArray(value.providers) || value.providers.length > 4096)) throw Error("Invalid provider observations");
  const matches = (value.providers || []).filter(p => p?.address === config.owner && (approved.includes(p.model) || Array.isArray(p.models)));
  if (matches.length > 1) throw Error("Ambiguous provider observation");
  const p = matches[0];
  // An older backend has no readiness contract. Never paint it green.
  if (!p) return { state: "checking", label: "CHECKING CONNECTION", detail: "Waiting for the network's provider status update. Online eligibility is not yet confirmed." };
  const check = row => {
    if (row?.address !== config.owner || !approved.includes(row.model) || !labels[row.state] || !Number.isSafeInteger(row.asOf) || !Number.isSafeInteger(row.validUntil) ||
        row.asOf > now + 5000 || now - row.asOf > 30000 || row.validUntil <= now || row.validUntil <= row.asOf || row.validUntil > row.asOf + 15000) throw Error("Provider status is stale or its model identity changed");
    return { model: row.model, state: row.state, label: labels[row.state], detail: String(row.detail || "").slice(0, 400), validUntil: row.validUntil };
  };
  const result = check(p);
  if (p.models !== undefined) {
    if (!Array.isArray(p.models) || !p.models.length || p.models.length > 64 || new Set(p.models.map(m => m?.model)).size !== p.models.length) throw Error("Invalid per-model provider status");
    const models = p.models.map(check), readyModels = models.filter(m => m.state === "online").map(m => m.model);
    if (!Array.isArray(p.readyModels) || JSON.stringify([...p.readyModels].sort()) !== JSON.stringify([...readyModels].sort()) ||
        (p.state === "online") !== (readyModels.length > 0) || !models.some(m => m.model === p.model && m.state === p.state) ||
        (readyModels.length && p.validUntil > Math.min(...models.filter(m => m.state === "online").map(m => m.validUntil)))) throw Error("Provider model readiness is inconsistent");
    result.models = models; result.readyModels = readyModels;
  }
  access.authorize(config.schedulerUrl); signal.throwIfAborted();
  return result;
}
module.exports = { readProviderStatus, readProviderAccount };
