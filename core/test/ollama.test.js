"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { startFakeOllama } = require("./fixtures/fake-ollama");
const { OllamaRuntime } = require("../lib/runtimes/ollama");
const { selfTest } = require("../lib/runtimes/llamacpp");
const { RuntimeManager } = require("../lib/runtime-manager");
const { ModelManager } = require("../lib/model-manager");
const { JsonStore } = require("../lib/store");
const { ApiKeys } = require("../lib/keys");
const { Gateway } = require("../lib/gateway");
const { makeZip } = require("./fixtures/make-zip");
const { RuntimeProvisioner } = require("../lib/runtime-provisioner");

test("selfTest passes on a runnable binary and fails on a crashing one", () => {
  // node itself answers --version: the cheapest healthy binary around.
  selfTest(process.execPath);
  if (process.platform !== "win32") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-st-"));
    const bad = path.join(dir, "crasher");
    fs.writeFileSync(bad, "#!/bin/sh\nexit 5\n");
    fs.chmodSync(bad, 0o755);
    assert.throws(() => selfTest(bad), /Engine self-test failed.*exit code 5/);
  }
});

test("ollama detect returns null when nothing listens", async () => {
  assert.equal(await OllamaRuntime.detect({ port: 1 }), null);
});

test("llama.cpp self-test failure falls through to Ollama; gateway rewrites the alias", async () => {
  const { server: ollama, port: ollamaPort, state } = await startFakeOllama();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ol-"));

  // Runtime catalog whose CPU build extracts a crashing binary.
  const badZip = makeZip([{ name: "llama-server", data: "#!/bin/sh\nexit 5\n", mode: 0o755, deflate: true }]);
  const badSha = crypto.createHash("sha256").update(badZip).digest("hex");
  const { server: cdn, port: cdnPort } = await new Promise((resolve) => {
    const http = require("http");
    const s = http.createServer((req, res) => {
      res.writeHead(200, { "content-length": badZip.length });
      res.end(badZip);
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
  });
  const rtCatalog = path.join(dir, "rt.json");
  fs.writeFileSync(
    rtCatalog,
    JSON.stringify({
      llamacpp: {
        version: "t1",
        builds: {
          [`${process.platform}-${process.arch}-cpu`]: {
            url: `http://127.0.0.1:${cdnPort}/bad.zip`,
            sha256: badSha,
            binPath: "llama-server",
          },
        },
      },
    })
  );

  // Model catalog with a pre-placed verified file.
  const MODEL = Buffer.from("verified fake weights");
  const modelSha = crypto.createHash("sha256").update(MODEL).digest("hex");
  const mcat = path.join(dir, "models.json");
  fs.writeFileSync(
    mcat,
    JSON.stringify({
      aliases: { "dev-tiny": { label: "Dev", package: "tiny@1" } },
      packages: { "tiny@1": { filename: "tiny.gguf", url: "http://127.0.0.1:1/x", sha256: modelSha } },
    })
  );
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "tiny.gguf"), MODEL);

  const events = [];
  const runtime = new RuntimeManager({
    models: new ModelManager({
      catalogPath: mcat,
      modelsDir: path.join(dir, "models"),
      state: new JsonStore(path.join(dir, "s.json"), {}),
      onEvent: () => {},
    }),
    hardware: { capabilities: { cudaEligible: false } },
    provisioner: new RuntimeProvisioner({
      catalogPath: rtCatalog,
      runtimesDir: path.join(dir, "runtimes"),
      hardware: {},
      onEvent: () => {},
    }),
    makeFallback: async () =>
      (await OllamaRuntime.detect({ port: ollamaPort })) ? new OllamaRuntime({ port: ollamaPort, onEvent: () => {} }) : null,
    onEvent: (e) => events.push(e),
    makeRuntime: () => {
      throw new Error("llama runtime must not boot — self-test should fail first");
    },
  });
  const keys = new ApiKeys(new JsonStore(path.join(dir, "k.json"), {}));
  const gateway = new Gateway({ port: 0, runtime, models: runtime.models, keys, coreInfo: () => ({}) });
  const base = `http://127.0.0.1:${await gateway.listen()}`;

  try {
    const j = await (
      await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "dev-tiny", messages: [{ role: "user", content: "hi" }] }),
      })
    ).json();

    assert.ok(j.choices, `gateway answered: ${JSON.stringify(j)}`);
    assert.equal(j.choices[0].message.content, "ollama served koinos-dev-tiny", "alias rewritten to registered name");
    assert.ok(state.models.has("koinos-dev-tiny"), "model registered in Ollama");
    assert.ok(state.blobs.has(`sha256:${modelSha}`), "verified blob uploaded by digest");
    const fb = events.find((e) => e.type === "runtime:fallback" && e.to === "ollama");
    assert.ok(fb, "fallback event emitted");
    assert.match(fb.reason, /self-test failed/i);
    assert.equal(runtime.status().runtime.kind, "ollama");
  } finally {
    runtime.stop();
    await gateway.close();
    ollama.close();
    cdn.close();
  }
});
