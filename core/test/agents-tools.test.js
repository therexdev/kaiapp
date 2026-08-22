"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const { ToolRegistry } = require("../lib/tools");
const { MemoryStore, registerMemoryTools } = require("../lib/memory");
const { registerBuiltinTools, safePath } = require("../lib/builtin-tools");
const { McpConnection } = require("../lib/mcp");
const { McpManager } = require("../lib/mcp-manager");
const { CalendarService, parseVevents } = require("../lib/caldav");
const { EmailService } = require("../lib/email");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kai-agents-"));

/* ---------------- tool registry: the single policy point ---------------- */

test("tool registry: egress tools vanish and refuse in Local-Only; sensitive tools demand confirmation", async () => {
  let mode = "local-only";
  const reg = new ToolRegistry({ privacyMode: () => mode });
  reg.register({ name: "local_ok", description: "", egress: false, sensitive: false, handler: () => "fine" });
  reg.register({ name: "webby", description: "", egress: true, sensitive: false, handler: () => "net" });
  reg.register({ name: "scary", description: "", egress: false, sensitive: true, handler: () => "did it" });

  assert.deepStrictEqual(reg.list().map((t) => t.name).sort(), ["local_ok", "scary"], "egress tool hidden in Local-Only");
  await assert.rejects(() => reg.call("webby"), /Local-Only/, "and refused server-side even if called anyway");

  await assert.rejects(() => reg.call("scary"), (e) => e.needsConfirmation === true, "sensitive without confirmation → machine-readable refusal");
  assert.strictEqual(await reg.call("scary", {}, { confirmed: true }), "did it", "confirmed call runs");

  mode = "local-first";
  assert.ok(reg.list().some((t) => t.name === "webby"), "egress tool appears outside Local-Only");
  assert.strictEqual(await reg.call("webby"), "net");
});

test("tool registry: unspecified flags fail closed (egress+sensitive)", async () => {
  const reg = new ToolRegistry({ privacyMode: () => "network" });
  reg.register({ name: "mystery", description: "", handler: () => "x" });
  await assert.rejects(() => reg.call("mystery"), (e) => e.needsConfirmation === true);
});

/* ---------------- memory ---------------- */

test("memory: persists across store instances, dedups, searches by relevance", () => {
  const dir = tmp();
  const m1 = new MemoryStore(dir);
  m1.add("The user prefers Python over JavaScript");
  m1.add("User's timezone is Central European Time");
  m1.add("Dog's name is Bruno");
  m1.add("The user prefers Python over JavaScript"); // dup → refresh, not duplicate
  assert.strictEqual(m1.list().length, 3, "dedup by text");

  const m2 = new MemoryStore(dir); // fresh instance = fresh process
  assert.strictEqual(m2.list().length, 3, "memories survive restart");
  const hits = m2.search("what programming language does the user like", 2);
  assert.ok(hits.length >= 1 && /Python/.test(hits[0].text), "keyword relevance finds the right memory first");
  assert.deepStrictEqual(m2.search("quantum blockchain sailboat"), [], "no noise when nothing matches");

  m2.remove(hits[0].id);
  assert.strictEqual(new MemoryStore(dir).list().length, 2, "delete persists");
});

test("memory tools register as all-local and callable without confirmation", async () => {
  const reg = new ToolRegistry({ privacyMode: () => "local-only" });
  registerMemoryTools(reg, new MemoryStore(tmp()));
  assert.strictEqual(await reg.call("memory_save", { text: "likes espresso" }), "remembered");
  assert.match(await reg.call("memory_search", { query: "espresso coffee" }), /espresso/);
});

/* ---------------- workspace file sandbox ---------------- */

