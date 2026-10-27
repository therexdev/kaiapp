"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { McpManager } = require("../lib/mcp-manager"), { McpConnection } = require("../lib/mcp");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-mcp-startup-"));
  const script = path.join(directory, "stdio-fixture.js"), marker = path.join(directory, "spawned.txt");
  fs.writeFileSync(script, `"use strict";
require("node:fs").writeFileSync(process.argv[2], "started");
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "initialize" ? { serverInfo: { name: "startup-fixture" }, capabilities: {} } : { tools: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`);
  fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify({
    network: { privacyMode: "local-only" }, remote: { enabled: false }, earn: { autoStart: false },
    mcp: { servers: [{ id: "startup-fixture", name: "Startup fixture", transport: "stdio", command: [process.execPath],
      args: [script, marker], localSafe: true, trusted: false, autoConnect: true }] },
  }));
  // Hardware probing can execute platform utilities; it is unrelated to this
  // ordering test. The only real child is the local stdio fixture above.
  t.mock.method(require("../lib/hardware"), "detect", async () => ({ platform: process.platform, arch: process.arch,
    cpu: { model: "fixture", cores: 2 }, ramBytes: 8e9, gpus: [], disk: null, capabilities: { cpuFallback: true } }));
  const egress = [], children = [], listeningAtSpawn = [], beforeStop = [], connected = deferred();
  t.mock.method(global, "fetch", async url => { egress.push(String(url)); throw Error("External network is disabled in the MCP startup test"); });
  let core, autoConnectCalls = 0;
  const autoConnect = McpManager.prototype.autoConnect, stdioStart = McpConnection.prototype._stdioStart;
  t.mock.method(McpManager.prototype, "autoConnect", function (...args) { autoConnectCalls++; return autoConnect.apply(this, args); });
  t.mock.method(McpConnection.prototype, "_stdioStart", function (...args) {
    listeningAtSpawn.push(core?.gateway.server?.listening === true);
    const result = stdioStart.apply(this, args); children.push(this._child); return result;
  });
  t.after(async () => {
    for (const finish of beforeStop) await finish();
    await core?.stop();
    await Promise.all(children.map(child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      return new Promise(resolve => { child.once("exit", resolve); child.kill(); });
    }));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  core = await require("../server").createCore({ dataDir: directory, port: 0,
    onEvent: event => { if (event.type === "mcp:connected") connected.resolve(event); } });
  return { core, marker, connected, egress, listeningAtSpawn, beforeStop, calls: () => autoConnectCalls };
}

test("configured stdio MCP servers start only after the Core gateway successfully listens", { timeout: 10000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  assert.equal(f.calls(), 0, "constructing Core must not auto-connect tool servers");
  assert.deepEqual(f.listeningAtSpawn, []); assert.equal(fs.existsSync(f.marker), false);
  const listen = f.core.gateway.listen.bind(f.core.gateway);
  t.mock.method(f.core.gateway, "listen", async () => { entered.resolve(); await release.promise; return listen(); });
  let starting;
  f.beforeStop.push(async () => { release.resolve(); await starting?.catch(() => {}); });
  starting = f.core.start(); await entered.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls(), 0, "a pending listen must not start MCP");
  assert.deepEqual(f.listeningAtSpawn, []); assert.equal(fs.existsSync(f.marker), false);

  release.resolve(); const port = await starting; await f.connected.promise;
  assert.ok(Number.isInteger(port) && port > 0);
  assert.equal(f.core.gateway.server.listening, true);
  assert.equal(f.calls(), 1); assert.deepEqual(f.listeningAtSpawn, [true]);
  assert.equal(fs.readFileSync(f.marker, "utf8"), "started", "the configured stdio child really started after binding");
  assert.equal(f.core.gateway.mcp.servers()[0].connected, true);
  assert.deepEqual(f.egress, []);
});

test("a failed gateway bind leaves configured stdio MCP servers unspawned", { timeout: 10000 }, async t => {
  const f = await fixture(t), failure = Object.assign(new Error("fixture gateway bind failed"), { code: "EACCES" });
  assert.equal(f.calls(), 0); assert.equal(fs.existsSync(f.marker), false);
  t.mock.method(f.core.gateway, "listen", async () => { throw failure; });
  await assert.rejects(f.core.start(), error => error === failure);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls(), 0); assert.deepEqual(f.listeningAtSpawn, []);
  assert.equal(fs.existsSync(f.marker), false);
  assert.equal(f.core.gateway.mcp.servers()[0].connected, false);
  assert.deepEqual(f.egress, []);
});
