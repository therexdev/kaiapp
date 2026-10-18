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
  const { config, access, signal, clock = Date.now } = options, value = await readProviderAccount(options);
  // An older backend has no readiness contract. Never paint it green.
  const p = value.providers?.find(p => p.address === config.owner && p.model === config.model);
  if (!p) return { state: "checking", label: "CHECKING CONNECTION", detail: "Waiting for the network's provider status update. Online eligibility is not yet confirmed." };
  if (!labels[p.state] || !Number.isSafeInteger(p.asOf) || !Number.isSafeInteger(p.validUntil) ||
      Math.abs(clock() - p.asOf) > 30000 || p.validUntil <= clock() || p.validUntil > p.asOf + 15000) throw Error("Provider status is stale");
  access.authorize(config.schedulerUrl); signal.throwIfAborted();
  return { state: p.state, label: labels[p.state], detail: String(p.detail || "").slice(0, 400), validUntil: p.validUntil };
}
module.exports = { readProviderStatus, readProviderAccount };
