"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { ChainRead } = require("./chain-read");
const { NETWORKS, NODE_REQUIREMENTS } = require("./chain-constants");

/*
 * Koinos node tools — the optional mode behind the Earn toggle.
 *
 * Two rules shape this file.
 *
 * OFF MEANS INERT, not hidden. With the toggle off nothing here constructs a
 * Provider, schedules a timer, touches the network or reads a disk. A user who
 * never flips it pays nothing, which is the only honest way to ship an opt-in
 * feature into an app most of whose users do not want it.
 *
 * READ ONLY. There is no signing anywhere in this module or in chain-read.js.
 * Burning, registering a producer key and sending are later stages with their
 * own prerequisites; until then the worst a bug here can do is display a wrong
 * number. That is deliberate — it is what lets this ship without a password
 * prompt, an Origin allow-list for money routes, or a manual money test.
 */

const CACHE_MS = 30000;
const BYTES_PER_GB = 1024 ** 3;

/** Where Koinos Node Desktop installs itself, per platform. A filesystem
 *  probe only — nothing here executes anything it finds, and the path never
 *  arrives from a request body (any local page could then aim the Open button
 *  at an arbitrary binary). */
function companionCandidates() {
  const home = os.homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const pf = process.env.PROGRAMFILES || "C:\\Program Files";
    return [
      path.join(local, "Programs", "koinos-node-desktop", "Koinos Node Desktop.exe"),
      path.join(pf, "Koinos Node Desktop", "Koinos Node Desktop.exe"),
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Koinos Node Desktop.app",
      path.join(home, "Applications", "Koinos Node Desktop.app"),
    ];
  }
  return [path.join(home, "Applications"), path.join(home, ".local", "bin"), path.join(home, "Downloads")];
}

function findCompanion() {
  try {
    if (process.platform === "linux") {
      for (const dir of companionCandidates()) {
        let entries = [];
        try { entries = fs.readdirSync(dir); } catch { continue; }
        const hit = entries.find((f) => /^Koinos-Node-Desktop.*\.AppImage$/i.test(f));
        if (hit) return path.join(dir, hit);
      }
      return null;
    }
    for (const p of companionCandidates()) if (fs.existsSync(p)) return p;
  } catch {
    /* a probe that throws must not take the panel down */
  }
  return null;
}

class KoinosService {
  constructor({ settings, hardware = null, dataDir = null, onEvent = () => {} }) {
    this.settings = settings;
    this.hardware = hardware; // the object core/lib/hardware.js detect() returned
    this.dataDir = dataDir;
    this.onEvent = onEvent;
    this._chain = null;
    this._cache = new Map(); // key -> { at, value }
  }

  enabled() {
    return this.settings.get("koinos.enabled", false) === true;
  }

  /** Constructed lazily, so "off" really does mean no Provider exists. */
  chain() {
    if (!this._chain) {
      this._chain = new ChainRead(this.settings);
      this._chain._onDrift = (drifted) =>
        this.onEvent({ type: "koinos:contract-drift", detail: drifted.join("; ") });
    }
    return this._chain;
  }

  setEnabled(on) {
    this.settings.set("koinos.enabled", Boolean(on));
    if (!on) {
      this._chain = null; // drop the Provider; off is inert
      this._cache.clear();
    }
    return this.enabled();
  }

  setRpcUrl(url) {
    const v = String(url ?? "").trim();
    if (v && !/^https?:\/\//.test(v)) throw new Error("A node address has to start with http:// or https://");
    this.settings.set("koinos.rpcUrl", v);
    this._cache.clear();
    return v;
  }

  setWatchAddress(address) {
    const v = String(address ?? "").trim();
    if (v && !this.chain().isValidAddress(v)) throw new Error("That is not a valid Koinos address");
    this.settings.set("koinos.watchAddress", v);
    this._cache.clear();
    return v;
  }

  async _cached(key, fn) {
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = await fn();
    this._cache.set(key, { at: Date.now(), value });
    return value;
  }

  /**
   * Can THIS machine run a Koinos node? Answered before any install or start
   * control is drawn, so nobody downloads anything to find out their chip is
   * unsupported.
   */
  capability() {
    const hw = this.hardware || {};
    const req = NODE_REQUIREMENTS;
    const arch = hw.arch || process.arch;
    const platform = hw.platform || process.platform;
    const ramGb = hw.ramBytes ? hw.ramBytes / BYTES_PER_GB : os.totalmem() / BYTES_PER_GB;
    const freeGb = hw.diskFreeBytes ? hw.diskFreeBytes / BYTES_PER_GB : null;

    const out = { arch, platform, ramGb: Math.round(ramGb * 10) / 10, freeGb: freeGb === null ? null : Math.round(freeGb), requirements: req };

    // Architecture first, because it is the only unfixable one.
    if (!req.arch.includes(arch)) {
      out.canRun = false;
      out.reason = "arch";
      return out;
    }
    if (ramGb + 0.5 < req.minRamGb) {
      out.canRun = false;
      out.reason = "ram";
      return out;
    }
    if (freeGb !== null && freeGb < req.minFreeGbToRun) {
      out.canRun = false;
      out.reason = "disk";
      return out;
    }
    out.canRun = true;
    // Enough to run, not enough to shortcut the sync — a real and separate state.
    out.quickSync = freeGb === null ? null : freeGb >= req.minFreeGbForQuickSync;
    return out;
  }

  companion() {
    const p = findCompanion();
    return { installed: Boolean(p), path: p, releasesUrl: NODE_REQUIREMENTS.releasesUrl };
  }

  /** Everything the panel needs, in one call. Inert and cheap when off. */
  async status() {
    if (!this.enabled()) return { ok: true, enabled: false };
    const net = this.chain().network();
    return {
      ok: true,
      enabled: true,
      network: { id: net.id, label: net.label, symbol: net.tokenSymbol, explorer: net.explorer },
      rpcUrl: this.settings.get("koinos.rpcUrl", ""),
      watchAddress: this.settings.get("koinos.watchAddress", ""),
      capability: this.capability(),
      companion: this.companion(),
    };
  }

  async balances(address) {
    if (!this.enabled()) throw new Error("Koinos node tools are switched off");
    return this._cached(`bal:${address}`, () => this.chain().balances(address));
  }

  async nodeProbe() {
    if (!this.enabled()) throw new Error("Koinos node tools are switched off");
    const url = this.settings.get("koinos.rpcUrl", "") || NETWORKS.mainnet.localRpcUrl;
    return this._cached(`probe:${url}`, async () => {
      // Compare against the public chain head so "connected" can be told apart
      // from "connected and 40,000 blocks behind".
      let publicHead = null;
      try {
        publicHead = (await this.chain().headInfo(NETWORKS.mainnet.rpcUrls)).height;
      } catch {
        /* the public RPC being down must not make the user's node look broken */
      }
      return { url, publicHead, ...(await this.chain().probeNode(url, publicHead)) };
    });
  }
}

module.exports = { KoinosService, findCompanion, companionCandidates };
