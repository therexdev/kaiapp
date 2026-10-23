"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { RuntimeManager } = require("../lib/runtime-manager");
const { ModelManager } = require("../lib/model-manager");
const { JsonStore } = require("../lib/store");

/*
 * Field report (network serving): answers cut off mid-sentence, and the log
 * showed switching -> crashed 3221225477 -> fallback on every model switch.
 * Two causes, two probes:
 *   1. ensure() for another model stopped the engine a stream was riding.
 *   2. a build that crashes at STARTUP (not self-test) was retried forever.
 */

function makeModels(dir, aliases) {
  const catalogPath = path.join(dir, "catalog.json");
  const packages = {};
  const aliasMap = {};
  for (const a of aliases) {
    aliasMap[a] = { label: a, package: `${a}@1` };
    packages[`${a}@1`] = { filename: `${a}.gguf`, url: "http://127.0.0.1:1/unused", sha256: "0".repeat(64), runtime: "llamacpp" };
    fs.mkdirSync(path.join(dir, "models"), { recursive: true });
    fs.writeFileSync(path.join(dir, "models", `${a}.gguf`), "stub");
  }
  fs.writeFileSync(catalogPath, JSON.stringify({ aliases: aliasMap, packages }));
  return new ModelManager({ catalogPath, modelsDir: path.join(dir, "models"), state: new JsonStore(path.join(dir, "st.json"), {}), onEvent: () => {} });
}

/** A runtime stub that records start/stop and always reports running. */
function stubRuntime(log, { failStart } = {}) {
  let running = false;
  return {
    start: async (opts) => {
      log.push({ op: "start", model: path.basename(opts.modelPath), gpuLayers: opts.gpuLayers });
      if (failStart) throw new Error(failStart);
      running = true;
    },
    stop: () => {
      log.push({ op: "stop" });
      running = false;
    },
    status: () => ({ kind: "stub", running }),
    get endpoint() { return "http://127.0.0.1:1"; },
  };
}

test("runtime: a switch WAITS for the stream in flight instead of killing it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rt-drain-"));
  const log = [];
  const rm = new RuntimeManager({
    models: makeModels(dir, ["a", "b"]),
    hardware: { capabilities: {} },
    onEvent: () => {},
    makeRuntime: () => stubRuntime(log),
  });
  rm.drainMaxMs = 5000;

  assert.ok(typeof rm.acquireFor === "function", "acquireFor exists"); // old code: fails here
  const hold = await rm.acquireFor("a");
  const stopsBefore = () => log.filter((l) => l.op === "stop").length;
  assert.strictEqual(stopsBefore(), 0);

  // Another class arrives mid-stream — exactly the field timeline.
  const switching = rm.ensure("b");
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(stopsBefore(), 0, "the serving engine is NOT stopped while the stream is open");

  hold.release();
  await switching;
  assert.strictEqual(stopsBefore(), 1, "…and the switch proceeds the moment it closes");
  assert.strictEqual(rm.activeAlias, "b");
});

test("runtime: a switch never hangs forever behind an abandoned stream", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rt-cap-"));
  const log = [];
  const rm = new RuntimeManager({
    models: makeModels(dir, ["a", "b"]),
    hardware: { capabilities: {} },
    onEvent: () => {},
    makeRuntime: () => stubRuntime(log),
  });
  rm.drainMaxMs = 200; // the cap under test

  await rm.acquireFor("a"); // never released — a dead connection
  const t0 = Date.now();
  await rm.ensure("b");
  assert.ok(Date.now() - t0 >= 150, "the switch waited for the cap");
  assert.strictEqual(rm.activeAlias, "b", "…then went ahead anyway");
});

