"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/*
 * Model manager (spec §6/§27): capability aliases over versioned, immutable,
 * hash-verified model packages. Consumers see "Koinos Fast", never a
 * quantization string. Downloads are resumable (Range + .part file) and a
 * package is only accepted when its SHA-256 matches the catalog — a package
 * whose artifact changed is a different package.
 */

class ModelManager {
  constructor({ catalogPath, modelsDir, state, onEvent }) {
    this.modelsDir = modelsDir;
    this.state = state; // JsonStore for download-job persistence
    this.onEvent = onEvent || (() => {});
    this.catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    this._active = null; // in-flight download {alias, controller}
    this._progress = null; // last emitted progress for the UI
  }

  /** Progress of the in-flight download, or null. */
  downloadProgress() {
    return this._active ? this._progress : null;
  }

  aliases() {
    return Object.entries(this.catalog.aliases).map(([alias, a]) => ({
      alias,
      label: a.label,
      package: a.package,
      status: this.packageStatus(a.package).status,
    }));
  }

  resolveAlias(alias) {
    const a = this.catalog.aliases[alias];
    if (!a) throw new Error(`Unknown model alias: ${alias}`);
    const pkg = this.catalog.packages[a.package];
    if (!pkg) throw new Error(`Catalog is broken: missing package ${a.package}`);
    return { alias, packageId: a.package, ...pkg };
  }

  packagePath(packageId) {
    const pkg = this.catalog.packages[packageId];
    if (!pkg) throw new Error(`Unknown package: ${packageId}`);
    return path.join(this.modelsDir, pkg.filename);
  }

  packageStatus(packageId) {
    const file = this.packagePath(packageId);
    const part = file + ".part";
    if (fs.existsSync(file)) return { status: "ready", path: file };
    if (fs.existsSync(part)) {
      return { status: "partial", downloadedBytes: fs.statSync(part).size };
    }
    return { status: "absent" };
  }

  /** Verify a fully downloaded file against the catalog hash. */
  async _verify(file, expectedSha256) {
    const hash = crypto.createHash("sha256");
    await new Promise((resolve, reject) => {
      fs.createReadStream(file)
        .on("data", (c) => hash.update(c))
        .on("end", resolve)
        .on("error", reject);
    });
    return hash.digest("hex") === String(expectedSha256).toLowerCase();
  }

  /**
   * Ensure a package is present and verified; downloads (with resume) when
   * absent. Returns the on-disk path. Single-flight per Core instance.
   */
  async ensurePackage(packageId) {
    const pkg = this.catalog.packages[packageId];
    if (!pkg) throw new Error(`Unknown package: ${packageId}`);
    // Fail closed (§27): a package without a pinned hash is not downloadable —
    // we never run weights we can't verify. Pin with: node scripts/pin-model.js
    if (!/^[0-9a-f]{64}$/i.test(String(pkg.sha256 || ""))) {
      throw new Error(
        `Package ${packageId} has no pinned sha256 in the catalog. ` +
          `Run "node core/scripts/pin-model.js ${packageId} --write" on a networked machine first.`
      );
    }
    const file = this.packagePath(packageId);
    if (fs.existsSync(file)) return file;
    if (this._active) throw new Error(`Another download is in progress (${this._active.alias})`);

    fs.mkdirSync(this.modelsDir, { recursive: true });
    const part = file + ".part";
    const controller = new AbortController();
    this._active = { alias: packageId, controller };
    this.state.set("modelDownload", { packageId, startedAt: new Date().toISOString() });

    try {
      let from = 0;
      if (fs.existsSync(part)) from = fs.statSync(part).size;
      const headers = {};
      if (from > 0) headers.range = `bytes=${from}-`;

      const resp = await fetch(pkg.url, { headers, signal: controller.signal, redirect: "follow" });
      // A server that ignores Range restarts the file — start the .part over.
      const resumed = resp.status === 206;
      if (!resp.ok && resp.status !== 206) throw new Error(`Download failed: HTTP ${resp.status}`);
      if (!resumed && from > 0) {
        fs.rmSync(part, { force: true });
        from = 0;
      }

      const total = pkg.sizeBytes || Number(resp.headers.get("content-length") || 0) + from;
      const out = fs.createWriteStream(part, { flags: resumed ? "a" : "w" });
      let done = from;
      let lastPct = -1;
      for await (const chunk of resp.body) {
        out.write(chunk);
        done += chunk.length;
        const pct = total ? Math.floor((done / total) * 100) : null;
        this._progress = { packageId, pct, done, total };
        if (pct !== null && pct !== lastPct) {
          lastPct = pct;
          this.onEvent({ type: "model:download", packageId, pct, done, total });
        }
      }
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));

      // §27: identity is the hash. Wrong hash = not this package; discard.
      if (!(await this._verify(part, pkg.sha256))) {
        fs.rmSync(part, { force: true });
        throw new Error(
          `Downloaded file failed SHA-256 verification for ${packageId} — discarded. ` +
            "Retry; if it persists the catalog or mirror is wrong."
        );
      }
      fs.renameSync(part, file);
      this.onEvent({ type: "model:ready", packageId, path: file });
      return file;
    } finally {
      this._active = null;
      this.state.set("modelDownload", null);
    }
  }

  cancelDownload() {
    if (this._active) this._active.controller.abort();
    return { cancelled: !!this._active };
  }

  /** Bytes used by the local model store (§5: storage limits surface later). */
  storageUsage() {
    let bytes = 0;
    try {
      for (const f of fs.readdirSync(this.modelsDir)) {
        bytes += fs.statSync(path.join(this.modelsDir, f)).size;
      }
    } catch {
      /* dir may not exist yet */
    }
    return { bytes, dir: this.modelsDir };
  }
}

module.exports = { ModelManager };
