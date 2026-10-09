"use strict";

// Dormant trusted-host adapter for ONE already-running, dedicated llama.cpp
// child. Never hand this object to plugins. No runtime provisioning, gateway,
// model switching, tools, scheduler, provider or network fallback is reachable.
const http = require("node:http");
const { ChildProcess } = require("node:child_process");
const { record, integer, name } = require("./validation");
const unavailable = () => new Error("Local inference unavailable");
const MAX_RESPONSE_BYTES = 1024 * 1024;

function createLocalInferenceAdapter(options) {
  const { resource, port, child, apiKey, timeoutMs } = record(options,
    ["resource", "port", "child", "apiKey", "timeoutMs"]);
  name(resource);
  if (!resource.startsWith("model:") || !(child instanceof ChildProcess) || !Number.isSafeInteger(child.pid)) throw unavailable();
  integer(port, 1, 65535);
  integer(timeoutMs, 1, 60000);
  if (typeof apiKey !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(apiKey)) throw unavailable();
  let busy = false, disabled = false, activeRequest = null, stopping = null;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  function shutdown() {
    disabled = true;
    activeRequest?.destroy(unavailable());
    if (stopping) return stopping;
    if (exited()) return Promise.resolve(true);
    // Retire the adapter permanently even if termination cannot be confirmed.
    // This child MUST be dedicated: killing the shared serving engine is unsafe.
    stopping = new Promise(resolve => {
      const done = result => {
        clearTimeout(timer); child.removeListener("exit", onExit); child.removeListener("error", onError); resolve(result);
      };
      const onExit = () => done(true), onError = () => done(false);
      const timer = setTimeout(() => done(false), 2000);
      child.once("exit", onExit);
      child.once("error", onError);
      try { child.kill("SIGKILL"); } catch { done(false); }
    });
    return stopping;
  }
  function post(body, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted || disabled || exited()) return reject(unavailable());
      const request = http.request({ hostname: "127.0.0.1", port, path: "/completion", method: "POST",
        agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body),
          authorization: `Bearer ${apiKey}` } });
      activeRequest = request;
      const abort = () => { request.destroy(unavailable()); void shutdown(); };
      signal.addEventListener("abort", abort, { once: true });
      let settled = false;
      function finish(error, value) {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        activeRequest = null;
        error ? reject(unavailable()) : resolve(value);
      }
      request.on("error", error => finish(error));
      request.on("response", response => {
        // Node http does not follow redirects. No DNS, proxy or remote URL input.
        if (response.statusCode !== 200 || response.headers["content-encoding"] ||
            !/^application\/json(?:\s*;|$)/i.test(response.headers["content-type"] || "")) {
          response.destroy(); request.destroy(); finish(unavailable()); return;
        }
        const chunks = []; let size = 0;
        response.on("data", chunk => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) { response.destroy(); request.destroy(); finish(unavailable()); }
          else chunks.push(chunk);
        });
        response.on("error", error => finish(error));
        response.on("aborted", () => finish(unavailable()));
        response.on("end", () => {
          try { finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { finish(unavailable()); }
        });
      });
      request.end(body);
    });
  }
  async function infer(input) {
    input = record(input, ["resource", "prompt", "maxOutputTokens", "signal"]);
    if (input.resource !== resource || typeof input.prompt !== "string" || input.prompt.length > 100000 ||
        !(input.signal instanceof AbortSignal) || input.signal.aborted || busy || disabled || exited() || child.killed) throw unavailable();
    integer(input.maxOutputTokens, 1, 32768);
    busy = true; // No queue or overlapping inference on this dedicated engine.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const signal = AbortSignal.any([input.signal, deadline.signal]);
    try {
      // Native llama.cpp raw completion; no chat tools or routing instructions.
      // The host owns the port/model binding. Plugins cannot select an endpoint.
      const result = await post(JSON.stringify({ prompt: input.prompt, n_predict: input.maxOutputTokens,
        stream: false, cache_prompt: false }), signal);
      if (signal.aborted || disabled || exited() || !result || result.stop !== true ||
          typeof result.content !== "string" || !Number.isSafeInteger(result.tokens_predicted) ||
          result.tokens_predicted < 0 || result.tokens_predicted > input.maxOutputTokens ||
          (result.content.length > 0 && result.tokens_predicted === 0)) throw unavailable();
      return result.content;
    } catch {
      await shutdown();
      throw unavailable(); // Never expose runtime bodies, paths or credentials.
    } finally { clearTimeout(timer); busy = false; }
  }
  return Object.freeze({ infer, close: shutdown });
}
module.exports = { createLocalInferenceAdapter };