test("runtime: a build that hard-crashes at startup is not retried on the next switch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rt-crash-"));
  const log = [];
  const bins = { vulkan: path.join(dir, "vulkan", "llama-server"), cpu: path.join(dir, "cpu", "llama-server") };
  const state = new JsonStore(path.join(dir, "state.json"), {});
  const rm = new RuntimeManager({
    models: makeModels(dir, ["a", "b"]),
    hardware: { capabilities: { vulkanEligible: true } },
    onEvent: () => {},
    state,
    appVersion: "test-1",
    provisioner: { ensure: async (_kind, { cap }) => bins[cap] },
    makeRuntime: (binPath) =>
      stubRuntime(log, binPath === bins.vulkan
        ? { failStart: "llama-server exited during startup (exit code 3221225477)" }
        : {}),
  });
  // The self-test needs a real binary; these stubs are the units under test.
  rm._testedBins.add(bins.vulkan).add(bins.cpu);

  await rm.ensure("a");
  const starts = () => log.filter((l) => l.op === "start").length;
  const after1 = starts();
  assert.ok(after1 >= 2, "first load: vulkan crashed, cpu served");
  assert.ok(state.get("badBuilds", {})[bins.vulkan], "the startup crash is remembered"); // old code: fails here

  await rm.ensure("b"); // the switch from the field log
  // One new start only (cpu with model b) — vulkan is not crash-tested again.
  assert.strictEqual(starts(), after1 + 1, "the switch goes straight to the build that works");
});

test("runtime: macOS tries Metal before CPU and disables GPU layers on fallback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rt-metal-"));
  const log = [];
  const caps = [];
  const bins = {
    metal: path.join(dir, "metal", "llama-server"),
    cpu: path.join(dir, "cpu", "llama-server"),
  };
  const rm = new RuntimeManager({
    models: makeModels(dir, ["a"]),
    hardware: { capabilities: { metalEligible: true } },
    onEvent: () => {},
    provisioner: {
      ensure: async (_kind, { cap }) => {
        caps.push(cap);
        return bins[cap];
      },
    },
    makeRuntime: (binPath) => stubRuntime(log, binPath === bins.metal ? { failStart: "Metal startup failed" } : {}),
  });
  rm._testedBins.add(bins.metal).add(bins.cpu);

  await rm.ensure("a");
  assert.deepStrictEqual(caps, ["metal", "cpu"]);
  assert.deepStrictEqual(log.filter((entry) => entry.op === "start").map((entry) => entry.gpuLayers), [999, 0]);
});

/*
 * Network context opt-in (docs/NETWORK_CONTEXT_PROTOCOL.md §5). The legacy
 * launch must stay byte-identical; an opted-in alias launches with one slot
 * and is advertised only after the live engine proves the window; an
 * opt-in that fails to start costs one same-rung legacy retry and is never
 * held against the build.
 */

const { launchArgs, LlamaCppRuntime } = require("../lib/runtimes/llamacpp");

function makeCtxModels(dir, aliases, maxContextTokens = 32768) {
  const catalogPath = path.join(dir, "catalog.json");
  const packages = {};
  const aliasMap = {};
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  for (const a of aliases) {
    aliasMap[a] = { label: a, package: `${a}@1` };
    packages[`${a}@1`] = { filename: `${a}.gguf`, url: "http://127.0.0.1:1/unused", sha256: "0".repeat(64), runtime: "llamacpp", contextSize: 4096, maxContextTokens };
    fs.writeFileSync(path.join(dir, "models", `${a}.gguf`), "stub");
  }
  fs.writeFileSync(catalogPath, JSON.stringify({ aliases: aliasMap, packages }));
  return new ModelManager({ catalogPath, modelsDir: path.join(dir, "models"), state: new JsonStore(path.join(dir, "st.json"), {}), onEvent: () => {} });
}

const memorySettings = (v = {}) => ({ v, get() { return this.v; }, set(x) { this.v = x; } });

/** Stub engine: records every start's options; an opt-in start (parallel set)
 *  can fail, and its "child" can take a while to exit. */
