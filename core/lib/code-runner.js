"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const { systemNodePath } = require("./node-runtime");

/*
 * Sandboxed script execution — the "run code" tool (task #58, the one
 * AutoGen capability worth taking whole). The model writes a short Node.js
 * script; we run it and hand back stdout/stderr, and the agent loop iterates
 * on what it reads. That loop is how a language model does the things it
 * cannot do in its head: exact arithmetic over a file, bulk renames inside
 * the workspace, parsing, date math.
 *
 * The sandbox, in layers (each one stated with its real strength):
 *
 *   1. Node PERMISSION MODEL (hard, kernel-of-node enforced): the child gets
 *      --permission with fs read/write limited to the agent WORKSPACE (the
 *      same scratch folder write_file/read_file use — deliberate: the tools
 *      compose). Everything else the model denies BY DEFAULT: no
 *      child_process, no worker_threads, no fs outside the allow-list — the
 *      wallet, keystore and the user's documents are unreachable. A runtime
 *      whose node cannot do --permission REFUSES to run code at all rather
 *      than run it unjailed.
 *   2. NETWORK preload (soft, module patching): lib/sandbox-preload.cjs
 *      replaces net/tls/http/https/http2/dgram/dns and global fetch before
 *      user code runs. Honest framing: this stops model-written code, not a
 *      determined adversary — the per-run approval in the tool policy layer
 *      is the actual trust boundary, and the tool is sensitive:true so the
 *      code is SHOWN and confirmed before any of this even starts.
 *   3. RESOURCE caps: wall-clock timeout (SIGKILL), V8 heap cap, output
 *      capped per stream so a print loop cannot flood the model's context.
 *   4. ENV scrub: the child sees a minimal environment — no proxy vars, no
 *      real HOME (HOME points into the run dir), nothing inherited that
 *      could leak configuration.
 *
 * Scripts are CommonJS (.cjs) so the model's natural `require("fs")` works.
 */

const DEFAULT_TIMEOUT_SEC = 30;
const MAX_TIMEOUT_SEC = 120;
const MAX_CODE_BYTES = 100_000;
const MAX_STREAM_BYTES = 32_768; // per stream, then truncated with a marker
const HEAP_MB = 256;

/** Which node binary runs sandboxed scripts, and with what extra env.
 *  Managed copy first (a known-real node), then this very process when it is
 *  one (headless Core), then Electron-as-node. */
function nodeBinFor(nodeRuntime) {
  const managed = nodeRuntime?.installedPath?.();
  if (managed) return { bin: managed, env: {} };
  if (!process.versions.electron) return { bin: process.execPath, env: {} };
  const sys = systemNodePath();
  if (sys) return { bin: sys, env: {} };
  // Electron binaries become plain node under this env var.
  return { bin: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** The permission flag this node accepts, or null when it has none.
 *  (--permission stabilized after --experimental-permission; support both.) */
function permissionFlagFor(bin, extraEnv) {
  for (const flag of ["--permission", "--experimental-permission"]) {
    try {
      const r = spawnSync(bin, [flag, "--allow-fs-read=*", "-e", "0"], {
        env: { ...minimalEnv(), ...extraEnv },
        timeout: 10000,
        windowsHide: true,
      });
      if (r.status === 0) return flag;
    } catch {
      /* try the next spelling */
    }
  }
  return null;
}

function minimalEnv() {
  // PATH only — node itself needs nothing else, and everything else
  // (proxies, tokens, real HOME) is exactly what must not leak in.
  return { PATH: process.env.PATH || "" };
}

class CodeRunner {
  constructor({ workspaceDir, nodeRuntime = null }) {
    this.workspaceDir = workspaceDir;
    this.nodeRuntime = nodeRuntime;
    this.preload = path.join(__dirname, "sandbox-preload.cjs");
    this._resolved = null; // { bin, env, flag } — probed once, lazily
  }

  /** Probe the runtime once. Returns { ok } or { ok:false, reason }. */
  availability() {
    if (!this._resolved) {
      const { bin, env } = nodeBinFor(this.nodeRuntime);
      const flag = permissionFlagFor(bin, env);
      this._resolved = { bin, env, flag };
    }
    if (!this._resolved.flag) {
      return {
        ok: false,
        reason:
          "this machine's Node runtime cannot sandbox code (needs the permission model, Node 20+) — code execution stays OFF rather than running unjailed",
      };
    }
    return { ok: true };
  }

  /**
   * Run one script. Returns a text report shaped for a model to read:
   * exit status, wall time, then the captured output.
   */
  async run(code, { timeoutSec } = {}) {
    const avail = this.availability();
    if (!avail.ok) throw new Error(avail.reason);
    const src = String(code ?? "");
    if (!src.trim()) throw new Error("no code to run");
    if (Buffer.byteLength(src) > MAX_CODE_BYTES) throw new Error("script too large (100 KB cap)");
    const timeoutMs = Math.min(Math.max(1, Number(timeoutSec) || DEFAULT_TIMEOUT_SEC), MAX_TIMEOUT_SEC) * 1000;

    const { bin, env, flag } = this._resolved;
    const runDir = path.join(this.workspaceDir, ".runs", crypto.randomBytes(6).toString("hex"));
    fs.mkdirSync(runDir, { recursive: true });
    const scriptPath = path.join(runDir, "script.cjs");
    fs.writeFileSync(scriptPath, src);

    // Read: workspace (script + preload + the files the other tools made).
    // Write: workspace only. Nothing else exists as far as fs is concerned.
    const args = [
      flag,
      `--allow-fs-read=${this.workspaceDir}`,
      `--allow-fs-read=${this.preload}`,
      `--allow-fs-write=${this.workspaceDir}`,
      `--max-old-space-size=${HEAP_MB}`,
      "--require",
      this.preload,
      scriptPath,
    ];

    const started = Date.now();
    const result = await new Promise((resolve) => {
      const child = spawn(bin, args, {
        cwd: this.workspaceDir,
        env: { ...minimalEnv(), ...env, HOME: runDir, NODE_OPTIONS: "" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      let killed = false;
      const cap = (cur, chunk) =>
        cur.length >= MAX_STREAM_BYTES ? cur : (cur + chunk).slice(0, MAX_STREAM_BYTES);
      child.stdout.on("data", (c) => (out = cap(out, String(c))));
      child.stderr.on("data", (c) => (err = cap(err, String(c))));
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: null, out, err: `${err}\nfailed to start: ${e.message}`, killed });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, out, err, killed });
      });
    });

    try {
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch { /* a locked temp file must not fail the run report */ }

    const secs = ((Date.now() - started) / 1000).toFixed(2);
    const mark = (s, name) =>
      s.length >= MAX_STREAM_BYTES ? `${s}\n…[${name} truncated at ${MAX_STREAM_BYTES} bytes]` : s;
    const head = result.killed
      ? `TIMED OUT after ${timeoutMs / 1000}s and was killed`
      : `exit ${result.code} in ${secs}s`;
    const parts = [head];
    if (result.out.trim()) parts.push(`--- stdout ---\n${mark(result.out, "stdout")}`);
    if (result.err.trim()) parts.push(`--- stderr ---\n${mark(result.err, "stderr")}`);
    if (!result.out.trim() && !result.err.trim()) parts.push("(no output — print what you need to see)");
    return parts.join("\n");
  }
}

module.exports = { CodeRunner };
