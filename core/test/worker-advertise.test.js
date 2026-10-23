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
  let capabilities = null;
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith("/worker/register")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        advertised = body.models;
        capabilities = body.capabilities;
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
    assert.equal(capabilities.preferredModel, "koinos-fast", "the scheduler receives one stable model for background probes");
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
    return { advertised: advertised.slice().sort(), gate: worker.modelGate, seen, preferred: worker.preferredModel };
  };

  try {
    // 16 GB of system RAM, no GPU: the two big classes are correctly refused.
    const cpuOnly = await run({ ramBytes: 16e9, gpus: [] });
    assert.deepStrictEqual(cpuOnly.advertised, ["koinos-fast"]);

    // The SAME 16 GB of RAM, plus a 48 GB card. The weights live on the card.
    const withGpu = await run({ ramBytes: 16e9, gpus: [{ name: "NVIDIA A40", vramMb: 49140 }] });
    assert.deepStrictEqual(withGpu.advertised, ["gemma3-27b", "koinos-fast", "qwen25-32b"]);
    assert.equal(withGpu.preferred, "koinos-fast", "one stable background-probe model is chosen without hiding other classes");

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

/*
 * Network context protocol 1 (docs/NETWORK_CONTEXT_PROTOCOL.md §6/§11): the
 * worker advertises only what its live engine proved, refuses larger terms
 * before any inference, and stops generating for a consumer the scheduler
 * already forgot.
 */

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", function () { r(this.address().port); }));
const closeServer = (srv) => { srv.closeAllConnections?.(); srv.close(); };
const readJson = (req) => new Promise((resolve) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
});

/** OpenAI-compatible SSE engine that records what it was asked and whether
 *  the caller hung up before the answer finished. */
async function fakeEngine({ words = 4, everyMs = 5, usage = { prompt_tokens: 7, completion_tokens: 4 } } = {}) {
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    const body = await readJson(req);
    const rec = { body, aborted: false, finished: false };
    seen.push(rec);
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0;
    const tick = setInterval(() => {
      if (i < words) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `w${i} ` } }] })}\n\n`);
        i += 1;
        return;
      }
      clearInterval(tick);
      rec.finished = true;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    }, everyMs);
    res.on("close", () => {
      clearInterval(tick);
      if (!rec.finished) rec.aborted = true;
    });
  });
  const port = await listen(srv);
  return { srv, seen, url: `http://127.0.0.1:${port}` };
}

function ctxRuntime(endpoint, { adv = null, live = null } = {}) {
  const listeners = new Set();
  const rt = {
    activeAlias: "koinos-fast",
    acquired: 0,
    released: 0,
    probes: 0,
    advertisedContext: (alias) => (typeof adv === "function" ? adv(alias) : adv),
    verifiedContextFor: async (alias) => {
      rt.probes += 1;
      return typeof live === "function" ? live(alias) : live;
    },
    acquireFor: async () => {
      rt.acquired += 1;
      return { endpoint, release: () => { rt.released += 1; } };
    },
    servedModelName: () => null,
    onContextChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    fire: () => { for (const fn of [...listeners]) fn(); },
    listeners,
    status: () => ({ activeAlias: "koinos-fast", runtime: { running: true }, loading: false }),
  };
  return rt;
}

test("context: registration advertises verified terms per class, legacy 4096/512 otherwise", async () => {
  let body = null;
  const srv = http.createServer(async (req, res) => {
    body = await readJson(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, token: "wt_test" }));
  });
  const port = await listen(srv);
  try {
    const worker = new Worker({
      schedulerUrl: `http://127.0.0.1:${port}`,
      wallet: { address: "1TestAddr", signHash: async () => "sig" },
      runtime: ctxRuntime("http://127.0.0.1:1", { adv: (a) => (a === "koinos-fast" ? { contextTokens: 16384, maxOutputTokens: 2048 } : null) }),
      hardware: { ramBytes: 16e9 },
      models: {
        aliases: () => [
          { alias: "koinos-fast", status: "ready", minRamGb: 3 },
          { alias: "koinos-smart", status: "ready", minRamGb: 12 },
          { alias: "dev-tiny", status: "ready", dev: true },
          { alias: "custom-x", status: "ready", custom: true },
        ],
      },
      onEvent: () => {},
    });
    await worker._register();
    assert.deepStrictEqual(body.models, ["koinos-fast", "koinos-smart"]);
    assert.deepStrictEqual(body.context, {
      protocol: 1,
      models: { "koinos-fast": { contextTokens: 16384, maxOutputTokens: 2048 }, "koinos-smart": { contextTokens: 4096, maxOutputTokens: 512 } },
    });
    // A runtime without the capacity API (older Core pieces) is all legacy.
    worker.runtime = { ensure: async () => "http://127.0.0.1:1" };
    await worker._register();
    assert.deepStrictEqual(body.context.models["koinos-fast"], { contextTokens: 4096, maxOutputTokens: 512 });
  } finally {
    closeServer(srv);
  }
});

