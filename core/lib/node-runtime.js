"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/*
 * Node.js runtime for MCP tool servers (§5: everything handled automatically).
 *
 * Most of the MCP ecosystem ships as npm packages run via npx. Telling a
 * consumer "go install Node.js first" ends the one-click promise, so Core
 * provisions Node exactly like it provisions inference engines: the official
 * build, hash-pinned in the runtime catalog, unpacked INSIDE the app's data
 * dir. No system install, no PATH edits, no admin prompt, and it leaves with
 * the app.
 *
 * Resolution order when a server needs node:
 *   1. A system node already on PATH (respect what the user has — and it
 *      keeps their global npm cache/config working).
 *   2. Our provisioned copy.
 *   3. Neither → the UI offers a one-click setup with the real size.
 */

/** Does a usable `node` exist on PATH? Returns its version or null. */
function systemNode() {
  try {
    const r = spawnSync("node", ["--version"], { encoding: "utf8", timeout: 8000, windowsHide: true });
    const v = String(r.stdout || "").trim();
    return /^v\d+\./.test(v) ? v : null;
  } catch {
    return null;
  }
}

class NodeRuntime {
  // probeSystemNode is injectable so the managed-Node path can be tested on
  // a machine that (like every dev box and CI runner) already has node.
  constructor({ provisioner, runtimesDir, probeSystemNode = systemNode }) {
    this.provisioner = provisioner || null;
    this.runtimesDir = runtimesDir;
    this._probe = probeSystemNode;
  }

  /** Path to our provisioned node binary if it's installed, else null. */
  installedPath() {
    if (!this.provisioner) return null;
    try {
      const p = this.provisioner.installedBinPath("node", { cap: "cpu" });
      return fs.existsSync(p) ? p : null;
    } catch {
      return null; // no build for this platform
    }
  }

  /** Can this platform get Node from the catalog at all? */
  installable() {
    if (!this.provisioner) return false;
    try {
      const b = this.provisioner.selectBuild("node", { cap: "cpu" });
      return /^[0-9a-f]{64}$/i.test(String(b.sha256));
    } catch {
      return false;
    }
  }

  downloadBytes() {
    try {
      return this.provisioner.selectBuild("node", { cap: "cpu" }).sizeBytes || 0;
    } catch {
      return 0;
    }
  }

  status() {
    const sys = this._probe();
    const mine = this.installedPath();
    let managedVersion = null;
    if (!sys && mine) {
      try {
        managedVersion = this.provisioner.selectBuild("node", { cap: "cpu" }).version || null;
      } catch { /* catalog gone — still usable */ }
    }
    return {
      available: Boolean(sys || mine),
      source: sys ? "system" : mine ? "managed" : null,
      version: sys || managedVersion,
      installable: this.installable(),
      downloadBytes: this.downloadBytes(),
    };
  }

  async ensure() {
    if (this._probe() || this.installedPath()) return this.status();
    if (!this.provisioner) throw new Error("no provisioner available");
    await this.provisioner.ensure("node", { cap: "cpu" });
    const bin = this.installedPath();
    if (!bin) throw new Error("Node runtime unpacked but the binary is missing — catalog binPath is wrong");
    if (process.platform !== "win32") {
      // The tarball's bin/ holds node plus npm/npx symlinks; make them all
      // executable (tar usually preserves this, but a stray umask can bite).
      try {
        for (const f of fs.readdirSync(path.dirname(bin))) {
          fs.chmodSync(path.join(path.dirname(bin), f), 0o755);
        }
      } catch { /* best effort */ }
    }
    return this.status();
  }

  /**
   * Turn an npx-based server command into something runnable here.
   * Returns { command, args, env } or null when Node is unavailable.
   *
   * With a system node we just run `npx`. With OUR node we must invoke
   * npm-cli's npx entry through our node binary — the shim scripts assume a
   * node on PATH, which is exactly what this machine lacks.
   */
  resolveNpx(args = []) {
    if (this._probe()) {
      return {
        command: process.platform === "win32" ? "npx.cmd" : "npx",
        args,
        env: process.env,
      };
    }
    const bin = this.installedPath();
    if (!bin) return null;
    const dir = path.dirname(bin);
    // win32 zip: <root>/node.exe + <root>/node_modules/npm/...
    // posix tar: <root>/bin/node + <root>/lib/node_modules/npm/...
    const npmRoot = process.platform === "win32"
      ? path.join(dir, "node_modules", "npm")
      : path.join(path.dirname(dir), "lib", "node_modules", "npm");
    const npxCli = path.join(npmRoot, "bin", "npx-cli.js");
    if (!fs.existsSync(npxCli)) return null;
    return {
      command: bin,
      args: [npxCli, ...args],
      // Put our node first so the spawned server (and anything it shells out
      // to) finds a node at all.
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH || ""}` },
    };
  }
}

module.exports = { NodeRuntime, systemNode };
