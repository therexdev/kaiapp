"use strict";

/*
 * Runtime manager (spec §4/§6): owns which model is loaded on which runtime.
 * M1 scope: one active runtime + one loaded model at a time; the gateway
 * asks ensure(alias) before proxying. Switching models stops the current
 * runtime and starts the requested one.
 */

class RuntimeManager {
  constructor({ models, makeRuntime, hardware, provisioner, onEvent }) {
    this.models = models; // ModelManager
    this.makeRuntime = makeRuntime; // (binPath|null) => runtime adapter instance
    this.hardware = hardware; // detection snapshot (may be null in tests)
    this.provisioner = provisioner || null; // RuntimeProvisioner (null when a bin is forced)
    this.onEvent = onEvent || (() => {});
    this.runtime = null;
    this.activeAlias = null;
    this._loading = null; // in-flight ensure() promise
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

    // GPU path first when eligible, but a GPU failure must never strand the
    // user (§5): any provisioning or startup error falls back to the CPU
    // build automatically. Without a provisioner (forced KAI_LLAMA_BIN) the
    // single configured binary is all there is.
    const boot = async (binPath, gpuLayers) => {
      const runtime = this.makeRuntime(binPath);
      await runtime.start({ modelPath, contextSize: resolved.contextSize || 4096, gpuLayers });
      return runtime;
    };

    let runtime;
    if (this.provisioner && wantGpu) {
      try {
        runtime = await boot(await this.provisioner.ensure(kind, { cap: "cuda" }), 999);
      } catch (e) {
        this.onEvent({ type: "runtime:fallback", from: "cuda", to: "cpu", reason: String(e.message) });
        runtime = await boot(await this.provisioner.ensure(kind, { cap: "cpu" }), 0);
      }
    } else if (this.provisioner) {
      runtime = await boot(await this.provisioner.ensure(kind, { cap: "cpu" }), 0);
    } else {
      runtime = await boot(null, wantGpu ? 999 : 0);
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
