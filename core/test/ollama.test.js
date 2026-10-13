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

/*
 * Network context opt-in on Ollama (docs/NETWORK_CONTEXT_PROTOCOL.md §5).
 * /api/show's num_ctx is the model's CONFIGURATION; only the loaded runner
 * (/api/ps context_length after a bounded warm-up) says what one request
 * actually gets. Every test talks to its own fake daemon on port 0.
 */

const { parseNumCtx, psContextLength } = require("../lib/runtimes/ollama");

function fakeOllamaCtx(opts = {}) {
  const reqs = [];
  const models = new Map(); // name -> configured num_ctx (null = default)
  const loaded = new Set();
  const server = require("http").createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const blob = req.url.startsWith("/api/blobs/");
      const raw = blob ? null : Buffer.concat(chunks).toString();
      reqs.push({ method: req.method, url: req.url, raw });
      const body = raw ? JSON.parse(raw) : {};
      const json = (status, v) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(v));
      };
      if (req.url === "/api/version") return json(200, { version: "0.0.0-fake" });
      if (req.url === "/api/show") {
        if (!models.has(body.model)) return json(404, { error: "not found" });
        const n = opts.showNumCtx ?? models.get(body.model);
        return json(200, { parameters: n ? `stop                           "<|im_end|>"\nnum_ctx                        ${n}` : "" });
      }
      if (blob) return json(201, {});
      if (req.url === "/api/create") {
        if (opts.createFails?.(body)) return json(400, { error: "unsupported" });
        const fromFile = /PARAMETER num_ctx (\d+)/.exec(body.modelfile || "");
        models.set(body.model || body.name, body.parameters?.num_ctx ?? (fromFile ? Number(fromFile[1]) : null));
        return json(200, { status: "success" });
      }
      if (req.url === "/api/generate") {
        return setTimeout(() => {
          loaded.add(body.model);
          json(200, { model: body.model, done: true, done_reason: "load" });
        }, opts.warmDelayMs || 0);
      }
      if (req.url === "/api/ps") {
        return json(200, {
          models: [...loaded].map((name) => ({
            name: `${name}:latest`,
            model: `${name}:latest`,
            ...(opts.psOmitContext ? {} : { context_length: opts.psContext ?? models.get(name) ?? 4096 }),
          })),
        });
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, reqs, models, loaded })));
}

function modelFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-olctx-"));
  const file = path.join(dir, "a.gguf");
  fs.writeFileSync(file, "verified fake weights");
  return { dir, file, sha: crypto.createHash("sha256").update("verified fake weights").digest("hex") };
}

test("ollama context: parseNumCtx and psContextLength read only well-formed numbers", () => {
  assert.strictEqual(parseNumCtx({ parameters: 'stop "x"\nnum_ctx                        16384' }), 16384);
  assert.strictEqual(parseNumCtx({ parameters: "num_ctx 32768\nstop x" }), 32768);
  assert.strictEqual(parseNumCtx({ parameters: "num_ctx_extra 9" }), null);
  assert.strictEqual(parseNumCtx({}), null);
  assert.strictEqual(parseNumCtx(null), null);
  const ps = { models: [{ name: "koinos-a-ctx16384:latest", model: "koinos-a-ctx16384:latest", context_length: 16384 }, { name: "x", context_length: "99999" }] };
  assert.strictEqual(psContextLength(ps, "koinos-a-ctx16384"), 16384);
  assert.strictEqual(psContextLength(ps, "koinos-a-ctx16384:latest"), 16384);
  assert.strictEqual(psContextLength(ps, "x"), null, "a non-number context_length is not a window");
  assert.strictEqual(psContextLength(ps, "koinos-b"), null);
  assert.strictEqual(psContextLength({ models: [{ model: "koinos-a:latest", context_length: 8192 }] }, "koinos-a"), 8192, "matched on model too");
  assert.strictEqual(psContextLength(null, "koinos-a"), null);
});