test("context: a change in the verified set re-registers once, single-flight with a dirty flag", async () => {
  const registers = [];
  let hold = 0;
  const srv = http.createServer(async (req, res) => {
    if (req.url.startsWith("/worker/register")) {
      const b = await readJson(req);
      registers.push(b.context.models["koinos-fast"]);
      await new Promise((r) => setTimeout(r, hold));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, token: `wt_${registers.length}` }));
    }
    // Long-poll that holds until the worker hangs up.
    req.on("close", () => {});
  });
  const port = await listen(srv);
  let adv = null;
  const runtime = ctxRuntime("http://127.0.0.1:1", { adv: () => adv });
  const worker = new Worker({
    schedulerUrl: `http://127.0.0.1:${port}`,
    wallet: { address: "1TestAddr", signHash: async () => "sig" },
    runtime,
    hardware: { ramBytes: 16e9 },
    models: { aliases: () => [{ alias: "koinos-fast", status: "ready", minRamGb: 3 }] },
    onEvent: () => {},
  });
  try {
    await worker.start();
    assert.strictEqual(registers.length, 1);
    hold = 150;
    adv = { contextTokens: 16384, maxOutputTokens: 1024 };
    runtime.fire(); // starts registration #2
    await new Promise((r) => setTimeout(r, 20));
    runtime.fire(); // in flight: only marks dirty
    runtime.fire();
    for (let i = 0; i < 100 && registers.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    await worker._registerGate;
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(registers.length, 3, "one re-register plus exactly one for the dirty flag");
    assert.deepStrictEqual(registers[2], { contextTokens: 16384, maxOutputTokens: 1024 });
    await worker.stop();
    assert.strictEqual(runtime.listeners.size, 0, "stop unsubscribes");
    runtime.fire();
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(registers.length, 3, "a stopped worker never re-registers");
  } finally {
    await worker.stop();
    closeServer(srv);
  }
});

test("context: job terms — legacy runs today's path; larger terms need the advertisement AND a live proof", async () => {
  const engine = await fakeEngine({ usage: { prompt_tokens: 7, completion_tokens: 9999 } });
  const events = [];
  const make = (opts) => {
    const runtime = ctxRuntime(engine.url, opts);
    const worker = new Worker({
      schedulerUrl: "http://127.0.0.1:1",
      wallet: { address: "1TestAddr", signHash: async () => "sig" },
      runtime,
      hardware: { ramBytes: 16e9 },
      onEvent: (e) => events.push(e),
    });
    return { worker, runtime };
  };
  const msgs = [{ role: "user", content: "hi" }];
  try {
    // Old scheduler: no terms at all -> exactly today's engine body.
    {
      const { worker } = make();
      const out = await worker._execute({ id: "j1", type: "chat", model: "koinos-fast", messages: msgs }, () => {});
      assert.deepStrictEqual(engine.seen.at(-1).body, { model: "koinos-fast", temperature: 0.7, max_tokens: 512, messages: msgs, stream: true });
      assert.deepStrictEqual(Object.keys(engine.seen.at(-1).body), ["model", "temperature", "max_tokens", "messages", "stream"]);
      assert.strictEqual(out.usage.completion_tokens, 512, "reported output never exceeds the terms");
    }
    // Legacy-lane job carrying a smaller output; evals stay at 128.
    {
      const { worker, runtime } = make();
      await worker._execute({ id: "j2", type: "chat", model: "koinos-fast", messages: msgs, maxTokens: 256, contextTokens: 4096 }, () => {});
      assert.strictEqual(engine.seen.at(-1).body.max_tokens, 256);
      await worker._execute({ id: "e1", type: "inference-eval", model: "koinos-fast", prompt: "2+2", maxTokens: 4096, contextTokens: 32768 }, () => {});
      assert.strictEqual(engine.seen.at(-1).body.max_tokens, 128);
      assert.strictEqual(runtime.probes, 0, "legacy terms never probe the engine");
    }
    // Not advertised: refused BEFORE the hold — no load, no inference.
    {
      const { worker, runtime } = make();
      const n = engine.seen.length;
      await assert.rejects(
        () => worker._execute({ id: "j3", type: "chat", model: "koinos-fast", messages: msgs, maxTokens: 2048, contextTokens: 16384 }, () => {}),
        /Refused job terms/
      );
      assert.strictEqual(runtime.acquired, 0);
      assert.strictEqual(engine.seen.length, n);
      assert.ok(events.some((e) => e.type === "worker:terms-refused" && e.jobId === "j3"));
    }
    // Advertised but output above it: refused before the hold.
    {
      const { worker, runtime } = make({ adv: { contextTokens: 16384, maxOutputTokens: 2048 }, live: { contextTokens: 16384, maxOutputTokens: 2048 } });
      await assert.rejects(() => worker._execute({ id: "j4", type: "chat", model: "koinos-fast", messages: msgs, maxTokens: 4096, contextTokens: 16384 }, () => {}), /Refused/);
      assert.strictEqual(runtime.acquired, 0);
    }
    // Advertised, but the live engine no longer proves it: refused AFTER the
    // hold, without inference, and the hold is released.
    {
      const { worker, runtime } = make({ adv: { contextTokens: 16384, maxOutputTokens: 2048 }, live: null });
      const n = engine.seen.length;
      await assert.rejects(() => worker._execute({ id: "j5", type: "chat", model: "koinos-fast", messages: msgs, maxTokens: 2048, contextTokens: 16384 }, () => {}), /did not prove/);
      assert.strictEqual(runtime.acquired, 1);
      assert.strictEqual(runtime.released, 1);
      assert.strictEqual(engine.seen.length, n);
    }
    // Advertised and proven: the engine sees the signed output limit.
    {
      const { worker, runtime } = make({ adv: { contextTokens: 16384, maxOutputTokens: 2048 }, live: { contextTokens: 16384, maxOutputTokens: 2048 } });
      const out = await worker._execute({ id: "j6", type: "chat", model: "koinos-fast", messages: msgs, maxTokens: 2048, contextTokens: 16384 }, () => {});
      assert.strictEqual(engine.seen.at(-1).body.max_tokens, 2048);
      assert.strictEqual(out.usage.completion_tokens, 2048);
      assert.strictEqual(runtime.probes, 1);
      assert.strictEqual(runtime.released, 1);
    }
  } finally {
    closeServer(engine.srv);
  }
});

