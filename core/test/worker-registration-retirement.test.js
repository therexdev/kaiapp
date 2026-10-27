"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { Worker } = require("../lib/worker");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t) {
  const original = { fetch: global.fetch, setInterval: global.setInterval, clearInterval: global.clearInterval };
  const intervals = [], registrations = [], workers = [], releaseOnCleanup = [];
  const heartbeatStarted = deferred(), heartbeatResponse = deferred();
  let activeToken = null, firstJob = null;
  const models = {
    aliases: () => ["fast", "smart"].map(alias => ({ alias, status: "ready", minRamGb: 4 })),
    catalog: {
      aliases: { fast: { package: "fast" }, smart: { package: "smart" } },
      packages: { fast: { sha256: "a".repeat(64) }, smart: { sha256: "b".repeat(64) } },
    },
    packageStatus: () => ({ status: "ready" }), quarantineOf: () => null,
  };
  global.setInterval = (callback, milliseconds) => {
    const interval = { callback, milliseconds, cleared: false, unref() {} };
    intervals.push(interval); return interval;
  };
  global.clearInterval = interval => {
    if (intervals.includes(interval)) interval.cleared = true;
    else original.clearInterval(interval);
  };
  global.fetch = async (value, options = {}) => {
    const url = new URL(value);
    assert.equal(url.origin, "https://fixture.invalid", "the test must never contact a real scheduler");
    if (url.pathname === "/worker/register") {
      const body = JSON.parse(options.body), token = "worker-" + (registrations.length + 1);
      registrations.push({ token, models: body.models }); activeToken = token;
      return Response.json({ ok: true, token });
    }
    if (url.pathname === "/worker/heartbeat") {
      heartbeatStarted.resolve(); return heartbeatResponse.promise;
    }
    if (url.pathname === "/worker/result") return Response.json({ accepted: true });
    if (url.pathname === "/worker/next-job") {
      if (firstJob && url.searchParams.get("token") === "worker-1") {
        const job = firstJob; firstJob = null; return Response.json({ job });
      }
      return new Promise((_, reject) => {
        const abort = () => { options.signal.removeEventListener("abort", abort); reject(options.signal.reason); };
        options.signal.addEventListener("abort", abort, { once: true });
        if (options.signal.aborted) abort();
      });
    }
    throw Error("Unexpected scheduler request: " + url.pathname);
  };
  const create = model => {
    const worker = new Worker({ schedulerUrl: "https://fixture.invalid", wallet: { address: "same-wallet", signHash: async () => "fixture-signature" },
      runtime: {}, hardware: { ramBytes: 8e9 }, models, modelPins: { [model]: models.catalog.packages[model].sha256 } });
    workers.push(worker); return worker;
  };
  t.after(async () => {
    for (const release of releaseOnCleanup) release();
    heartbeatResponse.resolve(new Response(null, { status: 204 }));
    try { await Promise.all(workers.map(worker => worker.stop())); }
    finally { Object.assign(global, original); }
  });
  return { create, intervals, registrations, heartbeatStarted, heartbeatResponse, releaseOnCleanup,
    assignJob: () => { firstJob = { id: "assigned-job", type: "chat", model: "fast" }; },
    activeToken: () => activeToken };
}

test("a retired worker's late heartbeat cannot re-advertise its old selection after replacement", { timeout: 5000 }, async t => {
  const f = fixture(t), old = f.create("fast"), executing = deferred(), finishWork = deferred(), delivered = deferred();
  f.releaseOnCleanup.push(() => finishWork.resolve());
  f.assignJob();
  old._execute = async () => { executing.resolve(); await finishWork.promise; return { output: "PONG", usage: { completion_tokens: 1 } }; };
  old.onEvent = event => { if (event.type === "worker:job-done") delivered.resolve(); };
  await old.start(); await executing.promise;
  const heartbeat = f.intervals.find(interval => interval.callback.toString().includes("/worker/heartbeat"));
  assert.ok(heartbeat, "an assigned job has its real heartbeat callback");
  const lateHeartbeat = heartbeat.callback(); await f.heartbeatStarted.promise;
  finishWork.resolve(); await delivered.promise; await old.stop();
  assert.equal(heartbeat.cleared, true);

  const replacement = f.create("smart"); await replacement.start();
  assert.deepEqual(f.registrations.map(row => row.models), [["fast"], ["smart"]]);
  f.heartbeatResponse.resolve(new Response(null, { status: 401 })); await lateHeartbeat;

  assert.equal(old.running, false);
  assert.equal(replacement.running, true);
  assert.deepEqual(f.registrations.map(row => row.models), [["fast"], ["smart"]], "the old callback cannot put the deselected model back on the scheduler");
  assert.equal(f.activeToken(), replacement.token, "the replacement registration remains current");
});

test("a retired worker's delayed watchdog cannot replace the new worker's registration", { timeout: 5000 }, async t => {
  const f = fixture(t), old = f.create("fast"), snapshotStarted = deferred(), finishSnapshot = deferred();
  f.releaseOnCleanup.push(() => finishSnapshot.resolve(null));
  await old.start();
  let first = true;
  old._producerSnapshot = async () => {
    if (!first) return null;
    first = false; snapshotStarted.resolve(); return finishSnapshot.promise;
  };
  const watchdog = f.intervals.find(interval => interval.milliseconds === 60000);
  assert.ok(watchdog);
  const lateWatchdog = watchdog.callback(); await snapshotStarted.promise;
  await old.stop(); assert.equal(watchdog.cleared, true);

  const replacement = f.create("smart"); await replacement.start();
  assert.deepEqual(f.registrations.map(row => row.models), [["fast"], ["smart"]]);
  finishSnapshot.resolve(null); await lateWatchdog;

  assert.equal(old.running, false);
  assert.equal(replacement.running, true);
  assert.deepEqual(f.registrations.map(row => row.models), [["fast"], ["smart"]], "cleared intervals cannot finish by re-registering an obsolete selection");
  assert.equal(f.activeToken(), replacement.token);
});
