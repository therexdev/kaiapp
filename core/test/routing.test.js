"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const { createCore } = require("../server");

/*
 * §7 routing policy — Local-First overflow. Policy order is privacy →
 * spending → capability: a request for a local model that the machine
 * cannot serve overflows to the network ONLY when the privacy mode allows
 * it, only within spending limits, and always visibly (the answer's model
 * field says "koinos-network"). Local-Only remains provably airtight even
 * when the local model is missing — failing closed, never failing open.
 */

/**
 * Canned network scheduler. The §7 guarantee under test is about CHAT
 * data, so consume hits are counted separately from incidental control
 * traffic (pricing lookups, balance pings) the core makes around config.
 */
function spyScheduler({ ctxTokens } = {}) {
  const paths = [];
  const srv = http.createServer((req, res) => {
    paths.push(req.url);
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url.startsWith("/pricing") && ctxTokens) {
        return res.end(JSON.stringify({ ok: true, models: { "koinos-fast": { usdPerMInputTokens: 0.1, usdPerMOutputTokens: 0.4, ctxTokens } } }));
      }
      if (!req.url.startsWith("/consume/")) return res.end("{}");
      res.end(
        JSON.stringify({
          object: "chat.completion",
          model: "koinos-network",
          choices: [{ index: 0, message: { role: "assistant", content: "from-network" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        })
      );
    });
  });
  return {
    srv,
    hits: () => paths.filter((p) => p.startsWith("/consume/")).length,
    listen: () => new Promise((r) => srv.listen(0, "127.0.0.1", function () { r(this.address().port); })),
  };
}

async function bootCore(dir, events) {
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const core = await createCore({
    dataDir: dir,
    port: 0,
    llamaBin: path.join(__dirname, "fixtures", "fake-llama-server"),
    onEvent: events ? (e) => events.push(e) : () => {},
  });
  const base = `http://127.0.0.1:${await core.start()}`;
  const post = async (p, b, headers) => {
    const r = await fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers || {}) },
      body: JSON.stringify(b || {}),
    });
    return { status: r.status, json: await r.json().catch(() => null), raw: r };
  };
  return { core, base, post };
}

test("local-first: capable request stays local; capability miss overflows to the network, visibly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-route-"));
  const spy = spyScheduler();
  const spyPort = await spy.listen();
  const events = [];
  const { core, post } = await bootCore(dir, events);
  try {
    await post("/core/earn/wallet", { password: "correct horse" });
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${spyPort}` });
    await post("/core/network/config", { privacyMode: "local-first" });

    // Locally servable alias (the fixture weights register as "dev-tiny"):
    // the network must not be involved at all.
    const local = await post("/v1/chat/completions", { model: "dev-tiny", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(local.status, 200);
    assert.strictEqual(spy.hits(), 0, "local-capable request must not touch the scheduler");

    // Alias with no local model: §7 capability miss → overflow.
    const over = await post("/v1/chat/completions", { model: "koinos-ultra", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(over.status, 200);
    assert.strictEqual(over.json.choices[0].message.content, "from-network");
    assert.strictEqual(over.json.model, "koinos-network", "overflowed answer must disclose it left the machine");
    assert.strictEqual(spy.hits(), 1);
    const ev = events.find((e) => e.type === "gateway:overflow");
    assert.ok(ev && ev.from === "koinos-ultra" && ev.reason, "overflow emits an event naming the alias and reason");
  } finally {
    await core.stop();
    spy.srv.close();
  }
});

test("local-only: a capability miss fails closed — no overflow, zero bytes to the scheduler", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-route-"));
  const spy = spyScheduler();
  const spyPort = await spy.listen();
  const { core, post } = await bootCore(dir);
  try {
    await post("/core/earn/wallet", { password: "correct horse" });
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${spyPort}` });
    await post("/core/network/config", { privacyMode: "local-only" });

    const r = await post("/v1/chat/completions", { model: "koinos-ultra", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(spy.hits(), 0, "local-only must never fail open to the network");
  } finally {
    await core.stop();
    spy.srv.close();
  }
});

test("local-first: overflow respects §8 spending — exhausted key budget blocks with a two-sided error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-route-"));
  const spy = spyScheduler();
  const spyPort = await spy.listen();
  const { core, post } = await bootCore(dir);
  try {
    await post("/core/earn/wallet", { password: "correct horse" });
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${spyPort}` });
    await post("/core/network/config", { privacyMode: "local-first" });

    const created = await post("/core/keys", { label: "budgeted" });
    const key = created.json.key || created.json.token || created.json.secret;
    const id = created.json.id;
    assert.ok(key && id, `key create reply: ${JSON.stringify(created.json)}`);
    await post(`/core/keys/${id}/budget`, { budgetUsdMonthly: 0 });

    const r = await post(
      "/v1/chat/completions",
      { model: "koinos-ultra", messages: [{ role: "user", content: "hi" }] },
      { authorization: `Bearer ${key}` }
    );
    assert.strictEqual(r.status, 429);
    assert.match(r.json.error.message, /unavailable/, "error names the local miss");
    assert.match(r.json.error.message, /budget/, "error names the spending block");
    assert.strictEqual(spy.hits(), 0, "a blocked overflow buys nothing");
  } finally {
    await core.stop();
    spy.srv.close();
  }
});

test("§7 context: oversized prompts refuse cleanly, and overflow only when the network class fits", async () => {
  const big = "x".repeat(30000); // ~7,504 tokens: over a 4,096 ctx, under 8,192

  // Local-only: clean refusal naming the estimate — never a runtime crash,
  // never a byte to the scheduler.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-"));
    const spy = spyScheduler();
    const spyPort = await spy.listen();
    const { core, post } = await bootCore(dir);
    try {
      await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${spyPort}` });
      await post("/core/network/config", { privacyMode: "local-only" });
      const r = await post("/v1/chat/completions", { model: "dev-tiny", messages: [{ role: "user", content: big }] });
      assert.strictEqual(r.status, 400);
      assert.match(r.json.error.message, /larger than the local model/);
      assert.strictEqual(spy.hits(), 0);
    } finally {
      await core.stop();
      spy.srv.close();
    }
  }

  // Local-first, network advertises the SAME class size: fits nowhere —
  // refuse with both numbers instead of billing a remote failure.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-"));
    const spy = spyScheduler(); // default pricing -> 4096 ctx
    const spyPort = await spy.listen();
    const { core, post } = await bootCore(dir);
    try {
      await post("/core/earn/wallet", { password: "correct horse" });
      await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${spyPort}` });
      await post("/core/network/config", { privacyMode: "local-first" });
      const r = await post("/v1/chat/completions", { model: "dev-tiny", messages: [{ role: "user", content: big }] });
      assert.strictEqual(r.status, 400);
      assert.match(r.json.error.message, /network's 4096-token class/);
      assert.strictEqual(spy.hits(), 0, "a prompt that fits nowhere must not be billed anywhere");
    } finally {
      await core.stop();
      spy.srv.close();
    }
  }

  // Local-first, network advertises a BIGGER class: genuine capability
  // difference -> overflow and serve.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-"));
    const spy = spyScheduler({ ctxTokens: 8192 });
    const spyPort = await spy.listen();
    const events = [];
    const { core, post } = await bootCore(dir, events);
    try {
      await post("/core/earn/wallet", { password: "correct horse" });
      await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${spyPort}` });
      await post("/core/network/config", { privacyMode: "local-first" });
      const r = await post("/v1/chat/completions", { model: "dev-tiny", messages: [{ role: "user", content: big }] });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.model, "koinos-network");
      assert.strictEqual(spy.hits(), 1);
      const ev = events.find((e) => e.type === "gateway:overflow");
      assert.match(ev.reason, /exceeds the 4096-token local context/);
    } finally {
      await core.stop();
      spy.srv.close();
    }
  }
});

