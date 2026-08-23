"use strict";

/*
 * Node value and dollar earnings.
 *
 * This is money on a screen, and every failure mode here is a lie of a
 * different kind: a decimal slip misvalues someone's stack by 100×, dropping
 * VHP reports a working producer as nearly broke, counting mana counts the
 * same coins twice, and a missing price rendered as 0 tells someone their
 * node earns nothing. So the arithmetic is a pure function and it is pinned
 * here, without a network anywhere near it.
 */

const { test } = require("node:test");
const assert = require("node:assert");

const {
  computeUsdPerKoin, satsToUsd, valuation, createPriceCache, SATS, USDT_UNITS,
} = require("../lib/koinos/koin-price");

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test("the price divides two different decimal scales correctly", () => {
  // 100 USDT (6-dec) buys 2000 vKOIN (8-dec) → $0.05 per KOIN.
  const usd = computeUsdPerKoin({ usdtSats: 100n * BigInt(USDT_UNITS), vkoinSats: 2000n * BigInt(SATS) });
  assert.ok(close(usd, 0.05), `expected 0.05, got ${usd}`);

  // The scales are NOT the same, and mixing them is a 100× error in the
  // direction that flatters the number.
  assert.ok(!close(usd, 5), "6-dec USDT must not be read as 8-dec");
});

test("an empty or zero quote yields no price rather than a fake one", () => {
  assert.equal(computeUsdPerKoin({ usdtSats: 0n, vkoinSats: 100n }), null);
  assert.equal(computeUsdPerKoin({ usdtSats: 100n, vkoinSats: 0n }), null, "never divide by zero into Infinity");
  assert.equal(satsToUsd("100000000", null), null, "no price means no dollar figure");
  assert.equal(satsToUsd(null, 0.05), null);
});

test("node value is KOIN plus VHP — and never counts mana", () => {
  const v = valuation({
    // 10 KOIN liquid, 90 KOIN burned into VHP, plus mana that must be ignored.
    balances: { koin: String(10 * SATS), vhp: String(90 * SATS), mana: String(10 * SATS) },
    windows: null,
    usdPerKoin: 0.05,
  });
  assert.equal(v.holdingsSats, String(100 * SATS), "burned stake is still the node's value");
  assert.ok(close(v.nodeValueUsd, 5), `100 KOIN at $0.05 is $5, got ${v.nodeValueUsd}`);
  assert.ok(close(v.koinUsd, 0.5));
  assert.ok(close(v.vhpUsd, 4.5));
  assert.ok(
    !close(v.nodeValueUsd, 5.5),
    "mana derives from the KOIN already counted — including it would double-count",
  );
});

test("a producing node's earnings scale from the measured daily rate", () => {
  const v = valuation({
    balances: { koin: "0", vhp: String(1000 * SATS) },
    windows: { avgDailyProfit: String(2 * SATS), daysTracked: 14 },
    usdPerKoin: 0.05,
  });
  assert.ok(close(v.dailyUsd, 0.1), `2 KOIN/day at $0.05 = $0.10, got ${v.dailyUsd}`);
  assert.ok(close(v.weeklyUsd, 0.7));
  assert.ok(close(v.yearlyUsd, 36.5), `365 days, not 360 or 12 months, got ${v.yearlyUsd}`);
  assert.equal(v.basis, "measured");
});

/*
 * The one that matters most for a new node. "$0.00 per day" is a claim that
 * the machine earns nothing; the truth is that nothing has been measured yet.
 * Someone deciding whether to keep a Pi running deserves the difference.
 */
test("a node with no history reports no estimate — not zero", () => {
  const v = valuation({
    balances: { koin: String(50 * SATS), vhp: "0" },
    windows: { avgDailyProfit: "0", daysTracked: 0 },
    usdPerKoin: 0.05,
  });
  assert.equal(v.dailyUsd, null, "no measured days means no daily figure");
  assert.equal(v.weeklyUsd, null);
  assert.equal(v.yearlyUsd, null);
  assert.equal(v.basis, "no-history");
  assert.ok(close(v.nodeValueUsd, 2.5), "but what it holds is known, and still shown");
});

