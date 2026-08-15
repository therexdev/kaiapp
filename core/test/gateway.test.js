"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { JsonStore } = require("../lib/store");
const { ApiKeys } = require("../lib/keys");
const { ModelManager } = require("../lib/model-manager");
const { RuntimeManager } = require("../lib/runtime-manager");
const { LlamaCppRuntime } = require("../lib/runtimes/llamacpp");
const { Gateway } = require("../lib/gateway");

/*
 * Integration test of the whole local chain with a FAKE llama-server binary:
 * gateway -> runtime manager -> llamacpp adapter (real child process) -> SSE
 * streamed back through the proxy. The "model file" is pre-placed so no
 * network is involved.
 */

const FAKE_BIN = path.join(__dirname, "fixtures", "fake-llama-server");

function freePort() {
  const net = require("net");
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function makeStack() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-gw-"));
  const catalogPath = path.join(dir, "catalog.json");
  fs.writeFileSync(
    catalogPath,
    JSON.stringify({
      aliases: { "dev-tiny": { label: "Dev", package: "tiny@1" } },
      packages: { "tiny@1": { filename: "tiny.gguf", url: "http://127.0.0.1:1/unused", sha256: "0".repeat(64), runtime: "llamacpp" } },
    })
  );
  // Pre-place the model so ensurePackage never downloads.
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "tiny.gguf"), "not a real model");

  const settings = new JsonStore(path.join(dir, "settings.json"), {});
  const keys = new ApiKeys(settings);
  const models = new ModelManager({
    catalogPath,
    modelsDir: path.join(dir, "models"),
    state: new JsonStore(path.join(dir, "state.json"), {}),
    onEvent: () => {},
  });
  const rtPort = await freePort();
  const runtime = new RuntimeManager({
    models,
    hardware: { capabilities: { cudaEligible: false } },
    onEvent: () => {},
    makeRuntime: () => new LlamaCppRuntime({ binPath: FAKE_BIN, port: rtPort, onEvent: () => {} }),
  });
  const gateway = new Gateway({ port: 0, runtime, models, keys, coreInfo: () => ({ version: "test" }) });
  const port = await gateway.listen();
  const base = `http://127.0.0.1:${port}`;
  return { gateway, runtime, keys, base };
}

test("health + models list, unauthenticated when no keys exist", async () => {
  const { gateway, runtime, base } = await makeStack();
  try {
    const health = await (await fetch(`${base}/core/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.modules.gateway.ok, true);

    const models = await (await fetch(`${base}/v1/models`)).json();
    assert.equal(models.object, "list");
    assert.equal(models.data[0].id, "dev-tiny");
  } finally {
    runtime.stop();
    await gateway.close();
  }
});

test("chat/completions streams SSE through the real child-process chain", async () => {
  const { gateway, runtime, base } = await makeStack();
  try {
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "dev-tiny", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type"), /text\/event-stream/);
    const text = await resp.text();
    assert.ok(text.includes("Hello"), "streamed content arrived");
    assert.ok(text.trimEnd().endsWith("data: [DONE]"), "SSE terminator passed through");

    // Non-streaming on the now-warm runtime.
    const j = await (
      await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "dev-tiny", messages: [{ role: "user", content: "hi" }] }),
      })
    ).json();
    assert.equal(j.choices[0].message.content, "Hello from fake llama");
  } finally {
    runtime.stop();
    await gateway.close();
  }
});

test("unknown model alias is a clean 400, not a crash", async () => {
  const { gateway, runtime, base } = await makeStack();
  try {
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    });
    assert.equal(resp.status, 400);
    const j = await resp.json();
    assert.match(j.error.message, /Unknown model alias/);
  } finally {
    runtime.stop();
    await gateway.close();
  }
});

test("creating a key locks /v1 down; bearer key opens it; control plane stays open", async () => {
  const { gateway, runtime, keys, base } = await makeStack();
  try {
    const created = await (
      await fetch(`${base}/core/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"t"}' })
    ).json();
    assert.ok(created.secret.startsWith("kai_sk_"));

    const denied = await fetch(`${base}/v1/models`);
    assert.equal(denied.status, 401);

    const ok = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${created.secret}` } });
    assert.equal(ok.status, 200);

    const health = await fetch(`${base}/core/health`);
    assert.equal(health.status, 200, "control plane never requires the API key");

    assert.equal(keys.required(), true);
  } finally {
    runtime.stop();
    await gateway.close();
  }
});

test("§8 developer platform: per-key usage metering, budgets, embeddings passthrough", async () => {
  const { gateway, runtime, keys, base } = await makeStack();
  try {
    const { id, secret } = keys.create({ name: "app key" });
    const H = { "content-type": "application/json", authorization: `Bearer ${secret}` };

    // Local chat (non-stream): tokens metered against the key, cost $0.
    const j = await (
      await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ model: "dev-tiny", messages: [{ role: "user", content: "hi" }] }),
      })
    ).json();
    assert.equal(j.choices[0].message.content, "Hello from fake llama");
    // The metering tee runs after the response ends — give it a beat.
    await new Promise((r) => setTimeout(r, 200));
    const k1 = keys.list().find((k) => k.id === id);
    assert.deepEqual(
      [k1.usage.requests, k1.usage.inTok, k1.usage.outTok, k1.usage.costUsd],
      [1, 1, 4, "0.000000"],
      "local usage recorded from the fixture's usage block, at zero cost"
    );

    // Budgets: set, read back, and the remaining-µ$ math.
    keys.setBudget(id, 0.5);
    assert.equal(keys.list().find((k) => k.id === id).budgetUsdMonthly, 0.5);
    assert.equal(keys.budgetRemainingMicro(id), 500000);
    keys.setBudget(id, null);
    assert.equal(keys.budgetRemainingMicro(id), Infinity);

    // Embeddings pass through to the engine.
    const e = await (
      await fetch(`${base}/v1/embeddings`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ model: "dev-tiny", input: "hello world" }),
      })
    ).json();
    assert.equal(e.object, "list");
    assert.equal(e.data[0].embedding.length, 3, "embedding vector relayed from the engine");
  } finally {
    runtime.stop();
    await gateway.close();
  }
});
