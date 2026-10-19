"use strict";
const { ChildProcess } = require("node:child_process");
const { createLocalInferenceAdapter } = require("./local-inference");
const { createEnginePlatform } = require("./engine-platform");
const { record, name, integer } = require("./validation");
// Process-wide reservations survive individual supervisor disposal. Unconfirmed
// shutdown keeps its reservation; never silently reuse that resource or port.
const reservations = new Map();
const fail = () => { throw Error("Dedicated engine unavailable"); };
function createEngineSupervisor({ platform = createEnginePlatform() } = {}) {
  return Object.freeze({
    async supervise(input) {
      const spec = record(input, ["resource", "child", "port", "apiKey", "timeoutMs", "executablePath", "executableSha256",
        "modelPath", "modelSha256", "entrypointPath", "entrypointSha256"]);
      name(spec.resource); integer(spec.port, 1, 65535);
      if (!platform.supported || !(spec.child instanceof ChildProcess)) fail();
      const keys = [`resource:${spec.resource}`, `port:${spec.port}`, `pid:${spec.child.pid}`];
      if (keys.some(key => reservations.has(key))) fail();
      const reservation = {};
      keys.forEach(key => reservations.set(key, reservation)); // Before first asynchronous check.
      let adapter, retired = false, busy = false;
      async function verify(signal) {
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), spec.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
        let abort;
        const cancelled = new Promise((_, reject) => {
          abort = () => reject(Error("Engine verification cancelled"));
          combined.addEventListener("abort", abort, { once: true });
          if (combined.aborted) abort();
        });
        try {
          const check = Promise.resolve().then(() => {
            if (combined.aborted) fail();
            return platform.verify(spec, combined);
          });
          if (await Promise.race([cancelled, check]) !== true || combined.aborted) fail();
        } finally { clearTimeout(timer); combined.removeEventListener("abort", abort); }
      }
      const release = () => keys.forEach(key => { if (reservations.get(key) === reservation) reservations.delete(key); });
      async function close() {
        retired = true;
        if (!adapter) return false;
        const confirmed = await adapter.close();
        if (confirmed) release();
        return confirmed;
      }
      try {
        // Takes ownership of this dedicated child after the reservation succeeds.
        adapter = createLocalInferenceAdapter(specForAdapter(spec));
        await verify();
        return Object.freeze({
          async infer(input) {
            input = record(input, ["resource", "prompt", "maxOutputTokens", "signal"]);
            if (retired || busy || !(input.signal instanceof AbortSignal) || input.signal.aborted) fail();
            busy = true;
            const abort = () => { void close(); };
            input.signal.addEventListener("abort", abort, { once: true });
            try {
              // Revalidate immediately before each dispatch, not just admission.
              await verify(input.signal);
              if (retired || input.signal.aborted) fail();
              return await adapter.infer(input);
            } catch { await close(); fail(); }
            finally { input.signal.removeEventListener("abort", abort); busy = false; }
          },
          close,
        });
      } catch {
        if (adapter) await close();
        // Invalid constructor input has not dispatched; caller still owns child.
        else release();
        fail();
      }
    },
  });
}
function specForAdapter(s) { return { resource: s.resource, child: s.child, port: s.port, apiKey: s.apiKey, timeoutMs: s.timeoutMs }; }
module.exports = { createEngineSupervisor };
