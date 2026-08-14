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
  selectBuild(kind) {
    const rt = this.catalog[kind];
    if (!rt) throw new Error(`Unknown runtime kind: ${kind}`);
    const cap = this.hardware?.capabilities?.cudaEligible ? "cuda" : "cpu";
    const keys = [`${process.platform}-${process.arch}-${cap}`, `${process.platform}-${process.arch}-cpu`];
    for (const key of keys) {
      if (rt.builds[key]) return { key, version: rt.version, ...rt.builds[key] };
    }
    throw new Error(
      `No ${kind} build for this machine (${keys[0]}). ` +
        "Point KAI_LLAMA_BIN at an existing llama-server binary as a workaround."
    );
  }

  installedBinPath(kind) {
    const b = this.selectBuild(kind);
    return path.join(this.runtimesDir, kind, b.version, b.key, ...b.binPath.split("/"));
  }

  /** Ensure the runtime binary exists locally; download + extract if not. */
  async ensure(kind) {
    if (this._active) return this._active;
    const run = this._ensure(kind);
    this._active = run;
    try {
      return await run;
    } finally {
      this._active = null;
    }
  }

  async _ensure(kind) {
    const build = this.selectBuild(kind);
    const bin = this.installedBinPath(kind);
    if (fs.existsSync(bin)) return bin;

    const installDir = path.dirname(path.join(this.runtimesDir, kind, build.version, build.key, "x"));
    const zipPath = path.join(os.tmpdir(), `kai-runtime-${kind}-${build.version}-${build.key}.zip`);
    this.onEvent({ type: "runtime:provisioning", kind, build: build.key, version: build.version });

    await downloadFile(build.url, zipPath, {
      sha256: build.sha256,
      sizeBytes: build.sizeBytes,
      onProgress: (p) => {
        this._progress = { kind, ...p };
        this.onEvent({ type: "runtime:download", kind, ...p });
      },
    });

    extractZip(zipPath, installDir);
    fs.rmSync(zipPath, { force: true });
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
