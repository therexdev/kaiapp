"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");

const { extractZip } = require("../lib/zip");
const { makeZip } = require("./fixtures/make-zip");
const { RuntimeProvisioner } = require("../lib/runtime-provisioner");

// ---------- zip extraction ----------

test("zip: extracts store+deflate entries, dirs, and unix modes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-zip-"));
  const zip = path.join(dir, "a.zip");
  fs.writeFileSync(
    zip,
    makeZip([
      { name: "build/", mode: 0o755 },
      { name: "build/bin/", mode: 0o755 },
      { name: "build/bin/llama-server", data: "#!/bin/sh\necho hi\n", mode: 0o755, deflate: true },
      { name: "README.txt", data: "hello world ".repeat(100), deflate: true },
      { name: "plain.dat", data: "stored" },
    ])
  );
  const out = path.join(dir, "out");
  const files = extractZip(zip, out);
  assert.equal(files.length, 3, "three file entries");
  assert.equal(fs.readFileSync(path.join(out, "plain.dat"), "utf8"), "stored");
  assert.match(fs.readFileSync(path.join(out, "README.txt"), "utf8"), /^hello world /);
  const bin = path.join(out, "build", "bin", "llama-server");
  assert.match(fs.readFileSync(bin, "utf8"), /echo hi/);
  if (process.platform !== "win32") {
    assert.ok(fs.statSync(bin).mode & 0o100, "executable bit preserved");
  }
});

test("zip: refuses traversal entries and non-zip files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-zip-"));
  const evil = path.join(dir, "evil.zip");
  fs.writeFileSync(evil, makeZip([{ name: "../escape.txt", data: "x" }]));
  assert.throws(() => extractZip(evil, path.join(dir, "out")), /escaping the target/);
  const junk = path.join(dir, "junk.bin");
  fs.writeFileSync(junk, crypto.randomBytes(100));
  assert.throws(() => extractZip(junk, path.join(dir, "out2")), /Not a zip/);
});

// ---------- provisioner ----------

function serveMap(bodies) {
  const server = http.createServer((req, res) => {
    const body = bodies[req.url];
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-length": body.length });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}
const serveOnce = (body) => serveMap({ "/rt.zip": body });

function writeCatalog(dir, { url, sha256, extras }) {
  const p = path.join(dir, "rt-catalog.json");
  const key = `${process.platform}-${process.arch}-cpu`;
  fs.writeFileSync(
    p,
    JSON.stringify({
      llamacpp: {
        version: "test1",
        builds: { [key]: { url, sha256, sizeBytes: null, binPath: "build/bin/llama-server", extras } },
      },
    })
  );
  return p;
}

test("provisioner: downloads main + extras, verifies, extracts, caches", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-prov-"));
  const zipBody = makeZip([
    { name: "build/", mode: 0o755 },
    { name: "build/bin/", mode: 0o755 },
    { name: "build/bin/llama-server", data: "#!/bin/sh\nexit 0\n", mode: 0o755, deflate: true },
  ]);
  const extraBody = makeZip([{ name: "build/bin/cudart.dll", data: "runtime-dll", deflate: true }]);
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  const { server, port } = await serveMap({ "/rt.zip": zipBody, "/extra.zip": extraBody });
  try {
    const prov = new RuntimeProvisioner({
      catalogPath: writeCatalog(dir, {
        url: `http://127.0.0.1:${port}/rt.zip`,
        sha256: sha(zipBody),
        extras: [{ url: `http://127.0.0.1:${port}/extra.zip`, sha256: sha(extraBody), sizeBytes: null }],
      }),
      runtimesDir: path.join(dir, "runtimes"),
      hardware: { capabilities: { cudaEligible: false } },
      onEvent: () => {},
    });
    const bin = await prov.ensure("llamacpp");
    assert.ok(fs.existsSync(bin));
    if (process.platform !== "win32") assert.ok(fs.statSync(bin).mode & 0o100);
    // Companion archive landed in the same install dir.
    assert.equal(fs.readFileSync(path.join(path.dirname(bin), "cudart.dll"), "utf8"), "runtime-dll");

    // Cached: works with the server gone.
    server.close();
    assert.equal(await prov.ensure("llamacpp"), bin);
  } finally {
    server.close();
  }
});

test("provisioner: unpinned hash fails closed; wrong hash rejected", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-prov-"));
  const zipBody = makeZip([{ name: "build/bin/llama-server", data: "x" }]);
  const { server, port } = await serveOnce(zipBody);
  try {
    const unpinned = new RuntimeProvisioner({
      catalogPath: writeCatalog(dir, { url: `http://127.0.0.1:${port}/rt.zip`, sha256: "PENDING_FIRST_FETCH" }),
      runtimesDir: path.join(dir, "r1"),
      hardware: {},
      onEvent: () => {},
    });
    await assert.rejects(() => unpinned.ensure("llamacpp"), /pinned sha256/);

    const wrong = new RuntimeProvisioner({
      catalogPath: writeCatalog(dir, { url: `http://127.0.0.1:${port}/rt.zip`, sha256: "0".repeat(64) }),
      runtimesDir: path.join(dir, "r2"),
      hardware: {},
      onEvent: () => {},
    });
    await assert.rejects(() => wrong.ensure("llamacpp"), /SHA-256 verification/);
  } finally {
    server.close();
  }
});

test("provisioner: no matching build gives an actionable error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-prov-"));
  const p = path.join(dir, "c.json");
  fs.writeFileSync(p, JSON.stringify({ llamacpp: { version: "v", builds: { "beos-ppc-cpu": { url: "x", sha256: "0".repeat(64), binPath: "b" } } } }));
  const prov = new RuntimeProvisioner({ catalogPath: p, runtimesDir: dir, hardware: {}, onEvent: () => {} });
  assert.throws(() => prov.selectBuild("llamacpp"), /No llamacpp build for this machine/);
  assert.throws(() => prov.selectBuild("vllm"), /Unknown runtime kind/);
});