function ctxRuntime(log, { failOptIn, failLegacy, props, exitDelayMs = 0 } = {}) {
  let running = false;
  let exited = Promise.resolve();
  return {
    start: async (opts) => {
      log.push({ op: "start", opts: { ...opts } });
      if (opts.parallel != null && failOptIn) {
        exited = new Promise((r) => setTimeout(() => { log.push({ op: "exited" }); r(); }, exitDelayMs));
        throw new Error(failOptIn);
      }
      if (opts.parallel == null && failLegacy) throw new Error(failLegacy);
      running = true;
    },
    stop: () => {
      log.push({ op: "stop" });
      running = false;
    },
    waitForExit: async (ms) => {
      log.push({ op: "wait", ms });
      await exited;
      return true;
    },
    probeContext: async () => {
      log.push({ op: "probe" });
      return (typeof props === "function" ? props() : props) ?? null;
    },
    status: () => ({ kind: "stub", running }),
    get endpoint() { return "http://127.0.0.1:1"; },
  };
}

test("context: legacy launch args are byte-identical; an opt-in adds --parallel 1 after the GPU pair", () => {
  const base = { modelPath: "/m/a.gguf", host: "127.0.0.1", port: 5555, contextSize: 4096, gpuLayers: 999, extraArgs: ["--mmproj", "/m/p.gguf"] };
  assert.deepStrictEqual(launchArgs(base), [
    "--model", "/m/a.gguf", "--host", "127.0.0.1", "--port", "5555", "--ctx-size", "4096", "--n-gpu-layers", "999", "--mmproj", "/m/p.gguf",
  ]);
  assert.deepStrictEqual(launchArgs({ ...base, contextSize: 16384, parallel: 1 }), [
    "--model", "/m/a.gguf", "--host", "127.0.0.1", "--port", "5555", "--ctx-size", "16384", "--n-gpu-layers", "999", "--parallel", "1", "--mmproj", "/m/p.gguf",
  ]);
});

test("context: without settings every load is the legacy launch and nothing is probed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-legacy-"));
  const log = [];
  const rm = new RuntimeManager({
    models: makeCtxModels(dir, ["a"]),
    hardware: { capabilities: {} },
    onEvent: () => {},
    makeRuntime: () => ctxRuntime(log, { props: { nCtx: 32768, totalSlots: 1 } }),
  });
  await rm.ensure("a");
  const starts = log.filter((l) => l.op === "start");
  assert.strictEqual(starts.length, 1);
  assert.deepStrictEqual(Object.keys(starts[0].opts).sort(), ["contextSize", "extraArgs", "gpuLayers", "modelPath", "sizeBytes"]);
  assert.strictEqual(starts[0].opts.contextSize, 4096);
  assert.strictEqual(log.filter((l) => l.op === "probe").length, 0, "the legacy path never calls /props");
  assert.strictEqual(rm.advertisedContext("a"), null);
  assert.strictEqual(await rm.verifiedContextFor("a"), null);
  assert.strictEqual(rm.contextStatus().configurable, false);
  await assert.rejects(() => rm.configureContext({ alias: "a", contextTokens: 16384 }), /not available/);
});

test("context: opt-in launches one slot, verifies from /props with retries, then advertises", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-optin-"));
  const log = [];
  const events = [];
  let probes = 0;
  const rm = new RuntimeManager({
    models: makeCtxModels(dir, ["a"]),
    hardware: { capabilities: {} },
    onEvent: (e) => events.push(e),
    contextSettings: memorySettings({ a: { contextTokens: 16384, maxOutputTokens: 2048 } }),
    // /props is not up on the first two tries (slow first boot).
    makeRuntime: () => ctxRuntime(log, { props: () => (++probes < 3 ? null : { nCtx: 16384, totalSlots: 1 }) }),
  });
  rm.ctxProbeBackoffMs = 1;
  let changes = 0;
  rm.onContextChange(() => changes++);
  await rm.ensure("a");
  const starts = log.filter((l) => l.op === "start");
  assert.strictEqual(starts.length, 1);
  assert.strictEqual(starts[0].opts.contextSize, 16384);
  assert.strictEqual(starts[0].opts.parallel, 1);
  assert.strictEqual(probes, 3, "probed up to three times");
  assert.deepStrictEqual(rm.advertisedContext("a"), { contextTokens: 16384, maxOutputTokens: 2048 });
  assert.strictEqual(changes, 1, "the verified set changed once");
  assert.ok(events.some((e) => e.type === "runtime:context" && e.verified === true && e.contextTokens === 16384));
  assert.strictEqual(rm.plannedContext("a"), 16384);
  assert.deepStrictEqual(await rm.verifiedContextFor("a"), { contextTokens: 16384, maxOutputTokens: 2048 });
  const st = rm.contextStatus().models.find((m) => m.alias === "a");
  assert.strictEqual(st.parallel, 1, "an opted-in alias reports one request at a time");
  assert.strictEqual(st.verified, true);

  // Same alias again: served, no reload, no extra probe on ensure().
  const before = log.length;
  await rm.ensure("a");
  const hold = await rm.acquireFor("a");
  hold.release();
  assert.strictEqual(log.slice(before).filter((l) => l.op === "start").length, 0, "no reload loop");
});