test("local-first: locked wallet blocks overflow with a two-sided error; streaming overflow shims SSE", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-route-"));
  const spy = spyScheduler();
  const spyPort = await spy.listen();
  const { core, base, post } = await bootCore(dir);
  try {
    // No wallet yet: §23 identity is unavailable, so overflow must stop
    // with an error that names both the local miss and the wallet fix.
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${spyPort}` });
    await post("/core/network/config", { privacyMode: "local-first" });
    const blocked = await post("/v1/chat/completions", { model: "koinos-ultra", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(blocked.status, 400);
    assert.match(blocked.json.error.message, /unavailable/);
    assert.match(blocked.json.error.message, /earning account/);
    assert.strictEqual(spy.hits(), 0);

    // With a wallet, a STREAMING request overflows through the SSE shim.
    await post("/core/earn/wallet", { password: "correct horse" });
    const sr = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "koinos-ultra", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.strictEqual(sr.headers.get("content-type"), "text/event-stream");
    const sse = await sr.text();
    assert.ok(sse.includes("from-network"), "streamed content arrives");
    assert.ok(sse.includes('"koinos-network"'), "stream chunks disclose the network route");
    assert.ok(sse.includes("data: [DONE]"), "stream terminates properly");
    assert.strictEqual(spy.hits(), 1);
  } finally {
    await core.stop();
    spy.srv.close();
  }
});

test("overflow failure tells both truths: the local reason AND the network reason", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-route-"));
  // A scheduler with no online providers — the exact field situation.
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!req.url.startsWith("/consume/")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("{}");
      }
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: 'No providers are serving "koinos-fast" right now', type: "server_error" } }));
    });
  });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", function () { r(this.address().port); }));
  const { core, post } = await bootCore(dir);
  try {
    await post("/core/earn/wallet", { password: "correct horse" });
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${port}` });
    await post("/core/network/config", { privacyMode: "local-first" });

    const r = await post("/v1/chat/completions", { model: "koinos-ultra", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(r.status, 503);
    // Relaying the scheduler's error raw dropped the local half (field
    // finding): the user saw 'no providers' with no hint their own model
    // failed. Both truths, always.
    assert.match(r.json.error.message, /Local model "koinos-ultra" is unavailable/);
    assert.match(r.json.error.message, /No providers are serving/);
  } finally {
    await core.stop();
    srv.close();
  }
});

test("multi-class network: overflow asks for the exact missing model; explicit network picks route auto", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-route-"));
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url.startsWith("/consume/")) {
        const b = JSON.parse(raw);
        seen.push(b.model);
        return res.end(
          JSON.stringify({
            object: "chat.completion",
            model: "koinos-network",
            servedModel: b.model === "auto" ? "gemma3-12b" : b.model,
            choices: [{ index: 0, message: { role: "assistant", content: "net" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          })
        );
      }
      res.end("{}");
    });
  });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", function () { r(this.address().port); }));
  const { core, post } = await bootCore(dir);
  try {
    await post("/core/earn/wallet", { password: "correct horse" });
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${port}` });
    await post("/core/network/config", { privacyMode: "local-first" });

    // §7 overflow of a specific missing model asks the network for THAT model.
    const over = await post("/v1/chat/completions", { model: "koinos-ultra", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(over.status, 200);
    assert.strictEqual(seen[0], "koinos-ultra", "overflow carries the exact requested class");

    // An explicit network pick routes "auto" and relays which class served.
    const auto = await post("/v1/chat/completions", { model: "koinos-network", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(auto.status, 200);
    assert.strictEqual(seen[1], "auto", "network picker requests auto routing");
    assert.strictEqual(auto.json.servedModel, "gemma3-12b", "the serving class is disclosed");
  } finally {
    await core.stop();
    srv.close();
  }
});

test("live network streaming: scheduler SSE relays through the gateway as it arrives, class pinned", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-route-"));
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!req.url.startsWith("/consume/")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("{}");
      }
      const b = JSON.parse(raw);
      seen.push({ model: b.model, stream: b.stream });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ accepted: true, model: b.model })}\n\n`);
      res.write(`data: ${JSON.stringify({ delta: "streamed " })}\n\n`);
      res.write(`data: ${JSON.stringify({ delta: "words" })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true, servedModel: b.model, usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", function () { r(this.address().port); }));
  const { core, base, post } = await bootCore(dir);
  try {
    await post("/core/earn/wallet", { password: "correct horse" });
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${port}` });
    await post("/core/network/config", { privacyMode: "local-first" });

    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "koinos-network:gemma3-12b", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.ok((resp.headers.get("content-type") || "").includes("text/event-stream"), "gateway answers SSE");
    const body = await resp.text();
    assert.match(body, /"content":"streamed "/, "first delta relayed");
    assert.match(body, /"content":"words"/, "second delta relayed");
    assert.match(body, /"servedModel":"gemma3-12b"/, "serving class disclosed in chunks");
    assert.ok(seen.every((s) => s.model === "gemma3-12b" && s.stream === true), "explicit class + stream reach the scheduler");
  } finally {
    await core.stop();
    srv.close();
  }
});

