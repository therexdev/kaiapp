"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const { PriceOracle, parseSources } = require("../../server/oracle");
const { Scheduler } = require("../../server/scheduler");

/*
 * §51: "Design KAI reference-price mechanism, oracle inputs, smoothing,
 * epochs, and circuit breakers." The oracle must be boring under stress:
 * a bad feed cannot move the median, a spike cannot move an epoch more
 * than one clamped step, a dead feed HOLDS the price, and with no feeds
 * at all it is exactly the fixed anchor the alpha launched with.
 */

/** One JSON price endpoint the tests can repoint per call. */
function priceServer(initial) {
  const state = { body: initial, status: 200 };
  const srv = http.createServer((req, res) => {
    res.writeHead(state.status, { "content-type": "application/json" });
    res.end(JSON.stringify(state.body));
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", function () {
      resolve({ url: `http://127.0.0.1:${this.address().port}/`, state, close: () => srv.close() });
    })
  );
}

test("anchor mode: no sources means the fixed reference price, forever", async () => {
  const o = new PriceOracle({ anchorUsd: 0.01 });
  const s = o.snapshot();
  assert.equal(s.usd, 0.01);
  assert.equal(s.status, "anchor");
  assert.equal(s.microPerKai, 10000n); // µ$ per KAI at $0.01
  assert.equal(s.satPerMicro, 10000n); // sat per µ$ at $0.01
  const after = await o.refresh(); // must be a total no-op
  assert.deepEqual(after, s);
});

test("median of sources, EMA smoothing, and the step clamp breaker", async () => {
  const a = await priceServer({ kai: { usd: 0.02 } });
  const b = await priceServer({ price: "0.018" });
  const c = await priceServer({ broken: true }); // no numeric price at path
  try {
    const o = new PriceOracle({
      anchorUsd: 0.01,
      alpha: 0.25,
      maxStepPct: 10,
      ceilUsd: 1,
      sources: [
        { url: a.url, path: "kai.usd" },
        { url: b.url, path: "price" },
        { url: c.url, path: "nope.nothing" },
      ],
    });
    const s1 = await o.refresh();
    // median(0.02, 0.018)=0.019 -> EMA 0.25*0.019+0.75*0.01=0.01225
    // -> step clamp ±10% of 0.01 caps the move at 0.011.
    assert.equal(o.lastMedian, 0.019);
    assert.equal(s1.usd, 0.011);
    assert.equal(s1.status, "live");
    const s2 = await o.refresh();
    // EMA 0.25*0.019+0.75*0.011=0.013 -> clamped to 0.011*1.1=0.0121
    assert.ok(Math.abs(s2.usd - 0.0121) < 1e-12, `expected 0.0121, got ${s2.usd}`);
    // The conversion pair always derives from the same usd figure.
    assert.equal(s2.microPerKai, 12100n);
    assert.equal(s2.satPerMicro, BigInt(Math.round(1e8 / 12100)));
  } finally {
    a.close(); b.close(); c.close();
  }
});

test("circuit breakers: dead feeds hold the price; bounds are hard", async () => {
  const a = await priceServer({ usd: 0.5 });
  try {
    const o = new PriceOracle({
      anchorUsd: 0.01,
      alpha: 1,
      maxStepPct: 100000, // disarm the step clamp; test the bounds alone
      ceilUsd: 0.05,
      sources: [{ url: a.url, path: "usd" }],
    });
    const up = await o.refresh();
    assert.equal(up.usd, 0.05, "ceiling bound engaged");
    a.state.status = 500; // the only feed dies
    const held = await o.refresh();
    assert.equal(held.usd, 0.05, "stale-hold keeps the last good price");
    assert.equal(held.status, "stale-hold");
    a.state.status = 200;
    a.state.body = { usd: 0.000001 };
    const down = await o.refresh();
    assert.equal(down.usd, 0.001, "floor bound engaged (anchor/10 default)");
  } finally {
    a.close();
  }
});