test("workspace files: reads/writes confined to the workspace folder", async () => {
  const dir = tmp();
  const reg = new ToolRegistry({ privacyMode: () => "local-only" });
  registerBuiltinTools(reg, { dataDir: dir });
  await reg.call("write_file", { name: "notes/plan.md", content: "step 1" });
  assert.strictEqual(await reg.call("read_file", { name: "notes/plan.md" }), "step 1");
  assert.match(await reg.call("list_files", {}), /notes\/plan\.md/);

  const root = path.join(dir, "workspace");
  assert.throws(() => safePath(root, "../../etc/passwd"), /escapes/);
  assert.throws(() => safePath(root, "/etc/passwd"), /escapes/);
  await assert.rejects(() => reg.call("read_file", { name: "..\\..\\secret" }), /escapes/);
});

/* ---------------- MCP: real protocol over both transports ---------------- */

// A genuine MCP server implemented inline over stdio (node -e script).
const STDIO_SERVER = `
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  if (m.method === "initialize") reply({ protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: "test-srv", version: "1" } });
  else if (m.method === "tools/list") reply({ tools: [{ name: "shout", description: "uppercase text", inputSchema: { type: "object", properties: { text: { type: "string", description: "text" } } } }] });
  else if (m.method === "tools/call") reply({ content: [{ type: "text", text: String(m.params.arguments.text || "").toUpperCase() }] });
});
`;

test("mcp stdio: handshake, tools/list, tools/call against a real subprocess server", async () => {
  const conn = new McpConnection({ id: "t", name: "test", transport: "stdio", command: [process.execPath, "-e", STDIO_SERVER] });
  try {
    const tools = await conn.connect();
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, "shout");
    assert.strictEqual(await conn.callTool("shout", { text: "quiet" }), "QUIET");
  } finally {
    conn.close();
  }
});

test("mcp http: streamable-http transport with session id and SSE answer", async () => {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const m = JSON.parse(body);
      const wrap = (result) => JSON.stringify({ jsonrpc: "2.0", id: m.id, result });
      if (m.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
        res.end(wrap({ protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: "http-srv" } }));
      } else if (m.method === "notifications/initialized") {
        res.writeHead(202).end();
      } else if (m.method === "tools/list") {
        assert.strictEqual(req.headers["mcp-session-id"], "sess-1", "session id echoed");
        // Answer over SSE to prove that path works too.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${wrap({ tools: [{ name: "ping", description: "", inputSchema: {} }] })}\n\n`);
      } else if (m.method === "tools/call") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(wrap({ content: [{ type: "text", text: "pong" }] }));
      }
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const conn = new McpConnection({ id: "h", name: "http-test", transport: "http", url: `http://127.0.0.1:${port}/mcp` });
  try {
    const tools = await conn.connect();
    assert.strictEqual(tools[0].name, "ping");
    assert.strictEqual(await conn.callTool("ping", {}), "pong");
  } finally {
    conn.close();
    srv.close();
  }
});

test("mcp manager: registry naming, http=egress policy, trusted flip clears confirmation", async () => {
  const { JsonStore } = require("../lib/store");
  const dir = tmp();
  const settings = new JsonStore(path.join(dir, "settings.json"), {});
  let mode = "network";
  const reg = new ToolRegistry({ privacyMode: () => mode });
  const mgr = new McpManager({ settings, registry: reg, onEvent: () => {} });

  const s = mgr.addServer({ name: "Local test", transport: "stdio", command: [process.execPath, "-e", STDIO_SERVER] });
  await mgr.connect(s.id);
  const name = `mcp:${s.id}:shout`;
  assert.ok(reg.list().some((t) => t.name === name), "server tool lands in the registry");

  // Untrusted server → sensitive → confirmation required; trusted → clean call.
  await assert.rejects(() => reg.call(name, { text: "x" }), (e) => e.needsConfirmation === true);
  mgr.setServerFlags(s.id, { trusted: true });
  assert.strictEqual(await reg.call(name, { text: "abc" }, {}), "ABC");

  // stdio without the user's local-safe vouch counts as egress → hidden in Local-Only.
  mode = "local-only";
  assert.ok(!reg.list().some((t) => t.name === name), "unvouched stdio hidden in Local-Only");
  mgr.setServerFlags(s.id, { localSafe: true });
  assert.ok(reg.list().some((t) => t.name === name), "user vouch makes it visible again");

  mgr.closeAll();
  assert.strictEqual(reg.list().some((t) => t.name === name), false, "disconnect unregisters");
});