/*
 * Network context protocol 1 — client lane selection (docs/NETWORK_CONTEXT_
 * PROTOCOL.md §13/§16). Larger OUTPUT is an explicit caller opt-in
 * (kai_extended_output); a longer PROMPT on an explicit network request may
 * negotiate signed larger context. Existing callers sending max_tokens 900
 * stay on the legacy lane, a v1 failure is never retried smaller or legacy,
 * and automatic overflow never upgrades to v1.
 */

const { Signer } = require("koilib");
const { consumeV1Hash, legacyConsumeHash } = require("../lib/context-terms");

function ctxScheduler({ context = true, status = 200, pricing = null } = {}) {
  const consumes = [];
  const paths = [];
  const srv = http.createServer((req, res) => {
    paths.push(req.url);
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/pricing") && pricing) return res.end(JSON.stringify(pricing));
      if (req.url.startsWith("/pricing")) {
        const ceil = (n) => (context ? { maxCtxTokens: n } : {});
        return res.end(JSON.stringify({
          ok: true,
          models: {
            "koinos-fast": { usdPerMInputTokens: 0.1, usdPerMOutputTokens: 0.4, ctxTokens: 4096, ...ceil(32768) },
            "phi-4": { usdPerMInputTokens: 0.5, usdPerMOutputTokens: 2, ctxTokens: 4096, ...ceil(16384) },
          },
          ...(context ? { context: { protocol: 1, tiers: [4096, 16384, 32768], legacyCtxTokens: 4096, legacyMaxTokens: 512, maxOutputTokens: 4096 } } : {}),
        }));
      }
      if (!req.url.startsWith("/consume/")) return res.end("{}");
      const b = JSON.parse(raw);
      consumes.push({ body: b, keys: Object.keys(b) });
      const st = typeof status === "function" ? status(b) : status;
      if (st !== 200) {
        res.statusCode = st;
        return res.end(JSON.stringify({ error: { message: st === 503 ? "No provider can serve these terms right now" : "bad request signature", type: st === 503 ? "server_error" : "invalid_request_error", code: st === 503 ? "insufficient_capacity" : undefined } }));
      }
      res.end(JSON.stringify({
        object: "chat.completion", model: "koinos-network", servedModel: "koinos-fast",
        choices: [{ index: 0, message: { role: "assistant", content: "from-network" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }));
    });
  });
  return {
    srv,
    consumes,
    pricingHits: () => paths.filter((p) => p.startsWith("/pricing")).length,
    listen: () => new Promise((r) => srv.listen(0, "127.0.0.1", function () { r(this.address().port); })),
  };
}

const recovers = (hash, b) => Signer.recoverAddress(hash, Buffer.from(String(b.signature), "base64")) === b.address;
const isLegacy = (b) => b.signatureVersion === undefined && recovers(legacyConsumeHash(b.address, b.ts, b.messages), b);
const isV1 = (b) => b.signatureVersion === 1 && recovers(consumeV1Hash({ address: b.address, ts: b.ts, model: b.model, max_tokens: b.max_tokens, messages: b.messages }), b);

test("context lanes: explicit network requests pick legacy or signed v1 exactly as §16 says", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-lanes-"));
  const spy = ctxScheduler();
  const spyPort = await spy.listen();
  const { core, post } = await bootCore(dir);
  const chat = (extra) => post("/v1/chat/completions", { model: "koinos-network:koinos-fast", messages: [{ role: "user", content: "hello" }], ...extra });
  const last = () => spy.consumes.at(-1);
  try {
    await post("/core/earn/wallet", { password: "correct horse" });
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${spyPort}` });
    await post("/core/network/config", { privacyMode: "local-first" });

    // Short prompt, no max_tokens: today's exact legacy body.
    let r = await chat({});
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(last().keys, ["messages", "model", "stream", "address", "ts", "signature"]);
    assert.ok(isLegacy(last().body), "legacy signature, unchanged");

    // The existing 900-token caller (ui/app.js, ui/mascot.js, the CLI):
    // legacy lane, max_tokens forwarded for the scheduler to serve at 512.
    for (const mt of [256, 900, 1024, 1200, 1500, 4096, 9000]) {
      r = await chat({ max_tokens: mt });
      assert.strictEqual(r.status, 200, `max_tokens ${mt}`);
      assert.ok(isLegacy(last().body), `max_tokens ${mt} stays legacy without the opt-in`);
      assert.strictEqual(last().body.max_tokens, mt);
    }
    r = await chat({ max_tokens: null });
    assert.strictEqual(r.status, 200);
    assert.ok(!("max_tokens" in last().body), "null is absent");

    // Extended opt-in: v1 with the caller's exact output, signed.
    r = await chat({ max_tokens: 1024, kai_extended_output: true });
    assert.strictEqual(r.status, 200);
    assert.ok(isV1(last().body), "v1 signature covers model + max_tokens");
    assert.strictEqual(last().body.max_tokens, 1024);
    assert.strictEqual(last().body.model, "koinos-fast");
    assert.ok(!("kai_extended_output" in last().body), "the opt-in flag never leaves the machine");
    // No unsigned billing switch ever rides v1: the body is exactly the
    // signed terms plus the signature, whatever else the caller sent.
    r = await chat({ max_tokens: 1024, kai_extended_output: true, forWorker: "someone" });
    assert.strictEqual(r.status, 200);
    assert.ok(isV1(last().body));
    assert.deepStrictEqual(last().keys, ["messages", "model", "max_tokens", "stream", "address", "ts", "signature", "signatureVersion"]);
    // §13 selfHost on v1: refused locally — never dropped for a paid public
    // request. Anything but absent/false is a 400 with nothing signed or sent.
    const net = core.gateway.network;
    const realSignV1 = net.signConsumeV1;
    let v1Signs = 0;
    net.signConsumeV1 = async (...a) => {
      v1Signs += 1;
      return realSignV1.apply(net, a);
    };
    const sentSelf = spy.consumes.length;
    for (const selfHost of [true, null, 0, "false"]) {
      r = await chat({ max_tokens: 1024, kai_extended_output: true, selfHost });
      assert.strictEqual(r.status, 400, `selfHost ${JSON.stringify(selfHost)}`);
      assert.strictEqual(r.json.error.type, "invalid_request_error");
      assert.strictEqual(r.json.error.code, "invalid_terms", `selfHost ${JSON.stringify(selfHost)}`);
      // A long prompt negotiates v1 too: the same refusal.
      r = await post("/v1/chat/completions", { model: "koinos-network:koinos-fast", selfHost, messages: [{ role: "user", content: "a".repeat(14321) }] });
      assert.strictEqual(r.json.error.code, "invalid_terms", `long prompt, selfHost ${JSON.stringify(selfHost)}`);
    }
    assert.strictEqual(v1Signs, 0, "a refused selfHost request is never signed");
    assert.strictEqual(spy.consumes.length, sentSelf, "and never reaches /consume");
    // Absent or false: served on v1 as before.
    for (const extra of [{}, { selfHost: false }]) {
      r = await chat({ max_tokens: 1024, kai_extended_output: true, ...extra });
      assert.strictEqual(r.status, 200, JSON.stringify(extra));
      assert.ok(isV1(last().body));
      assert.ok(!("selfHost" in last().body));
    }
    assert.strictEqual(v1Signs, 2);
    net.signConsumeV1 = realSignV1;
    // The legacy lane is unchanged: a short request with selfHost is served
    // there exactly as today.
    r = await chat({ selfHost: true });
    assert.strictEqual(r.status, 200);
    assert.ok(isLegacy(last().body));
    // The opt-in with no larger output is just a legacy request.
    r = await chat({ max_tokens: 400, kai_extended_output: true });
    assert.ok(isLegacy(last().body));

    // A long prompt negotiates signed context at the legacy output cap.
    r = await post("/v1/chat/completions", { model: "koinos-network:koinos-fast", messages: [{ role: "user", content: "a".repeat(14321) }] });
    assert.strictEqual(r.status, 200);
    assert.ok(isV1(last().body));
    assert.strictEqual(last().body.max_tokens, 512);
    // ...but CJK text that fits the legacy estimate stays legacy.
    r = await post("/v1/chat/completions", { model: "koinos-network:koinos-fast", messages: [{ role: "user", content: "你".repeat(4000) }] });
    assert.ok(isLegacy(last().body));
    // "auto" uses the largest class window.
    r = await post("/v1/chat/completions", { model: "koinos-network", max_tokens: 2048, kai_extended_output: true, messages: [{ role: "user", content: "a".repeat(23984) }] });
    assert.strictEqual(r.status, 200);
    assert.ok(isV1(last().body));
    assert.deepStrictEqual([last().body.model, last().body.max_tokens], ["auto", 2048]);

    // Local 400s: nothing is signed, nothing is sent.
    const before = spy.consumes.length;
    for (const [extra, code] of [
      [{ max_tokens: 0 }, "invalid_max_tokens"],
      [{ max_tokens: -1 }, "invalid_max_tokens"],
      [{ max_tokens: 1.5 }, "invalid_max_tokens"],
      [{ max_tokens: "64" }, "invalid_max_tokens"],
      [{ max_tokens: 9000, kai_extended_output: true }, "invalid_max_tokens"],
    ]) {
      r = await chat(extra);
      assert.strictEqual(r.status, 400, JSON.stringify(extra));
      assert.strictEqual(r.json.error.code, code, JSON.stringify(extra));
    }
    // Too long for the class even with signed context (phi-4: 16384).
    r = await post("/v1/chat/completions", { model: "koinos-network:phi-4", max_tokens: 4096, kai_extended_output: true, messages: [{ role: "user", content: "a".repeat(4 * 12500) }] });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error.code, "context_length_exceeded");
    // Tool turns or extra message keys never ride the v1 lane.
    r = await post("/v1/chat/completions", {
      model: "koinos-network:koinos-fast", max_tokens: 1024, kai_extended_output: true,
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: null, tool_calls: [{ id: "1" }] }, { role: "tool", content: "42", tool_call_id: "1" }],
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error.code, "invalid_terms");
    r = await post("/v1/chat/completions", { model: "koinos-network:koinos-fast", max_tokens: 1024, kai_extended_output: true, messages: [{ role: "user", content: "hi", name: "x" }] });
    assert.strictEqual(r.json.error.code, "invalid_terms");
    // An unknown class keeps the legacy lane; extended output is refused.
    r = await chat({ model: "koinos-network:custom-mine", max_tokens: 1024, kai_extended_output: true });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error.code, "extended_output_unavailable");
    // Prototype names are never a class: no window, so never v1.
    for (const model of ["koinos-network:constructor", "koinos-network:__proto__", "koinos-network:hasOwnProperty"]) {
      r = await chat({ model, max_tokens: 1024, kai_extended_output: true });
      assert.strictEqual(r.json.error.code, "extended_output_unavailable", model);
      r = await post("/v1/chat/completions", { model, messages: [{ role: "user", content: "a".repeat(14321) }] });
      assert.strictEqual(r.status, 400, `${model}: today's refusal, never signed context`);
    }
    assert.strictEqual(spy.consumes.length, before, "no refused request was signed or sent");
    r = await chat({ model: "koinos-network:custom-mine", max_tokens: 1024 });
    assert.ok(isLegacy(last().body));
  } finally {
    await core.stop();
    spy.srv.close();
  }
});

