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
    this._importing = null; // in-flight custom import {path, pct}
  }

  // ----- custom models (§27 extended: bring your own GGUF) -----
  // Imported models are referenced in place (nobody wants a 19 GB copy),
  // identified by their SHA-256 exactly like catalog packages — so the §32
  // kill switch and dedupe both work on them — and marked "missing" with a
  // clean error if the file later moves.

  _customs() {
    return this.state.get("customModels", []);
  }

  _saveCustoms(list) {
    this.state.set("customModels", list);
  }

  importStatus() {
    return this._importing;
  }

  async importCustom({ path: filePath, label }) {
    filePath = String(filePath || "");
    if (!filePath.toLowerCase().endsWith(".gguf")) throw new Error("Pick a .gguf model file");
    if (!fs.existsSync(filePath)) throw new Error(`No file at ${filePath}`);
    const sizeBytes = fs.statSync(filePath).size;
    if (!sizeBytes) throw new Error("That file is empty");
    if (this._importing) throw new Error("Another import is already running");

    this._importing = { path: filePath, pct: 0 };
    try {
      const sha256 = await new Promise((resolve, reject) => {
        const h = require("crypto").createHash("sha256");
        let done = 0;
        const s = fs.createReadStream(filePath);
        s.on("data", (c) => {
          h.update(c);
          done += c.length;
          const pct = Math.floor((done / sizeBytes) * 100);
          if (pct !== this._importing.pct) {
            this._importing.pct = pct;
            this.onEvent({ type: "model:import", path: filePath, pct });
          }
        });
        s.on("error", reject);
        s.on("end", () => resolve(h.digest("hex")));
      });

      const q = this.state.get("quarantined", {})[`custom:${sha256}`];
      if (q) throw new Error(`This model was revoked by the network operator: ${q.reason}`);
      const dupCatalog = Object.entries(this.catalog.packages).find(([, p]) => String(p.sha256).toLowerCase() === sha256);
      if (dupCatalog) throw new Error(`This file is already in the catalog (${dupCatalog[0]}) — download it from Models instead`);
      const customs = this._customs();
      const dup = customs.find((c) => c.sha256 === sha256);
      if (dup) throw new Error(`Already imported as “${dup.label}”`);

      const base = path.basename(filePath, path.extname(filePath));
      let alias = `custom-${base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "model"}`;
      let n = 2;
      while (customs.some((c) => c.alias === alias) || this.catalog.aliases[alias]) alias = `${alias}-${n++}`;

      const entry = {
        alias,
        label: String(label || base).slice(0, 60),
        path: filePath,
        sha256,
        sizeBytes,
        contextSize: 4096,
        minRamGb: Math.max(4, Math.ceil((sizeBytes / 1e9) * 1.4 + 1)),
        importedAt: new Date().toISOString(),
      };
      customs.push(entry);
      this._saveCustoms(customs);
      this.onEvent({ type: "model:imported", alias, sha256, path: filePath });
      return entry;
    } finally {
      this._importing = null;
    }
  }

  removeCustom(alias) {
    const customs = this._customs();
    if (!customs.some((c) => c.alias === alias)) throw new Error("No such imported model");
    this._saveCustoms(customs.filter((c) => c.alias !== alias));
    return {}; // the file itself is the user's — never deleted
  }

  /** Progress of the in-flight download, or null. */
  downloadProgress() {
    return this._active ? this._progress : null;
  }

  aliases() {
    const catalog = Object.entries(this.catalog.aliases).map(([alias, a]) => {
      const q = this.quarantineOf(a.package);
      const pkg = this.catalog.packages[a.package] || {};
      return {
        alias,
        label: a.label,
        blurb: a.blurb || "",
        package: a.package,
        sizeBytes: pkg.sizeBytes ?? null,
        license: pkg.license ?? null,
        minRamGb: a.minRamGb ?? null,
        status: q ? "quarantined" : this.packageStatus(a.package).status,
        // Vision-capable packages (mmproj projector rides along) — the chat
        // UI gates image attachments on this flag.
        ...(pkg.vision ? { vision: true } : {}),
        ...(a.dev ? { dev: true } : {}),
        ...(q ? { quarantineReason: q.reason } : {}),
      };
    });
    const customs = this._customs().map((c) => {
      const q = this.quarantineOf(`custom:${c.sha256}`);
      return {
        alias: c.alias,
        label: c.label,
        blurb: `Imported from your files · ${(c.sizeBytes / 1e9).toFixed(1)} GB`,
        package: `custom:${c.sha256}`,
        sizeBytes: c.sizeBytes,
        license: null,
        minRamGb: c.minRamGb,
        custom: true,
        status: q ? "quarantined" : fs.existsSync(c.path) ? "ready" : "missing",
        ...(q ? { quarantineReason: q.reason } : {}),
      };
    });
    return [...catalog, ...customs];
  }

  resolveAlias(alias) {
    const a = this.catalog.aliases[alias];
    if (!a) {
      const c = this._customs().find((x) => x.alias === alias);
      if (!c) throw new Error(`Unknown model alias: ${alias}`);
      const q = this.quarantineOf(`custom:${c.sha256}`);
      if (q) throw new Error(`Imported model "${c.label}" is quarantined: ${q.reason}`);
      return {
        alias,
        packageId: `custom:${c.sha256}`,
        filename: path.basename(c.path),
        sha256: c.sha256,
        sizeBytes: c.sizeBytes,
        contextSize: c.contextSize || 4096,
        runtime: "llamacpp",
        custom: true,
      };
    }
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
    // §32 reaches imported models too — same weights, same revocation.
    for (const c of this._customs()) {
      const id = `custom:${c.sha256}`;
      if (c.sha256.toLowerCase() === sha && !q[id]) {
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
    if (String(packageId).startsWith("custom:")) {
      const sha = packageId.slice(7);
      const c = this._customs().find((x) => x.sha256 === sha);
      if (!c) throw new Error(`Unknown package: ${packageId}`);
      const q = this.quarantineOf(packageId);
      if (q) throw new Error(`Imported model "${c.label}" is quarantined: ${q.reason}`);
      if (!fs.existsSync(c.path)) {
        throw new Error(`The imported model file for "${c.label}" is gone (was at ${c.path}) — re-import it from Models`);
      }
      return c.path;
    }
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

  /** Vision packages carry a second artifact: the multimodal projector
   *  (--mmproj). Same fail-closed rules as the weights themselves — pinned
   *  sha256 or no download, quarantine honored via the parent package.
   *  Returns the local path, or null when the package has no projector. */
  async ensureMmproj(packageId) {
    const pkg = this.catalog.packages[packageId];
    const mm = pkg && pkg.mmproj;
    if (!mm || !mm.filename) return null;
    const file = path.join(this.modelsDir, mm.filename);
    if (fs.existsSync(file)) return file;
    if (!/^[0-9a-f]{64}$/i.test(String(mm.sha256 || ""))) {
      throw new Error(
        `Package ${packageId} has no pinned sha256 for its vision projector. ` +
          `Run "node core/scripts/pin-model.js ${packageId} --write" on a networked machine first.`
      );
    }
    if (this._active) throw new Error(`Another download is in progress (${this._active.alias})`);
    fs.mkdirSync(this.modelsDir, { recursive: true });
    const controller = new AbortController();
    this._active = { alias: `${packageId}#mmproj`, controller };
    try {
      await downloadFile(mm.url, file, {
        sha256: mm.sha256,
        sizeBytes: mm.sizeBytes,
        signal: controller.signal,
        onProgress: ({ pct, done, total }) => {
          this._progress = { packageId: `${packageId}#mmproj`, pct, done, total };
          this.onEvent({ type: "model:download", packageId: `${packageId}#mmproj`, pct, done, total });
        },
      });
      return file;
    } finally {
      this._active = null;
    }
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
