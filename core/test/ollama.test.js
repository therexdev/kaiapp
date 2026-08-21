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

test("selfTest passes on a runnable binary and fails on a crashing one", async () => {
  // node itself answers --version: the cheapest healthy binary around.
  await selfTest(process.execPath);
  if (process.platform !== "win32") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-st-"));
    const bad = path.join(dir, "crasher");
    fs.writeFileSync(bad, "#!/bin/sh\nexit 5\n");
    fs.chmodSync(bad, 0o755);
    await assert.rejects(() => selfTest(bad), /Engine self-test failed.*exit code 5/);
  }
});

test("selfTest does not block the event loop while the binary is slow", { skip: process.platform === "win32" }, async () => {
  // The field failure mode: a slow probe used to be a BLOCKING spawn that
  // starved scheduler long-polls and heartbeats. A timer ticking while the
  // self-test runs is the whole guarantee.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-st-slow-"));
  const slow = path.join(dir, "slowpoke");
  fs.writeFileSync(slow, "#!/bin/sh\nsleep 1\necho v1.0.0\n");
  fs.chmodSync(slow, 0o755);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 50);
  try {
    await selfTest(slow);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks >= 5, `event loop starved during selfTest: only ${ticks} timer ticks in ~1s`);
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

test("ensureRunning returns the version when a daemon is up, null when absent", async () => {
  const { server, port } = await startFakeOllama();
  try {
    assert.equal(await OllamaRuntime.ensureRunning({ port }), "0.0.0-fake");
  } finally {
    server.close();
  }
  // Nothing listening and (in this container) no ollama binary to spawn.
  if (!OllamaRuntime.locate()) {
    assert.equal(await OllamaRuntime.ensureRunning({ port: 1 }), null);
  }
});

test("ensureCrtBeside copies runtime DLLs without overwriting existing ones", () => {
  const { ensureCrtBeside } = require("../lib/runtimes/llamacpp");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-crt-"));
  const src = path.join(dir, "electron");
  const dst = path.join(dir, "engine");
  fs.mkdirSync(src);
  fs.mkdirSync(dst);
  fs.writeFileSync(path.join(src, "msvcp140.dll"), "new-runtime");
  fs.writeFileSync(path.join(src, "vcruntime140.dll"), "new-runtime");
  fs.writeFileSync(path.join(dst, "vcruntime140.dll"), "upstream-shipped");
  const bin = path.join(dst, "llama-server.exe");
  fs.writeFileSync(bin, "exe");
  if (process.platform === "win32") {
    ensureCrtBeside(bin, src);
    assert.equal(fs.readFileSync(path.join(dst, "msvcp140.dll"), "utf8"), "new-runtime", "absent DLL copied");
    assert.equal(fs.readFileSync(path.join(dst, "vcruntime140.dll"), "utf8"), "upstream-shipped", "existing DLL untouched");
  } else {
    ensureCrtBeside(bin, src); // no-op off Windows
    assert.ok(!fs.existsSync(path.join(dst, "msvcp140.dll")));
  }
});

test("no system ollama + a provision hook: the fallback provisions itself and starts", async () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const net = require("net");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ollama-prov-"));
  const port = await new Promise((r) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); });
  });
  // The "portable ollama": a script that answers /api/version like the real
  // daemon, honoring OLLAMA_HOST — proving env plumbing end to end.
  const bin = path.join(dir, "ollama");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const http = require("http");
const [h, p] = process.env.OLLAMA_HOST.split(":");
if (process.argv[2] !== "serve") process.exit(1);
http.createServer((req, res) => { res.end(JSON.stringify({ version: "0.32.13-fake" })); }).listen(Number(p), h);
setInterval(() => {}, 1000);
`
  );
  fs.chmodSync(bin, 0o755);

  let provisioned = 0;
  const v = await OllamaRuntime.ensureRunning({
    host: "127.0.0.1",
    port,
    provision: async () => (provisioned++, bin),
    modelsDir: path.join(dir, "models"),
    onEvent: () => {},
  });
  assert.strictEqual(provisioned, 1, "with nothing installed, the app provisions its own engine");
  assert.ok(v && String(v).includes("0.32.13"), `daemon came up and answered: ${v}`);
});