/*
 * A 29-tool server rendered 29 rows of `mcp:srvmsxqbdxy249df8:health` in the
 * multi-agent tool picker — the internal storage id, repeated on every line
 * (field report, v0.42.0). The handshake already returns the name the server
 * calls itself; this is that name reaching the list.
 *
 * The `name` key must NOT change: saved team specs store it.
 */
test("mcp manager: tools carry a readable label, and the id stays the wiring key", async () => {
  const { JsonStore } = require("../lib/store");
  const dir = tmp();
  const settings = new JsonStore(path.join(dir, "settings.json"), {});
  const reg = new ToolRegistry({ privacyMode: () => "network" });
  const mgr = new McpManager({ settings, registry: reg, onEvent: () => {} });

  // serverInfo.name is "test-srv" (see STDIO_SERVER); the user called it
  // something else entirely, and the SERVER's own name is what should win.
  const s = mgr.addServer({ name: "Whatever I typed", transport: "stdio", command: [process.execPath, "-e", STDIO_SERVER] });
  await mgr.connect(s.id);
  try {
    const t = reg.list().find((x) => x.name === `mcp:${s.id}:shout`);
    assert.ok(t, "the tool is registered under its id");
    assert.strictEqual(t.label, "test-srv:shout", "label comes from serverInfo.name, not the internal id");
    assert.strictEqual(t.server, "test-srv", "and the group header names the server");
    assert.strictEqual(t.serverId, s.id, "the id is still available, for a tooltip");
    assert.ok(!t.label.includes(s.id), "the id does not appear in what a person reads");

    // Built-ins have no server and fall back to their own name, so a list
    // consumer never has to branch on whether `label` exists.
    registerBuiltinTools(reg, { dataDir: dir });
    const builtin = reg.list().find((x) => x.name === "read_file");
    assert.ok(builtin, "a built-in is present");
    assert.strictEqual(builtin.label, "read_file", "built-ins label as themselves");
    assert.strictEqual(builtin.server, null, "and belong to no server group");
  } finally {
    mgr.closeAll();
  }
});

test("mcp manager: two servers with the SAME self-reported name stay tellable apart", async () => {
  const { JsonStore } = require("../lib/store");
  const dir = tmp();
  const settings = new JsonStore(path.join(dir, "settings.json"), {});
  const reg = new ToolRegistry({ privacyMode: () => "network" });
  const mgr = new McpManager({ settings, registry: reg, onEvent: () => {} });

  const a = mgr.addServer({ name: "one", transport: "stdio", command: [process.execPath, "-e", STDIO_SERVER] });
  const b = mgr.addServer({ name: "two", transport: "stdio", command: [process.execPath, "-e", STDIO_SERVER] });
  await mgr.connect(a.id);
  await mgr.connect(b.id);
  try {
    const la = reg.list().find((x) => x.name === `mcp:${a.id}:shout`).label;
    const lb = reg.list().find((x) => x.name === `mcp:${b.id}:shout`).label;
    /*
     * The id earns a place in the label ONLY here. Both servers say they are
     * "test-srv", so one of them has to carry a fragment of its id or the two
     * checkboxes are indistinguishable — which is worse than a little noise.
     */
    assert.notStrictEqual(la, lb, "identical server names must not produce identical labels");
    assert.ok(la.startsWith("test-srv") && lb.startsWith("test-srv"), "both still read as the server they are");
  } finally {
    mgr.closeAll();
  }
});

/* ---------------- calendar ---------------- */

