#!/usr/bin/env node
"use strict";

/*
 * End-to-end proof of the "tool servers set themselves up" promise, run on
 * the SHIPPING OS (see the nodecheck job in netcheck.yml).
 *
 * It deliberately pretends the machine has no Node at all — CI runners and
 * dev boxes always do, which is exactly why the managed path would
 * otherwise never be exercised until a user hit it. Every step a real user
 * triggers by clicking "Add" runs here: provision → resolve npx → launch a
 * catalog MCP server → list its tools → call one.
 *
 *   node core/scripts/verify-node-runtime.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { RuntimeProvisioner } = require("../lib/runtime-provisioner");
const { NodeRuntime } = require("../lib/node-runtime");
const { McpManager, CATALOG } = require("../lib/mcp-manager");
const { ToolRegistry } = require("../lib/tools");
const { JsonStore } = require("../lib/store");

const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!cond) process.exitCode = 1;
  return cond;
};

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-nodecheck-"));
  console.log(`platform: ${process.platform}-${process.arch}\nworkdir : ${dir}\n`);

  const provisioner = new RuntimeProvisioner({
    catalogPath: path.join(__dirname, "..", "runtimes", "catalog.json"),
    runtimesDir: path.join(dir, "runtimes"),
    hardware: {},
    onEvent: (e) => {
      if (e.type !== "runtime:download") console.log(`  · ${e.type} ${e.build || ""}`);
    },
  });
  // The whole point: behave as if no Node exists on this machine.
  const nodeRuntime = new NodeRuntime({ provisioner, runtimesDir: path.join(dir, "runtimes"), probeSystemNode: () => null });

  const before = nodeRuntime.status();
  ok("status starts unavailable but installable", before.available === false && before.installable === true, JSON.stringify(before));
  ok("download size is quotable to the user", before.downloadBytes > 1e7, `${Math.round(before.downloadBytes / 1e6)} MB`);

  console.log("\nprovisioning Node (hash-verified by the provisioner)…");
  await nodeRuntime.ensure();
  const after = nodeRuntime.status();
  ok("status flips to managed", after.available === true && after.source === "managed", JSON.stringify(after));

  const binPath = nodeRuntime.installedPath();
  ok("binary exists at the catalog binPath", Boolean(binPath) && fs.existsSync(binPath), binPath || "(missing)");

  const resolved = nodeRuntime.resolveNpx(["--version"]);
  ok("npx resolves onto our own node", Boolean(resolved) && resolved.command === binPath);
  ok("…via npm's npx-cli (shims assume a PATH node this machine lacks)", Boolean(resolved) && /npx-cli\.js$/.test(resolved.args[0]), resolved ? resolved.args[0] : "");

  const { spawnSync } = require("child_process");
  const v = spawnSync(binPath, ["--version"], { encoding: "utf8", timeout: 30000, windowsHide: true });
  ok("provisioned node executes", /^v\d+\./.test(String(v.stdout).trim()), String(v.stdout).trim());
  const npxV = spawnSync(resolved.command, resolved.args, { encoding: "utf8", timeout: 120000, env: resolved.env, windowsHide: true });
  ok("npx runs through it", /\d+\.\d+\.\d+/.test(String(npxV.stdout || npxV.stderr)), String(npxV.stdout || npxV.stderr).trim().split("\n")[0]);

  // The real user journey: add a catalog server and connect it.
  console.log("\nlaunching a catalog MCP server (npx fetches the package on first run)…");
  const settings = new JsonStore(path.join(dir, "settings.json"), {});
  const registry = new ToolRegistry({ privacyMode: () => "network" });
  const mgr = new McpManager({ settings, registry, nodeRuntime, onEvent: () => {} });
  const entry = CATALOG.find((c) => c.id === "everything");
  const srv = mgr.addServer({ name: entry.name, transport: entry.transport, command: entry.command, args: entry.args });
  const tools = await mgr.connect(srv.id);
  ok("MCP server connected and exposed tools", tools.length > 0, `${tools.length} tools`);
  ok("tools landed in the registry", registry.list().some((t) => t.name.startsWith(`mcp:${srv.id}:`)));

  mgr.setServerFlags(srv.id, { trusted: true });
  const echo = tools.find((t) => /^echo$/i.test(t.name));
  if (echo) {
    const out = await registry.call(`mcp:${srv.id}:${echo.name}`, { message: "koinos" });
    ok("a tool call returns a real result", /koinos/.test(out), out.slice(0, 60));
  }
  mgr.closeAll();

  // ---- second pass: the SYSTEM-node route ----
  // This is the branch that shipped broken (Windows returned the npx.cmd
  // shim and Node threw EINVAL). CI only ever ran the managed route, so it
  // saw nothing. Run it explicitly whenever the runner has its own node.
  const sysRt = new NodeRuntime({ provisioner, runtimesDir: path.join(dir, "runtimes") });
  if (sysRt.status().source === "system") {
    console.log("\n--- system-node route ---");
    const sr = sysRt.resolveNpx(["-y", "x"]);
    ok("system route resolves", Boolean(sr));
    ok(
      "never a bare .cmd/.bat shim (Windows spawn EINVAL)",
      !/\.(cmd|bat)$/i.test(sr.command) || sr.shell === true,
      sr.command
    );
    const mgr2 = new McpManager({ settings: new JsonStore(path.join(dir, "sys.json"), {}), registry: new ToolRegistry({ privacyMode: () => "network" }), nodeRuntime: sysRt, onEvent: () => {} });
    const s2 = mgr2.addServer({ name: entry.name, transport: entry.transport, command: entry.command, args: entry.args });
    const t2 = await mgr2.connect(s2.id).catch((e) => { ok("system-node server connects", false, e.message); return []; });
    if (t2.length) ok("system-node server connects", true, `${t2.length} tools`);
    mgr2.closeAll();
  } else {
    console.log("\n(no system node on this runner — system route not applicable)");
  }

  console.log(process.exitCode ? "\nNODE RUNTIME CHECK FAILED" : "\nNODE RUNTIME CHECK PASSED");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
