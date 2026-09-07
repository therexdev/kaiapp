"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto"), { EventEmitter } = require("events");
const { DesktopProviders, registerProviderIPC } = require("../../electron/providers");
const protocol = require("../../electron/provider-http");
const { Gateway } = require("../lib/gateway");
const { ModelManager } = require("../lib/model-manager");
const { JsonStore } = require("../lib/store");
const { ApiKeys } = require("../lib/keys");
const key = "synthetic-provider-key-not-a-real-credential";
function encryptedStorage() {
  const secret = crypto.randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", secret, iv); const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
    decryptString(value) { const cipher = crypto.createDecipheriv("aes-256-gcm", secret, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8"); } };
}
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-providers-"));
  const params = { dataDir: dir, safeStorage: encryptedStorage(), privacyMode: () => "local-first", ...options };
  const service = new DesktopProviders(params);
  t.after(() => { service.cancel(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, params, service };
}
function sse(events, split = false) {
  const bytes = new TextEncoder().encode(events.map(e => "event: " + e.type + "\r\ndata: " + JSON.stringify(e) + "\r\n\r\n").join(""));
  return new Response(new ReadableStream({ start(c) { if (split) for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); else c.enqueue(bytes); c.close(); } }));
}
const turn = model => ({ model, stream: true, messages: [{ role: "system", content: "Be KAI." }, { role: "user", content: "Hello" }] });

test("desktop provider keys survive encrypted restart; status and backups never contain plaintext", t => {
  const { service, params, dir } = fixture(t);
  service.save("openai", { key, model: "gpt-fixture" });
  const contents = fs.readFileSync(service.file, "utf8");
  assert.equal(contents.includes(key), false); assert.equal(JSON.stringify(service.status()).includes(key), false);
  const restarted = new DesktopProviders(params); assert.equal(restarted.entries.openai.key, key);
  assert.equal(restarted.status().providers[0].models[0].id, "gpt-fixture");
  const { backupLiveProfile } = require("../lib/profile-backup");
  const backup = backupLiveProfile(dir, "1.0.0-test.1");
  assert.equal(fs.readFileSync(path.join(backup, "desktop-providers.json"), "utf8"), contents);
  restarted.remove("openai"); assert.equal(new DesktopProviders(params).status().providers[0].configured, false);
});
test("unavailable, plaintext-fallback and wrong OS keychain never save unencrypted credentials or overwrite a locked store", t => {
  const { service, params } = fixture(t); service.save("openai", { key, model: "gpt-fixture" });
  const before = fs.readFileSync(service.file, "utf8");
  const wrong = new DesktopProviders({ ...params, safeStorage: encryptedStorage() });
  assert.equal(wrong.status().locked, true); assert.throws(() => wrong.save("openai", { key }), /unlocked/);
  assert.equal(fs.readFileSync(service.file, "utf8"), before);
  params.safeStorage.getSelectedStorageBackend = () => "basic_text";
  assert.throws(() => service.save("anthropic", { key }), /Secure OS storage/);
});
for (const id of ["openai", "anthropic"]) test(`${id}: model discovery, fixed HTTPS host/auth and incremental Unicode replies`, async t => {
  const calls = [];
  const events = id === "openai" ? [{ type: "response.output_text.delta", delta: "Hi 🤖" }, { type: "response.completed" }] :
    [{ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "private reasoning" } }, { type: "content_block_delta", delta: { type: "text_delta", text: "Hi 🤖" } }, { type: "message_stop" }];
  const { service } = fixture(t, { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return url.includes("/models") ? Response.json({ data: [{ id: id === "openai" ? "gpt-fixture" : "claude-fixture" }, { id: "text-embedding-fixture" }] }) : sse(events, true);
  } });
  service.save(id, { key }); await service.refresh(id);
  const model = service.status().providers.find(p => p.id === id).models[0].id;
  let output = ""; await service.chat(turn(`desktop:${id}:${model}`), text => { output += text; });
  assert.equal(output, "Hi 🤖"); assert.equal(calls.length, 2);
  for (const c of calls) { assert.equal(new URL(c.url).origin, id === "openai" ? "https://api.openai.com" : "https://api.anthropic.com"); assert.equal(c.init.redirect, "error"); }
  const wire = JSON.parse(calls[1].init.body);
  assert.equal(wire.model, model); assert.equal(wire.stream, true); assert.equal(wire.temperature, undefined);
  if (id === "openai") { assert.equal(wire.store, false); assert.equal(wire.instructions, "Be KAI."); assert.equal(calls[1].init.headers.authorization, "Bearer " + key); }
  else { assert.equal(wire.system, "Be KAI."); assert.equal(wire.messages[0].role, "user"); assert.equal(calls[1].init.headers["anthropic-version"], "2023-06-01"); assert.equal(calls[1].init.headers["x-api-key"], key); }
});
test("provider errors, truncated streams and quota failures cannot retry, leak keys, or fall back to the network", async t => {
  let calls = 0, response;
  const { service } = fixture(t, { fetchImpl: async () => { calls++; return response; } });
  service.save("openai", { key, model: "gpt-fixture" });
  response = new Response(JSON.stringify({ error: { message: key } }), { status: 401 });
  await assert.rejects(service.chat(turn("desktop:openai:gpt-fixture"), () => {}), e => /API key was rejected/.test(e.message) && !e.message.includes(key));
  assert.equal(calls, 1);
  response = sse([{ type: "response.output_text.delta", delta: "partial" }]);
  await assert.rejects(service.chat(turn("desktop:openai:gpt-fixture"), () => {}), /ended before/); assert.equal(calls, 2);
  response = sse([{ type: "error", message: key }]);
  await assert.rejects(service.chat(turn("desktop:openai:gpt-fixture"), () => {}), e => /could not finish/.test(e.message) && !e.message.includes(key));
  await assert.rejects(service.chat(turn("desktop:openai:unknown"), () => {}), /no longer configured/); assert.equal(calls, 3);
});
test("Local-Only prevents egress; Stop, removing a connection and changing privacy abort in-flight requests", async t => {
  // A real pending HTTPS request keeps Node alive. This synthetic fetch has
  // no socket; keep the fixture alive while the unref'd privacy guard fires.
  const pendingSocket = setInterval(() => {}, 1000);
  t.after(() => clearInterval(pendingSocket));
  let mode = "local-only", calls = 0, started;
  const { service } = fixture(t, { privacyMode: () => mode, fetchImpl: (_url, { signal }) => {
    calls++; started?.(); return new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
  } });
  service.save("openai", { key, model: "gpt-fixture" });
  await assert.rejects(service.refresh("openai"), /Local-Only/);
  await assert.rejects(service.chat(turn("desktop:openai:gpt-fixture"), () => {}), /Local-Only/); assert.equal(calls, 0);
  for (const why of ["stop", "remove", "privacy"]) {
    mode = "local-first"; service.save("openai", { key, model: "gpt-fixture" });
    const ready = new Promise(resolve => { started = resolve; }), abort = new AbortController();
    const job = service.chat(turn("desktop:openai:gpt-fixture"), () => {}, abort.signal);
    const rejected = assert.rejects(job, why === "privacy" ? /Local-Only/ : { name: "AbortError" });
    await ready;
    if (why === "stop") abort.abort(); else if (why === "remove") service.remove("openai"); else mode = "local-only";
    await rejected;
  }
});
test("provider message conversion preserves history and images; rejects arbitrary content and hosts", () => {
  const image = "data:image/png;base64,aGVsbG8=";
  const messages = [{ role: "system", content: "one" }, { role: "user", content: [{ type: "text", text: "See this" }, { type: "image_url", image_url: { url: image } }] }, { role: "assistant", content: "I see." }, { role: "user", content: "Now?" }];
  assert.equal(protocol.messagesFor("anthropic", messages).turns[0].content[1].source.data, "aGVsbG8=");
  assert.equal(protocol.messagesFor("openai", messages).turns[0].content[1].image_url, image);
  assert.throws(() => protocol.messagesFor("openai", [{ role: "tool", content: "unsafe" }]), /Unsupported/);
  assert.throws(() => protocol.parseModel("https://elsewhere.example/v1"), /Choose/);
  assert.throws(() => protocol.provider("__proto__"), /Choose/);
});
test("IPC requires the actual desktop main frame; settings are not accessible to KAI, embedded frames or browser callers", async t => {
  const { service } = fixture(t), handlers = new Map(), origin = "http://127.0.0.1:41100";
  function window(id, route) {
    const webContents = Object.assign(new EventEmitter(), { id, send() {}, isDestroyed: () => false, mainFrame: { url: origin + route, send() {} } });
    return { isDestroyed: () => false, webContents };
  }
  const main = window(1, "/"), mascot = window(2, "/mascot.html"), foreign = window(3, "/");
  const bridge = registerProviderIPC({ ipcMain: { handle: (k, v) => handlers.set(k, v), removeHandler: k => handlers.delete(k) }, service, origin,
    getMainWindow: () => main, getMascotWindow: () => mascot }); t.after(() => bridge.dispose());
  const event = w => ({ sender: w.webContents, senderFrame: w.webContents.mainFrame });
  assert.equal((await handlers.get("providers:save")(event(main), "openai", { key, model: "gpt-fixture" })).ok, true);
  assert.equal((await handlers.get("providers:status")(event(mascot))).providers[0].configured, true);
  await assert.rejects(handlers.get("providers:save")(event(mascot), "openai", { key }), /denied/);
  await assert.rejects(handlers.get("providers:status")(event(foreign)), /denied/);
  await assert.rejects(handlers.get("providers:chat")({ sender: main.webContents, senderFrame: { url: origin + "/" } }, "x", turn("desktop:openai:gpt-fixture")), /denied/);
  main.webContents.mainFrame.url = origin + "/koinos-node/index.html";
  await assert.rejects(handlers.get("providers:status")(event(main)), /denied/);
});
test("Core and public API refuse desktop models before tools, runtime or network; model advertisements contain no providers", async t => {
  const { dir } = fixture(t), state = new JsonStore(path.join(dir, "state.json"), {});
  const gw = new Gateway({ host: "127.0.0.1", port: 0, models: new ModelManager({ catalogPath: path.join(__dirname, "../models/catalog.json"), modelsDir: path.join(dir, "models"), state }),
    keys: new ApiKeys(state), runtime: { status: () => ({ running: false }), ensure() { throw new Error("Runtime must not run"); } },
    coreInfo: () => ({}), onEvent: () => {}, network: { status: () => ({ privacyMode: "local-first" }), chat() { throw new Error("Network must not run"); } } });
  await gw.listen(); t.after(() => gw.close()); const base = `http://127.0.0.1:${gw.port}`;
  for (const route of ["/core/chat/completions", "/v1/chat/completions"]) {
    const r = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(turn("desktop:openai:gpt-fixture")) });
    assert.equal(r.status, 403); assert.equal((await r.json()).error.type, "desktop_only");
  }
  for (const route of ["/core/models", "/v1/models"]) {
    const r = await fetch(base + route); assert.equal(r.status, 200); assert.equal((await r.text()).includes("desktop:"), false);
  }
  assert.equal((await fetch(base + "/core/providers")).status, 404);
});