test("ollama context: the legacy registration is byte-identical and never probes", async () => {
  const fake = await fakeOllamaCtx();
  const { file, sha } = modelFile();
  try {
    const rt = new OllamaRuntime({ host: "127.0.0.1", port: fake.port, onEvent: () => {} });
    await rt.start({ modelPath: file, sha256: sha, modelName: "koinos-a" });
    const posts = fake.reqs.filter((r) => r.url !== `/api/blobs/sha256:${sha}`);
    assert.deepStrictEqual(posts.map((r) => [r.url, r.raw]), [
      ["/api/show", '{"model":"koinos-a"}'],
      ["/api/create", `{"model":"koinos-a","files":{"model.gguf":"sha256:${sha}"}}`],
    ]);
    assert.strictEqual(rt.servedName(), "koinos-a");
    // The older-Ollama Modelfile fallback is unchanged too.
    const old = await fakeOllamaCtx({ createFails: (b) => !!b.files });
    try {
      const rt2 = new OllamaRuntime({ host: "127.0.0.1", port: old.port, onEvent: () => {} });
      await rt2.start({ modelPath: file, sha256: sha, modelName: "koinos-a" });
      const creates = old.reqs.filter((r) => r.url === "/api/create").map((r) => r.raw);
      assert.deepStrictEqual(creates, [`{"model":"koinos-a","files":{"model.gguf":"sha256:${sha}"}}`, JSON.stringify({ name: "koinos-a", modelfile: `FROM ${file}` })]);
    } finally {
      old.server.close();
    }
  } finally {
    fake.server.close();
  }
});

test("ollama context: an opt-in registers its own model with num_ctx and verifies via warm-up + /api/ps", async () => {
  const fake = await fakeOllamaCtx();
  const { file, sha } = modelFile();
  try {
    const rt = new OllamaRuntime({ host: "127.0.0.1", port: fake.port, onEvent: () => {} });
    await rt.start({ modelPath: file, sha256: sha, modelName: "koinos-a-ctx16384", contextTokens: 16384 });
    const create = fake.reqs.find((r) => r.url === "/api/create");
    assert.strictEqual(create.raw, `{"model":"koinos-a-ctx16384","files":{"model.gguf":"sha256:${sha}"},"parameters":{"num_ctx":16384}}`);
    assert.strictEqual(await rt.verifyContext(16384), true);
    const warm = fake.reqs.find((r) => r.url === "/api/generate");
    assert.strictEqual(warm.raw, '{"model":"koinos-a-ctx16384","prompt":"","stream":false}');
    assert.ok(fake.reqs.findIndex((r) => r.url === "/api/ps") > fake.reqs.indexOf(warm), "ps is read after the warm-up");
    assert.strictEqual(await rt.verifyContext(32768), false, "a smaller runner never proves a bigger tier");

    // The show precheck: a model created with another num_ctx is recreated once.
    const before = fake.reqs.filter((r) => r.url === "/api/create").length;
    fake.models.set("koinos-a-ctx32768", 4096);
    await rt.start({ modelPath: file, sha256: sha, modelName: "koinos-a-ctx32768", contextTokens: 32768 });
    assert.strictEqual(fake.reqs.filter((r) => r.url === "/api/create").length, before + 1, "recreated once on mismatch");
    await rt.start({ modelPath: file, sha256: sha, modelName: "koinos-a-ctx32768", contextTokens: 32768 });
    assert.strictEqual(fake.reqs.filter((r) => r.url === "/api/create").length, before + 1, "a matching config is left alone");
  } finally {
    fake.server.close();
  }
  // Older Ollama: the Modelfile fallback carries the parameter.
  const old = await fakeOllamaCtx({ createFails: (b) => !!b.files });
  try {
    const rt = new OllamaRuntime({ host: "127.0.0.1", port: old.port, onEvent: () => {} });
    await rt.start({ modelPath: file, sha256: sha, modelName: "koinos-a-ctx16384", contextTokens: 16384 });
    const creates = old.reqs.filter((r) => r.url === "/api/create").map((r) => JSON.parse(r.raw));
    assert.deepStrictEqual(creates[1], { name: "koinos-a-ctx16384", modelfile: `FROM ${file}\nPARAMETER num_ctx 16384` });
  } finally {
    old.server.close();
  }
});

