"use strict";

/*
 * Block-rate maths, checked against a real node's logs (2026-08-23, 100
 * samples over 1h45m). Every number below was read off that machine, so a
 * regression here is measurable against something that actually happened
 * rather than against a figure someone made up to make a test pass.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const { summarize, quietness } = require("../lib/koinos/producer-share");

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test("a real node's share and block rate", () => {
  const s = summarize({ producingVhp: 659.46173948, networkVhp: 5381380 });
  assert.ok(close(s.sharePct, 0.012254, 1e-5), `share ${s.sharePct}`);
  assert.ok(Math.round(s.oneInBlocks) === 8160, `one in ${s.oneInBlocks}`);
  assert.ok(close(s.blocksPerDay, 3.529, 1e-3), `blocks/day ${s.blocksPerDay}`);
  assert.ok(close(s.hoursPerBlock, 6.8, 0.05), `hours/block ${s.hoursPerBlock}`);
});

test("missing or zero inputs give nothing, not Infinity or zero", () => {
  for (const bad of [
    { producingVhp: 659, networkVhp: 0 },
    { producingVhp: 0, networkVhp: 5e6 },
    { producingVhp: null, networkVhp: 5e6 },
    { producingVhp: 659, networkVhp: undefined },
    {},
  ]) {
    const s = summarize(bad);
    assert.equal(s.sharePct, null, `share must be unknown for ${JSON.stringify(bad)}`);
    assert.equal(s.blocksPerDay, null);
    assert.equal(s.oneInBlocks, null, "never 1/0");
  }
});

test("share scales the way the lottery does", () => {
  const a = summarize({ producingVhp: 1000, networkVhp: 5_000_000 });
  const b = summarize({ producingVhp: 2000, networkVhp: 5_000_000 });
  assert.ok(close(b.blocksPerDay, a.blocksPerDay * 2), "twice the stake, twice the blocks");
  const c = summarize({ producingVhp: 1000, networkVhp: 10_000_000 });
  assert.ok(close(c.blocksPerDay, a.blocksPerDay / 2), "twice the network, half the blocks");
});

/*
 * The property that keeps a dashboard from crying wolf. This node averages a
 * block every ~7 hours, so a quiet half-day is ordinary — and telling someone
 * their node looks broken because of it would be worse than saying nothing.
 */
test("quiet stretches are normal for a small producer, and only the tail is unusual", () => {
  const { hoursPerBlock } = summarize({ producingVhp: 659.46173948, networkVhp: 5381380 });

  assert.equal(quietness({ hoursSinceLastBlock: 2, hoursPerBlock }).unusual, false);
  assert.equal(quietness({ hoursSinceLastBlock: 7, hoursPerBlock }).unusual, false,
    "one mean gap is the single most ordinary thing that can happen");
  assert.equal(quietness({ hoursSinceLastBlock: 12, hoursPerBlock }).unusual, false);
  assert.equal(quietness({ hoursSinceLastBlock: 24, hoursPerBlock }).unusual, true,
    "a day of silence at this rate is out in the tail and worth a look");

  assert.equal(quietness({ hoursSinceLastBlock: 5, hoursPerBlock: null }).p, null,
    "no rate means no verdict");
});

/* ---------------------------------------------------------------------------
 * Reading the producer's own log. These lines are copied verbatim from a real
 * node, docker compose prefix and all — the format that actually arrives, not
 * a tidied version of it.
 * ------------------------------------------------------------------------ */
const { parseProducerLog } = require("../lib/koinos/producer-share");

const REAL_LOG = [
  "block_producer-1  | 2026-08-23 06:39:03.112779 (block_producer.KoinosDesktop) [pob_producer.cpp:507] <info>: Estimated total VHP producing: 5300652.25868389 VHP",
  "block_producer-1  | 2026-08-23 06:39:03.113358 (block_producer.KoinosDesktop) [pob_producer.cpp:511] <info>: Producing with 659.46173948 VHP",
  "block_producer-1  | 2026-08-23 06:40:09.747626 (block_producer.KoinosDesktop) [pob_producer.cpp:507] <info>: Estimated total VHP producing: 5298037.50481388 VHP",
  "block_producer-1  | 2026-08-23 06:40:09.748257 (block_producer.KoinosDesktop) [pob_producer.cpp:511] <info>: Producing with 659.46173948 VHP",
].join("\n");

test("the producer log gives up both numbers, from its most recent pair", () => {
  const r = parseProducerLog(REAL_LOG);
  assert.ok(close(r.producingVhp, 659.46173948));
  assert.ok(close(r.networkVhp, 5298037.50481388), "the LAST estimate, not the first");
  assert.match(r.at, /^2026-08-23T06:40:09Z$/);

  // End to end, the number a person reads off the dashboard.
  const s = summarize(r);
  assert.ok(close(s.blocksPerDay, 3.585, 1e-3), `blocks/day ${s.blocksPerDay}`);
});

test("a node that is synced but not producing reads as absent, not as zero", () => {
  assert.equal(parseProducerLog(""), null);
  assert.equal(parseProducerLog("block_producer-1  | starting up\nno vhp here"), null);

  // Half a pair is still worth reporting, with the missing half absent.
  const half = parseProducerLog("block_producer-1  | 2026-08-23 06:40:09.7 x <info>: Producing with 659.46173948 VHP");
  assert.ok(close(half.producingVhp, 659.46173948));
  assert.equal(half.networkVhp, null);
  assert.equal(summarize(half).sharePct, null, "and a half pair yields no share");
});

/* ---------------------------------------------------------------------------
 * The worker carries it, and never lets it stop the thing the user switched on.
 * ------------------------------------------------------------------------ */
const { Worker } = require("../lib/worker");

test("a producer snapshot rides along with registration", async () => {
  const w = new Worker({ schedulerUrl: "http://127.0.0.1:1", producer: async () => ({ producingVhp: 659.46 }) });
  const snap = await w._producerSnapshot();
  assert.ok(close(snap.producingVhp, 659.46));
});

test("a broken or absent node never blocks earning", async () => {
  const boom = new Worker({ schedulerUrl: "http://127.0.0.1:1", producer: async () => { throw new Error("docker is down"); } });
  assert.equal(await boom._producerSnapshot(), null, "a node that errors is simply absent");

  const none = new Worker({ schedulerUrl: "http://127.0.0.1:1" });
  assert.equal(await none._producerSnapshot(), null, "and a machine with no node at all is fine");

  const hangs = new Worker({ schedulerUrl: "http://127.0.0.1:1", producer: () => { throw new Error("sync throw"); } });
  assert.equal(await hangs._producerSnapshot(), null, "including one that throws synchronously");
});