test("context lanes: an extended request is never downgraded — a 503 fails without retry, a 401 drops the /pricing cache", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-lanes-503-"));
  let mode = 503;
  const spy = ctxScheduler({ status: (b) => (b.signatureVersion === 1 ? mode : 200) });
  const spyPort = await spy.listen();
  const { core, post } = await bootCore(dir);
  try {
    await post("/core/earn/wallet", { password: "correct horse" });
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${spyPort}` });
    await post("/core/network/config", { privacyMode: "network" });
    const req = { model: "koinos-network:koinos-fast", max_tokens: 2048, kai_extended_output: true, messages: [{ role: "user", content: "a".repeat(4 * 20000) }] };
    let r = await post("/v1/chat/completions", req);
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.json.error.code, "insufficient_capacity");
    assert.strictEqual(spy.consumes.length, 1, "exactly one request: no smaller or legacy retry");
    assert.ok(isV1(spy.consumes[0].body));
    // Streaming callers get the same honest failure.
    r = await post("/v1/chat/completions", { ...req, stream: true });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(spy.consumes.length, 2);

    const pricing = spy.pricingHits();
    mode = 401;
    r = await post("/v1/chat/completions", req);
    assert.strictEqual(r.status, 401);
    assert.strictEqual(spy.consumes.length, 3, "a 401 is not retried either");
    mode = 200;
    r = await post("/v1/chat/completions", req);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(spy.pricingHits(), pricing + 1, "the 401 cleared the cached /pricing");
  } finally {
    await core.stop();
    spy.srv.close();
  }
});

test("context lanes: a metered API key must cover the v1 worst case before anything is signed; legacy keeps the zero gate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-lanes-budget-"));
  const spy = ctxScheduler();
  const spyPort = await spy.listen();
  const { core, post } = await bootCore(dir);
  try {
    await post("/core/earn/wallet", { password: "correct horse" });
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${spyPort}` });
    await post("/core/network/config", { privacyMode: "local-first" });
    const created = await post("/core/keys", { label: "metered" });
    const key = created.json.key || created.json.token || created.json.secret;
    const id = created.json.id;
    assert.ok(key && id, `key create reply: ${JSON.stringify(created.json)}`);
    const auth = { authorization: `Bearer ${key}` };
    const chat = (extra) => post("/v1/chat/completions", { model: "koinos-network:koinos-fast", messages: [{ role: "user", content: "hello" }], ...extra }, auth);
    const net = core.gateway.network;
    const realSignV1 = net.signConsumeV1;
    let v1Signs = 0;
    net.signConsumeV1 = async (...a) => {
      v1Signs += 1;
      return realSignV1.apply(net, a);
    };

    // koinos-fast at $0.10/$0.40 per M. Worst case for max_tokens 4096 on
    // "hello": prompt min(24 + 36 bytes, 16384) = 60, so
    // ceil(60*0.1 + 4096*0.4) = 1645 µ$ — above a $0.001 budget.
    await post(`/core/keys/${id}/budget`, { budgetUsdMonthly: 0.001 }, auth);
    let r = await chat({ max_tokens: 4096, kai_extended_output: true });
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.json.error.type, "insufficient_quota");
    assert.strictEqual(r.json.error.code, "worst_case_unaffordable");
    // A long prompt negotiating v1 at the legacy output cap: the window is
    // smaller than its byte cap, min(24 + 40031, 16384) = 16384, so
    // ceil(16384*0.1 + 512*0.4) = 1844 µ$ — refused too.
    r = await post("/v1/chat/completions", { model: "koinos-network:koinos-fast", messages: [{ role: "user", content: "a".repeat(40000) }] }, auth);
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.json.error.code, "worst_case_unaffordable");
    assert.strictEqual(v1Signs, 0, "nothing was signed");
    assert.strictEqual(spy.consumes.length, 0, "nothing was sent");

    // Within budget (worst case ceil(60*0.1 + 1024*0.4) = 416 µ$): served on v1.
    r = await chat({ max_tokens: 1024, kai_extended_output: true });
    assert.strictEqual(r.status, 200);
    assert.ok(isV1(spy.consumes.at(-1).body));
    assert.strictEqual(v1Signs, 1);
    // Legacy is unchanged: any remaining budget passes, whatever max_tokens says.
    r = await chat({ max_tokens: 4096 });
    assert.strictEqual(r.status, 200);
    assert.ok(isLegacy(spy.consumes.at(-1).body));
    // An exhausted budget still stops both lanes with today's message.
    await post(`/core/keys/${id}/budget`, { budgetUsdMonthly: 0 }, auth);
    for (const extra of [{}, { max_tokens: 1024, kai_extended_output: true }]) {
      r = await chat(extra);
      assert.strictEqual(r.status, 429);
      assert.match(r.json.error.message, /budget is exhausted/);
    }
    assert.strictEqual(spy.consumes.length, 2);
    net.signConsumeV1 = realSignV1;
  } finally {
    await core.stop();
    spy.srv.close();
  }
});