test("ollama context: configured large but effective small, missing, or slow is never verified", async () => {
  const { file, sha } = modelFile();
  const cases = [
    [{ psContext: 4096 }, "context_length below N"],
    [{ psOmitContext: true }, "context_length missing"],
    [{ showNumCtx: 16384, psContext: 8192 }, "show says 16384, the runner says 8192"],
  ];
  for (const [opts, label] of cases) {
    const fake = await fakeOllamaCtx(opts);
    try {
      const rt = new OllamaRuntime({ host: "127.0.0.1", port: fake.port, onEvent: () => {} });
      await rt.start({ modelPath: file, sha256: sha, modelName: "koinos-a-ctx16384", contextTokens: 16384 });
      assert.strictEqual(await rt.verifyContext(16384), false, label);
    } finally {
      fake.server.close();
    }
  }
  const slow = await fakeOllamaCtx({ warmDelayMs: 400 });
  try {
    const rt = new OllamaRuntime({ host: "127.0.0.1", port: slow.port, onEvent: () => {} });
    await rt.start({ modelPath: file, sha256: sha, modelName: "koinos-a-ctx16384", contextTokens: 16384 });
    assert.strictEqual(await rt.verifyContext(16384, { warmupMs: 50 }), false, "a warm-up timeout fails closed");
  } finally {
    slow.server.close();
  }
  // Not loaded and no warm-up allowed: unverified, and nothing was loaded.
  const cold = await fakeOllamaCtx();
  try {
    const rt = new OllamaRuntime({ host: "127.0.0.1", port: cold.port, onEvent: () => {} });
    await rt.start({ modelPath: file, sha256: sha, modelName: "koinos-a-ctx16384", contextTokens: 16384 });
    assert.strictEqual(await rt.verifyContext(16384, { warm: false }), false);
    assert.ok(!cold.reqs.some((r) => r.url === "/api/generate"));
  } finally {
    cold.server.close();
  }
});

