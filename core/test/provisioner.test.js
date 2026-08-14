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

function serveOnce(body) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-length": body.length });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function writeCatalog(dir, { url, sha256 }) {
  const p = path.join(dir, "rt-catalog.json");
  const key = `${process.platform}-${process.arch}-cpu`;
  fs.writeFileSync(
    p,
    JSON.stringify({
      llamacpp: {
        version: "test1",
        builds: { [key]: { url, sha256, sizeBytes: null, binPath: "build/bin/llama-server" } },
      },
    })
  );
  return p;
}

test("provisioner: downloads, verifies, extracts, returns executable bin; caches after", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-prov-"));
  const zipBody = makeZip([
    { name: "build/", mode: 0o755 },
    { name: "build/bin/", mode: 0o755 },
    { name: "build/bin/llama-server", data: "#!/bin/sh\nexit 0\n", mode: 0o755, deflate: true },
  ]);
  const sha = crypto.createHash("sha256").update(zipBody).digest("hex");
  const { server, port } = await serveOnce(zipBody);
  try {
    const prov = new RuntimeProvisioner({
      catalogPath: writeCatalog(dir, { url: `http://127.0.0.1:${port}/rt.zip`, sha256: sha }),
      runtimesDir: path.join(dir, "runtimes"),
      hardware: { capabilities: { cudaEligible: false } },
      onEvent: () => {},
    });
    const bin = await prov.ensure("llamacpp");
    assert.ok(fs.existsSync(bin));
    if (process.platform !== "win32") assert.ok(fs.statSync(bin).mode & 0o100);

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
