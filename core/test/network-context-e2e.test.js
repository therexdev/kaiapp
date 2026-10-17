"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { Signer } = require("koilib");

const { Worker } = require("../lib/worker");
const { Gateway } = require("../lib/gateway");
const { legacyConsumeHash, consumeV1Hash } = require("../lib/context-terms");

/*
 * Network context protocol 1, end to end against the REAL production
 * scheduler (therexdev/kai lib/scheduler.js): real kaiapp Workers, the real
 * Gateway._chatNetwork lane selection, consumers signed with the helpers
 * server.js signs with, and fake OpenAI-compatible engines that record what
 * they were asked. Skipped unless KAI_SCHEDULER_DIR points at a kai checkout;
 * nothing here touches a real engine, wallet or service.
 */

const SCHED_DIR = process.env.KAI_SCHEDULER_DIR;
const skip = SCHED_DIR ? false : "set KAI_SCHEDULER_DIR to a therexdev/kai checkout to run against the real scheduler";

const b64 = (sig) => Buffer.from(sig).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

/** A koilib-backed wallet stub: address + signHash, returning exactly what
 *  WalletService.signHash returns (base64 of the recoverable signature). */
function wallet(seed) {
  const signer = Signer.fromSeed(seed);
  return { signer, address: signer.getAddress(), signHash: async (hash) => b64(await signer.signHash(hash)) };
}

/** Fake engine: SSE, a few words, the usage it is told to report. */
async function fakeEngine({ promptTokens = 10 } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      seen.push({ max_tokens: body.max_tokens, messages: body.messages });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "four" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: promptTokens, completion_tokens: 4 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  return { srv, seen, url: `http://127.0.0.1:${port}` };
}

/** Fake SLOW engine: one delta at once, then one every `everyMs` for up to
 *  `maxMs` — far longer than any wait below, so only a real abort ends it
 *  early. Records whether the request was cut off before it finished. */
async function slowEngine({ everyMs = 100, maxMs = 30000 } = {}) {
  const state = { requests: 0, deltas: 0, aborted: 0, finished: 0, max_tokens: [] };
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      state.requests += 1;
      state.max_tokens.push(JSON.parse(raw || "{}").max_tokens);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = () => {
        state.deltas += 1;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `w${state.deltas} ` } }] })}\n\n`);
      };
      send();
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (Date.now() - t0 < maxMs) return send();
        clearInterval(timer);
        state.finished += 1;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: state.deltas } })}\n\n`);
        res.end("data: [DONE]\n\n");
      }, everyMs);
      res.on("close", () => {
        clearInterval(timer);
        if (!res.writableFinished) state.aborted += 1;
      });
    });
  });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  return { srv, state, seen: [], url: `http://127.0.0.1:${port}` };
}

/** Runtime stub with the capacity API. `cap` = the verified opt-in, or null
 *  (legacy); `configured` without `verified` is an unproven opt-in. */
function capacityRuntime(endpoint, { cap = null, verified = true } = {}) {
  const listeners = new Set();
  const live = () => (cap && verified ? { ...cap } : null);
  let held = 0;
  let releases = 0;
  return {
    activeAlias: "koinos-fast",
    advertisedContext: (alias) => (alias === "koinos-fast" ? live() : null),
    verifiedContextFor: async (alias) => (alias === "koinos-fast" ? live() : null),
    acquireFor: async () => {
      held += 1;
      let done = false;
      return {
        endpoint,
        release() {
          if (done) return;
          done = true;
          held -= 1;
          releases += 1;
        },
      };
    },
    holds: () => ({ held, releases }),
    ensure: async () => endpoint,
    servedModelName: () => null,
    onContextChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setCap(next) {
      cap = next;
      for (const fn of [...listeners]) fn();
    },
    status: () => ({ activeAlias: "koinos-fast", loading: false, runtime: { running: true } }),
  };
}

/** One isolated network: a fresh real Scheduler, workers, and a consumer
 *  Gateway whose network object signs like server.js. */
