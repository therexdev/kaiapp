"use strict";

const { spawn } = require("child_process");
const path = require("path");

/*
 * llama.cpp runtime adapter (V1 working choice; spec §6 keeps runtimes
 * swappable). Core supervises a `llama-server` child process, which natively
 * serves OpenAI-compatible /v1/chat/completions with streaming — the gateway
 * proxies to it and adds policy in front.
 *
 * The adapter interface every runtime implements:
 *   start({ modelPath, contextSize, gpuLayers }) -> { endpoint }
 *   stop() -> void            status() -> { running, pid, endpoint, model }
 */

const HEALTH_TIMEOUT_MS = 120000; // model load can be slow on first start
const HEALTH_POLL_MS = 500;

class LlamaCppRuntime {
  constructor({ binPath, host = "127.0.0.1", port = 41101, onEvent }) {
    this.binPath = binPath;
    this.host = host;
    this.port = port;
    this.onEvent = onEvent || (() => {});
    this.child = null;
    this.model = null;
    this._stopping = false;
  }

  get endpoint() {
    return `http://${this.host}:${this.port}`;
  }

  status() {
    return {
      kind: "llamacpp",
      running: !!this.child,
      pid: this.child?.pid ?? null,
      endpoint: this.child ? this.endpoint : null,
      model: this.model,
    };
  }

  async _waitHealthy() {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.child) throw new Error("llama-server exited during startup");
      try {
        const r = await fetch(`${this.endpoint}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
    throw new Error("llama-server did not become healthy in time");
  }

  async start({ modelPath, contextSize = 4096, gpuLayers = 0, extraArgs = [] }) {
    if (this.child) throw new Error("Runtime already running — stop it first");
    this._stopping = false;
    const args = [
      "--model", modelPath,
      "--host", this.host,
      "--port", String(this.port),
      "--ctx-size", String(contextSize),
      // GPU offload only when hardware detection approved it; 0 = pure CPU.
      "--n-gpu-layers", String(gpuLayers),
      ...extraArgs,
    ];

    const child = spawn(this.binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // llama.cpp release archives keep shared libs beside the binary.
      cwd: path.dirname(this.binPath),
    });
    this.child = child;
    this.model = modelPath;

    let stderrTail = "";
    child.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    child.on("exit", (code, signal) => {
      const wasStopping = this._stopping;
      this.child = null;
      this.model = null;
      if (!wasStopping) {
        this.onEvent({
          type: "runtime:crashed",
          kind: "llamacpp",
          code,
          signal,
          stderrTail: stderrTail.slice(-1000),
        });
      }
    });

    try {
      await this._waitHealthy();
    } catch (e) {
      const tail = stderrTail.slice(-600);
      this.stop();
      throw new Error(`${e.message}${tail ? `\nllama-server said: ${tail}` : ""}`);
    }
    this.onEvent({ type: "runtime:ready", kind: "llamacpp", endpoint: this.endpoint });
    return { endpoint: this.endpoint };
  }

  stop() {
    if (!this.child) return;
    this._stopping = true;
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
    this.child = null;
    this.model = null;
  }
}

module.exports = { LlamaCppRuntime };