test("context: an engine that does not prove the window keeps serving locally and is never advertised", async () => {
  for (const props of [{ nCtx: 4096, totalSlots: 4 }, { nCtx: 16384, totalSlots: 4 }, { nCtx: 8192, totalSlots: 1 }, { nCtx: "16384", totalSlots: 1 }, null]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-unver-"));
    const log = [];
    const events = [];
    const rm = new RuntimeManager({
      models: makeCtxModels(dir, ["a"]),
      hardware: { capabilities: {} },
      onEvent: (e) => events.push(e),
      contextSettings: memorySettings({ a: { contextTokens: 16384 } }),
      makeRuntime: () => ctxRuntime(log, { props }),
    });
    rm.ctxProbeBackoffMs = 1;
    await rm.ensure("a");
    assert.strictEqual(rm.runtime.status().running, true, "still serving locally");
    assert.strictEqual(rm.advertisedContext("a"), null, `not advertised for ${JSON.stringify(props)}`);
    assert.ok(events.some((e) => e.type === "runtime:context" && e.verified === false));
    assert.strictEqual(rm.plannedContext("a"), null, "local planning falls back to the catalog window");
    assert.strictEqual(await rm.verifiedContextFor("a"), null);
    await rm.ensure("a");
    assert.strictEqual(log.filter((l) => l.op === "start").length, 1, "no reload loop");
  }
});

test("context: an opt-in start failure awaits the child's exit, then retries legacy once on the same rung", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-fail-"));
  const log = [];
  const events = [];
  const bins = { vulkan: path.join(dir, "vulkan", "llama-server"), cpu: path.join(dir, "cpu", "llama-server") };
  const state = new JsonStore(path.join(dir, "state.json"), {});
  const made = [];
  const rm = new RuntimeManager({
    models: makeCtxModels(dir, ["a"]),
    hardware: { capabilities: { vulkanEligible: true } },
    onEvent: (e) => { events.push(e); log.push({ op: "event", type: e.type }); },
    state,
    appVersion: "test-1",
    provisioner: { ensure: async (_kind, { cap }) => bins[cap] },
    contextSettings: memorySettings({ a: { contextTokens: 32768 } }),
    makeRuntime: (binPath) => {
      made.push(binPath);
      return ctxRuntime(log, { failOptIn: "llama-server exited during startup (exit code 3221226505)", exitDelayMs: 60 });
    },
  });
  rm._testedBins.add(bins.vulkan).add(bins.cpu);
  await rm.ensure("a");
  assert.deepStrictEqual(made, [bins.vulkan, bins.vulkan], "a fresh runtime on the SAME rung");
  const ops = log.filter((l) => l.op !== "event" || l.type === "runtime:context-fallback").map((l) => l.op === "event" ? l.type : l.op);
  assert.deepStrictEqual(ops, ["start", "stop", "wait", "exited", "runtime:context-fallback", "start"], "exit is awaited before the legacy retry");
  const legacyStart = log.filter((l) => l.op === "start")[1].opts;
  assert.deepStrictEqual(Object.keys(legacyStart).sort(), ["contextSize", "extraArgs", "gpuLayers", "modelPath", "sizeBytes"], "byte-identical legacy opts");
  assert.strictEqual(legacyStart.contextSize, 4096);
  assert.strictEqual(legacyStart.gpuLayers, 999);
  assert.deepStrictEqual(state.get("badBuilds", {}), {}, "an opt-in failure is never a verdict on the build");
  assert.strictEqual(rm._llamaDead, false);
  assert.strictEqual(rm.advertisedContext("a"), null);
  assert.ok(rm.contextStatus().models.find((m) => m.alias === "a").failed);
  // Session-failed: the next demand is plain legacy service, no reload loop.
  const n = log.filter((l) => l.op === "start").length;
  await rm.ensure("a");
  const hold = await rm.acquireFor("a");
  hold.release();
  assert.strictEqual(log.filter((l) => l.op === "start").length, n);
});

