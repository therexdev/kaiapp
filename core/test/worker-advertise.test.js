"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const http = require("http");

const { Worker } = require("../lib/worker");

/*
 * Trust boundary (field decision): a worker's PRIVATE models never ride
 * the network. Custom GGUF imports are unvetted, unpriced weights — if
 * they were advertised, they would appear in every consumer's network
 * picker and be dispatched + billed. Only trusted catalog classes are
 * advertised; dev pipeline models stay home for the same reason. The
 * scheduler filters against its rate table too — this pins the app side.
 */

test("worker advertises only catalog models — custom imports and dev builds stay private", async () => {
  let advertised = null;
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith("/worker/register")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        advertised = JSON.parse(raw).models;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, token: "wt_test" }));
      });
      return;
    }
    res.writeHead(204);
    res.end();
  });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", function () { r(this.address().port); }));
  try {
    const worker = new Worker({
      schedulerUrl: `http://127.0.0.1:${port}`,
      wallet: { address: "1TestAddr", signHash: async () => "sig" },
      runtime: { ensure: async () => "http://127.0.0.1:1" },
      hardware: { ramBytes: 8e9 }, // an 8 GB machine
      models: {
        aliases: () => [
          { alias: "koinos-fast", status: "ready", minRamGb: 4 },
          { alias: "gemma3-4b", status: "absent", minRamGb: 8 }, // not on disk — never advertised
          { alias: "dev-tiny", status: "ready", dev: true }, // pipeline model — private
          { alias: "custom-my-novel-gguf", status: "ready", custom: true }, // import — private
          // Downloaded but far beyond this machine's RAM: hoarding a model
          // you can't serve must not make you eligible for its jobs.
          { alias: "qwen25-14b", status: "ready", minRamGb: 24 },
          { alias: "koinos-balanced", status: "ready" }, // no minRamGb — benefit of the doubt
        ],
      },
      onEvent: () => {},
    });
    await worker._register();
    assert.deepStrictEqual(advertised, ["koinos-fast", "koinos-balanced"], "only ready catalog classes are advertised");
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

/*
 * VRAM counts toward what a machine can serve.
 *
 * Found while exploring cloud GPU hosting (docs/cloud-gpu-design.md), but it
 * is a consumer bug too: `minRamGb` was compared against os.totalmem() alone,
 * so a 24 GB 4090 beside 16 GB of DDR4 — an ordinary gaming PC — was refused
 * the classes it serves FASTEST, while a RAM-rich CPU-only box was waved into
 * classes it serves at a crawl. System RAM is a fine proxy for capability
 * until there is a real GPU, and then it is the wrong number entirely.
 */
test("a big GPU makes a machine eligible for classes its system RAM alone would refuse", async () => {
  const catalog = [
    { alias: "koinos-fast", status: "ready", minRamGb: 3 },
    { alias: "gemma3-27b", status: "ready", minRamGb: 24 },
    { alias: "qwen25-32b", status: "ready", minRamGb: 32 },
  ];

  let advertised = null;
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith("/worker/register")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        advertised = JSON.parse(raw).models;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, token: "wt_test" }));
      });
      return;
    }
    res.writeHead(204);
    res.end();
  });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", function () { r(this.address().port); }));

  const run = async (hardware) => {
    const seen = {};
    const worker = new Worker({
      schedulerUrl: `http://127.0.0.1:${port}`,
      wallet: { address: "1TestAddr", signHash: async () => "sig" },
      runtime: { ensure: async () => "http://127.0.0.1:1" },
      hardware,
      models: { aliases: () => catalog },
      onEvent: (e) => { seen[e.type] = e; },
    });
    await worker._register();
    return { advertised: advertised.slice().sort(), gate: worker.modelGate, seen };
  };

  try {
    // 16 GB of system RAM, no GPU: the two big classes are correctly refused.
    const cpuOnly = await run({ ramBytes: 16e9, gpus: [] });
    assert.deepStrictEqual(cpuOnly.advertised, ["koinos-fast"]);

    // The SAME 16 GB of RAM, plus a 48 GB card. The weights live on the card.
    const withGpu = await run({ ramBytes: 16e9, gpus: [{ name: "NVIDIA A40", vramMb: 49140 }] });
    assert.deepStrictEqual(withGpu.advertised, ["gemma3-27b", "koinos-fast", "qwen25-32b"]);

    // The refusal names BOTH numbers, so "why is my model not offered?" has an
    // answer that matches the machine the person is looking at.
    const refused = cpuOnly.gate.find((g) => g.alias === "qwen25-32b");
    assert.strictEqual(refused.reasonCode, "too-big");
    assert.match(refused.reason, /16 GB RAM/);
    const gpuRefusal = withGpu.gate.find((g) => g.alias === "qwen25-32b");
    assert.strictEqual(gpuRefusal.advertised, true, "nothing is refused on this box");

    // Nothing fits at all -> the notice still fires. It keys off reasonCode
    // now, not off a substring of its own prose.
    const tiny = await run({ ramBytes: 2e9, gpus: [] });
    assert.deepStrictEqual(tiny.advertised, []);
    assert.ok(tiny.seen["worker:no-servable-models"], "the machine says why it offers nothing");
    assert.match(tiny.seen["worker:no-servable-models"].message, /fits its memory/);
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});
