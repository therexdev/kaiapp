"use strict";

const { spawn } = require("child_process");
const net = require("net");
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

/** An OS-assigned free port on `host`, released just before we hand it out. */
function freePort(host) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Engine self-test (no model involved): a binary that can't even print its
 * version can't serve — catch machine incompatibility at provision time,
 * not at first chat. Throws with the decoded exit code on failure.
 */
/*
 * Field finding: an old msvcp140.dll elsewhere on the DLL search path can
 * shadow the modern MSVC runtime and crash 2022-toolchain llama.cpp builds
 * at load (the std::mutex 0xC0000005). The exe's own directory always wins
 * the search order, so place Electron's bundled (correct-version) CRT DLLs
 * beside the engine binary. Copy-if-absent; never overwrite upstream files.
 */
const CRT_DLLS = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
function ensureCrtBeside(binPath, srcDir = path.dirname(process.execPath)) {
  if (process.platform !== "win32") return;
  const fs = require("fs");
  const dstDir = path.dirname(binPath);
  for (const dll of CRT_DLLS) {
    const src = path.join(srcDir, dll);
    const dst = path.join(dstDir, dll);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    } catch {
      /* best effort — self-test still reports the truth */
    }
  }
}

function selfTest(binPath) {
  const { spawnSync } = require("child_process");
  ensureCrtBeside(binPath);
  const env = { ...process.env };
  if (process.platform === "win32") {
    env.PATH = `${path.dirname(process.execPath)};${env.PATH || ""}`;
  }
  const r = spawnSync(binPath, ["--version"], {
    timeout: 15000,
    windowsHide: true,
    cwd: path.dirname(binPath),
    env,
    encoding: "utf8",
  });
  // llama-server prints its version and exits 0 (some builds exit 1 after
  // printing usage); a loader crash gives a big NTSTATUS code and no output.
  const printed = `${r.stdout || ""}${r.stderr || ""}`.trim().length > 0;
  if (r.error || (!printed && r.status !== 0)) {
    const code = r.status;
    const hint =
      code === 3221225781
        ? " (0xC0000135: required DLL not found)"
        : code === 3221225477
          ? " (0xC0000005: access violation — build incompatible with this machine)"
          : code != null
            ? ` (exit code ${code})`
            : ` (${r.error?.message || "no output"})`;
    throw new Error(`Engine self-test failed for ${path.basename(binPath)}${hint}`);
  }
}

class LlamaCppRuntime {
  // No fixed default port: each start() probes a free one, so a second Core
  // instance (tests) or a stale llama-server from a crashed run can never be
  // mistaken for — or collide with — this instance's engine.
  constructor({ binPath, host = "127.0.0.1", port, onEvent }) {
    this._fixedPort = port ?? null;
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

  async _waitHealthy(timeoutMs = HEALTH_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.child) {
        const code = this._lastExit?.code;
        // Decode the two classic Windows loader deaths — they print nothing.
        const hint =
          code === 3221225781
            ? " (0xC0000135: a required DLL was not found — Visual C++ runtime or CUDA libraries missing)"
            : code === 3221225595
              ? " (0xC000007B: bad image — 32/64-bit or dependency mismatch)"
              : code != null
                ? ` (exit code ${code})`
                : "";
        throw new Error(`llama-server exited during startup${hint}`);
      }
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

  async start({ modelPath, contextSize = 4096, gpuLayers = 0, extraArgs = [], sizeBytes = 0 }) {
    if (this.child) throw new Error("Runtime already running — stop it first");
    this._stopping = false;
    this.port = this._fixedPort ?? (await freePort(this.host));
    const args = [
      "--model", modelPath,
      "--host", this.host,
      "--port", String(this.port),
      "--ctx-size", String(contextSize),
      // GPU offload only when hardware detection approved it; 0 = pure CPU.
      "--n-gpu-layers", String(gpuLayers),
      ...extraArgs,
    ];

    ensureCrtBeside(this.binPath);
    // Windows: llama-server needs the MSVC runtime DLLs. Electron ships them
    // beside its own exe, so prepend that directory to PATH — a clean machine
    // without the VC++ redistributable still loads. Harmless elsewhere.
    const env = { ...process.env };
    if (process.platform === "win32") {
      env.PATH = `${path.dirname(process.execPath)};${env.PATH || ""}`;
    }
    const child = spawn(this.binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
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
      this._lastExit = { code, signal };
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
      // Big models on laptop disks — and first-run Vulkan pipeline
      // compilation on Intel/AMD GPUs — legitimately take minutes. Scale
      // the patience with the weights instead of failing a healthy load.
      const budget = Math.max(HEALTH_TIMEOUT_MS, Math.ceil((sizeBytes / 1e9) * 30000));
      await this._waitHealthy(budget);
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

module.exports = { LlamaCppRuntime, selfTest, ensureCrtBeside };
