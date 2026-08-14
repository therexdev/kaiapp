"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const { downloadFile } = require("./download");
const { extractZip } = require("./zip");

/*
 * Runtime provisioner: fetches the right inference-engine build for this
 * machine exactly like a model package — versioned, hash-pinned, fail-closed
 * (§27) — so onboarding's one click covers model AND engine (§5: everything
 * handled automatically). Build selection: platform-arch-capability, with a
 * CPU fallback when no matching GPU build exists.
 */

class RuntimeProvisioner {
  constructor({ catalogPath, runtimesDir, hardware, onEvent }) {
    this.catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    this.runtimesDir = runtimesDir;
    this.hardware = hardware;
    this.onEvent = onEvent || (() => {});
    this._active = null; // in-flight provision promise
    this._progress = null;
  }

  downloadProgress() {
    return this._active ? this._progress : null;
  }

  /** Which build entry this machine gets, or throw with a clear reason. */
  selectBuild(kind, { cap } = {}) {
    const rt = this.catalog[kind];
    if (!rt) throw new Error(`Unknown runtime kind: ${kind}`);
    cap = cap || (this.hardware?.capabilities?.cudaEligible ? "cuda" : "cpu");
    const keys = [`${process.platform}-${process.arch}-${cap}`, `${process.platform}-${process.arch}-cpu`];
    for (const key of keys) {
      if (rt.builds[key]) return { key, version: rt.version, ...rt.builds[key] };
    }
    throw new Error(
      `No ${kind} build for this machine (${keys[0]}). ` +
        "Point KAI_LLAMA_BIN at an existing llama-server binary as a workaround."
    );
  }

  installedBinPath(kind, opts) {
    const b = this.selectBuild(kind, opts);
    return path.join(this.runtimesDir, kind, b.version, b.key, ...b.binPath.split("/"));
  }

  /** Ensure the runtime binary exists locally; download + extract if not. */
  async ensure(kind, opts = {}) {
    if (this._active) return this._active;
    const run = this._ensure(kind, opts);
    this._active = run;
    try {
      return await run;
    } finally {
      this._active = null;
    }
  }

  async _ensure(kind, opts) {
    const build = this.selectBuild(kind, opts);
    const bin = path.join(this.runtimesDir, kind, build.version, build.key, ...build.binPath.split("/"));
    if (fs.existsSync(bin)) return bin;

    const installDir = path.dirname(path.join(this.runtimesDir, kind, build.version, build.key, "x"));
    this.onEvent({ type: "runtime:provisioning", kind, build: build.key, version: build.version });

    // Main archive first, then companion archives (e.g. CUDA's cudart
    // runtime) — all hash-verified, all extracted into the same directory.
    const archives = [
      { url: build.url, sha256: build.sha256, sizeBytes: build.sizeBytes },
      ...(build.extras || []),
    ];
    for (let i = 0; i < archives.length; i++) {
      const a = archives[i];
      const zipPath = path.join(os.tmpdir(), `kai-runtime-${kind}-${build.version}-${build.key}-${i}.zip`);
      await downloadFile(a.url, zipPath, {
        sha256: a.sha256,
        sizeBytes: a.sizeBytes,
        onProgress: (p) => {
          this._progress = { kind, archive: i + 1, archives: archives.length, ...p };
          this.onEvent({ type: "runtime:download", kind, ...p });
        },
      });
      extractZip(zipPath, installDir);
      fs.rmSync(zipPath, { force: true });
    }
    if (!fs.existsSync(bin)) {
      throw new Error(
        `Runtime archive for ${build.key} did not contain expected binary at ${build.binPath} — catalog binPath is wrong`
      );
    }
    if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
    this.onEvent({ type: "runtime:provisioned", kind, bin });
    return bin;
  }
}

module.exports = { RuntimeProvisioner };
