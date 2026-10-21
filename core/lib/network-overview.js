"use strict";

const MAX_BYTES = 2 * 1024 * 1024;
const count = value => Number.isSafeInteger(value) && value >= 0;
const label = value => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
const localOnly = () => Error("Network status is off in Local-Only. Choose Local-First or Network in Settings to view it.");

function publicSnapshot(value, observedAt) {
  if (value?.ok !== true || !count(value.workersOnline) || !count(value.queueDepth) || !count(value.pendingJobs) ||
      !Array.isArray(value.models) || value.models.length > 256 || value.models.some(m => !label(m?.model) || !count(m.providers)) ||
      new Set(value.models.map(m => m.model)).size !== value.models.length ||
      !Array.isArray(value.workers) || value.workers.length > 5000 || value.workers.some(w => !label(w?.address) || typeof w.busy !== "boolean" ||
        !count(w.lastSeenSecs) || !Array.isArray(w.models) || w.models.length > 256 || w.models.some(m => !label(m)))) {
    throw Error("Network status could not be verified. Try again shortly.");
  }
  // This existing public endpoint reports presence, not credit qualification,
  // sponsored eligibility or a UTC-day receipt total. Keep those facts unknown.
  return {
    source: "public-scheduler", observedAt, validUntil: observedAt + 15000, state: "available",
    providersOnline: value.workersOnline, readyProviders: null,
    waitingRequests: value.queueDepth, activeJobs: value.pendingJobs, completedToday: null,
    models: value.models.map(m => ({ id: m.model, providers: m.providers, available: m.providers > 0, freeEligible: null, selectable: false })),
    providers: value.workers.slice(0, 256).map(w => ({ id: w.address, model: w.models.length ? w.models.join(", ") : "No model advertised", state: w.busy ? "busy" : "online", lastSeenSecs: w.lastSeenSecs })),
    providersTruncated: value.workers.length > 256, activity: [], activityAvailable: false,
  };
}

async function readPublicNetworkOverview({ network, signal, fetchImpl = fetch, now = Date.now, timeoutMs = 5000 }) {
  const before = network?.status();
  if (!before || !["local-first", "network"].includes(before.privacyMode)) throw localOnly();
  let base;
  try {
    base = new URL(before.schedulerUrl);
    if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.href.length > 2048) throw Error();
  } catch { throw Error("No valid network service is configured. Check Network settings."); }
  // The destination comes only from the existing Core configuration, never
  // from renderer input or a payment/invitation manifest.
  const endpoint = base.href.replace(/\/$/, "") + "/network/status";
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const release = network.trackShadowRequest?.(controller) || (() => {});
  const unchanged = () => {
    const current = network.status();
    if (!["local-first", "network"].includes(current.privacyMode)) throw localOnly();
    if (current.schedulerUrl !== before.schedulerUrl) throw Error("Network settings changed. Refresh to check the selected network.");
    combined.throwIfAborted();
  };
  try {
    unchanged();
    const response = await fetchImpl(endpoint, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store", headers: { accept: "application/json" }, signal: combined });
    unchanged();
    if (!response.ok) throw Error("The network status service is unavailable. Try again shortly.");
    const length = Number(response.headers.get("content-length"));
    if (length > MAX_BYTES) throw Error("Network status could not be verified. Try again shortly.");
    let size = 0; const parts = [];
    for await (const part of response.body) {
      unchanged(); size += part.length;
      if (size > MAX_BYTES) throw Error("Network status could not be verified. Try again shortly.");
      parts.push(part);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(parts).toString("utf8")); }
    catch { throw Error("Network status could not be verified. Try again shortly."); }
    unchanged();
    return publicSnapshot(value, now());
  } catch (error) {
    if (!["local-first", "network"].includes(network.status().privacyMode)) throw localOnly();
    if (combined.aborted) throw Error("Network status check was interrupted. Refresh to try again.");
    if (/^(Network status could not|The network status service|Network settings changed)/.test(error.message)) throw error;
    throw Error("Cannot reach the network status service. It will retry automatically.");
  } finally { clearTimeout(timeout); release(); }
}

module.exports = { publicSnapshot, readPublicNetworkOverview };
