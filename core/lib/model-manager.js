"use strict";

const fs = require("fs");
const path = require("path");

const { downloadFile } = require("./download");

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
    return Object.entries(this.catalog.aliases).map(([alias, a]) => {
      const q = this.quarantineOf(a.package);
      return {
        alias,
        label: a.label,
        package: a.package,
        status: q ? "quarantined" : this.packageStatus(a.package).status,
        ...(a.dev ? { dev: true } : {}),
        ...(q ? { quarantineReason: q.reason } : {}),
      };
    });
  }

  resolveAlias(alias) {
    const a = this.catalog.aliases[alias];
    if (!a) throw new Error(`Unknown model alias: ${alias}`);
    const pkg = this.catalog.packages[a.package];
    if (!pkg) throw new Error(`Catalog is broken: missing package ${a.package}`);
    const q = this.quarantineOf(a.package);
    if (q) throw new Error(`Model package "${a.package}" is quarantined: ${q.reason}`);
    return { alias, packageId: a.package, ...pkg };
  }

  /** §32: why a package is quarantined, or null. */
  quarantineOf(packageId) {
    return this.state.get("quarantined", {})[packageId] || null;
  }

  /** §32 kill switch: quarantine every catalog package pinned to this
   *  sha256. Persisted — the package stays dead across restarts until an
   *  updated catalog ships a clean replacement. Returns affected ids. */
  quarantineBySha(sha256, reason) {
    const sha = String(sha256 || "").toLowerCase();
    const q = this.state.get("quarantined", {});
    const hit = [];
    for (const [id, pkg] of Object.entries(this.catalog.packages)) {
      if (String(pkg.sha256 || "").toLowerCase() === sha && !q[id]) {
        q[id] = { reason: String(reason || "revoked by network operator"), at: new Date().toISOString() };
        hit.push(id);
      }
    }
    if (hit.length) {
      this.state.set("quarantined", q);
      this.onEvent({ type: "models:quarantined", packages: hit, reason });
    }
    return hit;
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

  /**
   * Ensure a package is present and verified; downloads (with resume) when
   * absent. Returns the on-disk path. Single-flight per Core instance.
   */
  async ensurePackage(packageId) {
    const pkg = this.catalog.packages[packageId];
    if (!pkg) throw new Error(`Unknown package: ${packageId}`);
    const q = this.quarantineOf(packageId);
    if (q) throw new Error(`Model package "${packageId}" is quarantined: ${q.reason}`);
    // An existing file was verified at download time (or placed deliberately
    // by a developer) — usable even while its catalog pin is still pending.
    const file = this.packagePath(packageId);
    if (fs.existsSync(file)) return file;
    // Fail closed (§27): a package without a pinned hash is not downloadable —
    // we never run weights we can't verify. Pin with: node scripts/pin-model.js
    if (!/^[0-9a-f]{64}$/i.test(String(pkg.sha256 || ""))) {
      throw new Error(
        `Package ${packageId} has no pinned sha256 in the catalog. ` +
          `Run "node core/scripts/pin-model.js ${packageId} --write" on a networked machine first.`
      );
    }
    if (this._active) throw new Error(`Another download is in progress (${this._active.alias})`);

    fs.mkdirSync(this.modelsDir, { recursive: true });
    const controller = new AbortController();
    this._active = { alias: packageId, controller };
    this.state.set("modelDownload", { packageId, startedAt: new Date().toISOString() });

    try {
      let lastPct = -1;
      await downloadFile(pkg.url, file, {
        sha256: pkg.sha256,
        sizeBytes: pkg.sizeBytes,
        signal: controller.signal,
        onProgress: ({ pct, done, total }) => {
          this._progress = { packageId, pct, done, total };
          if (pct !== null && pct !== lastPct) {
            lastPct = pct;
            this.onEvent({ type: "model:download", packageId, pct, done, total });
          }
        },
      });
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