test("context: a failing legacy retry right after an opt-in records nothing; a later plain hard crash still does", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-after-"));
  const log = [];
  const bins = { vulkan: path.join(dir, "vulkan", "llama-server"), cpu: path.join(dir, "cpu", "llama-server") };
  const state = new JsonStore(path.join(dir, "state.json"), {});
  const settings = memorySettings({ a: { contextTokens: 16384 } });
  const crash = "llama-server exited during startup (exit code 3221226505)";
  const rm = new RuntimeManager({
    models: makeCtxModels(dir, ["a", "b"]),
    hardware: { capabilities: { vulkanEligible: true } },
    onEvent: () => {},
    state,
    appVersion: "test-1",
    provisioner: { ensure: async (_kind, { cap }) => bins[cap] },
    contextSettings: settings,
    makeRuntime: (binPath) => ctxRuntime(log, binPath === bins.vulkan ? { failOptIn: crash, failLegacy: crash } : {}),
  });
  rm._testedBins.add(bins.vulkan).add(bins.cpu);

  await rm.ensure("a");
  assert.deepStrictEqual(state.get("badBuilds", {}), {}, "the afterOptIn failure wrote no badBuilds");
  assert.strictEqual(rm._llamaDead, false, "...and set no _llamaDead");
  const starts = log.filter((l) => l.op === "start");
  assert.deepStrictEqual(starts.map((s) => [s.opts.contextSize, s.opts.parallel ?? null, s.opts.gpuLayers]), [
    [16384, 1, 999], // vulkan opt-in
    [4096, null, 999], // vulkan legacy retry (fails: afterOptIn)
    [4096, null, 0], // the ladder falls through to CPU, plain legacy
  ]);

  // A later plain legacy load (no opt-in) that hard-crashes is recorded as today.
  await rm.ensure("b");
  assert.ok(state.get("badBuilds", {})[bins.vulkan], "a genuine hard crash is still remembered");
});

test("context: an opt-in failure never classifies the machine as llama-dead", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-dead-"));
  const log = [];
  const forced = { optIn: true };
  const rm = new RuntimeManager({
    models: makeCtxModels(dir, ["a", "b"]),
    hardware: { capabilities: {} },
    onEvent: () => {},
    contextSettings: memorySettings({ a: { contextTokens: 16384 } }),
    // Forced binary (no provisioner): both starts fail with a message that
    // would otherwise read as a crashed self-test.
    makeRuntime: () => ctxRuntime(log, forced.optIn
      ? { failOptIn: "Engine self-test failed for llama-server (exit code 5)", failLegacy: "Engine self-test failed for llama-server (exit code 5)" }
      : { failLegacy: "Engine self-test failed for llama-server (exit code 5)" }),
  });
  await assert.rejects(() => rm.ensure("a"));
  assert.strictEqual(rm._llamaDead, false, "the failure right after an opt-in classifies nothing");
  forced.optIn = false;
  await assert.rejects(() => rm.ensure("b"));
  assert.strictEqual(rm._llamaDead, true, "a plain legacy self-test failure still does");
});

