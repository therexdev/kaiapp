"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const crypto = require("crypto");
const { createCore } = require("../server");
const { Scheduler } = require("../../server/scheduler");
const { WalletService } = require("../lib/wallet");

/** §23 consumer signature, exactly as the app's core builds it. */
async function consumeIdent(wallet, messages) {
  const ts = Date.now();
  const hash = crypto
    .createHash("sha256")
    .update(`consume|${wallet.address}|${ts}|${JSON.stringify(messages)}`)
    .digest();
  return { address: wallet.address, ts, signature: await wallet.signHash(hash) };
}

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

    // §51 CU groundwork: the worker timed the job and the scheduler keeps a
    // rolling capability rating (generation tok/s vs the CU baseline).
    assert.ok(sched.receipts[0].perf?.tokPerSec > 0, "receipt carries provider perf");
    const rating = sched.perf[earn.wallet.address];
    assert.ok(rating?.jobs >= 1 && rating?.cuRating > 0, `provider CU rating tracked (${JSON.stringify(rating)})`);

    // The relay was signed by the app wallet and metered in AI tokens.
    assert.equal(sched.consumed[earn.wallet.address], 1, "request counted to the signing account");
    assert.equal(j.usage.total_tokens, 5, "OpenAI-shape usage returned (1 in + 4 out from the fixture)");
    assert.deepEqual(
      sched.usage[earn.wallet.address],
      { inTok: 1, outTok: 4, costMicro: 0 },
      "token meter recorded actuals; free allowance absorbed the cost"
    );

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

    // §23 auth: unsigned and forged requests never reach a provider.
    const noSig = await fetch(`http://127.0.0.1:${schedPort}/consume/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "free ride?" }] }),
    });
    assert.equal(noSig.status, 401);
    const imposter = new WalletService(path.join(dir, "imposter"));
    imposter.create({ password: "correct horse" });
    const forged = await consumeIdent(imposter, [{ role: "user", content: "x" }]);
    forged.address = earn.wallet.address; // claim someone else's account
    const bad = await fetch(`http://127.0.0.1:${schedPort}/consume/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "x" }], ...forged }),
    });
    assert.equal(bad.status, 401, "signature must match the claimed address");

    // Metering: a pure consumer's first request rides the free token
    // allowance; once free tokens, prepaid balance, and earnings are all
    // exhausted, the authorization gate refuses BEFORE any provider runs.
    const consumer = new WalletService(path.join(dir, "consumer"));
    consumer.create({ password: "correct horse" });
    const askNet = async (content) => {
      const ident = await consumeIdent(consumer, [{ role: "user", content }]);
      return fetch(`http://127.0.0.1:${schedPort}/consume/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content }], ...ident }),
      });
    };
    const ok1 = await askNet("free ride within allowance");
    assert.equal(ok1.status, 200, "free allowance covers a small request");
    await ok1.text();
    sched.freeUsed[consumer.address] = 25000; // allowance spent
    const refused = await askNet("one more?");
    assert.equal(refused.status, 402, "no free tokens, no balance, no earnings -> refused");
    assert.match((await refused.json()).error.message, /billed per AI token/);

    // §8 key budgets: an API key with an exhausted monthly network budget is
    // stopped by the GATEWAY, before the scheduler ever sees the request.
    const created = await (
      await fetch(base + "/core/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "budgeted" }),
      })
    ).json();
    await fetch(`${base}/core/keys/${created.id}/budget`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetUsdMonthly: 0.000001 }), // one µ$ of runway
    });
    const bearer = { "content-type": "application/json", authorization: `Bearer ${created.secret}` };
    const first = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ model: "koinos-network", messages: [{ role: "user", content: "within budget" }] }),
    });
    assert.equal(first.status, 200, "budget not yet exhausted: request flows");
    await first.text();
    const second = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ model: "koinos-network", messages: [{ role: "user", content: "over budget" }] }),
    });
    assert.equal(second.status, 429, "budget exhausted: gateway refuses");
    assert.match((await second.json()).error.message, /monthly network budget/);
  } finally {
    await post("/core/earn/stop").catch(() => {});
    await core.stop();
    await sched.close();
  }
});
