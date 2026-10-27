"use strict";

// Progress contains only named phases and public confirmation metadata. Never
// forward raw RPC errors, account credentials or transaction envelopes.
const STAGES = new Set(["checking-payment", "checking-network", "getting-price", "preparing-payment", "wallet-approval",
  "rechecking-payment", "signing", "checking-mana", "submitting", "awaiting-confirmation", "updating-credits",
  "cancellation-approval", "cancellation-signing", "cancellation-submitting", "cancellation-confirmation", "complete", "stopped", "failed"]);
function purchaseProgress(value) {
  if (!value || typeof value !== "object" || !STAGES.has(value.stage) ||
      typeof value.operationId !== "string" || !/^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(value.operationId) ||
      !Number.isSafeInteger(value.startedAt) || value.startedAt <= 0 ||
      !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.startedAt) return null;
  const result = { operationId: value.operationId, stage: value.stage, startedAt: value.startedAt, updatedAt: value.updatedAt };
  if (typeof value.txId === "string" && /^0x1220[a-f0-9]{64}$/.test(value.txId)) result.txId = value.txId;
  for (const key of ["blockHeight", "irreversibleHeight"]) {
    const height = value[key];
    if (typeof height === "string" && /^(0|[1-9]\d{0,19})$/.test(height)) result[key] = height;
    else if (Number.isSafeInteger(height) && height >= 0) result[key] = String(height);
  }
  if (["credited", "cancelled", "checked"].includes(value.outcome)) result.outcome = value.outcome;
  return result;
}
module.exports = { purchaseProgress };
