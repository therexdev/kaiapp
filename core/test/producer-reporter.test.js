"use strict";

/*
 * Task #84 — a Koinos node reports itself to the dashboard without selling AI
 * compute.
 *
 * The bug this closes is not a crash: it is a node that quietly vanished from
 * koinosai.com the moment its owner turned Earning off, because the only code
 * that ever reported a block producer lived inside the earning Worker. So the
 * tests here are mostly about WHEN a report is and is not sent, and about the
 * exact bytes on the wire — a report the scheduler rejects is the same
 * missing card, arrived by a longer route.
 *
 * Every tick is driven by hand. Nothing here waits on a timer.
 */

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { Signer } = require("koilib");

const { ProducerReporter } = require("../lib/producer-reporter");
const { createProducerSnapshot } = require("../lib/koinos/producer-snapshot");

/* A real node's log lines, docker compose prefix and all. */
const REAL_LOG = [
  "block_producer-1  | 2026-08-23 06:39:03.112779 (block_producer.KoinosDesktop) [pob_producer.cpp:507] <info>: Estimated total VHP producing: 5300652.25868389 VHP",
  "block_producer-1  | 2026-08-23 06:39:03.113358 (block_producer.KoinosDesktop) [pob_producer.cpp:511] <info>: Producing with 659.46173948 VHP",
].join("\n");

function makeWallet(seed = "producer-reporter-test") {
  const signer = Signer.fromSeed(seed);
  return {
    address: signer.getAddress(),
    status: () => ({ unlocked: true, address: signer.getAddress(), exists: true }),
    signHash: async (h) => Buffer.from(await signer.signHash(h)).toString("base64"),
  };
}

/* A scheduler stand-in that records what it was sent and answers 200 OK. */
function makeFetch(reply = { ok: true, stored: true }, status = 200) {
  const seen = [];
  const impl = async (url, opts) => {
    seen.push({ url, body: JSON.parse(opts.body), method: opts.method });
    return { ok: status >= 200 && status < 300, status, json: async () => reply };
  };
  return { impl, seen };
}

function makeReporter(over = {}) {
  const wallet = over.wallet || makeWallet();
  const { impl, seen } = over.fetch || makeFetch();
  const r = new ProducerReporter({
    schedulerUrl: over.schedulerUrl || (() => "https://koinosai.com/"),
    privacyMode: over.privacyMode || (() => "network"),
    wallet,
    snapshot: over.snapshot || (async () => ({ producingVhp: 659.46173948, sharePct: 0.0124 })),
    earning: over.earning || (() => false),
    fetchImpl: impl,
  });
  return { r, seen, wallet };
}

/* ---------------------------------------------------------------------------
 * The wire format. This is the half the scheduler checks, and every one of
 * these assertions corresponds to a rejection branch in its /producer/report
 * handler — an app that gets any of them wrong reports nothing at all.
 * ------------------------------------------------------------------------ */

test("the report is signed with the producer domain and recovers to the wallet", async () => {
  const { r, seen, wallet } = makeReporter();
  const out = await r.report();
  assert.equal(out.sent, true);
  assert.equal(seen.length, 1);

  const { url, method, body } = seen[0];
  assert.equal(method, "POST");
  assert.equal(url, "https://koinosai.com/producer/report", "trailing slash must not double up");
  assert.equal(body.address, wallet.address);
  assert.ok(Number.isFinite(body.ts), "ts must be a number the scheduler can window-check");
  assert.ok(Math.abs(Date.now() - body.ts) < 120000, "and inside its 2-minute window");
  assert.ok(body.producer, "the snapshot itself");

  const hash = crypto.createHash("sha256").update(`producer|${body.address}|${body.ts}`).digest();
  assert.equal(
    Signer.recoverAddress(hash, Buffer.from(body.signature, "base64")),
    wallet.address,
    "the scheduler recovers the claimed address from this exact preimage"
  );
});

test("the domain prefix is load-bearing: a register proof does not authorise a producer report", async () => {
  const { r, seen } = makeReporter();
  await r.report();
  const { body } = seen[0];
  /*
   * Same key, same timestamp, different domain. If the app ever signed the
   * bare address, or reused "register|", a signature captured from one
   * purpose would be replayable into the other — which is precisely why the
   * scheduler hashes the prefix in.
   */
  const wrong = crypto.createHash("sha256").update(`register|${body.address}|${body.ts}`).digest();
  assert.notEqual(
    Signer.recoverAddress(wrong, Buffer.from(body.signature, "base64")),
    body.address
  );
});

test("each report carries a fresh timestamp, so the replay guard never trips on us", async () => {
  const { r, seen } = makeReporter();
  await r.report();
  await new Promise((res) => setTimeout(res, 5));
  await r.report();
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].body.ts, seen[1].body.ts);
  assert.notEqual(seen[0].body.signature, seen[1].body.signature,
    "the scheduler rejects a signature it has already seen");
});

/* ---------------------------------------------------------------------------
 * When to stay quiet. Each of these is a state a person can be in for months.
 * ------------------------------------------------------------------------ */

