"use strict";

// Only the desktop main process imports this client. No configurable hosts,
// redirects, environment keys, Core routes, or network-worker integration.
const PROVIDERS = Object.freeze({
  openai: { label: "OpenAI", base: "https://api.openai.com/v1" },
  anthropic: { label: "Anthropic", base: "https://api.anthropic.com/v1" },
});
class ProviderError extends Error {}
const fail = message => { throw new ProviderError(message); };
function provider(id) {
  if (!Object.hasOwn(PROVIDERS, id)) fail("Choose OpenAI or Anthropic.");
  return PROVIDERS[id];
}
function modelId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,179}$/.test(id)) fail("Enter a valid provider model ID.");
  return id;
}
function parseModel(value) {
  const match = /^desktop:(openai|anthropic):(.+)$/.exec(value || "");
  if (!match) fail("Choose a connected desktop provider model.");
  return { provider: match[1], model: modelId(match[2]) };
}
function headers(id, key) {
  return { "content-type": "application/json", ...(id === "openai" ? { authorization: "Bearer " + key } :
    { "x-api-key": key, "anthropic-version": "2023-06-01" }) };
}
async function request(fetchImpl, id, key, route, options) {
  const response = await fetchImpl(provider(id).base + route, { ...options, headers: headers(id, key), redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const why = { 400: "The model rejected this request. Check the model ID and try a shorter conversation.",
      401: "The API key was rejected. Replace it in Settings.", 403: "This API key does not have access to that model or operation.",
      404: "That model is unavailable for this account. Refresh models in Settings.",
      429: "The account hit a rate or billing limit. Check your provider account and try again later.",
      529: "The provider is busy. Try again later." }[response.status] || "The provider is unavailable. Try again later.";
    fail(`${provider(id).label}: ${why} (HTTP ${response.status})`);
  }
  return response;
}
async function listModels(fetchImpl, id, key, signal) {
  const models = [], cursors = new Set();
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const route = "/models" + (id === "anthropic" ? "?limit=100" + (cursor ? "&after_id=" + encodeURIComponent(cursor) : "") : "");
    const r = await request(fetchImpl, id, key, route, { signal });
    const data = await r.json();
    if (!Array.isArray(data.data)) fail("The provider returned an invalid model list.");
    for (const m of data.data) {
      if (typeof m.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,179}$/.test(m.id)) continue;
      // The OpenAI list also contains embedding, audio and image-only models.
      if (id === "openai" && (!/^(gpt-|o\d|chatgpt-|ft:)/.test(m.id) || /audio|realtime|transcribe|tts|image|search|deep-research|instruct/.test(m.id))) continue;
      if (id === "openai" && /^(gpt-3|gpt-4(?:$|-|\.0))/.test(m.id)) continue; // legacy Chat Completions families
      models.push({ id: m.id, label: String(m.display_name || m.id).slice(0, 180) });
    }
    if (id !== "anthropic" || !data.has_more) break;
    if (!data.last_id || cursors.has(data.last_id)) fail("The provider returned an invalid model-list cursor.");
    cursor = data.last_id; cursors.add(cursor);
  }
  return [...new Map(models.map(m => [m.id, m])).values()].slice(0, 500);
}
function messagesFor(id, messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 200 || JSON.stringify(messages).length > 12_000_000) fail("This conversation is too large. Start a new chat or remove large attachments.");
  const system = [], turns = [];
  for (const m of messages) {
    if (!m || !["system", "user", "assistant"].includes(m.role)) fail("Unsupported chat message.");
    if (m.role === "system") {
      if (typeof m.content !== "string") fail("Unsupported system message.");
      system.push(m.content); continue;
    }
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    if (!Array.isArray(parts) || parts.length > 32) fail("Unsupported chat content.");
    const content = parts.map(p => {
      if (p?.type === "text" && typeof p.text === "string") return { type: id === "openai" ? (m.role === "assistant" ? "output_text" : "input_text") : "text", text: p.text };
      const image = p?.type === "image_url" && /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(p.image_url?.url || "");
      if (image && m.role === "user") return id === "openai" ? { type: "input_image", image_url: p.image_url.url } :
        { type: "image", source: { type: "base64", media_type: image[1], data: image[2] } };
      fail("This provider connection supports text and attached images only.");
    });
    turns.push({ role: m.role, content: id === "openai" && m.role === "assistant" ? parts.map(p => p.text).join("\n") : content });
  }
  if (!turns.length) fail("Enter a question first.");
  return { system: system.join("\n\n"), turns };
}
async function* events(body) {
  if (!body) fail("The provider returned no response stream.");
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "", data = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1_000_000) fail("The provider returned an oversized stream event.");
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, ""); buffer = buffer.slice(at + 1);
        if (!line) {
          if (data.length) { const raw = data.join("\n"); data = []; if (raw !== "[DONE]") yield JSON.parse(raw); }
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).trimStart());
          if (data.join("").length > 1_000_000) fail("The provider returned an oversized stream event.");
        }
      }
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function* complete(fetchImpl, id, key, body, signal) {
  const input = messagesFor(id, body.messages);
  const max = Math.max(id === "openai" ? 2048 : 256, Math.min(16384, Number(body.max_tokens) || (id === "openai" ? 8192 : 4096)));
  const wire = id === "openai" ? { model: modelId(body.providerModel), input: input.turns,
    ...(input.system ? { instructions: input.system } : {}), max_output_tokens: max, store: false, stream: true } :
    { model: modelId(body.providerModel), messages: input.turns, ...(input.system ? { system: input.system } : {}), max_tokens: max, stream: true };
  const r = await request(fetchImpl, id, key, id === "openai" ? "/responses" : "/messages", { method: "POST", signal, body: JSON.stringify(wire) });
  let terminal = false, text = false;
  for await (const e of events(r.body)) {
    signal.throwIfAborted();
    if (e.type === "error" || e.type === "response.failed") fail(provider(id).label + " could not finish the response. Check your account or try again.");
    if (e.type === "response.incomplete" || (e.type === "message_delta" && e.delta?.stop_reason === "max_tokens")) fail("The reply reached its output limit. Ask for a shorter response.");
    const delta = id === "openai" ? (["response.output_text.delta", "response.refusal.delta"].includes(e.type) ? e.delta : "") :
      e.type === "content_block_delta" && e.delta?.type === "text_delta" ? e.delta.text :
      e.type === "content_block_start" && e.content_block?.type === "text" ? e.content_block.text : "";
    if (typeof delta === "string" && delta) { text = true; yield delta; }
    if (e.type === "response.completed" || e.type === "message_stop") { terminal = true; break; }
  }
  if (!terminal) fail("The provider connection ended before the reply finished. Try again.");
  if (!text) fail("The provider returned no text. Try a different model or question.");
}
module.exports = { PROVIDERS, ProviderError, provider, modelId, parseModel, listModels, complete, messagesFor };