test("runtime manager falls back to CPU when the CUDA path fails", async () => {
  const { RuntimeManager } = require("../lib/runtime-manager");
  const { LlamaCppRuntime } = require("../lib/runtimes/llamacpp");
  const { ModelManager } = require("../lib/model-manager");
  const { JsonStore } = require("../lib/store");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-fb-"));
  const fakeJs = path.join(__dirname, "fixtures", "fake-llama-server.js");
  // CPU zip contains a working fake llama-server; CUDA build URL is dead.
  const cpuZip = makeZip([
    { name: "llama-server", data: `#!/bin/sh\nexec node "${fakeJs}" "$@"\n`, mode: 0o755, deflate: true },
  ]);
  const sha = crypto.createHash("sha256").update(cpuZip).digest("hex");
  const { server, port } = await serveMap({ "/cpu.zip": cpuZip });
  const key = (cap) => `${process.platform}-${process.arch}-${cap}`;
  const catalogPath = path.join(dir, "rt.json");
  fs.writeFileSync(
    catalogPath,
    JSON.stringify({
      llamacpp: {
        version: "fb1",
        builds: {
          [key("cuda")]: { url: "http://127.0.0.1:1/dead.zip", sha256: "0".repeat(64), binPath: "llama-server" },
          [key("cpu")]: { url: `http://127.0.0.1:${port}/cpu.zip`, sha256: sha, binPath: "llama-server" },
        },
      },
    })
  );

  const mcat = path.join(dir, "models.json");
  fs.writeFileSync(
    mcat,
    JSON.stringify({
      aliases: { t: { label: "T", package: "t@1" } },
      packages: { "t@1": { filename: "t.gguf", url: "http://127.0.0.1:1/x", sha256: "0".repeat(64) } },
    })
  );
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "t.gguf"), "weights");

  const events = [];
  const prov = new RuntimeProvisioner({
    catalogPath,
    runtimesDir: path.join(dir, "runtimes"),
    hardware: { capabilities: { cudaEligible: true } },
    onEvent: () => {},
  });
  // A FIXED port made this test collide under node --test concurrency; the
  // random-high-port fix then failed the SAME way on CI (2026-08-27, port
  // 58562) because 42000-62000 sits inside Linux's ephemeral range — every
  // concurrent test's sockets draw from it, so guessing can never be safe.
  // Ask the kernel instead: bind 0, read the assigned port, release it. The
  // close-to-rebind window is real but tiny, and kernels don't hand a just
  // released port straight back out.
  const rtPort = await new Promise((resolve, reject) => {
    const s = require("net").createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const rm = new RuntimeManager({
    models: new ModelManager({ catalogPath: mcat, modelsDir: path.join(dir, "models"), state: new JsonStore(path.join(dir, "s.json"), {}), onEvent: () => {} }),
    hardware: { capabilities: { cudaEligible: true } },
    provisioner: prov,
    onEvent: (e) => events.push(e.type),
    makeRuntime: (bin) => new LlamaCppRuntime({ binPath: bin, port: rtPort, onEvent: () => {} }),
  });
  try {
    const endpoint = await rm.ensure("t");
    assert.ok(endpoint.includes(String(rtPort)));
    assert.ok(events.includes("runtime:fallback"), "fallback event emitted");
    assert.equal(rm.status().runtime.running, true);
  } finally {
    rm.stop();
    server.close();
  }
});

test("zip extraction runs off-thread and round-trips content, modes, and nesting", async () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { execFileSync } = require("child_process");
  const { extractZipAsync } = require("../lib/zip");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-zipw-"));
  const src = path.join(dir, "src");
  fs.mkdirSync(path.join(src, "lib", "deep"), { recursive: true });
  fs.writeFileSync(path.join(src, "engine"), "#!/bin/sh\necho ok\n");
  fs.chmodSync(path.join(src, "engine"), 0o755);
  fs.writeFileSync(path.join(src, "lib", "deep", "data.bin"), Buffer.alloc(300000, 7));
  execFileSync("zip", ["-qr", path.join(dir, "a.zip"), "."], { cwd: src });

  const out = path.join(dir, "out");
  const files = await extractZipAsync(path.join(dir, "a.zip"), out);
  assert.ok(files.includes("engine"));
  assert.strictEqual(fs.readFileSync(path.join(out, "engine"), "utf8"), "#!/bin/sh\necho ok\n");
  assert.strictEqual(fs.statSync(path.join(out, "lib", "deep", "data.bin")).size, 300000);
  assert.ok(fs.statSync(path.join(out, "engine")).mode & 0o100, "executable bit survives");
});
