"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const { createCore } = require("../server");
const { Scheduler } = require("../../server/scheduler");

/*
 * M3 network consume (§46.5) against the §7 routing policy: privacy first.
 * Local-Only must be *provably* airtight — not "we return an error" but
 * "zero bytes reach the scheduler" — and Network mode must relay a chat
 * request end-to-end through a real scheduler to a real (fixture-backed)
 * provider and produce a paid-work receipt for it.
 */

async function bootCore(dir) {
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const core = await createCore({
    dataDir: dir,
    port: 0,
    llamaBin: path.join(__dirname, "fixtures", "fake-llama-server"),
    onEvent: () => {},
  });
  const base = `http://127.0.0.1:${await core.start()}`;
  const post = async (p, b) =>
    (await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) })).json();
  return { core, base, post };
}

test("local-only: koinos-network refused up front, zero bytes ever reach the scheduler", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-net-"));

  // Stand-in scheduler that only counts hits: the whole point is that this
  // counter stays at zero while privacy mode is local-only.
  let hits = 0;
  const spy = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const spyPort = await new Promise((r) => spy.listen(0, "127.0.0.1", function () { r(this.address().port); }));

  const { core, base, post } = await bootCore(dir);
  try {
    // A scheduler URL IS configured — the refusal below must come from the
    // privacy mode alone, not from missing configuration.
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${spyPort}` });

    const st = await (await fetch(base + "/core/network")).json();
    assert.equal(st.privacyMode, "local-only", "local-only is the default (§7)");

    // The network model is not even advertised.
    const models = await (await fetch(base + "/v1/models")).json();
    assert.ok(!models.data.some((m) => m.id === "koinos-network"), "koinos-network hidden in local-only");

    // Asking for it anyway is refused before any network code path runs.
    const r = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "koinos-network", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(r.status, 400);
    const err = await r.json();
    assert.match(err.error.message, /Local-Only/);

    // Bad mode names are rejected; the mode is unchanged.
    const bad = await post("/core/network/config", { privacyMode: "cloud" });
    assert.match(String(bad.error), /privacyMode/);
    assert.equal((await (await fetch(base + "/core/network")).json()).privacyMode, "local-only");

    assert.equal(hits, 0, "no request of any kind reached the scheduler");
  } finally {
    await core.stop();
    spy.closeAllConnections?.();
    spy.close();
  }
});

test("network mode: chat relays gateway -> scheduler -> provider -> back, with a receipt; SSE shim streams", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-net-"));
  const sched = new Scheduler({ dataDir: path.join(dir, "sched"), onEvent: () => {} });
  const schedPort = await sched.listen();

  const { core, base, post } = await bootCore(dir);
  try {
    // This one machine is both the consumer and the (only) provider: the
    // request goes out through the scheduler and comes back answered by the
    // core's own runtime — exactly the single-worker alpha topology.
    await post("/core/earn/wallet", { password: "correct horse" });
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${schedPort}` });
    await post("/core/network/config", { privacyMode: "network" });
    const started = await post("/core/earn/start");
    assert.equal(started.running, true);

    // Now the network model is advertised.
    const models = await (await fetch(base + "/v1/models")).json();
    assert.ok(models.data.some((m) => m.id === "koinos-network"), "koinos-network listed");

    const j = await post("/v1/chat/completions", {
      model: "koinos-network",
      messages: [{ role: "user", content: "hello network" }],
    });
    assert.equal(j.object, "chat.completion");
    assert.equal(j.model, "koinos-network");
    assert.equal(j.choices[0].message.content, "Hello from fake llama");

    // The provider earned a verified receipt for serving real demand (§16).
    const earn = await (await fetch(base + "/core/earn")).json();
    assert.equal(sched.receipts.length, 1);
    assert.equal(sched.receipts[0].worker, earn.wallet.address);
    assert.ok(sched.receipts[0].honest);

    // stream:true gets the SSE shim so the app UI works unchanged.
    const sr = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "koinos-network", stream: true, messages: [{ role: "user", content: "again" }] }),
    });
    assert.equal(sr.headers.get("content-type"), "text/event-stream");
    const sse = await sr.text();
    assert.ok(sse.includes("Hello from fake llama"), `content chunk present (got: ${sse})`);
    assert.ok(sse.trimEnd().endsWith("data: [DONE]"), "stream terminates with [DONE]");
    assert.equal(sched.receipts.length, 2, "second relay produced a second receipt");
  } finally {
    await post("/core/earn/stop").catch(() => {});
    await core.stop();
    await sched.close();
  }
});
