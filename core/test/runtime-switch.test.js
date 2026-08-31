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
