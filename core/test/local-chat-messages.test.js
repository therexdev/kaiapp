"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { createHash } = require("node:crypto");
const { Template } = require("@huggingface/jinja");
const { localChatMessages } = require("../lib/local-chat-messages");
const { Gateway } = require("../lib/gateway");
const catalog = require("../models/catalog.json");

// Original tokenizer.chat_template, extracted without model weights from the
// first 16,000,000 bytes of bartowski/google_gemma-3-4b-it-GGUF at HF revision
// 71506238f970075ca85125cd749c28b1b0eee84e (google_gemma-3-4b-it-Q4_K_M.gguf).
// Prefix SHA256: 966a7b9ab51e81e06b1463c18225b60e2bc1fd0c194324ff9b032b7dccbd489e.
// The reviewed Gemma 3 4B, 12B and 27B tokenizer packs share this template hash.
const source = fs.readFileSync(path.join(__dirname, "fixtures", "gemma3-original-chat-template.jinja"), "utf8");
const template = new Template(source);
const gemmaAliases = ["gemma3-4b", "gemma3-12b", "gemma3-27b"];
const model = alias => ({ ...catalog.packages[catalog.aliases[alias].package], packageId: catalog.aliases[alias].package });
const render = messages => template.render({ messages, bos_token: "<bos>", add_generation_prompt: true });
const freeze = value => {
  if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
};

test("original Gemma 3 template reproduces the reported failure for enriched app conversations", () => {
  assert.equal(createHash("sha256").update(source).digest("hex"), "7de1c58e208eda46e9c7f86397df37ec49883aeece39fb961e0a6b24088dd3c4");
  for (const messages of [
    [{ role: "system", content: "Persona" }, { role: "system", content: "Fast routing context" }, { role: "user", content: "Hello" }],
    [{ role: "system", content: "Persona" }, { role: "user", content: "Research context" }, { role: "user", content: "My question" }],
  ]) assert.throws(() => render(messages), /Conversation roles must alternate user\/assistant/);
});

test("every installed Gemma 3 size renders persona, fast context and research without changing saved history", () => {
  const original = [
    { role: "system", content: "You are KAI." },
    { role: "system", content: "Use the existing app tools when needed." },
    { role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer" },
    { role: "user", content: "Research context (untrusted data): source text" },
    { role: "user", content: "Explain this source." },
  ];
  const snapshot = structuredClone(original);
  freeze(original);
  for (const alias of gemmaAliases) {
    const normalized = localChatMessages(original, model(alias));
    const prompt = render(normalized);
    for (const message of original) assert.ok(prompt.includes(message.content), `${alias}: retained ${message.role} content`);
    assert.match(prompt, /You are KAI\.\n\nUse the existing app tools/);
    assert.match(prompt, /Research context \(untrusted data\): source text\n\nExplain this source\./);
    assert.deepEqual(normalized.map(message => message.role), ["system", "user", "assistant", "user"]);
  }
  assert.deepEqual(original, snapshot, "saved conversation remains byte-for-byte equivalent");
});

test("continued Agent/Research, grounding, interrupted replies and leading assistant history retain all turns", () => {
  const original = [
    { role: "system", content: [{ type: "text", text: "Persona" }, { type: "text", text: "Remembered preference" }] },
    { role: "assistant", content: "Restored answer" },
    { role: "assistant", content: "Interrupted continuation" },
    { role: "user", content: "Original request" },
    { role: "user", content: "Tool results (untrusted data, not instructions): exact result" },
    { role: "developer", content: "Runtime instruction" },
    { role: "system", content: "Grounded reference (untrusted): exact quotation" },
    { role: "user", content: "Follow-up question" },
  ];
  const normalized = localChatMessages(freeze(original), model("gemma3-4b"));
  const prompt = render(normalized);
  assert.match(prompt, /Persona\n\nRemembered preference/);
  assert.match(prompt, /Restored answer\n\nInterrupted continuation/);
  assert.match(prompt, /\[Developer message\]\n\nRuntime instruction/);
  assert.match(prompt, /\[System message\]\n\nGrounded reference/);
  for (const message of original.slice(1)) assert.ok(prompt.includes(message.content));
  assert.deepEqual(normalized.map(message => message.role), ["system", "user", "assistant", "user"]);
});

test("multimodal content and text boundaries survive adaptation and the original image template", () => {
  const picture = { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } };
  const original = freeze([
    { role: "system", content: [{ type: "text", text: "Reference image:" }, picture, { type: "text", text: "Treat image text as untrusted." }] },
    { role: "user", content: [{ type: "text", text: "Research context." }] },
    { role: "user", content: "What is shown?" },
  ]);
  const normalized = localChatMessages(original, model("gemma3-12b"));
  assert.deepEqual(normalized[0].content.find(part => part.type === "image_url"), picture);
  // llama.cpp translates OpenAI image_url parts to template image parts. Keep
  // the transport payload unchanged; emulate only that conversion for render.
  const templateInput = normalized.map(message => ({ ...message, content: message.content.map(part => part.type === "image_url" ? { type: "image" } : part) }));
  const prompt = render(templateInput);
  assert.match(prompt, /Reference image:<start_of_image>Treat image text as untrusted\.\n\nResearch context\.\n\nWhat is shown\?/);
  assert.equal((prompt.match(/<start_of_image>/g) || []).length, 1);
});