test("context lanes: a scheduler without protocol 1 only ever gets legacy requests", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-lanes-old-"));
  const spy = ctxScheduler({ context: false });
  const spyPort = await spy.listen();
  const { core, post } = await bootCore(dir);
  try {
    await post("/core/earn/wallet", { password: "correct horse" });
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${spyPort}` });
    await post("/core/network/config", { privacyMode: "local-first" });
    let r = await post("/v1/chat/completions", { model: "koinos-network", max_tokens: 900, messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(r.status, 200);
    assert.ok(isLegacy(spy.consumes.at(-1).body));
    r = await post("/v1/chat/completions", { model: "koinos-network", max_tokens: 1024, kai_extended_output: true, messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error.code, "extended_output_unavailable");
    r = await post("/v1/chat/completions", { model: "koinos-network", messages: [{ role: "user", content: "a".repeat(14321) }] });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error.message, /larger than the network's 4096-token class/, "today's refusal, unchanged");
    assert.strictEqual(spy.consumes.length, 1);
  } finally {
    await core.stop();
    spy.srv.close();
  }
});

test("context lanes: Local-First overflow never upgrades to v1 — nothing new leaves the machine", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-lanes-overflow-"));
  const spy = ctxScheduler();
  const spyPort = await spy.listen();
  const { core, post } = await bootCore(dir);
  try {
    await post("/core/earn/wallet", { password: "correct horse" });
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${spyPort}` });
    await post("/core/network/config", { privacyMode: "local-first" });
    // Non-opted-in local alias, prompt ~6000 tokens: refused as today.
    let r = await post("/v1/chat/completions", { model: "dev-tiny", messages: [{ role: "user", content: "a".repeat(23984) }] });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error.message, /larger than the local model's 4096-token context and the network's 4096-token class/);
    // Capability miss with the same prompt: today's refusal, no v1.
    r = await post("/v1/chat/completions", { model: "koinos-ultra", messages: [{ role: "user", content: "a".repeat(23984) }] });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error.message, /unavailable.*larger than the network's 4096-token class/s);
    // Extended output never rides an automatic overflow.
    r = await post("/v1/chat/completions", { model: "koinos-ultra", max_tokens: 2048, kai_extended_output: true, messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error.code, "extended_output_unavailable");
    assert.strictEqual(spy.consumes.length, 0, "no signing, no fetch");
    // A short overflow keeps today's legacy lane (max_tokens forwarded).
    r = await post("/v1/chat/completions", { model: "koinos-ultra", max_tokens: 900, messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(r.status, 200);
    assert.ok(isLegacy(spy.consumes.at(-1).body));
    assert.strictEqual(spy.consumes.at(-1).body.model, "koinos-ultra");
    // The opt-in flag never reaches the local engine either.
    r = await post("/v1/chat/completions", { model: "dev-tiny", kai_extended_output: true, max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(spy.consumes.length, 1);
  } finally {
    await core.stop();
    spy.srv.close();
  }
});

test("context lanes: v1 is text-only — image parts, extra part keys and nested tool fields never ride it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-lanes-text-"));
  const spy = ctxScheduler();
  const spyPort = await spy.listen();
  const { core, post } = await bootCore(dir);
  const send = (messages, extra) => post("/v1/chat/completions", { model: "koinos-network:koinos-fast", messages, ...extra });
  const long = "a".repeat(14321); // legacy 3585: past the legacy gate, would negotiate v1
  try {
    await post("/core/earn/wallet", { password: "correct horse" });
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${spyPort}` });
    await post("/core/network/config", { privacyMode: "local-first" });
    const shapes = {
      "extra part key": (text) => [{ role: "user", content: [{ type: "text", text, cache_control: { type: "ephemeral" } }] }],
      "nested tool field": (text) => [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text, tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }] }] },
      ],
    };
    for (const [label, shape] of Object.entries(shapes)) {
      // Fits legacy: today's legacy lane with the caller's messages as sent.
      let r = await send(shape("short"));
      assert.strictEqual(r.status, 200, label);
      assert.ok(isLegacy(spy.consumes.at(-1).body), `${label}: legacy lane as today`);
      assert.deepStrictEqual(spy.consumes.at(-1).body.messages, shape("short"));
      // Past the legacy gate, or extended output: local 400, nothing signed or sent.
      const before = spy.consumes.length;
      r = await send(shape(long));
      assert.strictEqual(r.status, 400, label);
      assert.strictEqual(r.json.error.code, "invalid_terms", label);
      r = await send(shape("short"), { max_tokens: 1024, kai_extended_output: true });
      assert.strictEqual(r.status, 400, label);
      assert.strictEqual(r.json.error.code, "invalid_terms", label);
      assert.strictEqual(spy.consumes.length, before, `${label}: never signed or sent`);
    }
    // Image parts: every network request with one is refused locally, as today.
    const before = spy.consumes.length;
    const img = (text) => [{ role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }];
    for (const [messages, extra] of [[img("what is this?"), {}], [img(long), {}], [img("what is this?"), { max_tokens: 1024, kai_extended_output: true }]]) {
      const r = await send(messages, extra);
      assert.strictEqual(r.status, 400);
      assert.match(r.json.error.message, /can't see images/);
    }
    assert.strictEqual(spy.consumes.length, before, "an image request is never signed or sent");
  } finally {
    await core.stop();
    spy.srv.close();
  }

  // The lane function itself never puts an image part on v1: the legacy lane
  // when it fits (where today's image refusal then applies), else invalid_terms.
  const { Gateway } = require("../lib/gateway");
  const gw = new Gateway({ runtime: {}, models: {}, keys: { required: () => false } });
  const rates = { ctxTokens: 4096, maxCtxTokens: 32768 };
  const proto = { protocol: 1, maxTier: 32768, maxOutputTokens: 4096 };
  const img = (text) => [{ role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url: "data:," } }] }];
  const lane = (req) => gw._networkTerms({ mt: null, extended: false, overflow: false, rates, proto, ...req });
  assert.deepStrictEqual(lane({ messages: img("hi") }), { lane: "legacy" });
  assert.strictEqual(lane({ messages: img(long) }).code, "invalid_terms");
  assert.strictEqual(lane({ messages: img("hi"), mt: 1024, extended: true }).code, "invalid_terms");
});

test("context lanes: malformed or oversized /pricing never authorises more than the contract tiers and ceilings", async () => {
  const { Gateway } = require("../lib/gateway");
  const gw = new Gateway({ runtime: {}, models: {}, keys: { required: () => false } });
  const url = "http://pricing.test.invalid";
  const good = { protocol: 1, tiers: [4096, 16384, 32768], legacyCtxTokens: 4096, legacyMaxTokens: 512, maxOutputTokens: 4096 };
  const cls = (maxCtxTokens) => ({ "koinos-fast": { usdPerMInputTokens: 0.1, usdPerMOutputTokens: 0.4, ctxTokens: 4096, maxCtxTokens } });
  const neg = async (context, models = cls(32768)) => {
    gw._rates = { url, at: Date.now(), models, context }; // a cached /pricing reply
    return { proto: await gw._networkContext(url), rates: await gw._networkRates(url, "koinos-fast"), auto: await gw._networkRates(url, "auto") };
  };
  const lane = async (context, models, req) => {
    const { proto, rates } = await neg(context, models);
    return gw._networkTerms({ mt: null, extended: false, overflow: false, ...req, rates, proto });
  };
  const user = (content) => [{ role: "user", content }];

  // Tiers: only the contract's count; none left means no protocol at all.
  assert.deepStrictEqual((await neg({ ...good, tiers: [4096, 65536, "x"] })).proto, { protocol: 1, maxTier: 4096, maxOutputTokens: 4096 });
  for (const tiers of [[65536], ["x", "16384", 1e9, -1, null], []]) {
    assert.strictEqual((await neg({ ...good, tiers })).proto, null, JSON.stringify(tiers));
  }
  // Output ceiling: an integer in [512, 4096], anything else is 512.
  for (const [out, want] of [[99999, 512], [100, 512], ["4096", 512], [4096.5, 512], [null, 512], [512, 512], [2048, 2048], [4096, 4096]]) {
    assert.strictEqual((await neg({ ...good, maxOutputTokens: out })).proto.maxOutputTokens, want, String(out));
  }
  // Class window: a safe positive integer, clamped to 32768; else null (legacy).
  for (const [v, want] of [[1e9, 32768], [65536, 32768], [32768, 32768], [16384, 16384], ["32768", null], [-1, null], [NaN, null], [null, null], [0, null], [1.5, null]]) {
    const n = await neg(good, cls(v));
    assert.strictEqual(n.rates.maxCtxTokens, want, `class ${v}`);
    assert.strictEqual(n.auto.maxCtxTokens, want, `auto ${v}`);
  }

  // What that means for lanes. tiers [4096, 65536, "x"]: nothing above 4096 is signed.
  assert.strictEqual((await lane({ ...good, tiers: [4096, 65536, "x"] }, undefined, { messages: user("a".repeat(14321)) })).code, "context_length_exceeded");
  assert.strictEqual((await lane({ ...good, tiers: [4096, 65536, "x"] }, undefined, { messages: user("hi"), mt: 1024, extended: true })).lane, "v1");
  // maxCtxTokens 1e9 is 32768: one token past it is refused locally.
  assert.strictEqual((await lane(good, cls(1e9), { messages: user("a".repeat(129008)) })).lane, "v1", "required 32768");
  assert.strictEqual((await lane(good, cls(1e9), { messages: user("a".repeat(129012)) })).code, "context_length_exceeded", "required 32769");
  // Malformed class windows: legacy rules only.
  for (const v of ["32768", -1, NaN]) {
    assert.match((await lane(good, cls(v), { messages: user("a".repeat(14321)) })).error, /larger than the network's 4096-token class/, String(v));
    assert.strictEqual((await lane(good, cls(v), { messages: user("hi"), mt: 1024, extended: true })).code, "extended_output_unavailable", String(v));
  }
  // Output ceiling outside [512, 4096]: extended output is refused locally,
  // a long prompt still negotiates at the legacy 512.
  for (const out of [99999, 100, "4096"]) {
    assert.strictEqual((await lane({ ...good, maxOutputTokens: out }, undefined, { messages: user("hi"), mt: 1024, extended: true })).code, "invalid_max_tokens", String(out));
    assert.strictEqual((await lane({ ...good, maxOutputTokens: out }, undefined, { messages: user("a".repeat(14321)) })).maxTokens, 512, String(out));
  }

  // End to end through Core: a malformed /pricing yields local 400s — nothing signed or sent.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-lanes-pricing-"));
  const spy = ctxScheduler({
    pricing: { ok: true, models: cls(1e9), context: { ...good, tiers: [4096, 65536, "x"], maxOutputTokens: 99999 } },
  });
  const spyPort = await spy.listen();
  const { core, post } = await bootCore(dir);
  try {
    await post("/core/earn/wallet", { password: "correct horse" });
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${spyPort}` });
    await post("/core/network/config", { privacyMode: "network" });
    let r = await post("/v1/chat/completions", { model: "koinos-network:koinos-fast", messages: user("a".repeat(23984)) });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error.code, "context_length_exceeded");
    r = await post("/v1/chat/completions", { model: "koinos-network:koinos-fast", max_tokens: 2048, kai_extended_output: true, messages: user("hi") });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error.code, "invalid_max_tokens");
    assert.strictEqual(spy.consumes.length, 0, "nothing signed or sent");
    r = await post("/v1/chat/completions", { model: "koinos-network:koinos-fast", max_tokens: 900, messages: user("hi") });
    assert.strictEqual(r.status, 200);
    assert.ok(isLegacy(spy.consumes.at(-1).body), "ordinary callers keep the legacy lane");
  } finally {
    await core.stop();
    spy.srv.close();
  }
});