test("ics parser: events, all-day, escaping, rrule marker", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:1@x",
    "SUMMARY:Team sync\\, weekly",
    "DTSTART:20260820T140000Z",
    "DTEND:20260820T150000Z",
    "RRULE:FREQ=WEEKLY",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:2@x",
    "SUMMARY:Launch",
    "  day", // folded continuation (RFC 5545: unfold strips CRLF + ONE space)
    "DTSTART;VALUE=DATE:20260821",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const evs = parseVevents(ics);
  assert.strictEqual(evs.length, 2);
  assert.strictEqual(evs[0].summary, "Team sync, weekly");
  assert.strictEqual(evs[0].repeats, true);
  assert.strictEqual(evs[1].summary, "Launch day");
  assert.strictEqual(evs[1].allDay, true);
});

test("caldav: REPORT parses server events; PUT creates one", async () => {
  const puts = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "REPORT") {
        assert.match(String(req.headers.authorization), /^Basic /);
        const soon = new Date(Date.now() + 3600000);
        const stamp = soon.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
        res.writeHead(207, { "content-type": "application/xml" });
        res.end(
          `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">` +
            `<d:response><d:propstat><d:prop><cal:calendar-data>BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:9@x\nSUMMARY:Dentist\nDTSTART:${stamp}\nEND:VEVENT\nEND:VCALENDAR</cal:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`
        );
      } else if (req.method === "PUT") {
        puts.push({ url: req.url, body });
        res.writeHead(201).end();
      } else res.writeHead(405).end();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;

  const cal = new CalendarService({ dataDir: tmp(), onEvent: () => {} });
  cal.saveConfig({ url: `http://127.0.0.1:${port}/cal/`, user: "u", pass: "p" });
  const evs = await cal.events(7);
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].summary, "Dentist");

  const created = await cal.create({ summary: "Call, with Bob", startIso: "2026-08-25T15:00:00Z" });
  assert.strictEqual(puts.length, 1);
  assert.match(puts[0].body, /SUMMARY:Call {2}with Bob/);
  assert.match(puts[0].body, /DTSTART:20260825T150000Z/);
  assert.ok(created.uid.endsWith("@koinos-ai"));
  srv.close();
});

/* ---------------- email config (no live IMAP in tests) ---------------- */

test("email: config round-trips via the 0600 fallback, status never leaks the password", () => {
  const dir = tmp();
  const svc = new EmailService({ dataDir: dir, safeStorage: null, onEvent: () => {} });
  assert.strictEqual(svc.status().connected, false);
  svc.saveConfig({ email: "me@example.com", imapHost: "imap.example.com", smtpHost: "smtp.example.com", pass: "app-password" });
  const st = svc.status();
  assert.strictEqual(st.connected, true);
  assert.strictEqual(st.email, "me@example.com");
  assert.strictEqual(st.credsEncrypted, false, "honest about the fallback");
  assert.ok(!JSON.stringify(st).includes("app-password"), "password never appears in status");
  assert.ok(st.presets.some((p) => p.id === "gmail"), "presets ship with guidance");
  svc.removeConfig();
  assert.strictEqual(svc.status().connected, false);
});

test("email: encrypted path uses safeStorage when the OS keychain is there", () => {
  const fakeSafe = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(Buffer.from(s).toString("base64")),
    decryptString: (b) => Buffer.from(b.toString(), "base64").toString(),
  };
  const dir = tmp();
  const svc = new EmailService({ dataDir: dir, safeStorage: fakeSafe, onEvent: () => {} });
  svc.saveConfig({ email: "a@b.c", imapHost: "h", pass: "secret" });
  const onDisk = fs.readFileSync(path.join(dir, "email.cfg"));
  assert.strictEqual(onDisk.slice(0, 4).toString(), "ENC1");
  assert.ok(!onDisk.includes("secret"), "plaintext password never touches disk");
  assert.strictEqual(svc.status().credsEncrypted, true);
});