test("context: a remembered self-test crash still classifies the machine exactly as before (badBuilds skip + plain CPU failure)", async () => {
  // HEAD behaviour: the skipped rung's "crashed on this machine before
  // (... self-test failed ...)" reason is part of the ladder error, so the
  // machine is llama-dead even though the CPU rung failed for another reason.
  // A remembered hard crash (no self-test signature) does not classify.
  for (const [reason, dead] of [
    ["Engine self-test failed for llama-server (exit code 3221225477)", true],
    ["llama-server exited during startup (exit code 3221225477)", false],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-skip-"));
    const log = [];
    const bins = { vulkan: path.join(dir, "vulkan", "llama-server"), cpu: path.join(dir, "cpu", "llama-server") };
    const state = new JsonStore(path.join(dir, "state.json"), {});
    state.set("badBuilds", { [bins.vulkan]: { reason, appVersion: "test-1" } });
    const rm = new RuntimeManager({
      models: makeModels(dir, ["a"]),
      hardware: { capabilities: { vulkanEligible: true } },
      onEvent: () => {},
      state,
      appVersion: "test-1",
      provisioner: { ensure: async (_kind, { cap }) => bins[cap] },
      makeRuntime: () => stubRuntime(log, { failStart: "llama-server exited during startup (port in use)" }),
    });
    rm._testedBins.add(bins.vulkan).add(bins.cpu);
    await assert.rejects(() => rm.ensure("a"), /\[vulkan\] skipped — crashed on this machine before/);
    assert.deepStrictEqual(log.filter((l) => l.op === "start").map((l) => l.gpuLayers), [0], "only the CPU rung started");
    assert.strictEqual(rm._llamaDead, dead, reason);
  }
});

test("context: configuring never loads; the next demand reloads through the drain/hold path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-config-"));
  const log = [];
  const events = [];
  const settings = memorySettings({});
  const rm = new RuntimeManager({
    models: makeCtxModels(dir, ["a", "phi"], 32768),
    hardware: { capabilities: {} },
    onEvent: (e) => events.push(e),
    contextSettings: settings,
    makeRuntime: () => ctxRuntime(log, { props: { nCtx: 32768, totalSlots: 1 } }),
  });
  rm.drainMaxMs = 5000;
  let changes = 0;
  rm.onContextChange(() => changes++);
  const hold = await rm.acquireFor("a");
  assert.strictEqual(log.filter((l) => l.op === "start").length, 1);

  await assert.rejects(() => rm.configureContext({ alias: "a", contextTokens: 8192 }), /16384 or 32768/);
  await assert.rejects(() => rm.configureContext({ alias: "a", contextTokens: 16384, maxOutputTokens: 9000 }), /512 to 4096/);
  await assert.rejects(() => rm.configureContext({ alias: "nope", contextTokens: 16384 }), /Unknown model/);
  await assert.rejects(() => rm.configureContext({ alias: "__proto__", contextTokens: null }), /Unknown model/);
  assert.deepStrictEqual(settings.v, {}, "nothing persisted from invalid requests");

  const st = await rm.configureContext({ alias: "a", contextTokens: 32768, maxOutputTokens: 4096 });
  assert.deepStrictEqual(settings.v, { a: { contextTokens: 32768, maxOutputTokens: 4096 } });
  assert.ok(events.some((e) => e.type === "runtime:context-configured" && e.alias === "a" && e.contextTokens === 32768));
  assert.strictEqual(changes, 1, "listeners hear the configuration");
  assert.strictEqual(st.models.find((m) => m.alias === "a").parallel, 1);
  assert.strictEqual(log.filter((l) => l.op === "start").length, 1, "configuring loads nothing");

  // The stream in flight keeps its engine; the reload waits for the hold.
  const switching = rm.ensure("a");
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(log.filter((l) => l.op === "stop").length, 0, "the serving engine is not stopped mid-stream");
  hold.release();
  await switching;
  const starts = log.filter((l) => l.op === "start");
  assert.strictEqual(starts.length, 2);
  assert.deepStrictEqual([starts[1].opts.contextSize, starts[1].opts.parallel], [32768, 1]);
  assert.deepStrictEqual(rm.advertisedContext("a"), { contextTokens: 32768, maxOutputTokens: 4096 });

  // Clearing (null or 4096) drops the entry and the advertisement at once.
  await rm.configureContext({ alias: "a", contextTokens: 4096 });
  assert.deepStrictEqual(settings.v, {});
  assert.strictEqual(rm.advertisedContext("a"), null);
  await rm.ensure("a");
  assert.deepStrictEqual([log.filter((l) => l.op === "start")[2].opts.contextSize, log.filter((l) => l.op === "start")[2].opts.parallel], [4096, undefined]);
});

