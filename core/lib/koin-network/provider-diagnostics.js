"use strict";

// Local observations explain a failed check; they never establish network
// qualification. Raw runtime/RPC messages, prompts and credentials stay out.
const CODES = Object.freeze(["preparation_timeout", "model_load_failed", "runtime_unavailable", "tokenizer_mismatch",
  "tokenizer_unavailable", "inference_timeout", "inference_failed", "result_unconfirmed", "check_invalid"]);
function code(stage, error, deadline, now = Date.now()) {
  const timedOut = error?.name === "TimeoutError" || Number.isSafeInteger(deadline) && now >= deadline;
  if (error?.message === "Shadow metering currently requires llama.cpp" || error?.message === "Prepared model is not ready") return "runtime_unavailable";
  if (error?.message === "Local tokenizer differs from quoted tokenizer") return "tokenizer_mismatch";
  if (stage === "preparing") return timedOut ? "preparation_timeout" : "model_load_failed";
  if (stage === "loading") return timedOut ? "preparation_timeout" : "model_load_failed";
  if (stage === "tokenizing") return timedOut ? "inference_timeout" : "tokenizer_unavailable";
  if (stage === "answering") return timedOut ? "inference_timeout" : "inference_failed";
  if (stage === "reporting") return "result_unconfirmed";
  return "check_invalid";
}
function sanitize(value, models, now = Date.now()) {
  if (!Array.isArray(value) || value.length > 64 || !Array.isArray(models)) return [];
  const allowed = new Set(models), seen = new Set(), rows = [];
  for (const row of value) {
    if (!row || !allowed.has(row.model) || seen.has(row.model) || !CODES.includes(row.code) || !Number.isSafeInteger(row.at) ||
        row.at < 0 || row.at > now + 5000 || now - row.at > 86400000) continue;
    seen.add(row.model); rows.push({ model: row.model, code: row.code, at: row.at });
  }
  return rows;
}
module.exports = { CODES, code, sanitize };
