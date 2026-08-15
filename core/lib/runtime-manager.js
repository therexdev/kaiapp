"use strict";

/*
 * Runtime manager (spec §4/§6): owns which model is loaded on which runtime.
 * M1 scope: one active runtime + one loaded model at a time; the gateway
 * asks ensure(alias) before proxying. Switching models stops the current
 * runtime and starts the requested one.
 */

class RuntimeManager {
  constructor({ models, makeRuntime, hardware, provisioner, makeFallback, preferFallback, onEvent, state }) {
    this.models = models; // ModelManager
    this.makeRuntime = makeRuntime; // (binPath|null) => runtime adapter instance
    this.hardware = hardware; // detection snapshot (may be null in tests)
    this.provisioner = provisioner || null; // RuntimeProvisioner (null when a bin is forced)
    this.makeFallback = makeFallback || null; // async () => alt runtime (e.g. Ollama) or null
    this.preferFallback = !!preferFallback; // KAI_RUNTIME override: skip llama.cpp entirely
    this.onEvent = onEvent || (() => {});
    this.state = state || null; // JsonStore: remembers builds that crash on THIS machine
    this.runtime = null;
    this.activeAlias = null;
    this._loading = null; // in-flight ensure() promise
    this._stopped = false; // stop() raced against an in-flight load
    this._testedBins = new Set(); // self-test once per binary per session
  }

  /** Name the active runtime serves the model under (null = passthrough). */
  servedModelName() {
    return this.runtime?.servedName?.() ?? null;
  }

  status() {
    return {
      activeAlias: this.activeAlias,
      loading: !!this._loading,
      runtime: this.runtime ? this.runtime.status() : null,
      // Why the last load failed (null after a success) — the UI shows
      // this instead of a bare "Model load failed" nobody can act on.
      lastLoadError: this.lastLoadError || null,
    };
  }

  /** Endpoint of the healthy runtime serving `alias`, starting it if needed. */
  /** Can ANY engine run on this machine? Called before big downloads so a
   *  platform with no managed build (today: Linux without Ollama) fails in
   *  plain language up front instead of after a gigabyte. A forced binary
   *  or a working fallback engine counts as viable. */
  async preflight() {
    if (!this.provisioner) return; // forced binary (KAI_LLAMA_BIN) — viable
    try {
      this.provisioner.selectBuild("llamacpp");
      return;
    } catch {
      /* no managed build — check the fallback before refusing */
    }
    if (this.makeFallback && (await Promise.resolve(this.makeFallback()).catch(() => null))) return;
    throw new Error(
      process.platform === "linux"
        ? "Koinos AI on Linux currently needs Ollama installed (free, from ollama.com) — install it and relaunch, and Koinos AI will use it as the engine."
        : "No AI engine build is available for this machine yet — check for an app update, or install Ollama (ollama.com) as a fallback engine."
    );
  }

  async ensure(alias) {
    this._stopped = false; // new demand revives the manager
    // §32: consult the catalog EVERY time — the already-running fast path
    // below must never keep serving a model that was quarantined after it
    // loaded. If this engine is the one running the revoked package, take
    // it down on the spot before refusing.
    try {
      this.models.resolveAlias(alias);
    } catch (e) {
      if (this.activeAlias === alias && this.runtime?.status().running) this.stop();
      throw e;
    }
    if (this.activeAlias === alias && this.runtime?.status().running) {
      return this.runtime.endpoint;
    }
    // Single-flight: concurrent requests for the same alias share the load.
    // A different model mid-load (one runtime slot) is WAITED OUT rather
    // than refused — a boot warm-start racing the first chat message used
    // to throw here, which the §7 router would read as a real capability
    // miss and overflow a locally-servable request to the paid network.
    while (this._loading && this._loading.alias !== alias) {
      await this._loading.promise.catch(() => {});
    }
    if (this._loading) return this._loading.promise;
    if (this.activeAlias === alias && this.runtime?.status().running) {
      return this.runtime.endpoint;
    }

    const promise = this._load(alias);
    this._loading = { alias, promise };
    try {
      return await promise;
    } finally {
      this._loading = null;
    }
  }