test("context: a resident alias reloaded at a new tier announces /worker/warming once (isServing)", async () => {
  const http = require("http");
  const { Worker } = require("../lib/worker");
  const listenOn = (handler) => new Promise((r) => {
    const srv = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => handler(req, res, raw));
    });
    srv.listen(0, "127.0.0.1", () => r({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
  const warmings = [];
  const sched = await listenOn((req, res, raw) => {
    if (req.url.startsWith("/worker/warming")) warmings.push(JSON.parse(raw));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  const engine = await listenOn((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-warming-"));
  const log = [];
  const settings = memorySettings({});
  const rm = new RuntimeManager({
    models: makeCtxModels(dir, ["a"]),
    hardware: { capabilities: {} },
    onEvent: () => {},
    contextSettings: settings,
    makeRuntime: () => {
      const rt = ctxRuntime(log, { props: { nCtx: 16384, totalSlots: 1 } });
      Object.defineProperty(rt, "endpoint", { get: () => engine.base });
      return rt;
    },
  });
  const worker = new Worker({
    schedulerUrl: sched.base,
    wallet: { address: "1abc", signHash: async () => "sig" },
    runtime: rm,
    hardware: {},
    onEvent: () => {},
  });
  worker.token = "tok";
  const settle = async (n) => {
    for (let i = 0; i < 40 && warmings.length < n; i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 100));
  };
  const job = (id) => ({ id, type: "chat", model: "a", messages: [{ role: "user", content: "q" }] });
  try {
    await rm.ensure("a");
    assert.strictEqual(rm.isServing("a"), true);
    await worker._execute(job("j-resident"), null);
    await settle(0);
    assert.strictEqual(warmings.length, 0, "a resident, correctly loaded alias stays silent");

    // Same alias, new tier: still resident, but the next hold reloads it.
    await rm.configureContext({ alias: "a", contextTokens: 16384 });
    assert.strictEqual(rm.activeAlias, "a");
    assert.strictEqual(rm.isServing("a"), false, "resident but due a reload");
    await worker._execute(job("j-reload"), null);
    await settle(1);
    assert.strictEqual(warmings.length, 1, "the same-alias context reload announced itself once");
    assert.strictEqual(warmings[0].jobId, "j-reload");
    const starts = log.filter((l) => l.op === "start");
    assert.deepStrictEqual(starts.map((s) => s.opts.contextSize), [4096, 16384], "it really reloaded at the new tier");

    assert.strictEqual(rm.isServing("a"), true);
    await worker._execute(job("j-after"), null);
    await settle(2);
    assert.strictEqual(warmings.length, 1, "no further warming once serving at the new tier");
  } finally {
    rm.stop();
    sched.srv.close();
    engine.srv.close();
  }
});

test("context: POST clears the session-failed marker so the owner can retry the tier", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-retry-"));
  const log = [];
  const behaviour = { failOptIn: "out of memory" };
  const rm = new RuntimeManager({
    models: makeCtxModels(dir, ["a"]),
    hardware: { capabilities: {} },
    onEvent: () => {},
    contextSettings: memorySettings({ a: { contextTokens: 16384 } }),
    makeRuntime: () => ctxRuntime(log, { ...behaviour, props: { nCtx: 16384, totalSlots: 1 } }),
  });
  await rm.ensure("a");
  assert.strictEqual(rm.advertisedContext("a"), null);
  delete behaviour.failOptIn;
  await rm.configureContext({ alias: "a", contextTokens: 16384 });
  await rm.ensure("a");
  assert.deepStrictEqual(rm.advertisedContext("a"), { contextTokens: 16384, maxOutputTokens: 512 });
});

test("context: a failed live probe marks the alias unverified and tells listeners", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-live-"));
  const log = [];
  let props = { nCtx: 16384, totalSlots: 1 };
  const rm = new RuntimeManager({
    models: makeCtxModels(dir, ["a"]),
    hardware: { capabilities: {} },
    onEvent: () => {},
    contextSettings: memorySettings({ a: { contextTokens: 16384, maxOutputTokens: 1024 } }),
    makeRuntime: () => ctxRuntime(log, { props: () => props }),
  });
  rm.ctxProbeBackoffMs = 1;
  await rm.ensure("a");
  let changes = 0;
  rm.onContextChange(() => changes++);
  const hold = await rm.acquireFor("a");
  props = { nCtx: 4096, totalSlots: 4 }; // the engine changed under us
  assert.strictEqual(await rm.verifiedContextFor("a"), null);
  hold.release();
  assert.strictEqual(rm.advertisedContext("a"), null);
  assert.strictEqual(changes, 1);
});

test("context: the real adapter launches --parallel 1 and /props proves the window; legacy never probes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctx-real-"));
  const logFile = path.join(dir, "llama.log");
  const bin = path.join(__dirname, "fixtures", "fake-llama-server");
  const prev = { log: process.env.FAKE_LLAMA_LOG, delay: process.env.FAKE_LLAMA_DELAY_MS };
  process.env.FAKE_LLAMA_LOG = logFile;
  process.env.FAKE_LLAMA_DELAY_MS = "50";
  const lines = () => fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  try {
    const settings = memorySettings({});
    const rm = new RuntimeManager({
      models: makeCtxModels(dir, ["a"]),
      hardware: { capabilities: {} },
      onEvent: () => {},
      contextSettings: settings,
      makeRuntime: () => new LlamaCppRuntime({ binPath: bin, onEvent: () => {} }),
    });
    await rm.ensure("a");
    const port = rm.runtime.port;
    assert.deepStrictEqual(lines(), [{ argv: ["--model", path.join(dir, "models", "a.gguf"), "--host", "127.0.0.1", "--port", String(port), "--ctx-size", "4096", "--n-gpu-layers", "0"] }]);
    const old = rm.runtime;
    await rm.configureContext({ alias: "a", contextTokens: 16384 });
    await rm.ensure("a");
    assert.strictEqual(await old.waitForExit(5000), true, "the replaced child really exited");
    const after = lines();
    assert.deepStrictEqual(after[1].argv.slice(6), ["--ctx-size", "16384", "--n-gpu-layers", "0", "--parallel", "1"]);
    assert.ok(after.slice(2).every((l) => l.props), "only the opted-in engine was probed");
    assert.deepStrictEqual(rm.advertisedContext("a"), { contextTokens: 16384, maxOutputTokens: 512 });
    assert.deepStrictEqual(await rm.verifiedContextFor("a"), { contextTokens: 16384, maxOutputTokens: 512 });
    rm.stop();
  } finally {
    if (prev.log === undefined) delete process.env.FAKE_LLAMA_LOG;
    else process.env.FAKE_LLAMA_LOG = prev.log;
    if (prev.delay === undefined) delete process.env.FAKE_LLAMA_DELAY_MS;
    else process.env.FAKE_LLAMA_DELAY_MS = prev.delay;
  }
});

test("context: an auto-slot engine (no --parallel) is never verified even with a big --ctx-size", async () => {
  const rt = { status: () => ({ kind: "llamacpp", running: true }), probeContext: async () => ({ nCtx: 8192, totalSlots: 4 }) };
  const rm = new RuntimeManager({ models: { catalog: {} }, hardware: {}, onEvent: () => {}, makeRuntime: () => rt });
  assert.strictEqual(await rm._probeTier(rt, 16384), false);
  rt.probeContext = async () => ({ nCtx: 32768, totalSlots: 4 });
  assert.strictEqual(await rm._probeTier(rt, 16384), false, "more than one slot is unverified");
  rt.probeContext = async () => ({ nCtx: 16384, totalSlots: null });
  assert.strictEqual(await rm._probeTier(rt, 16384), true, "total_slots absent: n_ctx alone decides");
});