test("§29: a local-only machine reports nothing at all", async () => {
  const { r, seen } = makeReporter({ privacyMode: () => "local-only" });
  const out = await r.report();
  assert.equal(out.sent, false);
  assert.equal(out.reason, "local-only privacy mode");
  assert.equal(seen.length, 0, "not one byte leaves a local-only machine");
});

test("the earning worker reports the snapshot itself, so exactly one of the two speaks", async () => {
  const { r, seen } = makeReporter({ earning: () => true });
  const out = await r.report();
  assert.equal(out.sent, false);
  assert.equal(out.reason, "earning worker is reporting");
  assert.equal(seen.length, 0);
});

test("a locked wallet is a quiet state, not an error, and unlocking resumes", async () => {
  let unlocked = false;
  const signer = Signer.fromSeed("lock-test");
  const wallet = {
    status: () => (unlocked
      ? { unlocked: true, address: signer.getAddress() }
      : { unlocked: false, address: null }),
    signHash: async (h) => Buffer.from(await signer.signHash(h)).toString("base64"),
  };
  const { r, seen } = makeReporter({ wallet });

  assert.equal((await r.report()).reason, "wallet locked");
  assert.equal(r.status().lastError, null, "a locked wallet must not read as a failure");
  assert.equal(seen.length, 0);

  unlocked = true;
  assert.equal((await r.report()).sent, true, "the next tick after an unlock reports");
  assert.equal(seen.length, 1);
});

test("no scheduler URL means nowhere to report to", async () => {
  const { r, seen } = makeReporter({ schedulerUrl: () => "" });
  assert.equal((await r.report()).reason, "no scheduler URL");
  assert.equal(seen.length, 0);
});

/* ---------------------------------------------------------------------------
 * A machine with no Koinos node. This is most installs of the app, and it
 * must cost the network nothing forever.
 * ------------------------------------------------------------------------ */

test("a machine with no node never posts, however long it runs", async () => {
  const { r, seen } = makeReporter({ snapshot: async () => null });
  for (let i = 0; i < 50; i++) await r.report();
  assert.equal(seen.length, 0, "50 ticks, no node, no traffic");
  assert.equal(r.status().reported, false);
});

test("a node that stops says so ONCE, then goes quiet", async () => {
  let snap = { producingVhp: 659.46173948 };
  const { r, seen } = makeReporter({ snapshot: async () => snap });

  await r.report();
  assert.equal(seen.length, 1);
  assert.equal(r.status().reported, true);

  snap = null; // the node stops
  const cleared = await r.report();
  assert.equal(cleared.cleared, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].body.producer, null,
    "an empty snapshot is how the scheduler is told to drop the card");
  assert.equal(r.status().reported, false);

  // ...and then nothing, rather than a POST every five minutes about a node
  // that is not there.
  for (let i = 0; i < 10; i++) await r.report();
  assert.equal(seen.length, 2);
});

test("a node that cannot be read is reported as no node, not as a node with holes", async () => {
  const { r, seen } = makeReporter({
    snapshot: async () => { throw new Error("docker is not running"); },
  });
  const out = await r.report();
  assert.equal(out.sent, false);
  assert.equal(out.reason, "no producer");
  assert.equal(seen.length, 0);
  assert.match(r.status().lastError, /docker is not running/);
});

/* ---------------------------------------------------------------------------
 * Failures. A dashboard is a convenience; nothing here may take the app down
 * or turn into a stream of noise in front of someone whose node is fine.
 * ------------------------------------------------------------------------ */

test("a scheduler that refuses the report leaves the app running and says why", async () => {
  const { r, seen } = makeReporter({ fetch: makeFetch({ ok: false, error: "bad producer proof" }, 401) });
  const out = await r.report();
  assert.equal(out.sent, false);
  assert.equal(seen.length, 1, "we tried");
  assert.match(r.status().lastError, /HTTP 401/);
  assert.equal(r.status().reported, false, "a refused report must not be remembered as delivered");
});

test("a 200 that carries ok:false is still a refusal", async () => {
  const { r } = makeReporter({ fetch: makeFetch({ ok: false, error: "stale producer proof" }, 200) });
  assert.equal((await r.report()).sent, false);
  assert.match(r.status().lastError, /stale producer proof/);
});

test("a scheduler that will not answer is swallowed by the tick, not thrown at the app", async () => {
  const boom = { impl: async () => { throw new Error("ECONNREFUSED"); }, seen: [] };
  const { r } = makeReporter({ fetch: boom });
  r.running = true;
  await r._tick(); // must not reject
  r.stop();
  assert.match(r.status().lastError, /ECONNREFUSED/);
});

test("stop() is final: a tick already scheduled does not re-arm after it", () => {
  const { r } = makeReporter();
  r.start();
  assert.equal(r.status().running, true);
  r.stop();
  assert.equal(r.status().running, false);
  assert.equal(r.timer, null);
});

/* ---------------------------------------------------------------------------
 * The snapshot builder, now shared. The point of extracting it was that both
 * callers describe the same node the same way; that is what this checks.
 * ------------------------------------------------------------------------ */