test("ollama context: the runtime manager advertises an Ollama opt-in only when /api/ps proves it", async () => {
  const settingsFor = (v) => ({ v, get() { return this.v; }, set(x) { this.v = x; } });
  const setup = async (fakeOpts, plan) => {
    const fake = await fakeOllamaCtx(fakeOpts);
    const { dir, file, sha } = modelFile();
    const mcat = path.join(dir, "models.json");
    fs.writeFileSync(mcat, JSON.stringify({
      aliases: { "koinos-a": { label: "A", package: "a@1" } },
      packages: { "a@1": { filename: path.basename(file), url: "http://127.0.0.1:1/x", sha256: sha, contextSize: 4096, maxContextTokens: 32768 } },
    }));
    const events = [];
    const rm = new RuntimeManager({
      models: new ModelManager({ catalogPath: mcat, modelsDir: dir, state: new JsonStore(path.join(dir, "s.json"), {}), onEvent: () => {} }),
      hardware: { capabilities: {} },
      preferFallback: true,
      makeFallback: async () => new OllamaRuntime({ host: "127.0.0.1", port: fake.port, onEvent: () => {} }),
      makeRuntime: () => { throw new Error("llama.cpp must not boot here"); },
      contextSettings: settingsFor(plan),
      onEvent: (e) => events.push(e),
    });
    return { fake, rm, events, sha };
  };

  // Proven: the opt-in model serves and is advertised.
  {
    const { fake, rm } = await setup({}, { "koinos-a": { contextTokens: 16384, maxOutputTokens: 1024 } });
    try {
      await rm.ensure("koinos-a");
      assert.strictEqual(rm.servedModelName(), "koinos-koinos-a-ctx16384");
      assert.deepStrictEqual(rm.advertisedContext("koinos-a"), { contextTokens: 16384, maxOutputTokens: 1024 });
      assert.deepStrictEqual(await rm.verifiedContextFor("koinos-a"), { contextTokens: 16384, maxOutputTokens: 1024 });
    } finally {
      rm.stop();
      fake.server.close();
    }
  }
  // Configured large, effective small: serves locally, never advertised.
  {
    const { fake, rm, events } = await setup({ psContext: 4096 }, { "koinos-a": { contextTokens: 16384 } });
    try {
      await rm.ensure("koinos-a");
      assert.strictEqual(rm.servedModelName(), "koinos-koinos-a-ctx16384");
      assert.strictEqual(rm.advertisedContext("koinos-a"), null);
      assert.ok(events.some((e) => e.type === "runtime:context" && e.verified === false));
    } finally {
      rm.stop();
      fake.server.close();
    }
  }
  // The opt-in create fails outright: legacy name and body, session-failed.
  {
    const { fake, rm, events, sha } = await setup({ createFails: (b) => /ctx/.test(b.model || b.name || "") }, { "koinos-a": { contextTokens: 16384 } });
    try {
      await rm.ensure("koinos-a");
      assert.strictEqual(rm.servedModelName(), "koinos-koinos-a");
      assert.ok(fake.reqs.some((r) => r.raw === `{"model":"koinos-koinos-a","files":{"model.gguf":"sha256:${sha}"}}`));
      assert.ok(events.some((e) => e.type === "runtime:context-fallback" && e.via === "ollama"));
      assert.strictEqual(rm.advertisedContext("koinos-a"), null);
      const n = fake.reqs.length;
      await rm.ensure("koinos-a");
      assert.strictEqual(fake.reqs.length, n, "no reload loop");
    } finally {
      rm.stop();
      fake.server.close();
    }
  }
  // No opt-in at all: legacy only, nothing probed.
  {
    const { fake, rm } = await setup({}, {});
    try {
      await rm.ensure("koinos-a");
      assert.strictEqual(rm.servedModelName(), "koinos-koinos-a");
      assert.ok(!fake.reqs.some((r) => r.url === "/api/ps" || r.url === "/api/generate"));
    } finally {
      rm.stop();
      fake.server.close();
    }
  }
});

/*
 * §5 per-request verification is READ-ONLY: the one bounded warm-up belongs
 * to the initial opt-in load; every later check only reads /api/ps. A runner
 * Ollama unloaded, one missing from /api/ps, or one reporting a missing or
 * smaller context_length fails closed — refused, re-advertised at legacy —
 * and nothing is warmed, created or reloaded behind the owner's back.
 */
async function ollamaCtxManager(fakeOpts, plan) {
  const fake = await fakeOllamaCtx(fakeOpts);
  const { dir, file, sha } = modelFile();
  const mcat = path.join(dir, "models.json");
  fs.writeFileSync(mcat, JSON.stringify({
    aliases: { "koinos-a": { label: "A", package: "a@1" } },
    packages: { "a@1": { filename: path.basename(file), url: "http://127.0.0.1:1/x", sha256: sha, contextSize: 4096, maxContextTokens: 32768 } },
  }));
  const events = [];
  const rm = new RuntimeManager({
    models: new ModelManager({ catalogPath: mcat, modelsDir: dir, state: new JsonStore(path.join(dir, "s.json"), {}), onEvent: () => {} }),
    hardware: { capabilities: {} },
    preferFallback: true,
    makeFallback: async () => new OllamaRuntime({ host: "127.0.0.1", port: fake.port, onEvent: () => {} }),
    makeRuntime: () => { throw new Error("llama.cpp must not boot here"); },
    contextSettings: { v: plan, get() { return this.v; }, set(x) { this.v = x; } },
    onEvent: (e) => events.push(e),
  });
  const count = (url) => fake.reqs.filter((r) => r.url === url || (url === "/api/blobs/" && r.url.startsWith(url))).length;
  return { fake, rm, events, count };
}