async function network(specs) {
  const { Scheduler } = require(path.join(SCHED_DIR, "lib", "scheduler.js"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-e2e-"));
  const sched = new Scheduler({ dataDir, onEvent: () => {} });
  const port = await sched.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;

  const workers = {};
  for (const [name, spec] of Object.entries(specs)) {
    const engine = spec.slow ? await slowEngine(spec.slow) : await fakeEngine(spec.engine);
    const runtime = capacityRuntime(engine.url, spec);
    const w = wallet(`kaiapp-ctx-e2e-${name}`);
    const events = [];
    const worker = new Worker({
      schedulerUrl: base,
      wallet: w,
      runtime,
      hardware: { ramBytes: 16e9 },
      models: { aliases: () => [{ alias: "koinos-fast", status: "ready", minRamGb: 3 }] },
      onEvent: (e) => events.push(e),
    });
    await worker.start();
    workers[name] = { worker, engine, runtime, events, address: w.address };
  }

  const consumer = wallet("kaiapp-ctx-e2e-consumer");
  const net = {
    status: () => ({ privacyMode: "network", schedulerUrl: base, walletUnlocked: true, koinRehearsal: false }),
    signConsume: async (messages) => {
      const ts = Date.now();
      return { address: consumer.address, ts, signature: await consumer.signHash(legacyConsumeHash(consumer.address, ts, messages)) };
    },
    signConsumeV1: async ({ messages, model, max_tokens }) => {
      const ts = Date.now();
      const signature = await consumer.signHash(consumeV1Hash({ address: consumer.address, ts, model, max_tokens, messages }));
      return { address: consumer.address, ts, signature, signatureVersion: 1 };
    },
  };
  const gw = new Gateway({
    host: "127.0.0.1",
    port: 0,
    runtime: { ensure: async () => { throw new Error("no local model in this test"); } },
    models: { resolveAlias: () => { throw new Error("not local"); }, aliases: () => [] },
    keys: { required: () => false },
    network: net,
  });
  const gwBase = `http://127.0.0.1:${await gw.listen()}`;

  // Count what the gateway sends to /consume (retries would show here).
  const realFetch = globalThis.fetch;
  let consumeCalls = 0;
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith(base) && String(url).endsWith("/consume/chat/completions")) consumeCalls += 1;
    return realFetch(url, opts);
  };

  const chat = async (body) => {
    const r = await realFetch(`${gwBase}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const consumeRaw = async (body) => {
    const r = await realFetch(`${base}/consume/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const fastCaps = async () => {
    const j = await (await realFetch(`${base}/network/models`)).json();
    return (j.models || []).find((m) => m.model === "koinos-fast") || null;
  };
  const close = async () => {
    globalThis.fetch = realFetch;
    for (const { worker, engine } of Object.values(workers)) {
      await worker.stop();
      engine.srv.closeAllConnections?.();
      engine.srv.close();
    }
    await gw.close();
    await sched.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { sched, base, gwBase, workers, consumer, chat, consumeRaw, fastCaps, close, consumeCalls: () => consumeCalls };
}

const user = (content) => [{ role: "user", content }];

/** Stream a chat through the gateway and hang up right after the first
 *  delta, the way a local Stop or a closed tab does. */
function chatThenHangUp(gwBase, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${gwBase}/v1/chat/completions`);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json" }, agent: false },
      (res) => {
        let seen = "";
        res.on("data", (c) => {
          seen += c;
          if (/"content":"w\d+ "/.test(seen)) {
            req.destroy();
            resolve({ status: res.statusCode, seen, ended: false });
          }
        });
        res.on("end", () => resolve({ status: res.statusCode, seen, ended: true }));
      }
    );
    req.on("error", (e) => (req.destroyed ? null : reject(e)));
    req.end(JSON.stringify(body));
  });
}

test("e2e (real scheduler): default workers serve existing callers at the legacy 512 cap", { skip }, async () => {
  const n = await network({ w0: {} });
  try {
    const pricing = await (await fetch(`${n.base}/pricing`)).json();
    assert.strictEqual(pricing.context?.protocol, 1, "the scheduler under test speaks protocol 1");
    const engine = n.workers.w0.engine;

    // The existing 900-token caller (ui/app.js, ui/mascot.js, CLI).
    let r = await n.chat({ model: "koinos-network:koinos-fast", max_tokens: 900, messages: user("hello") });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(engine.seen.at(-1).max_tokens, 512, "served at the legacy cap");
    // Legacy with no max_tokens.
    r = await n.chat({ model: "koinos-network", messages: user("hello again") });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(engine.seen.at(-1).max_tokens, 512);
    // A smaller legacy output is honoured; a huge one without the opt-in
    // is served at the cap, never refused and never upgraded.
    r = await n.chat({ model: "koinos-network", max_tokens: 256, messages: user("short") });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(engine.seen.at(-1).max_tokens, 256);
    r = await n.chat({ model: "koinos-network", max_tokens: 9000, messages: user("long answer please") });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(engine.seen.at(-1).max_tokens, 512);

    // Invalid max_tokens: a local 400 (nothing signed or sent) and, sent
    // straight to the scheduler, a 400 that charges nothing.
    const free0 = n.sched._freeTokensLeft(n.consumer.address, null);
    const calls0 = n.consumeCalls();
    for (const mt of [0, -1, 1.5, "64"]) {
      r = await n.chat({ model: "koinos-network", max_tokens: mt, messages: user("x") });
      assert.strictEqual(r.status, 400, `gateway max_tokens ${mt}`);
    }
    assert.strictEqual(n.consumeCalls(), calls0, "no request left the gateway");
    for (const mt of [0, 1.5, "100"]) {
      const ts = Date.now();
      const messages = user(`direct ${mt}`);
      const signature = b64(await n.consumer.signer.signHash(legacyConsumeHash(n.consumer.address, ts, messages)));
      r = await n.consumeRaw({ address: n.consumer.address, ts, signature, messages, model: "koinos-fast", max_tokens: mt });
      assert.strictEqual(r.status, 400, `scheduler max_tokens ${mt}`);
      assert.strictEqual(r.json.error.code, "invalid_max_tokens");
    }
    assert.strictEqual(n.sched._freeTokensLeft(n.consumer.address, null), free0, "balance/free tier unchanged");

    // Larger terms with only default workers: an honest 503, never a downgrade.
    r = await n.chat({ model: "koinos-network:koinos-fast", max_tokens: 1024, kai_extended_output: true, messages: user("hello") });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.json.error.code, "insufficient_capacity");
    assert.ok(engine.seen.every((s) => s.max_tokens <= 512), "a default worker never received larger terms");
  } finally {
    await n.close();
  }
});

test("e2e (real scheduler): signed v1 terms reach only a verified worker; tamper, replay and capacity refusals", { skip }, async () => {
  const n = await network({
    w0: {},
    w16: { cap: { contextTokens: 16384, maxOutputTokens: 2048 } },
    // Configured but never proven: advertises legacy and must never be chosen.
    wu: { cap: { contextTokens: 32768, maxOutputTokens: 4096 }, verified: false },
  });
  try {
    const { w0, w16, wu } = n.workers;
    await until(async () => (await n.fastCaps())?.ctxTokensMax === 16384, 5000, "16K capacity visible");

    // Explicit v1 at 16K: served by the verified 16K worker with the signed output.
    let r = await n.chat({ model: "koinos-network:koinos-fast", max_tokens: 2048, kai_extended_output: true, messages: user("a".repeat(23984)) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(w16.engine.seen.length, 1);
    assert.strictEqual(w16.engine.seen[0].max_tokens, 2048, "the engine saw the signed max_tokens");
    assert.strictEqual(w0.engine.seen.length + wu.engine.seen.length, 0, "no other worker was handed the 16K job");

    // 32K terms with only 16K workers: 503, no charge, no retry.
    const free0 = n.sched._freeTokensLeft(n.consumer.address, null);
    const calls0 = n.consumeCalls();
    r = await n.chat({ model: "koinos-network:koinos-fast", max_tokens: 2048, kai_extended_output: true, messages: user("a".repeat(4 * 20000)) });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.json.error.code, "insufficient_capacity");
    assert.strictEqual(n.consumeCalls(), calls0 + 1, "exactly one request: never retried smaller or legacy");
    assert.strictEqual(n.sched._freeTokensLeft(n.consumer.address, null), free0, "nothing was charged");

    // Direct v1 consumes for the signature checks.
    const signV1 = async (terms) => {
      const ts = Date.now();
      const t = { model: "koinos-fast", max_tokens: 512, messages: user(`hi ${crypto.randomBytes(4).toString("hex")}`), ...terms };
      const signature = b64(await n.consumer.signer.signHash(consumeV1Hash({ address: n.consumer.address, ts, ...t })));
      return { address: n.consumer.address, ts, signature, signatureVersion: 1, ...t };
    };
    const good = await signV1({ max_tokens: 1024 });
    for (const tamper of [{ max_tokens: 2048 }, { model: "phi-4" }, { messages: user("something else") }]) {
      r = await n.consumeRaw({ ...good, ...tamper });
      assert.strictEqual(r.status, 401, `tampered ${Object.keys(tamper)[0]}`);
    }
    for (const v of [2, "1", 0]) {
      r = await n.consumeRaw({ ...good, signatureVersion: v });
      assert.strictEqual(r.status, 400, `signatureVersion ${JSON.stringify(v)}`);
      assert.strictEqual(r.json.error.code, "unsupported_signature_version");
    }
    r = await n.consumeRaw(good);
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    r = await n.consumeRaw(good);
    assert.strictEqual(r.status, 401, "an exact replay is refused");
    r = await n.consumeRaw({ ...good, signature: `${good.signature} \n` });
    assert.strictEqual(r.status, 401, "a whitespace-appended base64 replay is refused");
    assert.ok(wu.engine.seen.every((s) => s.max_tokens <= 512), "the unverified worker never served larger terms");

    // v1 carries no unsigned billing switch: selfHost is outside the signed
    // tuple, so any non-false selfHost — fresh, or flipped onto a captured
    // request — is a 400 before verification, and nothing is charged.
    const freeSelf = n.sched._freeTokensLeft(n.consumer.address, null);
    const balSelf = n.sched._balanceMicroOf(n.consumer.address);
    const servedSelf = w16.engine.seen.length;
    for (const selfHost of [true, 1, "yes"]) {
      r = await n.consumeRaw({ ...(await signV1({ max_tokens: 1024 })), selfHost });
      assert.strictEqual(r.status, 400, `selfHost ${JSON.stringify(selfHost)}`);
      assert.strictEqual(r.json.error.code, "invalid_terms");
    }
    assert.strictEqual(n.sched._freeTokensLeft(n.consumer.address, null), freeSelf, "selfHost refusals charged nothing");
    assert.strictEqual(n.sched._balanceMicroOf(n.consumer.address), balSelf);
    assert.strictEqual(w16.engine.seen.length, servedSelf, "no selfHost v1 request reached a worker");
    // The gateway half: a v1 request carrying any non-false selfHost is a
    // local 400 — never dropped and sent as a paid public request, so no
    // consume reaches the real scheduler and nothing is charged.
    const callsSelf = n.consumeCalls();
    for (const selfHost of [true, null, 0, "false"]) {
      r = await n.chat({ model: "koinos-network:koinos-fast", max_tokens: 1024, kai_extended_output: true, selfHost, messages: user("hello") });
      assert.strictEqual(r.status, 400, `gateway selfHost ${JSON.stringify(selfHost)}`);
      assert.strictEqual(r.json.error.code, "invalid_terms");
    }
    assert.strictEqual(n.consumeCalls(), callsSelf, "no gateway selfHost request reached /consume");
    assert.strictEqual(n.sched._freeTokensLeft(n.consumer.address, null), freeSelf, "gateway selfHost refusals charged nothing");
    assert.strictEqual(n.sched._balanceMicroOf(n.consumer.address), balSelf);
    assert.strictEqual(w16.engine.seen.length, servedSelf);
    // selfHost false is served on v1 as before.
    r = await n.chat({ model: "koinos-network:koinos-fast", max_tokens: 1024, kai_extended_output: true, selfHost: false, messages: user("hello") });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(w16.engine.seen.at(-1).max_tokens, 1024);

    // The owner clears the opt-in: the worker re-registers at legacy and the
    // network stops offering 16K at once.
    w16.runtime.setCap(null);
    await until(async () => (await n.fastCaps())?.ctxTokensMax === 4096, 5000, "re-registration at legacy");
    r = await n.chat({ model: "koinos-network:koinos-fast", max_tokens: 2048, kai_extended_output: true, messages: user("a".repeat(23984)) });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.json.error.code, "insufficient_capacity");
  } finally {
    await n.close();
  }
});

test("e2e (real scheduler): a legacy job on an opted-in worker is billed at most 4096 prompt tokens", { skip }, async () => {
  const n = await network({ w32: { cap: { contextTokens: 32768, maxOutputTokens: 4096 }, engine: { promptTokens: 12000 } } });
  try {
    const { w32 } = n.workers;
    const free0 = n.sched._freeTokensLeft(n.consumer.address, null);
    // Fits the legacy lane (estimate 3504) but is > 12000 bytes, so only the
    // terms cap — not the byte cap — can bound the reported 12000.
    const r = await n.chat({ model: "koinos-network:koinos-fast", messages: user("a".repeat(14000)) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(w32.engine.seen[0].max_tokens, 512);
    assert.ok(r.json.usage.prompt_tokens <= 4096, `billed prompt tokens ${r.json.usage.prompt_tokens}`);
    assert.strictEqual(free0 - n.sched._freeTokensLeft(n.consumer.address, null), r.json.usage.prompt_tokens + r.json.usage.completion_tokens);
    assert.ok(free0 - n.sched._freeTokensLeft(n.consumer.address, null) <= 4096 + 512);
    assert.strictEqual(n.sched.perf[w32.address]?.clamps ?? 0, 0, "no clamp strike for honest legacy work");
  } finally {
    await n.close();
  }
});

test("e2e (real scheduler): a v1 caller that hangs up after the first delta cancels the job end to end — nothing charged", { skip }, async () => {
  const n = await network({ w16: { cap: { contextTokens: 16384, maxOutputTokens: 2048 }, slow: { everyMs: 100 } } });
  try {
    const { w16 } = n.workers;
    await until(async () => (await n.fastCaps())?.ctxTokensMax === 16384, 5000, "16K capacity visible");
    const addr = n.consumer.address;
    const before = {
      free: n.sched._freeTokensLeft(addr, null),
      balance: n.sched._balanceMicroOf(addr),
      usage: JSON.stringify(n.sched.usage[addr] ?? null),
      consumed: n.sched.consumed[addr] ?? 0,
      receipts: n.sched.receipts.length,
    };

    const r = await chatThenHangUp(n.gwBase, {
      model: "koinos-network:koinos-fast",
      max_tokens: 1024,
      kai_extended_output: true,
      stream: true,
      messages: user("count slowly"),
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.ended, false, "the caller hung up mid-stream");
    assert.deepStrictEqual(w16.engine.state.max_tokens, [1024], "a non-legacy (v1) job reached the engine");

    // Gateway abort -> the scheduler drops the job -> the worker's next chunk
    // is answered 404 -> its engine request is aborted and the hold released.
    await until(() => w16.engine.state.aborted === 1, 10000, "the engine request to be aborted");
    const failed = await until(() => w16.events.find((e) => e.type === "worker:job-failed"), 10000, "the worker to give the job up");
    await until(() => w16.runtime.holds().held === 0, 5000, "the runtime hold to be released");
    assert.match(failed.message, /no longer holds this job/, "aborted by the chunk 404, not by a timeout");
    assert.deepStrictEqual(w16.runtime.holds(), { held: 0, releases: 1 });
    assert.strictEqual(w16.engine.state.finished, 0, "the engine never ran to completion");
    assert.strictEqual(w16.engine.state.requests, 1);

    const jobId = failed.jobId;
    assert.ok(!n.sched.pending.has(jobId), "dropped from the leased jobs");
    assert.ok(!n.sched.queue.some((j) => j.id === jobId), "and never requeued");
    assert.ok(!n.sched._streams.has(jobId) && !n.sched._consumers.has(jobId));
    assert.ok(!n.sched.receipts.some((x) => x.jobId === jobId), "no result, no receipt");
    assert.strictEqual(n.sched.receipts.length, before.receipts);
    assert.strictEqual(w16.worker.stats.receiptsAccepted, 0);
    assert.strictEqual(w16.worker.stats.jobsDone, 0);
    assert.deepStrictEqual(
      {
        free: n.sched._freeTokensLeft(addr, null),
        balance: n.sched._balanceMicroOf(addr),
        usage: JSON.stringify(n.sched.usage[addr] ?? null),
        consumed: n.sched.consumed[addr] ?? 0,
        receipts: n.sched.receipts.length,
      },
      before,
      "nothing charged: free tier, balance and usage unchanged"
    );
  } finally {
    await n.close();
  }
});
