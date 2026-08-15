"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const { RuntimeManager } = require("../lib/runtime-manager");

/*
 * Field finding (v0.19, Windows/Arc): a model that failed to load showed
 * testers a bare "Model load failed" — the engine's actual complaint
 * never reached a human. These pin the diagnosis chain: the manager
 * remembers WHY the last load failed, and a success clears it.
 */

function mkManager(startImpl) {
  return new RuntimeManager({
    models: {
      resolveAlias: () => ({ packageId: "p@1", contextSize: 4096 }),
      ensurePackage: async () => "/fake/model.gguf",
    },
    hardware: null, // no GPU: ladder is just the CPU rung
    provisioner: null, // forced-binary path: boot(null, …)
    makeRuntime: () => ({
      start: startImpl,
      stop() {},
      status: () => ({ running: false }),
    }),
    onEvent: () => {},
  });
}

test("a failed load records the engine's reason; the next success clears it", async () => {
  let attempts = 0;
  const mgr = mkManager(async () => {
    attempts++;
    if (attempts === 1) {
      throw new Error("llama-server exited during startup (exit code 1)\nllama-server said: unknown model architecture 'gemma3'");
    }
    return { endpoint: "http://127.0.0.1:9999" };
  });

  await assert.rejects(() => mgr.ensure("gemma3-4b"), /gemma3/);
  const err = mgr.status().lastLoadError;
  assert.ok(err, "failure is recorded for the UI");
  assert.strictEqual(err.alias, "gemma3-4b");
  assert.match(err.message, /unknown model architecture/, "the stderr tail survives to the status pane");

  await mgr.ensure("gemma3-4b");
  assert.strictEqual(mgr.status().lastLoadError, null, "success clears the stale diagnosis");
  mgr.stop();
});

test("when every engine rung fails, the error names each rung's reason — not just the last", async () => {
  const mgr = new RuntimeManager({
    models: {
      resolveAlias: () => ({ packageId: "p@1", contextSize: 4096, sizeBytes: 1e9 }),
      ensurePackage: async () => "/fake/model.gguf",
    },
    hardware: { capabilities: { cudaEligible: false, vulkanEligible: true } },
    provisioner: { ensure: async (_k, { cap }) => `/bins/${cap}/llama-server` },
    makeRuntime: (binPath) => ({
      start: async () => {
        throw new Error(binPath.includes("vulkan") ? "pipeline compile crashed" : "unknown model architecture 'gemma3'");
      },
      stop() {},
      status: () => ({ running: false }),
    }),
    onEvent: () => {},
  });
  // selfTest would run real binaries — the fake paths must skip it.
  mgr._testedBins.add("/bins/vulkan/llama-server");
  mgr._testedBins.add("/bins/cpu/llama-server");

  await assert.rejects(
    () => mgr.ensure("gemma3-12b"),
    (e) => /\[vulkan\] pipeline compile crashed/.test(e.message) && /\[cpu\] unknown model architecture/.test(e.message),
    "both rung reasons survive into one error"
  );
  assert.match(mgr.status().lastLoadError.message, /\[vulkan\].*\[cpu\]/s);
  mgr.stop();
});

test("a build that crashes self-test is remembered and skipped — not re-crashed on every load", async () => {
  const { JsonStore } = require("../lib/store");
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-badbuild-"));
  const state = new JsonStore(path.join(dir, "state.json"), {});
  const started = [];
  const attempts = [];
  const mk = (appVersion) =>
    new RuntimeManager({
      models: {
        resolveAlias: () => ({ packageId: "p@1", contextSize: 4096, sizeBytes: 1e9 }),
        ensurePackage: async () => "/fake/model.gguf",
      },
      hardware: { capabilities: { cudaEligible: false, vulkanEligible: true } },
      // The vulkan "binary" doesn't exist → the REAL selfTest crashes on it,
      // exactly like an access-violation build; cpu is pre-marked tested.
      provisioner: { ensure: async (_k, { cap }) => (attempts.push(cap), path.join(dir, cap, "llama-server")) },
      makeRuntime: (binPath) => ({
        start: async () => {
          started.push(binPath);
          return { endpoint: "http://127.0.0.1:1" };
        },
        stop() {},
        status: () => ({ running: true }),
      }),
      onEvent: () => {},
      state,
      appVersion,
    });

  const mgr = mk("0.22.1");
  mgr._testedBins.add(path.join(dir, "cpu", "llama-server")); // cpu build "passes"
  await mgr.ensure("gemma3-12b"); // vulkan self-test crashes → cpu serves
  assert.strictEqual(started.length, 1);
  assert.match(started[0], /cpu/, "load lands on the cpu rung");
  const bad = Object.values(state.get("badBuilds", {}))[0];
  assert.match(bad?.reason || "", /self-test failed/i, "the crash is remembered per binary");
  assert.strictEqual(bad.appVersion, "0.22.1", "…scoped to the app version that saw it");

  // Same app version restarting: the bad build is skipped outright (the
  // self-test never runs — no started entry for vulkan, no re-crash).
  const mgr2 = mk("0.22.1");
  mgr2._testedBins.add(path.join(dir, "cpu", "llama-server"));
  await mgr2.ensure("gemma3-12b");
  assert.strictEqual(started.length, 2);
  assert.match(started[1], /cpu/, "restart goes straight to cpu — no re-crash");

  // An app UPDATE retries the build once — loader fixes (the CRT heal) can
  // revive a build without changing its bits. It still crashes here, so it
  // lands on cpu and the memory is re-stamped with the new version.
  const mgr3 = mk("0.23.0");
  mgr3._testedBins.add(path.join(dir, "cpu", "llama-server"));
  await mgr3.ensure("gemma3-12b");
  assert.match(started[2], /cpu/);
  assert.strictEqual(Object.values(state.get("badBuilds", {}))[0].appVersion, "0.23.0", "retried and re-remembered under the new version");
  mgr.stop();
  mgr2.stop();
  mgr3.stop();
});
