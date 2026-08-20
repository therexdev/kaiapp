"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const { downloadFile } = require("../lib/download");
const { Worker } = require("../lib/worker");

/*
 * A40 field report (v0.29.1 headless, 2026-08-20). Four findings, each
 * pinned here: a stalled mirror must not wedge Core forever, the cancel
 * escape hatch must have a route, a cold engine swap must announce itself
 * to the scheduler, and /core/* must be lockable before the server edition.
 */

function listen(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

test("download: a mirror that stalls without closing aborts on the idle clock", async () => {
  // Sends headers and one byte, then goes silent forever.
  const { srv, base } = await listen((req, res) => {
    res.writeHead(200, { "content-length": "1000" });
    res.write("x");
    /* …and nothing more, ever */
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-stall-"));
  try {
    await assert.rejects(
      () => downloadFile(`${base}/f`, path.join(dir, "f"), { sha256: "a".repeat(64), idleMs: 300 }),
      /stalled — no data from the mirror/
    );
  } finally {
    srv.close();
  }
});

test("download: slow but MOVING mirrors are never punished; hash still verifies", async () => {
  const content = Buffer.from("drip-fed but honest");
  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  const { srv, base } = await listen((req, res) => {
    res.writeHead(200, { "content-length": String(content.length) });
    // One byte every 100ms — each chunk re-arms a 400ms idle clock.
    let i = 0;
    const t = setInterval(() => {
      if (i >= content.length) {
        clearInterval(t);
        res.end();
        return;
      }
      res.write(content.subarray(i, i + 1));
      i += 1;
    }, 100);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-drip-"));
  const dest = path.join(dir, "f");
  try {
    await downloadFile(`${base}/f`, dest, { sha256, idleMs: 400 });
    assert.strictEqual(fs.readFileSync(dest).toString(), content.toString());
  } finally {
    srv.close();
  }
});

test("download: the user's own cancel is still a cancel, not a 'stall'", async () => {
  const { srv, base } = await listen((req, res) => {
    res.writeHead(200, { "content-length": "1000" });
    res.write("x"); // then hold the connection open
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cancel-"));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(
      () => downloadFile(`${base}/f`, path.join(dir, "f"), { sha256: "a".repeat(64), idleMs: 60000, signal: controller.signal }),
      (e) => !/stalled/.test(String(e.message))
    );
  } finally {
    srv.close();
  }
});

test("worker: a job needing a NON-resident model announces warming; a resident one does not", async () => {
  const warmings = [];
  const sched = await listen((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url.startsWith("/worker/warming")) warmings.push(JSON.parse(raw));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const engine = await listen((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  try {
    const worker = new Worker({
      schedulerUrl: sched.base,
      wallet: { address: "1abc", signHash: async () => "sig" },
      runtime: { activeAlias: "resident-model", acquireFor: async () => ({ endpoint: engine.base, release: () => {} }) },
      hardware: {},
      onEvent: () => {},
    });
    worker.token = "tok";

    await worker._execute({ id: "j-cold", type: "chat", model: "cold-32b", messages: [{ role: "user", content: "q" }] }, null);
    // The warming post is fire-and-forget — give it a beat to land.
    for (let i = 0; i < 20 && warmings.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.strictEqual(warmings.length, 1, "cold swap announced itself");
    assert.strictEqual(warmings[0].jobId, "j-cold");

    await worker._execute({ id: "j-warm", type: "chat", model: "resident-model", messages: [{ role: "user", content: "q" }] }, null);
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(warmings.length, 1, "a resident model stays silent — no noise on the happy path");
  } finally {
    sched.srv.close();
    engine.srv.close();
  }
});

test("gateway: /core/models/download/cancel exists and answers honestly when idle; KAI_CORE_TOKEN gates /core/*", async () => {
  process.env.KAI_CORE_TOKEN = "test-core-token";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-hard-"));
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const { createCore } = require("../server");
  const core = await createCore({
    dataDir: dir,
    port: 0,
    llamaBin: path.join(__dirname, "fixtures", "fake-llama-server"),
    onEvent: () => {},
  });
  const base = `http://127.0.0.1:${await core.start()}`;
  const auth = { authorization: "Bearer test-core-token" };
  try {
    // Token gate: /core/* refuses without the bearer, works with it.
    assert.strictEqual((await fetch(`${base}/core/models`)).status, 401);
    assert.strictEqual((await fetch(`${base}/core/models`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.strictEqual((await fetch(`${base}/core/models`, { headers: auth })).status, 200);
    // /v1/* and the UI shell keep their own rules — the token is /core-only.
    assert.strictEqual((await fetch(`${base}/v1/models`)).status, 200);
    assert.strictEqual((await fetch(`${base}/`)).status, 200);

    // The cancel route: nothing in flight -> honest {cancelled:false}.
    const c = await (await fetch(`${base}/core/models/download/cancel`, { method: "POST", headers: auth })).json();
    assert.strictEqual(c.ok, true);
    assert.strictEqual(c.cancelled, false);

    // Teams still work with the token set — the internal loopback carries it.
    const resp = await fetch(`${base}/core/teams/run`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ template: "review", question: "say hello", model: "dev-tiny" }),
    });
    const events = (await resp.text())
      .split("\n\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    const done = events.find((e) => e.done);
    assert.strictEqual(done.error, undefined, `teams run clean under the token: ${done.error}`);
    assert.strictEqual(done.answer, "Hello from fake llama");
  } finally {
    delete process.env.KAI_CORE_TOKEN;
    await core.stop();
  }
});