test("balances that failed to load do not become a value of zero", () => {
  const v = valuation({ balances: { error: "rpc unreachable" }, windows: null, usdPerKoin: 0.05 });
  assert.equal(v.holdingsSats, null);
  assert.equal(v.nodeValueUsd, null, "an unreachable RPC must not read as an empty wallet");
});

test("with no price, everything dollar-denominated is absent rather than zero", () => {
  const v = valuation({
    balances: { koin: String(100 * SATS), vhp: "0" },
    windows: { avgDailyProfit: String(SATS), daysTracked: 30 },
    usdPerKoin: null,
  });
  assert.equal(v.nodeValueUsd, null);
  assert.equal(v.dailyUsd, null);
  assert.equal(v.usdPerKoin, null);
});

// ---------------------------------------------------------------- the cache

test("the price is fetched once per TTL, and concurrent callers share one trip", async () => {
  let calls = 0;
  const cache = createPriceCache({
    ttlMs: 1000,
    fetcher: async ({ now }) => { calls += 1; return { usdPerKoin: 0.05, at: now, probeUsdt: 100, error: null }; },
  });
  const t0 = 1_000_000;
  const [a, b] = await Promise.all([cache.get({ now: t0 }), cache.get({ now: t0 })]);
  assert.equal(calls, 1, "two callers at once must not both hit the network");
  assert.ok(close(a.usdPerKoin, 0.05));
  assert.ok(close(b.usdPerKoin, 0.05));

  await cache.get({ now: t0 + 500 });
  assert.equal(calls, 1, "still inside the TTL");
  await cache.get({ now: t0 + 1500 });
  assert.equal(calls, 2, "past it, refreshed");
});

test("a failed refresh dims the last price instead of deleting it", async () => {
  let fail = false;
  const cache = createPriceCache({
    ttlMs: 10, staleMs: 5000,
    fetcher: async ({ now }) =>
      fail
        ? { usdPerKoin: null, at: now, probeUsdt: 100, error: "No Ethereum RPC reachable" }
        : { usdPerKoin: 0.05, at: now, probeUsdt: 100, error: null },
  });
  const t0 = 2_000_000;
  await cache.get({ now: t0 });

  fail = true;
  const during = await cache.get({ now: t0 + 100 });
  assert.ok(close(during.usdPerKoin, 0.05), "a dropped connection keeps the last known price");
  assert.match(during.error, /No Ethereum RPC/, "and reports why it could not refresh");
  assert.equal(during.stale, false, "100ms old is not stale");

  const later = await cache.get({ now: t0 + 6000 });
  assert.equal(later.stale, true, "but an hour-old price must be marked, not passed off as current");
  assert.ok(close(later.usdPerKoin, 0.05));
});

test("a first fetch that fails yields no price at all, and says why", async () => {
  const cache = createPriceCache({
    fetcher: async ({ now }) => ({ usdPerKoin: null, at: now, probeUsdt: 100, error: "pool illiquid" }),
  });
  const r = await cache.get({ now: 1 });
  assert.equal(r.usdPerKoin, null);
  assert.match(r.error, /illiquid/);
});

test("a snapshot never waits on the network, and fills in on a later poll", async () => {
  let resolveFetch;
  let calls = 0;
  const cache = createPriceCache({
    ttlMs: 1000,
    fetcher: () => { calls += 1; return new Promise((r) => { resolveFetch = r; }); },
  });
  const t0 = 3_000_000;

  // The dashboard's first paint: instant, priceless, and it started the fetch.
  const first = cache.snapshot({ now: t0 });
  assert.equal(first.usdPerKoin, null, "no price yet, and crucially no waiting for one");
  assert.equal(first.pending, true);
  assert.equal(calls, 1);

  // Another poll while it is still in flight must not stack a second request.
  cache.snapshot({ now: t0 + 10 });
  assert.equal(calls, 1, "one round trip, however often the dashboard repaints");

  resolveFetch({ usdPerKoin: 0.05, at: t0, probeUsdt: 100, error: null });
  await new Promise((r) => setImmediate(r));

  const later = cache.snapshot({ now: t0 + 20 });
  assert.ok(close(later.usdPerKoin, 0.05), "the next poll has it");
  assert.equal(later.pending, false);
});
