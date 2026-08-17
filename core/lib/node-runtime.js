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

/** Absolute path of the `node` on PATH, or null. */
function systemNodePath() {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const r = spawnSync(finder, ["node"], { encoding: "utf8", timeout: 8000, windowsHide: true });
    const first = String(r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first && fs.existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

/**
 * npm ships npx as a JS entry point next to the node binary. Finding it lets
 * us run `node npx-cli.js …` instead of the `npx.cmd` shim — which matters a
 * lot on Windows: Node refuses to spawn .cmd/.bat without a shell (the
 * CVE-2024-27980 hardening) and throws EINVAL, exactly what a user hit in the
 * field. Layouts: win32 <dir>/node_modules/npm, posix <dir>/../lib/node_modules/npm.
 */
function npxCliFor(nodeBin) {
  const dir = path.dirname(nodeBin);
  const roots =
    process.platform === "win32"
      ? [path.join(dir, "node_modules", "npm")]
      : [path.join(path.dirname(dir), "lib", "node_modules", "npm"), path.join(dir, "node_modules", "npm")];
  for (const root of roots) {
    const cli = path.join(root, "bin", "npx-cli.js");
    if (fs.existsSync(cli)) return cli;
  }
  return null;
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
    // Preferred everywhere: drive npm's npx entry point with a real node
    // BINARY. Never spawn the npx.cmd shim — Windows rejects .cmd without a
    // shell (EINVAL) and shell:true reintroduces quoting hazards.
    const candidates = this._probe() ? [systemNodePath(), this.installedPath()] : [this.installedPath()];
    for (const bin of candidates) {
      if (!bin) continue;
      const npxCli = npxCliFor(bin);
      if (!npxCli) continue;
      return {
        command: bin,
        args: [npxCli, ...args],
        // Put this node first so the spawned server (and anything it shells
        // out to) finds a node at all.
        env: { ...process.env, PATH: `${path.dirname(bin)}${path.delimiter}${process.env.PATH || ""}` },
      };
    }
    // Last resort: a system node whose npm we could not locate (unusual
    // packaging). Go through the shim WITH a shell, which is the only way
    // Windows will run it.
    if (this._probe()) {
      return {
        command: process.platform === "win32" ? "npx.cmd" : "npx",
        args,
        env: process.env,
        shell: true,
      };
    }
    return null;
  }
}

module.exports = { NodeRuntime, systemNode, systemNodePath, npxCliFor };
