"use strict";

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const ACK_STATES = new Set(["testing", "qualified", "failed"]);

function delay(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); resolve(); };
    const aborted = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); reject(signal.reason); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function retryAfter(response) {
  const value = response.headers.get("retry-after");
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

// The verifier already makes an exact saved result idempotent. Keep the same
// body and signature through a short delivery/acknowledgment retry; never
// generate another answer or reinterpret a rejected/expired challenge.
async function submitQualificationResult({ url, body, signal, fetchImpl = fetch }) {
  const encoded = JSON.stringify(body), stop = new AbortController();
  const timeout = setTimeout(() => stop.abort(new DOMException("Qualification acknowledgment timed out", "TimeoutError")), 10000);
  const active = AbortSignal.any([signal || new AbortController().signal, stop.signal]);
  let last;
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      active.throwIfAborted();
      const request = new AbortController();
      const requestTimeout = setTimeout(() => request.abort(new DOMException("Qualification delivery timed out", "TimeoutError")), 3000);
      let wait = 200 * attempt;
      try {
        let response;
        try {
          response = await fetchImpl(url, { method: "POST", redirect: "error",
            headers: { "content-type": "application/json", connection: "close" }, body: encoded,
            signal: AbortSignal.any([active, request.signal]) });
        } catch (error) {
          active.throwIfAborted();
          last = error;
        }
        if (response) {
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            const error = Error(`Qualification result HTTP ${response.status}`);
            if (!RETRYABLE_STATUS.has(response.status)) throw error;
            last = error; wait = Math.max(wait, retryAfter(response));
          } else {
            if (response.status !== 200 || !response.body) throw Error("Qualification result was not acknowledged");
            let value;
            try { value = await require("./shadow-worker").readJson(response, 4096); }
            catch (error) {
              active.throwIfAborted();
              // A broken response stream may follow a successfully saved
              // result. Invalid JSON or an oversized answer is not an ack.
              if (error instanceof SyntaxError || error.message === "Shadow inference response too large") throw error;
              last = error;
            }
            if (value !== undefined) {
              if (value?.accepted !== true || !ACK_STATES.has(value.qualification?.state)) throw Error("Qualification result was not acknowledged");
              active.throwIfAborted();
              return value;
            }
          }
        }
      } finally { clearTimeout(requestTimeout); }
      if (attempt < 3) {
        if (!Number.isFinite(wait) || wait >= 10000) throw last;
        await delay(wait, active);
      }
    }
    throw last || Error("Qualification result was not acknowledged");
  } finally { clearTimeout(timeout); }
}

module.exports = { submitQualificationResult };
