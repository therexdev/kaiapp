"use strict";
const { validateJob, hash } = require("./job-protocol");

async function readJson(response, max = 1500000) {
  if (!response.ok) throw Error(`Shadow inference HTTP ${response.status}`);
  let size = 0; const chunks = [];
  for await (const part of response.body) {
    size += part.length;
    if (size > max) throw Error("Shadow inference response too large");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function executeShadow({ job, catalog, runtime, signal }) {
  const j = validateJob(job, catalog), q = j.quote;
  const abort = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(Math.max(1, j.deadline - Date.now()))]);
  abort.throwIfAborted();
  if (typeof runtime.acquireFor !== "function") throw Error("Shadow work requires a managed runtime lease");
  const hold = await runtime.acquireFor(j.model);
  try {
    abort.throwIfAborted();
    if (runtime.status()?.runtime?.kind !== "llamacpp") throw Error("Shadow metering currently requires llama.cpp");
    const endpoint = new URL(hold.endpoint);
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") throw Error("Local runtime endpoint required");
    const post = (route, body) => fetch(endpoint.origin + route, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: abort });
    const tokenized = await readJson(await post("/tokenize", { content: j.prompt, add_special: false, parse_special: true }));
    if (!Array.isArray(tokenized.tokens) || tokenized.tokens.length !== q.inputTokens ||
        tokenized.tokens.some((v) => !Number.isSafeInteger(v) || v < 0) ||
        hash(JSON.stringify(tokenized.tokens)) !== q.inputIdsHash) throw Error("Local tokenizer differs from quoted tokenizer");
    // Raw, committed prompt prevents the local server from applying a second
    // chat template. Only text inference parameters cross this boundary.
    const result = await readJson(await post("/completion", { prompt: j.prompt, n_predict: q.maxOutput,
      temperature: 0, stream: false, cache_prompt: false }));
    if (result.truncated || typeof result.content !== "string" || !result.content.length || Buffer.byteLength(result.content) > 1048576) throw Error("Invalid or truncated shadow response");
    abort.throwIfAborted();
    return { output: result.content, usage: { prompt_tokens: q.inputTokens, completion_tokens: 0 } };
  } finally { hold.release(); }
}
module.exports = { executeShadow, readJson };