/*
 * §13 caller-disconnect cancellation on the v1 lane, without a real
 * scheduler: this fake sends one delta and then goes QUIET (or never
 * answers at all), so only the gateway's close listener can end the
 * upstream request — the scheduler's cue to drop the job uncharged.
 */
function quietScheduler() {
  const consumes = [];
  let closed = 0;
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url.startsWith("/pricing")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({
          ok: true,
          models: { "koinos-fast": { usdPerMInputTokens: 0.1, usdPerMOutputTokens: 0.4, ctxTokens: 4096, maxCtxTokens: 32768 } },
          context: { protocol: 1, tiers: [4096, 16384, 32768], legacyCtxTokens: 4096, legacyMaxTokens: 512, maxOutputTokens: 4096 },
        }));
      }
      if (!req.url.startsWith("/consume/")) return res.end("{}");
      const b = JSON.parse(raw);
      consumes.push(b);
      res.on("close", () => closed++);
      if (!b.stream) return; // never answers: the caller leaves before the first byte
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ accepted: true, model: b.model })}\n\n`);
      res.write(`data: ${JSON.stringify({ delta: "w1 " })}\n\n`);
    });
  });
  return {
    srv,
    consumes,
    closed: () => closed,
    listen: () => new Promise((r) => srv.listen(0, "127.0.0.1", function () { r(this.address().port); })),
  };
}

/** POST through the gateway; hang up (as a local Stop does) once `ready`. */
function hangUpWhen(url, body, ready) {
  return new Promise((resolve) => {
    const u = new URL(url);
    let seen = "";
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json" }, agent: false }, (res) =>
      res.on("data", (c) => (seen += c))
    );
    req.on("error", () => {});
    req.end(JSON.stringify(body));
    const t = setInterval(() => {
      if (!ready(seen)) return;
      clearInterval(t);
      req.destroy();
      resolve(seen);
    }, 10);
  });
}

async function eventually(fn, ms, label) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("context lanes: a v1 caller that disconnects aborts the scheduler request — mid-stream and before the first byte", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-lanes-cancel-"));
  const sched = quietScheduler();
  const schedPort = await sched.listen();
  const { core, base, post } = await bootCore(dir);
  const v1 = { model: "koinos-network:koinos-fast", max_tokens: 1024, kai_extended_output: true, messages: [{ role: "user", content: "count slowly" }] };
  try {
    await post("/core/earn/wallet", { password: "correct horse" });
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${schedPort}` });
    await post("/core/network/config", { privacyMode: "network" });

    // Mid-stream: the caller saw the first delta and left; nothing else
    // arrives upstream, so only the close listener can abort it.
    const seen = await hangUpWhen(`${base}/v1/chat/completions`, { ...v1, stream: true }, (s) => s.includes('"content":"w1 "'));
    assert.match(seen, /"model":"koinos-network"/);
    assert.strictEqual(sched.consumes[0].signatureVersion, 1, "a v1 request");
    await eventually(() => sched.closed() === 1, 5000, "the streamed scheduler request to be aborted");

    // Before the first byte: the listener was registered before the fetch.
    await hangUpWhen(`${base}/v1/chat/completions`, v1, () => sched.consumes.length === 2);
    await eventually(() => sched.closed() === 2, 5000, "the waiting scheduler request to be aborted");

    // Core is unharmed and keeps serving.
    const r = await post("/v1/chat/completions", { model: "dev-tiny", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(r.status, 200);
  } finally {
    await core.stop();
    sched.srv.closeAllConnections?.();
    sched.srv.close();
  }
});

