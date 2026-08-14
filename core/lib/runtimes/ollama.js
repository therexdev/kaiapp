"use strict";

const fs = require("fs");

/*
 * Ollama runtime adapter (spec §6 keeps runtimes swappable). When a local
 * Ollama is running (default 127.0.0.1:11434), Core can serve chat through
 * it: our hash-verified GGUF is registered into Ollama's store via the blob
 * API — the §27 package sha256 IS the blob digest, so nothing unverified
 * ever enters — and Ollama's OpenAI-compatible /v1 surface does the rest.
 *
 * Used as a fallback when the managed llama.cpp build can't run on this
 * machine (first field case: a llama-server release build that crashed on
 * hardware where Ollama demonstrably worked), or forced via KAI_RUNTIME=ollama.
 */

class OllamaRuntime {
  constructor({ host = "127.0.0.1", port = 11434, onEvent } = {}) {
    this.host = host;
    this.port = port;
    this.onEvent = onEvent || (() => {});
    this.model = null; // registered Ollama model name
    this.running = false;
  }

  get endpoint() {
    return `http://${this.host}:${this.port}`;
  }

  /** Resolves to the Ollama version string when one is running, else null. */
  static async detect({ host = "127.0.0.1", port = 11434 } = {}) {
    try {
      const r = await fetch(`http://${host}:${port}/api/version`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return null;
      return (await r.json()).version ?? "unknown";
    } catch {
      return null;
    }
  }

  /** Where an installed Ollama binary lives, or null. */
  static locate() {
    const { spawnSync } = require("child_process");
    const path = require("path");
    const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["ollama"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    const found = (probe.stdout || "").split("\n")[0].trim();
    if (probe.status === 0 && found) return found;
    if (process.platform === "win32" && process.env.LOCALAPPDATA) {
      const p = path.join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe");
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  /**
   * Detect a running Ollama; if none but one is installed, start the daemon
   * ourselves ("ollama serve") and wait for it — the user should never have
   * to launch it by hand. Returns the version string or null.
   */
  static async ensureRunning({ host = "127.0.0.1", port = 11434, onEvent } = {}) {
    const up = await OllamaRuntime.detect({ host, port });
    if (up) return up;
    const bin = OllamaRuntime.locate();
    if (!bin) return null;
    (onEvent || (() => {}))({ type: "runtime:ollama-starting", bin });
    const { spawn } = require("child_process");
    try {
      // Detached daemon: it outlives us, exactly like a user-launched Ollama.
      spawn(bin, ["serve"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch {
      return null;
    }
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const v = await OllamaRuntime.detect({ host, port });
      if (v) return v;
      await new Promise((r) => setTimeout(r, 400));
    }
    return null;
  }

  status() {
    return {
      kind: "ollama",
      running: this.running,
      pid: null, // Ollama owns its own process lifecycle
      endpoint: this.running ? this.endpoint : null,
      model: this.model,
    };
  }

  /** Model name inside Ollama — the gateway rewrites request bodies to it. */
  servedName() {
    return this.model;
  }

  async _api(path, body, opts = {}) {
    const r = await fetch(`${this.endpoint}${path}`, {
      method: "POST",
      headers: { "content-type": opts.raw ? "application/octet-stream" : "application/json" },
      body: opts.raw ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs || 120000),
    });
    return r;
  }

  /**
   * Ensure our verified GGUF is registered in Ollama under `modelName`,
   * then treat Ollama as the serving endpoint.
   */
  async start({ modelPath, sha256, modelName }) {
    const name = modelName || "koinos-model";
    const digest = `sha256:${String(sha256).toLowerCase()}`;

    const shown = await this._api("/api/show", { model: name }, { timeoutMs: 5000 }).catch(() => null);
    if (!shown?.ok) {
      // Upload the verified artifact as a blob (idempotent server-side),
      // then create the model from that exact digest.
      this.onEvent({ type: "runtime:ollama-import", model: name });
      const blob = await this._api(`/api/blobs/${digest}`, fs.readFileSync(modelPath), { raw: true, timeoutMs: 300000 });
      if (!blob.ok && blob.status !== 201) {
        throw new Error(`Ollama rejected the model blob: HTTP ${blob.status}`);
      }
      let created = await this._api("/api/create", { model: name, files: { "model.gguf": digest } });
      if (!created.ok) {
        // Older Ollama versions take a Modelfile that references the path.
        created = await this._api("/api/create", { name, modelfile: `FROM ${modelPath}` });
      }
      if (!created.ok) {
        throw new Error(`Ollama could not create the model: HTTP ${created.status} ${await created.text().catch(() => "")}`);
      }
      await created.text().catch(() => ""); // drain the progress stream
    }

    this.model = name;
    this.running = true;
    this.onEvent({ type: "runtime:ready", kind: "ollama", endpoint: this.endpoint });
    return { endpoint: this.endpoint };
  }

  stop() {
    // We never own the Ollama daemon — just detach.
    this.running = false;
    this.model = null;
  }
}

module.exports = { OllamaRuntime };
