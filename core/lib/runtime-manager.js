"use strict";

/*
 * Runtime manager (spec §4/§6): owns which model is loaded on which runtime.
 * M1 scope: one active runtime + one loaded model at a time; the gateway
 * asks ensure(alias) before proxying. Switching models stops the current
 * runtime and starts the requested one.
 */

class RuntimeManager {
  constructor({ models, makeRuntime, hardware, provisioner, makeFallback, preferFallback, onEvent }) {
    this.models = models; // ModelManager
    this.makeRuntime = makeRuntime; // (binPath|null) => runtime adapter instance
    this.hardware = hardware; // detection snapshot (may be null in tests)
    this.provisioner = provisioner || null; // RuntimeProvisioner (null when a bin is forced)
    this.makeFallback = makeFallback || null; // async () => alt runtime (e.g. Ollama) or null
    this.preferFallback = !!preferFallback; // KAI_RUNTIME override: skip llama.cpp entirely
    this.onEvent = onEvent || (() => {});
    this.runtime = null;
    this.activeAlias = null;
    this._loading = null; // in-flight ensure() promise
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
    };
  }

  /** Endpoint of the healthy runtime serving `alias`, starting it if needed. */
  async ensure(alias) {
    if (this.activeAlias === alias && this.runtime?.status().running) {
      return this.runtime.endpoint;
    }
    if (this._loading) {
      // Single-flight: concurrent requests for the same alias share the load;
      // requests for a different model while loading are refused clearly.
      const { alias: loadingAlias, promise } = this._loading;
      if (loadingAlias === alias) return promise;
      throw new Error(`Model "${loadingAlias}" is currently loading — try again shortly`);
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
      await runtime.start({ modelPath, contextSize: resolved.contextSize || 4096, gpuLayers });
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
      let lastErr;
      for (let i = 0; i < caps.length; i++) {
        const cap = caps[i];
        try {
          return await boot(await this.provisioner.ensure(kind, { cap }), cap === "cpu" ? 0 : 999);
        } catch (e) {
          lastErr = e;
          if (i < caps.length - 1) {
            this.onEvent({ type: "runtime:fallback", from: cap, to: caps[i + 1], reason: String(e.message) });
          }
        }
      }
      throw lastErr;
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

    this.runtime = runtime;
    this.activeAlias = alias;
    return runtime.endpoint;
  }

  stop() {
    if (this.runtime) this.runtime.stop();
    this.runtime = null;
    this.activeAlias = null;
  }
}

module.exports = { RuntimeManager };