test("the shared snapshot builder reads the node's log and stamps the app version", async () => {
  const calls = [];
  const snap = createProducerSnapshot({
    call: async (method, args) => {
      calls.push(method);
      if (method === "node:logs") return REAL_LOG;
      throw new Error("RPC unreachable"); // dashboard:summary is best-effort
    },
    appVersion: "9.9.9",
  });
  const p = await snap();
  assert.ok(p, "a producing node reports");
  assert.equal(p.appVersion, "9.9.9");
  assert.ok(p.reportedAt, "and when it was taken");
  assert.ok(p.sharePct > 0, "the share comes from the log alone and is always present");
  assert.deepEqual(calls, ["node:logs", "dashboard:summary"]);
  assert.equal(p.vhpSats, null, "an RPC that would not answer leaves nulls, never zeros");
  assert.equal(p.nodeValueUsd, null);
});

test("no block-producer activity is null — never a zeroed card", async () => {
  const snap = createProducerSnapshot({ call: async () => "starting up", appVersion: "1" });
  assert.equal(await snap(), null);
});

test("the log service asked for is the one the standalone node app writes", async () => {
  let asked = null;
  const snap = createProducerSnapshot({
    call: async (_m, args) => { asked = args; return ""; },
    appVersion: "1",
  });
  await snap();
  assert.equal(asked.service, "block_producer");
  assert.ok(asked.tail >= 60, "enough lines to hold a full estimate/producing pair");
});

/* ---------------------------------------------------------------------------
 * Both halves, end to end. The client half and the scheduler half of #84
 * shipped as separate changes, and the only failure mode that survives every
 * test above is a mismatch BETWEEN them — a report the app is proud of and the
 * scheduler rejects looks exactly like the missing card the task set out to
 * fix. So this drives the real kai Scheduler with the real reporter, over a
 * real socket, and asks the scheduler what it now believes about the address.
 *
 * updates.json's test does the same trick: this only runs on a machine with
 * both repos checked out. CI clones kaiapp alone and skips it.
 * ------------------------------------------------------------------------ */
test("the report the app sends is one the live scheduler accepts and shows", async () => {
  let Scheduler;
  try {
    ({ Scheduler } = require("../../../kai/lib/scheduler"));
  } catch {
    return; // kai not checked out beside kaiapp
  }
  const http = require("node:http");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaiapp-producer-"));
  const sched = new Scheduler({ dataDir: dir, operatorSecret: null, onEvent: () => {} });
  const server = http.createServer((rq, rs) => sched.handle(rq, rs).catch(() => rs.end()));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  try {
    const wallet = makeWallet("cross-repo-producer");
    const snapshot = createProducerSnapshot({
      call: async (m) => (m === "node:logs" ? REAL_LOG : (() => { throw new Error("no rpc"); })()),
      appVersion: "0.53.1",
    });
    const r = new ProducerReporter({
      schedulerUrl: () => `http://127.0.0.1:${port}`,
      privacyMode: () => "network",
      wallet,
      snapshot,
      earning: () => false,
    });

    assert.equal((await r.report()).sent, true, "the scheduler took the report");

    const shown = sched.producerFor(wallet.address);
    assert.ok(shown, "and now knows this address produces blocks");
    assert.ok(Math.abs(shown.producingVhp - 659.46173948) < 1e-6);
    assert.equal(shown.appVersion, "0.53.1", "the build stamp survives the round trip");

    /*
     * The whole risk of #84, held from this side too: a producer-only address
     * must never become a worker. One that did would be dispatched jobs it
     * cannot serve and would draw a payout share it did not earn.
     */
    const stats = sched.statsPublic({ detail: true });
    assert.equal(stats.workersOnline, 0, "reporting a node must not mint a worker");
    const rows = stats.workers || [];
    assert.ok(!rows.some((w) => w.address === wallet.address), "and must not join the roster");

    // A node that stops disappears from the dashboard rather than leaving a
    // card quoting a VHP figure from hours ago.
    r.snapshot = async () => null;
    assert.equal((await r.report()).cleared, true);
    assert.equal(sched.producerFor(wallet.address), null, "the card goes, it does not go stale");
  } finally {
    server.close();
    sched.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the log gets one line per transition, not one every five minutes", async () => {
  const events = [];
  const wallet = makeWallet();
  const { impl } = makeFetch();
  let snap = { producingVhp: 659.46173948 };
  const r = new ProducerReporter({
    schedulerUrl: () => "https://koinosai.com",
    privacyMode: () => "network",
    wallet,
    snapshot: async () => snap,
    earning: () => false,
    onEvent: (e) => events.push(e.type),
    fetchImpl: impl,
  });

  for (let i = 0; i < 6; i++) await r.report();
  assert.deepEqual(events, ["producer:reported"], "six ticks of a healthy node, one line");

  snap = null;
  await r.report();
  assert.deepEqual(events, ["producer:reported", "producer:cleared"]);

  snap = { producingVhp: 700 };
  await r.report();
  assert.deepEqual(events, ["producer:reported", "producer:cleared", "producer:reported"],
    "and it says so again when the node comes back");
});
