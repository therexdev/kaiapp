"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const { JsonStore } = require("../lib/store");
const { ModelManager } = require("../lib/model-manager");

const PAYLOAD = crypto.randomBytes(256 * 1024); // "model" blob
const SHA = crypto.createHash("sha256").update(PAYLOAD).digest("hex");

/** Local server standing in for the model CDN; supports Range resume. */
function serveBlob({ rangeSupported = true } = {}) {
  const server = http.createServer((req, res) => {
    const range = /bytes=(\d+)-/.exec(String(req.headers.range || ""));
    if (range && rangeSupported) {
      const from = Number(range[1]);
      res.writeHead(206, {
        "content-length": PAYLOAD.length - from,
        "content-range": `bytes ${from}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
      });
      return res.end(PAYLOAD.subarray(from));
    }
    res.writeHead(200, { "content-length": PAYLOAD.length });
    res.end(PAYLOAD);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function makeManager(dir, url, sha = SHA) {
  const catalogPath = path.join(dir, "catalog.json");
  fs.writeFileSync(
    catalogPath,
    JSON.stringify({
      aliases: { tiny: { label: "Tiny", package: "tiny@1" } },
      packages: { "tiny@1": { filename: "tiny.bin", url, sha256: sha, sizeBytes: PAYLOAD.length, runtime: "llamacpp" } },
    })
  );
  return new ModelManager({
    catalogPath,
    modelsDir: path.join(dir, "models"),
    state: new JsonStore(path.join(dir, "state.json"), {}),
    onEvent: () => {},
  });
}

test("downloads, verifies sha256, and reports ready", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-mm-"));
  const { server, port } = await serveBlob();
  try {
    const mm = makeManager(dir, `http://127.0.0.1:${port}/tiny.bin`);
    assert.equal(mm.packageStatus("tiny@1").status, "absent");
    const file = await mm.ensurePackage("tiny@1");
    assert.ok(Buffer.compare(fs.readFileSync(file), PAYLOAD) === 0);
    assert.equal(mm.packageStatus("tiny@1").status, "ready");
    assert.equal(mm.aliases()[0].status, "ready");
    // Second call is a no-op returning the same path.
    assert.equal(await mm.ensurePackage("tiny@1"), file);
  } finally {
    server.close();
  }
});

test("resumes a partial download via Range", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-mm-"));
  const { server, port } = await serveBlob();
  try {
    const mm = makeManager(dir, `http://127.0.0.1:${port}/tiny.bin`);
    // Simulate an interrupted earlier attempt: first half already on disk.
    fs.mkdirSync(path.join(dir, "models"), { recursive: true });
    const part = mm.packagePath("tiny@1") + ".part";
    fs.writeFileSync(part, PAYLOAD.subarray(0, PAYLOAD.length / 2));
    assert.equal(mm.packageStatus("tiny@1").status, "partial");

    const file = await mm.ensurePackage("tiny@1");
    assert.ok(Buffer.compare(fs.readFileSync(file), PAYLOAD) === 0, "resumed file is byte-identical");
  } finally {
    server.close();
  }
});

test("wrong hash is rejected and the file discarded (§27 identity)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-mm-"));
  const { server, port } = await serveBlob();
  try {
    const mm = makeManager(dir, `http://127.0.0.1:${port}/tiny.bin`, "0".repeat(64));
    await assert.rejects(() => mm.ensurePackage("tiny@1"), /SHA-256 verification/);
    assert.equal(mm.packageStatus("tiny@1").status, "absent", "no partial/failed file left behind");
  } finally {
    server.close();
  }
});

test("unknown alias and package fail clearly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-mm-"));
  const { server, port } = await serveBlob();
  try {
    const mm = makeManager(dir, `http://127.0.0.1:${port}/tiny.bin`);
    assert.throws(() => mm.resolveAlias("nope"), /Unknown model alias/);
    await assert.rejects(() => mm.ensurePackage("nope@9"), /Unknown package/);
  } finally {
    server.close();
  }
});

test("a package without a pinned sha256 refuses to download (fail closed)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-mm-"));
  const catalogPath = path.join(dir, "catalog.json");
  fs.writeFileSync(
    catalogPath,
    JSON.stringify({
      aliases: { t: { label: "T", package: "t@1" } },
      packages: { "t@1": { filename: "t.bin", url: "http://127.0.0.1:1/x", sha256: "PENDING_FIRST_FETCH" } },
    })
  );
  const mm = new ModelManager({
    catalogPath,
    modelsDir: path.join(dir, "models"),
    state: new JsonStore(path.join(dir, "state.json"), {}),
    onEvent: () => {},
  });
  await assert.rejects(() => mm.ensurePackage("t@1"), /no pinned sha256/);
});
