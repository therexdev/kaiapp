"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { NodeRuntime } = require("../lib/node-runtime");
const { McpManager } = require("../lib/mcp-manager");
const { ToolRegistry } = require("../lib/tools");
const { JsonStore } = require("../lib/store");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kai-node-"));

/*
 * The promise: adding an MCP tool server never dead-ends on "go install
 * Node.js". These pin the resolution logic, which is the part that silently
 * differs per platform.
 */

test("node runtime: catalog is pinned and installable on the shipping platforms", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "runtimes", "catalog.json"), "utf8"));
  const builds = catalog.node?.builds || {};
  for (const key of ["win32-x64-cpu", "linux-x64-cpu", "linux-arm64-cpu", "darwin-arm64-cpu"]) {
    assert.ok(builds[key], `${key} present`);
    assert.match(builds[key].sha256, /^[0-9a-f]{64}$/, `${key} hash pinned (fail-closed otherwise)`);
    assert.ok(builds[key].sizeBytes > 1e7, `${key} has a real size for the download prompt`);
    assert.match(builds[key].url, /^https:\/\/nodejs\.org\/dist\//, `${key} comes from the official source`);
  }
  // binPath must match each archive's real layout: win zip is flat, the
  // posix tarballs nest the binary under bin/.
  assert.strictEqual(builds["win32-x64-cpu"].binPath, "node-v24.19.0-win-x64/node.exe");
  assert.strictEqual(builds["linux-x64-cpu"].binPath, "node-v24.19.0-linux-x64/bin/node");
});

test("node runtime: status reports availability and a real download size", () => {
  const { RuntimeProvisioner } = require("../lib/runtime-provisioner");
  const dir = tmp();
  const provisioner = new RuntimeProvisioner({
    catalogPath: path.join(__dirname, "..", "runtimes", "catalog.json"),
    runtimesDir: path.join(dir, "runtimes"),
    hardware: {},
    onEvent: () => {},
  });
  const nr = new NodeRuntime({ provisioner, runtimesDir: path.join(dir, "runtimes") });
  const st = nr.status();
  // This machine HAS node (we're running in it), so status must say so and
  // prefer it over downloading anything.
  assert.strictEqual(st.available, true);
  assert.strictEqual(st.source, "system");
  assert.match(st.version, /^v\d+\./);
  assert.strictEqual(nr.installable(), true, "the catalog can still provide one where absent");
  assert.ok(nr.downloadBytes() > 1e7, "download size is quotable to the user up front");
});

test("node runtime: resolveNpx uses the system node when present", () => {
  const nr = new NodeRuntime({ provisioner: null, runtimesDir: tmp() });
  const r = nr.resolveNpx(["-y", "@modelcontextprotocol/server-fetch"]);
  assert.ok(r, "resolves because this machine has node");
  assert.match(path.basename(r.command), /^npx/);
  assert.deepStrictEqual(r.args, ["-y", "@modelcontextprotocol/server-fetch"]);
});

test("node runtime: with NO system node, resolveNpx drives npm's npx-cli through OUR node", { skip: process.platform === "win32" ? "posix layout" : false }, () => {
  // A machine with no node on PATH (probe injected) but our copy unpacked.
  const dir = tmp();
  const root = path.join(dir, "node-v24.19.0-linux-x64");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "node"), "#!/bin/sh\n");
  fs.mkdirSync(path.join(root, "lib", "node_modules", "npm", "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib", "node_modules", "npm", "bin", "npx-cli.js"), "");

  const nr = new NodeRuntime({
    provisioner: { installedBinPath: () => path.join(root, "bin", "node") },
    runtimesDir: dir,
    probeSystemNode: () => null, // ← the machine we are simulating
  });

  assert.strictEqual(nr.status().source, "managed", "status reports the managed runtime");
  const r = nr.resolveNpx(["-y", "pkg"]); // the REAL implementation
  assert.strictEqual(r.command, path.join(root, "bin", "node"), "spawns OUR node binary directly");
  assert.strictEqual(r.args[0], path.join(root, "lib", "node_modules", "npm", "bin", "npx-cli.js"), "…running npm's npx entry point (shims assume a node on PATH)");
  assert.deepStrictEqual(r.args.slice(1), ["-y", "pkg"]);
  assert.ok(r.env.PATH.startsWith(path.join(root, "bin")), "our node leads PATH for anything the server shells out to");
});

test("node runtime: no system node and nothing provisioned → resolveNpx returns null (UI offers setup)", () => {
  const nr = new NodeRuntime({ provisioner: null, runtimesDir: tmp(), probeSystemNode: () => null });
  assert.strictEqual(nr.resolveNpx(["-y", "pkg"]), null);
  assert.strictEqual(nr.status().available, false);
});

test("mcp manager: an npx server without any Node fails with an actionable needsNode error", () => {
  const dir = tmp();
  const settings = new JsonStore(path.join(dir, "settings.json"), {});
  const registry = new ToolRegistry({ privacyMode: () => "network" });
  // nodeRuntime that reports nothing available (a machine with no Node).
  const noNode = { resolveNpx: () => null };
  const mgr = new McpManager({ settings, registry, nodeRuntime: noNode, onEvent: () => {} });
  const s = mgr.addServer({ name: "Fetch", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-fetch"] });
  assert.throws(
    () => mgr._resolveCommand(settings.get("mcp.servers").find((x) => x.id === s.id)),
    (e) => e.needsNode === true && /one click/i.test(e.message),
    "the error tells the user exactly what to do, and is machine-readable for the UI"
  );
});

test("mcp manager: npx servers are rewritten onto the resolved runtime; non-npx commands pass through", () => {
  const dir = tmp();
  const settings = new JsonStore(path.join(dir, "settings.json"), {});
  const registry = new ToolRegistry({ privacyMode: () => "network" });
  const fakeRuntime = {
    resolveNpx: (args) => ({ command: "/managed/node", args: ["/managed/npx-cli.js", ...args], env: { PATH: "/managed" } }),
  };
  const mgr = new McpManager({ settings, registry, nodeRuntime: fakeRuntime, onEvent: () => {} });

  const npxSrv = mgr.addServer({ name: "Fetch", transport: "stdio", command: "npx", args: ["-y", "server-fetch"] });
  const resolved = mgr._resolveCommand(settings.get("mcp.servers").find((x) => x.id === npxSrv.id));
  assert.deepStrictEqual(resolved.command, ["/managed/node"]);
  assert.deepStrictEqual(resolved.args, ["/managed/npx-cli.js", "-y", "server-fetch"]);
  assert.strictEqual(resolved.env.PATH, "/managed");

  const plainSrv = mgr.addServer({ name: "Custom", transport: "stdio", command: "/usr/local/bin/my-server", args: ["--flag"] });
  const plain = mgr._resolveCommand(settings.get("mcp.servers").find((x) => x.id === plainSrv.id));
  assert.strictEqual(plain.command, "/usr/local/bin/my-server", "a non-npx command is untouched");
  assert.deepStrictEqual(plain.args, ["--flag"]);
});