test("/core/runtime/context: same gates as /core/network/config, validated, persisted, never loads", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-api-"));
  const events = [];
  const { core, base, post } = await bootCore(dir, events);
  try {
    let r = await fetch(`${base}/core/runtime/context`);
    let j = await r.json();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(j.protocol, 1);
    assert.strictEqual(j.configurable, true);
    const fast = j.models.find((m) => m.alias === "koinos-fast");
    assert.deepStrictEqual([fast.maxContextTokens, fast.tiers, fast.contextTokens, fast.maxOutputTokens, fast.verified], [32768, [16384, 32768], 4096, 512, false]);
    assert.ok(!("parallel" in fast));
    assert.ok(!j.models.some((m) => m.alias === "dev-tiny"), "dev models are not configurable");

    for (const [body, re] of [
      [{ alias: "phi-4", contextTokens: 32768 }, /at most 16384/],
      [{ alias: "koinos-fast", contextTokens: 8192 }, /16384 or 32768/],
      [{ alias: "koinos-fast", contextTokens: 16384, maxOutputTokens: 100 }, /512 to 4096/],
      [{ alias: "dev-tiny", contextTokens: 16384 }, /not a network model/],
      [{ alias: "constructor", contextTokens: 16384 }, /Unknown model/],
    ]) {
      r = await post("/core/runtime/context", body);
      assert.strictEqual(r.status, 400, JSON.stringify(body));
      assert.strictEqual(r.json.ok, false);
      assert.match(r.json.error, re);
    }
    r = await fetch(`${base}/core/runtime/context`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    assert.strictEqual(r.status, 400);

    r = await post("/core/runtime/context", { alias: "koinos-fast", contextTokens: 16384, maxOutputTokens: 2048 });
    assert.strictEqual(r.status, 200);
    const row = r.json.models.find((m) => m.alias === "koinos-fast");
    assert.deepStrictEqual([row.contextTokens, row.maxOutputTokens, row.parallel, row.verified], [16384, 2048, 1, false]);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    assert.deepStrictEqual(saved.runtime.modelContext, { "koinos-fast": { contextTokens: 16384, maxOutputTokens: 2048 } });
    assert.ok(events.some((e) => e.type === "runtime:context-configured"));
    assert.ok(!events.some((e) => e.type === "model:download-start" || e.type === "runtime:ready"), "configuring loads nothing");
    r = await post("/core/runtime/context", { alias: "koinos-fast", contextTokens: null });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).runtime.modelContext, {});

    // Same-site gate: a foreign page can neither read nor write it.
    const cross = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };
    r = await fetch(`${base}/core/runtime/context`, { headers: cross });
    assert.strictEqual(r.status, 403);
    r = await fetch(`${base}/core/runtime/context`, { method: "POST", headers: { ...cross, "content-type": "text/plain" }, body: JSON.stringify({ alias: "koinos-fast", contextTokens: 32768 }) });
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).runtime.modelContext, {});
  } finally {
    await core.stop();
  }

  // Core-token gate: the same bearer the rest of /core/* requires.
  const prev = process.env.KAI_CORE_TOKEN;
  process.env.KAI_CORE_TOKEN = "ctx-secret";
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-api-tok-"));
  const second = await bootCore(dir2);
  try {
    let r = await fetch(`${second.base}/core/runtime/context`);
    assert.strictEqual(r.status, 401);
    r = await second.post("/core/runtime/context", { alias: "koinos-fast", contextTokens: 16384 });
    assert.strictEqual(r.status, 401);
    r = await fetch(`${second.base}/core/runtime/context`, { headers: { authorization: "Bearer ctx-secret" } });
    assert.strictEqual(r.status, 200);
  } finally {
    await second.core.stop();
    if (prev === undefined) delete process.env.KAI_CORE_TOKEN;
    else process.env.KAI_CORE_TOKEN = prev;
  }
});

