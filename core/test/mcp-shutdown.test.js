"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { McpManager } = require("../lib/mcp-manager");
const { JsonStore } = require("../lib/store");
const { ToolRegistry } = require("../lib/tools");

async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-mcp-shutdown-"));
  const settings = new JsonStore(path.join(dir, "settings.json"), {});
  const registry = new ToolRegistry({ privacyMode: () => "network" });
  const events = [];
  const manager = new McpManager({ settings, registry, onEvent: e => events.push(e) });
  t.after(() => { manager.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, settings, registry, events, manager };
}

const SERVER = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const [journal, gate, name] = process.argv.slice(1);
fs.appendFileSync(journal, JSON.stringify({name, pid: process.pid}) + "\n");
const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc: "2.0", id, result}) + "\n");
readline.createInterface({input: process.stdin}).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    const ready = () => {
      if (!fs.existsSync(gate)) return setTimeout(ready, 10);
      reply(m.id, {protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {name}});
    };
    ready();
  } else if (m.method === "tools/list") reply(m.id, {tools: [{name: "alive", inputSchema: {}}]});
  else if (m.method === "tools/call") reply(m.id, {content: [{type: "text", text: name}]});
});
`;

test("MCP shutdown kills a real child during initialize and stops the auto-connect queue; explicit reconnect still works", async t => {
  const { dir, settings, registry, events, manager } = fixture(t);
  const journal = path.join(dir, "children.jsonl"), gate = path.join(dir, "allow-handshake");
  const childPids = new Set();
  const children = () => {
    const entries = fs.existsSync(journal) ? fs.readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    for (const child of entries) childPids.add(child.pid);
    return entries;
  };
  // Also clean up if the assertions fail against the unfixed implementation.
  t.after(() => { for (const pid of childPids) { try { process.kill(pid); } catch {} } });
  const add = name => manager.addServer({ name, transport: "stdio", command: [process.execPath, "-e", SERVER, journal, gate, name] });
  const first = add("held-first"), second = add("must-not-spawn");
  manager.setServerFlags(first.id, { autoConnect: true });
  manager.setServerFlags(second.id, { autoConnect: true });
  const connecting = manager.autoConnect();
  await until(() => children().length === 1, "first stdio child should start");
  assert.deepEqual(registry.list(), []);
  manager.closeAll();
  await until(() => events.some(e => e.type === "mcp:exited" && e.server === first.name), "pending stdio child should exit after shutdown");
  await connecting;
  assert.deepEqual(children().map(c => c.name), ["held-first"], "retired auto-connect must not launch the next server");
  assert.equal(manager.servers().some(s => s.connected), false);
  assert.equal(events.some(e => e.type === "mcp:connected"), false);
  assert.deepEqual(registry.list(), []);
  assert.equal(settings.get("mcp.servers")[1].autoConnect, true, "shutdown preserves user preferences");

  fs.writeFileSync(gate, "ready");
  // Two callers share the new handshake, so only one replacement child exists.
  const [a, b] = await Promise.all([manager.connect(first.id), manager.connect(first.id)]);
  assert.deepEqual(a, b);
  assert.equal(children().length, 2);
  assert.equal(await registry.call(`mcp:${first.id}:alive`, {}, { confirmed: true }), "held-first");
  manager.closeAll();
  await until(() => events.filter(e => e.type === "mcp:exited" && e.server === first.name).length === 2, "replacement child should also stop");
  assert.deepEqual(registry.list(), []);
});

test("a late HTTP handshake cannot restore tools or overwrite a new connection after closeAll", async t => {
  const { registry, manager, events } = fixture(t);
  let releaseOld, releaseNew, oldListStarted = false, newListStarted = false, lists = 0;
  const held = new Promise(resolve => { releaseOld = resolve; });
  const freshHeld = new Promise(resolve => { releaseNew = resolve; });
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const m = JSON.parse(options.body);
    let result = {};
    if (m.method === "initialize") result = { serverInfo: { name: "fixture" } };
    if (m.method === "tools/list") {
      if (++lists === 1) { oldListStarted = true; await held; result = { tools: [{ name: "retired" }] }; }
      else { newListStarted = true; await freshHeld; result = { tools: [{ name: "current" }] }; }
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }), { headers: { "content-type": "application/json" } });
  });
  const server = manager.addServer({ name: "fixture", transport: "http", url: "https://mcp.invalid" });
  const old = manager.connect(server.id);
  const rejected = assert.rejects(old, /MCP connection cancelled/);
  await until(() => oldListStarted, "old tools/list should be pending");
  manager.closeAll();
  const fresh = manager.connect(server.id);
  await until(() => newListStarted, "new tools/list should be pending independently");
  releaseOld();
  await rejected;
  assert.deepEqual(registry.list(), [], "retired handshake cannot register while the replacement is pending");
  releaseNew();
  await fresh;
  assert.deepEqual(registry.list().map(t => t.name), [`mcp:${server.id}:current`]);
  assert.equal(manager.servers()[0].connected, true);
  assert.equal(events.filter(e => e.type === "mcp:connected").length, 1, "retired handshake must not emit success");
  manager.closeAll();
  assert.deepEqual(registry.list(), []);
});

test("disconnect cancels an individual pending handshake without closing the manager", async t => {
  const { registry, manager } = fixture(t);
  let release, started = false;
  const held = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const m = JSON.parse(options.body);
    if (m.method === "tools/list") { started = true; await held; }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "tools/list" ? { tools: [{ name: "retired" }] } : {} }));
  });
  const server = manager.addServer({ name: "fixture", transport: "http", url: "https://mcp.invalid" });
  const old = manager.connect(server.id), rejected = assert.rejects(old, /MCP connection cancelled/);
  await until(() => started, "tools/list should be pending");
  manager.disconnect(server.id);
  release();
  await rejected;
  assert.deepEqual(registry.list(), []);
  assert.equal(manager.servers()[0].autoConnect, false, "cancelled first connect cannot enable startup auto-connect");
});
