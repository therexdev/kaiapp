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

test("heal ladder: a crashing self-test triggers one fresh re-extract, then serves", async () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-heal-"));
  const bin = path.join(dir, "llama-server");
  // A binary that dies with no output — the field crash, portably.
  fs.writeFileSync(bin, "#!/bin/sh\nexit 139\n");
  fs.chmodSync(bin, 0o755);

  const events = [];
  const started = [];
  const mgr = new RuntimeManager({
    models: {
      resolveAlias: () => ({ packageId: "p@1", contextSize: 4096, sizeBytes: 1e9 }),
      ensurePackage: async () => "/fake/model.gguf",
    },
    hardware: null,
    provisioner: {
      ensure: async () => bin,
      // The "fresh extract" replaces the broken binary with a working one.
      reprovision: async () => {
        fs.writeFileSync(bin, "#!/bin/sh\necho b10423\n");
        fs.chmodSync(bin, 0o755);
        return bin;
      },
      selectBuild: () => ({}),
    },
    makeRuntime: () => ({
      start: async () => (started.push(1), { endpoint: "http://127.0.0.1:1" }),
      stop() {},
      status: () => ({ running: true }),
    }),
    onEvent: (e) => events.push(e),
    state: null,
  });
  // hardware null but provisioner set → ladder runs with caps [cpu]
  await mgr.ensure("koinos-fast");
  assert.strictEqual(started.length, 1, "model serves after the heal");
  assert.ok(events.some((e) => e.type === "runtime:heal" && e.step === "reprovision"), "the heal is announced");
  assert.strictEqual(mgr.status().lastLoadError, null);
  mgr.stop();
});

test("ggml-cpu variant strip keeps the conservative baseline and drops the exotic ones", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { stripCpuVariants } = require("../lib/runtimes/llamacpp");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-strip-"));
  const bin = path.join(dir, "llama-server.exe");
  for (const f of [
    "llama-server.exe", "ggml.dll", "ggml-base.dll", "llama.dll",
    "ggml-cpu.dll", "ggml-cpu-haswell.dll", "ggml-cpu-icelake.dll",
    "ggml-cpu-skylakex.dll", "ggml-cpu-sapphirerapids.dll", "ggml-cpu-alderlake.dll",
  ]) fs.writeFileSync(path.join(dir, f), "x");

  assert.strictEqual(stripCpuVariants(bin), true, "strip reports work done");
  const left = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(
    left,
    ["ggml-base.dll", "ggml-cpu-haswell.dll", "ggml-cpu.dll", "ggml.dll", "llama-server.exe", "llama.dll"].sort(),
    "baseline variants and non-variant DLLs survive; exotic ISA variants are gone"
  );
  assert.strictEqual(stripCpuVariants(bin), false, "nothing left to strip → no false claim of healing");
});

test("register storm is impossible: single-flight gate + in-flight poll recall", async () => {
  const http = require("http");
  const { Worker } = require("../lib/worker");
  let registers = 0;
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith("/worker/register")) {
      registers++;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, token: `wt_${registers}` }));
    }
    res.writeHead(204);
    res.end();
  });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", function () { r(this.address().port); }));
  try {
    const worker = new Worker({
      schedulerUrl: `http://127.0.0.1:${port}`,
      wallet: { address: "1TestAddr", signHash: async () => "sig" },
      runtime: { ensure: async () => "http://127.0.0.1:1" },
      hardware: null,
      models: null,
      onEvent: () => {},
    });

    // Three concurrent register attempts (watchdog racing the 401 path)
    // collapse into ONE server-side registration — no token churn.
    await Promise.all([worker._register(), worker._register(), worker._register()]);
    assert.strictEqual(registers, 1, "single-flight: three concurrent callers, one register");
    assert.strictEqual(worker.token, "wt_1");

    // A register recalls the in-flight long-poll: the old token it carries
    // just died server-side, so waiting out the hold only buys a 401.
    worker._pollAbort = new AbortController();
    let recalled = false;
    worker._pollAbort.signal.addEventListener("abort", () => (recalled = true));
    await worker._register();
    assert.strictEqual(registers, 2);
    assert.strictEqual(worker.token, "wt_2");
    assert.strictEqual(recalled, true, "in-flight poll recalled so the loop re-polls with the fresh token");
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});