test("persistence: a restart resumes the smoothed price, not the anchor", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-oracle-"));
  const statePath = path.join(dir, "oracle.json");
  const a = await priceServer({ usd: 0.02 });
  try {
    const o1 = new PriceOracle({ anchorUsd: 0.01, alpha: 1, maxStepPct: 1000, statePath, sources: [{ url: a.url, path: "usd" }] });
    await o1.refresh();
    assert.equal(o1.usd, 0.02);
    const o2 = new PriceOracle({ anchorUsd: 0.01, statePath, sources: [{ url: a.url, path: "usd" }] });
    assert.equal(o2.usd, 0.02, "resumed persisted price");
    assert.equal(o2.status, "stale-hold", "persisted price is held, not yet re-confirmed");
    const o3 = new PriceOracle({ anchorUsd: 0.01, statePath }); // sources removed
    assert.equal(o3.usd, 0.01, "no sources -> pure anchor ignores stale state");
  } finally {
    a.close();
  }
});

test("KAI_PRICE_SOURCES parsing is forgiving", () => {
  assert.deepEqual(parseSources(""), []);
  assert.deepEqual(parseSources("not json"), []);
  assert.deepEqual(parseSources('{"url":"x"}'), []); // not an array
  assert.deepEqual(parseSources('[{"url":"https://x","path":"p"}]'), [{ url: "https://x", path: "p" }]);
});

test("§16 eval cap: bootstrap subsidy is a budget, not a faucet", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-evalcap-"));
  const sched = new Scheduler({ dataDir: dir, epoch: 515151, evalCapPerEpoch: 3, onEvent: () => {} });
  try {
    const W = "1FakeWorkerAddressAAAAAAAAAAAAAAAA";
    for (let i = 0; i < 5; i++) {
      sched.receipts.push({ jobId: `j${i}`, worker: W, jobType: "inference-eval", honest: true });
    }
    // One PAID chat receipt rides along (freeTok: 0 = billed in full) —
    // paid chat value is real revenue and NEVER draws on the §54 budget.
    sched.receipts.push({
      jobId: "jc", worker: W, jobType: "chat", honest: true, freeTok: 0,
      usage: { prompt_tokens: 0, completion_tokens: 1000000 }, // $0.40 = 40 KAI at $0.01
    });
    const summary = sched.closeEpoch();
    // 3 capped evals x 1 KAI + 40 KAI paid chat = 43 KAI; the 2 excess evals mint nothing.
    assert.equal(summary.totals[W], String(43n * 100000000n));
    assert.equal(summary.served[W], 6, "all honest receipts still count as service");
  } finally {
    await sched.close();
  }
});

test("scheduler pins one price per epoch; conversions move only at close", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-oracle-sched-"));
  const feed = await priceServer({ usd: 0.02 });
  process.env.KAI_PRICE_ALPHA = "1";
  process.env.KAI_PRICE_MAX_STEP_PCT = "100000";
  const sched = new Scheduler({
    dataDir: dir,
    epoch: 424242,
    priceSources: [{ url: feed.url, path: "usd" }],
    onEvent: () => {},
  });
  delete process.env.KAI_PRICE_ALPHA;
  delete process.env.KAI_PRICE_MAX_STEP_PCT;
  try {
    assert.equal(sched.price.usd, 0.01, "epoch opens at the anchor");
    await sched.refreshPrice();
    assert.equal(sched.oracle.usd, 0.02, "oracle advanced");
    assert.equal(sched.price.usd, 0.01, "…but the pinned epoch price did NOT move");

    // A chat receipt's KAI value inside this epoch uses the pinned price.
    const chat = { jobType: "chat", honest: true, freeTok: 0, usage: { prompt_tokens: 0, completion_tokens: 1000000 } };
    assert.equal(sched._settleFor([chat]).workerSat, 400000n * 10000n, "1M out = $0.40 = 40 KAI at $0.01");

    const summary = sched.closeEpoch();
    assert.equal(summary.pricing.kaiRefUsd, 0.01, "the closed epoch records the price it ran at");
    assert.equal(sched.price.usd, 0.02, "the NEXT epoch repinned to the refreshed oracle");
    assert.equal(sched._settleFor([chat]).workerSat, 400000n * 5000n, "same $0.40 is 20 KAI at $0.02");
  } finally {
    feed.close();
    await sched.close();
  }
});