  async _load(alias) {
    const resolved = this.models.resolveAlias(alias);
    const modelPath = await this.models.ensurePackage(resolved.packageId);
    const kind = resolved.runtime || "llamacpp";
    const wantGpu = !!this.hardware?.capabilities?.cudaEligible;

    if (this.runtime) {
      this.onEvent({ type: "runtime:switching", from: this.activeAlias, to: alias });
      this.runtime.stop();
      this.runtime = null;
      this.activeAlias = null;
    }

    // Escalation ladder (§5: never strand the user): CUDA build when
    // eligible -> CPU build -> external fallback runtime (Ollama) when one
    // is present. Every provisioned binary passes a self-test before boot,
    // so a build this machine can't run fails fast and quietly moves on.
    const { selfTest } = require("./runtimes/llamacpp");
    const boot = async (binPath, gpuLayers) => {
      if (binPath && !this._testedBins.has(binPath)) {
        selfTest(binPath);
        this._testedBins.add(binPath);
      }
      const runtime = this.makeRuntime(binPath);
      await runtime.start({ modelPath, contextSize: resolved.contextSize || 4096, gpuLayers, sizeBytes: resolved.sizeBytes || 0 });
      return runtime;
    };

    const bootLlama = async () => {
      if (!this.provisioner) return boot(null, wantGpu ? 999 : 0);
      // Engine ladder by capability: CUDA (NVIDIA), Vulkan (any real GPU —
      // Intel Arc, AMD, NVIDIA), then CPU. Each rung self-tests before boot.
      const caps = [];
      if (wantGpu) caps.push("cuda");
      if (this.hardware?.capabilities?.vulkanEligible) caps.push("vulkan");
      caps.push("cpu");
      const rungErrors = [];
      const badBuilds = this.state?.get("badBuilds", {}) || {};
      for (let i = 0; i < caps.length; i++) {
        const cap = caps[i];
        try {
          const binPath = await this.provisioner.ensure(kind, { cap });
          // A build that crashed its self-test on this machine stays
          // skipped (an app update ships a new version dir, which retries
          // naturally). Re-crashing it on every load wasted a rung and
          // scared the status pane for nothing.
          if (badBuilds[binPath]) {
            rungErrors.push(`[${cap}] skipped — crashed self-test on this machine before (${badBuilds[binPath]})`);
            continue;
          }
          return await boot(binPath, cap === "cpu" ? 0 : 999);
        } catch (e) {
          rungErrors.push(`[${cap}] ${String(e.message)}`);
          if (this.state && /self-test failed/i.test(String(e.message)) && cap !== "cpu") {
            const bad = this.state.get("badBuilds", {});
            try {
              bad[await this.provisioner.ensure(kind, { cap })] = String(e.message).slice(0, 160);
              this.state.set("badBuilds", bad);
            } catch { /* provisioning itself failed — nothing to remember */ }
          }
          if (i < caps.length - 1) {
            this.onEvent({ type: "runtime:fallback", from: cap, to: caps[i + 1], reason: String(e.message) });
          }
        }
      }
      // Every rung's reason survives — reporting only the last one hid
      // the GPU failure that started the slide (field finding).
      throw new Error(rungErrors.join(" · "));
    };

    const bootFallback = async (why) => {
      const fb = this.makeFallback ? await this.makeFallback() : null;
      if (!fb) return null;
      if (why) this.onEvent({ type: "runtime:fallback", from: "llamacpp", to: fb.status().kind, reason: why });
      const modelName = `koinos-${alias}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
      await fb.start({ modelPath, sha256: resolved.sha256, modelName });
      return fb;
    };

    let runtime;
    try {
      if (this.preferFallback) {
        runtime = await bootFallback(null);
        if (!runtime) throw new Error("KAI_RUNTIME requested the fallback runtime, but none is available");
      } else {
        try {
          runtime = await bootLlama();
        } catch (e) {
          runtime = await bootFallback(String(e.message));
          if (!runtime) throw e;
        }
      }
      this.lastLoadError = null;
    } catch (e) {
      this.lastLoadError = { alias, message: String(e.message), at: new Date().toISOString() };
      throw e;
    }

    this.runtime = runtime;
    this.activeAlias = alias;
    // stop() may have run while this load was in flight (quick app quit
    // during the warm start): the child it never saw must not outlive us.
    if (this._stopped) {
      this.stop();
      throw new Error("Core is stopping");
    }
    return runtime.endpoint;
  }

  stop() {
    this._stopped = true;
    if (this.runtime) this.runtime.stop();
    this.runtime = null;
    this.activeAlias = null;
  }
}

module.exports = { RuntimeManager };
