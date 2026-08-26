"use strict";

/*
 * Load guard: earning backs off while the machine's owner is using it.
 *
 * Everything here drives _tick() by hand with an injected sampler — the
 * decision logic is what can go wrong (hysteresis, attribution, resume),
 * and none of it should need a GPU or a timer to prove.
 */

const test = require("node:test");
const assert = require("node:assert");
const { LoadGuard } = require("../lib/load-guard");

function makeGuard(overrides = {}) {
  const calls = { contention: 0, quiet: 0, events: [] };
  const samples = [];
  const guard = new LoadGuard({
    sample: async () => samples.shift() ?? null,
    isOurLoad: overrides.isOurLoad || (() => false),
    onContention: () => { calls.contention += 1; },
    onQuiet: () => { calls.quiet += 1; },
    onEvent: (e) => calls.events.push(e.type),
    enterSamples: 3,
    exitSamples: 4,
    busyPct: 40,
    ...overrides.opts,
  });
  return { guard, calls, samples };
}

const busy = { utilPct: 80 };
const quiet = { utilPct: 5 };

test("three consecutive busy samples pause; a blip does not", async () => {
  const { guard, calls, samples } = makeGuard();
  samples.push(busy, busy, quiet, busy, busy, busy);
  await guard._tick(); // busy 1
  await guard._tick(); // busy 2
  await guard._tick(); // quiet — run resets
  assert.equal(guard.paused, false);
  assert.equal(calls.contention, 0);
  await guard._tick(); // busy 1
  await guard._tick(); // busy 2
  await guard._tick(); // busy 3 — pause
  assert.equal(guard.paused, true);
  assert.equal(calls.contention, 1);
  assert.equal(guard.pauses, 1);
});

test("samples during our own load are skipped — counters hold in both directions", async () => {
  let ours = false;
  const { guard, calls, samples } = makeGuard({ isOurLoad: () => ours });
  samples.push(busy, busy, busy);
  await guard._tick();
  await guard._tick();
  ours = true; // our generation starts: high utilization is now us
  await guard._tick(); // skipped — does NOT consume a sample or count
  assert.equal(guard.paused, false);
  ours = false;
  await guard._tick(); // busy 3 — now it pauses
  assert.equal(guard.paused, true);
  assert.equal(calls.contention, 1);
});

test("resume needs the full quiet run; one busy sample resets it", async () => {
  const { guard, calls, samples } = makeGuard();
  samples.push(busy, busy, busy, quiet, quiet, quiet, busy, quiet, quiet, quiet, quiet);
  for (let i = 0; i < 3; i++) await guard._tick();
  assert.equal(guard.paused, true);
  for (let i = 0; i < 3; i++) await guard._tick(); // quiet 1..3 of 4
  assert.equal(guard.paused, true, "three quiet samples must not resume a four-sample exit");
  await guard._tick(); // busy — quiet run resets (and retries contention actions)
  for (let i = 0; i < 3; i++) await guard._tick(); // quiet 1..3
  assert.equal(guard.paused, true);
  await guard._tick(); // quiet 4 — resume
  assert.equal(guard.paused, false);
  assert.equal(calls.quiet, 1);
});

test("every contended sample re-fires the action so a skipped unload gets retried", async () => {
  const { guard, calls, samples } = makeGuard();
  samples.push(busy, busy, busy, busy, busy);
  for (let i = 0; i < 5; i++) await guard._tick();
  assert.equal(guard.pauses, 1, "one pause episode");
  assert.equal(calls.contention, 3, "entry sample plus each contended sample after it");
});

test("a sampler that cannot answer disarms the guard once, quietly", async () => {
  const { guard, calls, samples } = makeGuard();
  samples.push(null, null, null, null);
  for (let i = 0; i < 4; i++) await guard._tick();
  assert.equal(guard.supported, false);
  assert.equal(guard.paused, false);
  assert.equal(calls.events.filter((t) => t === "guard:unsupported").length, 1);
});

test("status carries what the pane needs", async () => {
  const { guard, samples } = makeGuard();
  samples.push(busy, busy, busy);
  for (let i = 0; i < 3; i++) await guard._tick();
  const s = guard.status();
  assert.equal(s.supported, true);
  assert.equal(s.paused, true);
  assert.equal(s.lastUtilPct, 80);
  assert.ok(s.pausedSince);
});

test("worker backoff flag: idempotent, visible, and safe when not running", () => {
  const { Worker } = require("../lib/worker");
  const w = new Worker({
    schedulerUrl: "http://127.0.0.1:1",
    wallet: { address: "1TestAddress" },
    runtime: {},
    hardware: {},
  });
  assert.equal(w.status().backoff, false);
  w.setBackoff(true, "your GPU is busy");
  w.setBackoff(true, "your GPU is busy"); // second call must not double-count
  const s = w.status();
  assert.equal(s.backoff, true);
  assert.equal(s.backoffReason, "your GPU is busy");
  assert.equal(s.backoffs, 1);
  // Clearing while not running must not try to register with a scheduler.
  w.setBackoff(false);
  assert.equal(w.status().backoff, false);
  assert.equal(w.status().backoffSince, null);
});