test("context: a chunk 404 aborts a non-legacy job's engine request and releases the hold; a 401 does not", async () => {
  const waitFor = async (fn, ms, label) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const run = async ({ job, chunkStatus, words }) => {
    const engine = await fakeEngine({ words, everyMs: 25 });
    const posted = { chunks: 0, results: 0 };
    let given = false;
    const srv = http.createServer(async (req, res) => {
      const json = (status, v) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.url.startsWith("/worker/register")) { await readJson(req); return json(200, { ok: true, token: "wt" }); }
      if (req.url.startsWith("/worker/next-job")) {
        if (!given) { given = true; return json(200, { ok: true, job }); }
        return; // hold the poll until the worker hangs up
      }
      if (req.url.startsWith("/worker/chunk")) {
        await readJson(req);
        posted.chunks += 1;
        return chunkStatus === 404 ? json(404, { ok: false, error: "unknown job" }) : json(401, { ok: false, error: "bad token" });
      }
      if (req.url.startsWith("/worker/result")) { await readJson(req); posted.results += 1; return json(200, { ok: true, accepted: true }); }
      json(200, { ok: true });
    });
    const port = await listen(srv);
    const events = [];
    const runtime = ctxRuntime(engine.url, { adv: { contextTokens: 16384, maxOutputTokens: 2048 }, live: { contextTokens: 16384, maxOutputTokens: 2048 } });
    const worker = new Worker({
      schedulerUrl: `http://127.0.0.1:${port}`,
      wallet: { address: "1TestAddr", signHash: async () => "sig" },
      runtime,
      hardware: { ramBytes: 16e9 },
      models: { aliases: () => [{ alias: "koinos-fast", status: "ready", minRamGb: 3 }] },
      onEvent: (e) => events.push(e),
    });
    try {
      await worker.start();
      await waitFor(() => events.some((e) => e.type === "worker:job-failed" || e.type === "worker:job-done"), 30000, "the job to end");
      // The engine learns of a hang-up asynchronously; read its verdict
      // before teardown (closing the server would abort it artificially).
      await waitFor(() => engine.seen[0] && (engine.seen[0].aborted || engine.seen[0].finished), 30000, "the engine request to settle");
      return { engine: { seen: engine.seen.map((s) => ({ ...s })) }, posted: { ...posted }, events, runtime };
    } finally {
      await worker.stop();
      closeServer(srv);
      closeServer(engine.srv);
    }
  };
  const msgs = [{ role: "user", content: "hi" }];
  const big = { id: "j-big", type: "chat", model: "koinos-fast", messages: msgs, maxTokens: 2048, contextTokens: 16384 };

  // Long enough that only the abort can end it early (~10 s of words).
  const gone = await run({ job: big, chunkStatus: 404, words: 400 });
  assert.ok(gone.events.some((e) => e.type === "worker:job-failed" && /no longer holds/.test(e.message)), JSON.stringify(gone.events.map((e) => e.type)));
  assert.strictEqual(gone.engine.seen[0].aborted, true, "the engine request was aborted");
  assert.strictEqual(gone.engine.seen[0].finished, false);
  assert.strictEqual(gone.runtime.released, 1, "the hold was released");
  assert.strictEqual(gone.posted.results, 0, "no result is posted for a forgotten job");

  const unauth = await run({ job: { ...big, id: "j-401" }, chunkStatus: 401, words: 20 });
  assert.ok(unauth.events.some((e) => e.type === "worker:job-done"), "a 401 never aborts");
  assert.strictEqual(unauth.engine.seen[0].aborted, false);
  assert.strictEqual(unauth.posted.results, 1);

  const legacy = await run({ job: { id: "j-legacy", type: "chat", model: "koinos-fast", messages: msgs }, chunkStatus: 404, words: 20 });
  assert.ok(legacy.events.some((e) => e.type === "worker:job-done"), "legacy jobs keep today's behaviour");
  assert.strictEqual(legacy.engine.seen[0].aborted, false);
});
