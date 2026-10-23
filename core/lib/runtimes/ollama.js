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

const WARMUP_TIMEOUT_MS = 120000;
const PS_TIMEOUT_MS = 5000;

/** num_ctx from an /api/show reply's `parameters` text, or null. A
 *  configuration precheck only — it says what the model was created with,
 *  not what the loaded runner actually gives one request. */
function parseNumCtx(show) {
  const m = /(?:^|\n)\s*num_ctx\s+(\d+)\s*(?:\n|$)/.exec(String(show?.parameters ?? ""));
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

/** The loaded runner's context_length for `model` from an /api/ps reply
 *  (matched on name or model, with or without ":latest"), or null. */
function psContextLength(ps, model) {
  const bare = (s) => String(s ?? "").replace(/:latest$/, "");
  const want = bare(model);
  if (!want || !Array.isArray(ps?.models)) return null;
  const hit = ps.models.find((m) => m && (bare(m.name) === want || bare(m.model) === want));
  return hit && Number.isSafeInteger(hit.context_length) ? hit.context_length : null;
}

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

  /** Where an installed Ollama binary lives, or null. Async spawn — a PATH
   *  probe must never block the event loop (same rule as engine selfTest). */
  static async locate() {
    const { spawn } = require("child_process");
    const path = require("path");
    const probe = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(process.platform === "win32" ? "where" : "which", ["ollama"], { windowsHide: true });
      } catch (e) {
        return resolve({ error: e, status: null, stdout: "" });
      }
      let stdout = "";
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 5000);
      child.stdout?.on("data", (d) => { stdout += d; });
      child.on("error", (e) => { clearTimeout(timer); resolve({ error: e, status: null, stdout }); });
      child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout }); });
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
  static async ensureRunning({ host = "127.0.0.1", port = 11434, onEvent, provision, modelsDir } = {}) {
    const emit = onEvent || (() => {});
    const up = await OllamaRuntime.detect({ host, port });
    if (up) return up;
    let bin = await OllamaRuntime.locate();
    // Nothing installed: provision our own portable build — everything in
    // the app, nobody gets sent to a website (field requirement). The zip
    // is hash-pinned in the runtime catalog like every engine (§27) and
    // downloaded lazily, only on machines that actually need the fallback.
    if (!bin && provision) {
      try {
        bin = await provision();
      } catch (e) {
        emit({ type: "runtime:ollama-provision-failed", message: String(e.message) });
        return null;
      }
    }
    if (!bin) return null;
    emit({ type: "runtime:ollama-starting", bin });
    const { spawn } = require("child_process");
    try {
      // Detached daemon: it outlives us, exactly like a user-launched
      // Ollama. A provisioned copy keeps its models inside our data dir so
      // storage stays governed and uninstall stays clean.
      const env = { ...process.env, OLLAMA_HOST: `${host}:${port}`, ...(modelsDir ? { OLLAMA_MODELS: modelsDir } : {}) };
      spawn(bin, ["serve"], { detached: true, stdio: "ignore", windowsHide: true, env }).unref();
    } catch {
      return null;
    }
    const deadline = Date.now() + 30000; // first run unpacks runners — allow it
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
      // Streamed request bodies (blob uploads) need half-duplex mode.
      ...(opts.duplex ? { duplex: "half" } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs || 120000),
    });
    return r;
  }

  /**
   * Ensure our verified GGUF is registered in Ollama under `modelName`,
   * then treat Ollama as the serving endpoint.
   *
   * `contextTokens` (network context opt-in) registers a separate model
   * whose parameters pin num_ctx; without it every request and body is
   * exactly the legacy one.
   */
  async start({ modelPath, sha256, modelName, contextTokens }) {
    const name = modelName || "koinos-model";
    const digest = `sha256:${String(sha256).toLowerCase()}`;
    const ctx = Number.isSafeInteger(contextTokens) && contextTokens > 0 ? contextTokens : null;

    const shown = await this._api("/api/show", { model: name }, { timeoutMs: 5000 }).catch(() => null);
    let register = !shown?.ok;
    if (!register && ctx) {
      // Configuration precheck: a model created with another num_ctx is
      // recreated once. Never verification — see verifyContext().
      register = parseNumCtx(await shown.json().catch(() => null)) !== ctx;
    }
    if (register) {
      // Upload the verified artifact as a blob (idempotent server-side),
      // then create the model from that exact digest.
      this.onEvent({ type: "runtime:ollama-import", model: name });
      // STREAM the upload — readFileSync capped registration at Node's
      // 2 GiB buffer limit (field finding: every model past Koinos Fast
      // failed with "File size … greater than 2 GiB") and would have put
      // a model-sized spike in memory besides. Localhost is disk-speed;
      // the generous timeout covers 20 GB models on laptop drives.
      const { Readable } = require("stream");
      const blob = await this._api(`/api/blobs/${digest}`, Readable.toWeb(fs.createReadStream(modelPath)), {
        raw: true,
        duplex: true,
        timeoutMs: 1800000,
      });
      if (!blob.ok && blob.status !== 201) {
        throw new Error(`Ollama rejected the model blob: HTTP ${blob.status}`);
      }
      let created = await this._api(
        "/api/create",
        ctx ? { model: name, files: { "model.gguf": digest }, parameters: { num_ctx: ctx } } : { model: name, files: { "model.gguf": digest } }
      );
      if (!created.ok) {
        // Older Ollama versions take a Modelfile that references the path.
        created = await this._api("/api/create", { name, modelfile: ctx ? `FROM ${modelPath}\nPARAMETER num_ctx ${ctx}` : `FROM ${modelPath}` });
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

  /** GET /api/ps: context_length of the loaded runner serving our model,
   *  or null (not loaded, field missing, timeout). */
  async probeContext({ timeoutMs = PS_TIMEOUT_MS } = {}) {
    if (!this.model) return null;
    try {
      const r = await fetch(`${this.endpoint}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return null;
      return psContextLength(await r.json(), this.model);
    } catch {
      return null;
    }
  }

  /**
   * Verified iff, after a bounded local warm-up that loads the runner,
   * /api/ps reports a per-request context_length >= n. Fails closed: a
   * missing entry, a missing or smaller length, or any timeout is false.
   * `warm: false` only reads /api/ps and never loads anything.
   */
  async verifyContext(n, { warm = true, warmupMs = WARMUP_TIMEOUT_MS } = {}) {
    if (!this.model || !Number.isSafeInteger(n)) return false;
    if (warm) {
      try {
        const w = await this._api("/api/generate", { model: this.model, prompt: "", stream: false }, { timeoutMs: warmupMs });
        await w.text().catch(() => "");
        if (!w.ok) return false;
      } catch {
        return false;
      }
    }
    const len = await this.probeContext();
    return Number.isSafeInteger(len) && len >= n;
  }

  stop() {
    // We never own the Ollama daemon — just detach.
    this.running = false;
    this.model = null;
  }
}

module.exports = { OllamaRuntime, parseNumCtx, psContextLength };
