"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const path = require("node:path");
const { createLocalInferenceAdapter } = require("../lib/plugins/local-inference");
const { createPermissionHost } = require("../lib/plugins/permissions");
const resource = "model:fixture";
async function engine(t, timeoutMs = 1000) {
  const child = fork(path.join(__dirname, "fixtures/plugin-local-engine.cjs"), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: {} });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const [ready] = await once(child, "message");
  const config = { resource, port: ready.port, apiKey: ready.apiKey, child, timeoutMs };
  const adapter = createLocalInferenceAdapter(config);
  t.after(() => adapter.close());
  const requests = []; child.on("message", message => { if (message.type === "request") requests.push(message); });
  const manifest = { schemaVersion: 1, id: "compare", version: "1.0.0", permissions: [{ kind: "local-inference", action: "infer", resource }] };
  const host = createPermissionHost({ localInference: adapter.infer });
  const manifestDigest = host.install(manifest);
  const approval = { caller: manifest.id, manifestDigest, scope: manifest.permissions[0], expiresAt: Date.now() + 30000,
    limits: { calls: 3, inputChars: 20, outputTokens: 10 } };
  const grantId = host.approve(approval), client = host.connect(manifest.id);
  const request = prompt => ({ grantId, resource, prompt, maxOutputTokens: 10 });
  return { child, config, adapter, requests, host, approval, grantId, client, request };
}
test("dedicated local completion receives only literal prompt and bounded tokens; no fetch/gateway fallback", async t => {
  const f = await engine(t);
  const original = global.fetch;
  global.fetch = () => { throw Error("paid/network inference forbidden"); };
  try { assert.equal(await f.client.infer(f.request("hello")), "local answer"); }
  finally { global.fetch = original; }
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, "/completion"); assert(f.requests[0].authorized);
  assert.deepEqual(f.requests[0].body, { prompt: "hello", n_predict: 10, stream: false, cache_prompt: false });
});
test("invalid scope, paths, route/provider injection and limits never dispatch", async t => {
  const f = await engine(t);
  for (const patch of [{ resource: "https://paid.invalid" }, { resource: "../wallet" }, { resource: "model:other" },
    { maxOutputTokens: 11 }, { maxOutputTokens: -1 }, { prompt: "x".repeat(21) }, { provider: "paid" }, { endpoint: "http://other" }]) {
    await assert.rejects(f.client.infer({ ...f.request("hello"), ...patch }));
  }
  assert.equal(f.requests.length, 0);
  for (const patch of [{ port: "80" }, { port: 0 }, { apiKey: "bad" }, { endpoint: "https://paid.invalid" }, { resource: "wallet:core" }]) {
    assert.throws(() => createLocalInferenceAdapter({ ...f.config, ...patch }));
  }
});
test("concurrent calls cannot bypass grant budget or engine exclusivity", async t => {
  const f = await engine(t);
  const grantId = f.host.approve({ ...f.approval, limits: { ...f.approval.limits, calls: 1 } });
  const pending = f.client.infer({ ...f.request("hang"), grantId });
  const rejected = f.client.infer({ ...f.request("hello"), grantId });
  await assert.rejects(rejected);
  await assert.rejects(f.client.infer(f.request("hello"))); // Separate grant, same busy engine.
  f.host.revoke(grantId); await assert.rejects(pending);
  assert(await f.adapter.close());
  assert(f.requests.length <= 1);
});
test("revocation closes transport and confirms dedicated process exit; adapter cannot restart", async t => {
  const f = await engine(t);
  const received = once(f.child, "message");
  const pending = f.client.infer(f.request("hang"));
  await received;
  const exit = once(f.child, "exit");
  f.host.revoke(f.grantId);
  await assert.rejects(pending, { message: "Plugin permission denied" });
  await exit; assert(await f.adapter.close());
  const fresh = f.host.approve(f.approval);
  await assert.rejects(f.client.infer({ ...f.request("hello"), grantId: fresh }));
  assert.equal(f.requests.length, 1);
});
test("expiry and independent deadline terminate hung engines", async t => {
  for (const mode of ["expiry", "deadline"]) {
    const f = await engine(t, mode === "deadline" ? 50 : 1000);
    const grantId = mode === "expiry" ? f.host.approve({ ...f.approval, expiresAt: Date.now() + 50 }) : f.grantId;
    const exit = once(f.child, "exit");
    await assert.rejects(f.client.infer({ ...f.request("hang"), grantId }));
    await exit; assert(await f.adapter.close());
  }
});
test("redirects, model errors, oversized/malformed replies and excess tokens fail closed without retry", async t => {
  for (const prompt of ["redirect", "error", "huge", "invalid", "partial", "over-limit"]) {
    const f = await engine(t);
    const exit = once(f.child, "exit");
    await assert.rejects(f.client.infer(f.request(prompt)), { message: "Plugin permission denied" });
    await exit;
    await assert.rejects(f.client.infer(f.request("hello")));
    assert.equal(f.requests.length, 1);
  }
});
test("unavailable local engine fails without provisioning or network calls", async t => {
  const f = await engine(t);
  assert(await f.adapter.close());
  await assert.rejects(f.client.infer(f.request("hello")));
  assert.equal(f.requests.length, 0);
});
test("all failure paths stay on the pinned loopback endpoint even with network hooks present", async t => {
  const http = require("node:http"), https = require("node:https");
  const originals = { request: http.request, secure: https.request, fetch: global.fetch };
  let external = 0, local = 0;
  const forbidden = () => { external++; throw Error("network fallback attempted"); };
  https.request = forbidden; global.fetch = forbidden;
  http.request = function(options, ...args) {
    if (options.hostname !== "127.0.0.1" || options.path !== "/completion" || options.agent !== false) return forbidden();
    local++; return originals.request.call(this, options, ...args);
  };
  try {
    for (const prompt of ["hello", "redirect", "error", "over-limit"]) {
      const f = await engine(t);
      if (prompt === "hello") await f.client.infer(f.request(prompt));
      else await assert.rejects(f.client.infer(f.request(prompt)));
    }
    assert.equal(local, 4); assert.equal(external, 0);
  } finally { http.request = originals.request; https.request = originals.secure; global.fetch = originals.fetch; }
});
test("unconfirmed engine termination permanently disables further dispatch", async t => {
  const f = await engine(t);
  const kill = f.child.kill;
  f.child.kill = () => { throw Error("termination failed"); };
  try {
    assert.equal(await f.adapter.close(), false);
    await assert.rejects(f.client.infer(f.request("hello")));
    assert.equal(f.requests.length, 0);
  } finally { f.child.kill = kill; f.child.kill("SIGKILL"); }
});
test("asynchronous kill failure returns unconfirmed and removes shutdown listeners", async t => {
  const f = await engine(t), kill = f.child.kill;
  const before = { exit: f.child.listenerCount("exit"), error: f.child.listenerCount("error") };
  f.child.kill = () => { queueMicrotask(() => f.child.emit("error", Error("kill failed"))); return false; };
  try {
    assert.equal(await f.adapter.close(), false);
    assert.equal(f.child.listenerCount("exit"), before.exit);
    assert.equal(f.child.listenerCount("error"), before.error);
    await assert.rejects(f.client.infer(f.request("hello")));
  } finally { f.child.kill = kill; f.child.kill("SIGKILL"); }
});
