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
async function executeShadow({ job, catalog, runtime, signal, onChunk }) {
  const j = ["koin-funded-rehearsal-chat", "koin-mainnet-pilot-chat"].includes(job?.type) ? require("./funded-protocol").validateJob(job, catalog) : validateJob(job, catalog), q = j.quote;
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
    const response = await post("/completion", { prompt: j.prompt, n_predict: q.maxOutput,
      temperature: 0, stream: j.stream === true, cache_prompt: false });
    let result;
    if (j.stream) {
      if (!response.ok || !(response.headers.get("content-type") || "").includes("text/event-stream") || typeof onChunk !== "function") throw Error("Metered streaming is unavailable from this runtime");
      let buffer = "", output = "", last = 0, sent = "", stopped = false;
      const decoder = new TextDecoder();
      for await (const bytes of response.body) {
        abort.throwIfAborted(); buffer += decoder.decode(bytes, { stream: true });
        if (Buffer.byteLength(buffer) > 1500000) throw Error("Stream frame too large");
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim(); if (data === "[DONE]") { stopped = true; continue; }
          const part = JSON.parse(data);
          if (part.error || part.truncated || typeof part.content !== "string") throw Error("Invalid runtime stream");
          output += part.content;
          if (Buffer.byteLength(output) > 1048576) throw Error("Stream output too large");
          if (part.stop === true) stopped = true;
          if (output.trim() && output !== sent && (Date.now() - last >= 250 || stopped)) {
            await onChunk(output); sent = output; last = Date.now();
          }
        }
      }
      if (!stopped || buffer.trim()) throw Error("Runtime stream interrupted");
      if (output.trim() && output !== sent) await onChunk(output);
      result = { content: output };
    } else result = await readJson(response);
    if (result.truncated || typeof result.content !== "string" || !result.content.length || Buffer.byteLength(result.content) > 1048576) throw Error("Invalid or truncated shadow response");
    abort.throwIfAborted();
    return { output: result.content, usage: { prompt_tokens: q.inputTokens, completion_tokens: 0 } };
  } finally { hold.release(); }
}
module.exports = { executeShadow, readJson };
