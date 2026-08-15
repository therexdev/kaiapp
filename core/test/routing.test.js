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
function spyScheduler() {
  const paths = [];
  const srv = http.createServer((req, res) => {
    paths.push(req.url);
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
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
    const over = await post("/v1/chat/completions", { model: "koinos-smart", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(over.status, 200);
    assert.strictEqual(over.json.choices[0].message.content, "from-network");
    assert.strictEqual(over.json.model, "koinos-network", "overflowed answer must disclose it left the machine");
    assert.strictEqual(spy.hits(), 1);
    const ev = events.find((e) => e.type === "gateway:overflow");
    assert.ok(ev && ev.from === "koinos-smart" && ev.reason, "overflow emits an event naming the alias and reason");
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

    const r = await post("/v1/chat/completions", { model: "koinos-smart", messages: [{ role: "user", content: "hi" }] });
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
      { model: "koinos-smart", messages: [{ role: "user", content: "hi" }] },
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
    const blocked = await post("/v1/chat/completions", { model: "koinos-smart", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(blocked.status, 400);
    assert.match(blocked.json.error.message, /unavailable/);
    assert.match(blocked.json.error.message, /earning account/);
    assert.strictEqual(spy.hits(), 0);

    // With a wallet, a STREAMING request overflows through the SSE shim.
    await post("/core/earn/wallet", { password: "correct horse" });
    const sr = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "koinos-smart", stream: true, messages: [{ role: "user", content: "hi" }] }),
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