test("context local gate: an opted-in alias serves a long prompt only once its engine proves the window", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-local-"));
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf"), "weights"); // koinos-fast, placed
  const logFile = path.join(dir, "llama.log");
  const prev = process.env.FAKE_LLAMA_LOG;
  process.env.FAKE_LLAMA_LOG = logFile;
  const { core, base, post } = await bootCore(dir);
  const ask = (n) => post("/v1/chat/completions", { model: "koinos-fast", messages: [{ role: "user", content: "a".repeat(n) }] });
  try {
    await post("/core/network/config", { privacyMode: "local-only" });
    // Not opted in: today's refusal, and the engine is never even started.
    let r = await ask(23984); // ~6000 tokens
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error.message, /larger than the local model's 4096-token context/);
    assert.ok(!fs.existsSync(logFile));

    r = await post("/core/runtime/context", { alias: "koinos-fast", contextTokens: 16384 });
    assert.strictEqual(r.status, 200);
    r = await ask(23984);
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.choices[0].message.content, "Hello from fake llama");
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepStrictEqual(lines[0].argv.slice(6), ["--ctx-size", "16384", "--n-gpu-layers", "0", "--parallel", "1"]);
    assert.ok(lines.filter((l) => l.props).length >= 2, "proved at load AND re-probed for the long request");
    const st = await (await fetch(`${base}/core/runtime/context`)).json();
    assert.deepStrictEqual(st.active, { alias: "koinos-fast", contextTokens: 16384, verified: true });
    const row = st.models.find((m) => m.alias === "koinos-fast");
    assert.deepStrictEqual([row.verified, row.parallel, row.advertised], [true, 1, { contextTokens: 16384, maxOutputTokens: 512 }]);

    // Beyond even the opted-in window: refused with the window it checked.
    r = await ask(4 * 16000);
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error.message, /16384-token context/);
    // Short prompts never pay for a probe.
    const probes = fs.readFileSync(logFile, "utf8").trim().split("\n").filter((l) => l.includes("props")).length;
    r = await ask(100);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(fs.readFileSync(logFile, "utf8").trim().split("\n").filter((l) => l.includes("props")).length, probes);
  } finally {
    await core.stop();
    if (prev === undefined) delete process.env.FAKE_LLAMA_LOG;
    else process.env.FAKE_LLAMA_LOG = prev;
  }
});