test("ollama context: the opt-in warm-up runs exactly once per load; per-request checks never POST /api/generate", async () => {
  const plan = { "koinos-a": { contextTokens: 16384, maxOutputTokens: 1024 } };
  const { fake, rm, count } = await ollamaCtxManager({}, plan);
  try {
    await rm.ensure("koinos-a");
    assert.strictEqual(count("/api/generate"), 1, "the initial opt-in load warms the runner up once");
    assert.deepStrictEqual(rm.advertisedContext("koinos-a"), { contextTokens: 16384, maxOutputTokens: 1024 });
    const ps0 = count("/api/ps");
    for (let i = 0; i < 3; i++) {
      const hold = await rm.acquireFor("koinos-a");
      assert.deepStrictEqual(await rm.verifiedContextFor("koinos-a"), { contextTokens: 16384, maxOutputTokens: 1024 });
      hold.release();
    }
    assert.strictEqual(count("/api/generate"), 1, "per-request checks never warm up");
    assert.strictEqual(count("/api/ps"), ps0 + 3, "each per-request check is one /api/ps read");
    await rm.ensure("koinos-a");
    assert.strictEqual(count("/api/generate"), 1, "an already-serving alias is not reloaded");
  } finally {
    rm.stop();
    fake.server.close();
  }
});

test("ollama context: an unloaded, missing or too-small runner fails closed with no warm-up and no implicit reload", async () => {
  const plan = { "koinos-a": { contextTokens: 16384, maxOutputTokens: 1024 } };
  const cases = [
    ["unloaded by Ollama", (fake) => fake.loaded.clear()],
    ["context_length missing", (fake, opts) => { opts.psOmitContext = true; }],
    ["context_length too small", (fake, opts) => { opts.psContext = 8192; }],
    ["listed under another name only", (fake) => { fake.loaded.clear(); fake.loaded.add("koinos-koinos-a"); }],
  ];
  for (const [label, change] of cases) {
    const opts = {};
    const { fake, rm, events, count } = await ollamaCtxManager(opts, plan);
    try {
      await rm.ensure("koinos-a");
      assert.deepStrictEqual(rm.advertisedContext("koinos-a"), { contextTokens: 16384, maxOutputTokens: 1024 }, label);
      const served = rm.servedModelName();
      const engine = rm.runtime;
      const before = { generate: count("/api/generate"), create: count("/api/create"), blobs: count("/api/blobs/"), show: count("/api/show") };
      let changes = 0;
      rm.onContextChange(() => changes++);
      change(fake, opts);

      const hold = await rm.acquireFor("koinos-a");
      assert.strictEqual(await rm.verifiedContextFor("koinos-a"), null, `${label}: refused`);
      hold.release();
      assert.strictEqual(rm.advertisedContext("koinos-a"), null, `${label}: re-advertised at legacy`);
      assert.strictEqual(changes, 1, `${label}: listeners (the worker) hear it once`);
      assert.ok(events.some((e) => e.type === "runtime:context" && e.verified === false && /live probe/.test(e.reason)), label);

      // Nothing was warmed, created or reloaded — not by the check, and not
      // by the next demand for the same alias.
      await rm.ensure("koinos-a");
      const again = await rm.acquireFor("koinos-a");
      assert.strictEqual(await rm.verifiedContextFor("koinos-a"), null, `${label}: stays refused until the next opt-in load`);
      again.release();
      assert.deepStrictEqual(
        { generate: count("/api/generate"), create: count("/api/create"), blobs: count("/api/blobs/"), show: count("/api/show") },
        before,
        `${label}: no warm-up, no create, no reload`
      );
      assert.strictEqual(rm.runtime, engine, `${label}: same engine`);
      assert.strictEqual(rm.servedModelName(), served, `${label}: same served model`);
    } finally {
      rm.stop();
      fake.server.close();
    }
  }
});