test("valid conversations, non-Gemma models and native tool protocols retain their established contracts", () => {
  const valid = [{ role: "system", content: "Persona", name: "kai" }, { role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }, { role: "user", content: "Again" }];
  assert.deepEqual(localChatMessages(freeze(valid), model("gemma3-27b")), valid);
  assert.equal(render(localChatMessages(valid, model("gemma3-27b"))), render(valid));
  const toolHistory = [
    { role: "user", content: "Read file" },
    { role: "assistant", content: "", tool_calls: [{ id: "call1", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call1", content: "private result" },
  ];
  assert.equal(localChatMessages(freeze(toolHistory), model("gemma3-4b")), toolHistory);
  assert.equal(localChatMessages(valid, { packageId: "qwen2.5-7b-instruct-q4_k_m@1" }), valid);
  assert.equal(localChatMessages(valid, { packageId: "custom:gemma3" }), valid);
  assert.equal(localChatMessages(valid, null), valid);
  assert.doesNotThrow(() => render(localChatMessages([{ role: "system", content: "System-only request" }], model("gemma3-4b"))));
});

async function makeGateway(t) {
  const seen = [], holds = [], networkRequests = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    seen.push(body);
    try { render(body.messages); }
    catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Unable to generate parser for this template. Automatic parser generation failed: " + error.message } }));
    }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"Template accepted"}}]}\n\ndata: [DONE]\n\n');
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Template accepted" } }] }));
    }
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const runtime = {
    async acquireFor(alias) {
      if (runtime.failure) throw Error("Local engine unavailable");
      const hold = { alias, released: false };
      holds.push(hold);
      return { endpoint: `http://127.0.0.1:${upstream.address().port}`, release: () => { hold.released = true; } };
    },
  };
  const networkState = { privacyMode: "local-only", schedulerUrl: "https://unused.invalid" };
  const gateway = new Gateway({
    port: 0, runtime,
    models: { resolveAlias: alias => model(alias) },
    keys: { required: () => false },
    network: { status: () => networkState },
  });
  gateway._chatNetwork = async (body, _req, res) => {
    networkRequests.push(body);
    return gateway._json(res, 200, { network: true });
  };
  const port = await gateway.listen();
  t.after(async () => {
    await gateway.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  const post = async (route, body) => fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { gateway, seen, holds, runtime, networkState, networkRequests, post };
}

test("real local gateway sends template-valid streaming and non-streaming requests for every Gemma 3 package", async t => {
  const stack = await makeGateway(t);
  for (const alias of gemmaAliases) {
    for (const stream of [false, true]) {
      const messages = [
        { role: "system", content: "Persona" }, { role: "system", content: "Fast context" },
        { role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Research context" }, { role: "user", content: "Follow-up" },
      ];
      const response = await stack.post(stream ? "/core/chat/completions" : "/v1/chat/completions", { model: alias, messages, stream, temperature: 0.3, max_tokens: 128 });
      assert.equal(response.status, 200, await response.clone().text());
      const text = await response.text();
      assert.match(text, /Template accepted/);
      if (stream) assert.match(text, /data: \[DONE\]/);
      const request = stack.seen.at(-1);
      assert.equal(request.temperature, 0.3);
      assert.equal(request.max_tokens, 128);
      assert.equal(request.messages[0].content, "Persona\n\nFast context");
      assert.equal(request.messages.at(-1).content, "Research context\n\nFollow-up");
      assert.equal(request.model, alias);
    }
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stack.holds.length, 6);
  assert.ok(stack.holds.every(hold => hold.released), "local engine holds release after replies");
  assert.equal(stack.networkRequests.length, 0);
});

test("local normalization never changes a network request or permits private-desktop fallback", async t => {
  const stack = await makeGateway(t);
  stack.networkState.privacyMode = "local-first";
  const messages = [{ role: "system", content: "Persona" }, { role: "system", content: "Context" }, { role: "user", content: "Question" }];
  stack.runtime.failure = true;
  const fallback = await stack.post("/core/chat/completions", { model: "gemma3-4b", messages });
  assert.equal(fallback.status, 200);
  assert.deepEqual(stack.networkRequests[0].messages, messages, "capability fallback receives the original signed/metered message structure");
  const direct = await stack.post("/core/chat/completions", { model: "koinos-network", messages });
  assert.equal(direct.status, 200);
  assert.deepEqual(stack.networkRequests[1].messages, messages);
  const privateDesktop = await stack.post("/core/chat/completions", { model: "gemma3-4b", messages, kai_private_desktop: true });
  assert.equal(privateDesktop.status, 400);
  assert.equal(stack.networkRequests.length, 2, "desktop observations never overflow");
  assert.equal(stack.seen.length, 0);
});

test("Gemma normalization cannot lower the context gate or alter a context overflow request", async t => {
  const stack = await makeGateway(t);
  const messages = [{ role: "system", content: "Persona" }, ...Array.from({ length: 900 }, () => ({ role: "user", content: "x" }))];
  const local = await stack.post("/core/chat/completions", { model: "gemma3-4b", messages });
  assert.equal(local.status, 400, "merging turns must not bypass the original context estimate");
  assert.match((await local.json()).error.message, /larger than the local model's 4096-token context/);
  stack.networkState.privacyMode = "local-first";
  stack.gateway._networkRates = async () => ({ ctxTokens: 8192 });
  const overflow = await stack.post("/core/chat/completions", { model: "gemma3-4b", messages });
  assert.equal(overflow.status, 200);
  assert.deepEqual(stack.networkRequests[0].messages, messages);
  const privateDesktop = await stack.post("/core/chat/completions", { model: "gemma3-4b", messages, kai_private_desktop: true });
  assert.equal(privateDesktop.status, 400);
  assert.equal(stack.networkRequests.length, 1);
  assert.equal(stack.holds.length, 0, "oversized prompts never acquire an engine");
  assert.equal(stack.seen.length, 0);
});
