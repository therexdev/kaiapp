"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { Signer } = require("koilib"), { Scheduler } = require("../../server/scheduler"), { CalendarService } = require("../lib/caldav"), { McpConnection } = require("../lib/mcp"), { Transport } = require("../lib/agent-network/transport");
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-service-security-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
async function server(t, handler) { const s = http.createServer(handler); await new Promise(r => s.listen(0, "127.0.0.1", r)); t.after(() => { s.closeAllConnections(); s.close(); }); return `http://127.0.0.1:${s.address().port}`; }
async function scheduler(t) { const s = new Scheduler({ dataDir: temp(t) }); const port = await s.listen(); t.after(() => s.close()); return { s, base: `http://127.0.0.1:${port}` }; }
const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("scheduler operator routes fail closed without a configured secret", async t => {
  const { s, base } = await scheduler(t);
  for (const route of ["/operator/revoke", "/operator/unrevoke", "/operator/enqueue", "/operator/settle", "/epoch/close"]) assert.equal((await post(base + route, {})).status, 401, route);
  s.operatorSecret = "fixture-secret";
  assert.equal((await post(base + "/operator/enqueue", { prompt: "fixture" }, { "x-operator-secret": "wrong" })).status, 401);
  assert.equal((await post(base + "/operator/enqueue", { prompt: "fixture" }, { "x-operator-secret": "fixture-secret" })).status, 200);
});

test("scheduler accepts results only from the assigned worker and rejects invalid billing counts", async t => {
  const { s, base } = await scheduler(t), a = new Signer({ privateKey: "01".repeat(32) }), b = new Signer({ privateKey: "02".repeat(32) });
  const register = async signer => (await (await post(base + "/worker/register", { address: signer.getAddress() })).json()).token;
  const ta = await register(a), tb = await register(b), job = s.enqueue({ prompt: "fixture" });
  s.workers.get(ta).lastSeen = 0;
  await fetch(base + "/worker/next-job?token=" + ta);
  assert.ok(s.workers.get(ta).lastSeen > Date.now() - 2000, "polling refreshes the stored worker record");
  const output = "fixture output", hash = crypto.createHash("sha256").update(`${job.id}|${output}`).digest();
  const wrong = { jobId: job.id, output, signature: Buffer.from(await b.signHash(hash)).toString("base64") };
  assert.equal((await post(base + "/worker/result?token=" + tb, wrong)).status, 403);
  const good = { ...wrong, signature: Buffer.from(await a.signHash(hash)).toString("base64") };
  for (const value of ["NaN", -1, 1.5, 2000001]) assert.equal((await post(base + "/worker/result?token=" + ta, { ...good, usage: { prompt_tokens: value } })).status, 400);
  assert.equal(s.pending.has(job.id), true); assert.equal(s.receipts.length, 0);
  assert.equal((await post(base + "/worker/result?token=" + ta, { ...good, usage: { prompt_tokens: 2, completion_tokens: 3 } })).status, 200);
  assert.equal(s.receipts.length, 1);
});

test("signed consumer requests cannot replay or run concurrently against the same wallet capacity", async t => {
  const { s, base } = await scheduler(t), signer = new Signer({ privateKey: "03".repeat(32) });
  s.workers.set("fixture", { address: "worker", models: [s.jobModel], lastSeen: Date.now() });
  const body = { address: signer.getAddress(), ts: Date.now(), messages: [{ role: "user", content: "fixture" }] };
  const sign = async b => ({ ...b, signature: Buffer.from(await signer.signHash(crypto.createHash("sha256").update(`consume|${b.address}|${b.ts}|${JSON.stringify(b.messages)}`).digest())).toString("base64") });
  const signed = await sign(body), controller = new AbortController();
  let enqueued; const queued = new Promise(r => enqueued = r), original = s.enqueue.bind(s); s.enqueue = data => { const job = original(data); enqueued(job); return job; };
  const first = fetch(base + "/consume/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed), signal: controller.signal }).catch(() => null);
  await queued;
  assert.equal((await post(base + "/consume/chat/completions", signed)).status, 409);
  assert.equal((await post(base + "/consume/chat/completions", await sign({ ...body, ts: body.ts + 1 }))).status, 409);
  assert.equal((await post(base + "/consume/chat/completions", await sign({ ...body, ts: "NaN" }))).status, 401);
  controller.abort(); await first;
  // Wait on the actual request cleanup, with a bounded test deadline.
  for (let i = 0; i < 50 && s._consumers.size; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(s.queue.length, 0); assert.equal(s._consumers.size, 0); assert.equal(s._consumerAddresses.size, 0);
});

test("calendar rejects invalid times and escapes injected ICS properties", async t => {
  let sent;
  const base = await server(t, (req, res) => { let raw = ""; req.on("data", c => raw += c); req.on("end", () => { sent = raw; res.writeHead(201).end(); }); });
  const calendar = new CalendarService({ dataDir: temp(t) }); calendar.saveConfig({ url: base + "/calendar/", user: "fixture", pass: "fixture" });
  for (const endIso of ["invalid", "2026-09-09T00:00:00Z"]) await assert.rejects(calendar.create({ summary: "fixture", startIso: "2026-09-10T08:00:00Z", endIso }), /end/);
  assert.equal(sent, undefined);
  await calendar.create({ summary: "Dentist\rATTENDEE:attacker@example.com", location: "Room, A; East\\West", startIso: "2026-09-10T08:00:00Z" });
  assert.ok(sent.includes("SUMMARY:Dentist\\nATTENDEE:attacker@example.com"));
  assert.equal(sent.split(/\r?\n/).filter(s => s.startsWith("ATTENDEE:")).length, 0);
  assert.ok(sent.includes("LOCATION:Room\\, A\\; East\\\\West"));
  assert.throws(() => calendar.saveConfig({ url: "http://remote.example/calendar/", user: "fixture", pass: "fixture" }), /HTTPS/);
  fs.writeFileSync(calendar.file, "PLN1" + JSON.stringify({ url: "http://remote.example/calendar/", user: "fixture", pass: "fixture" }));
  await assert.rejects(calendar.events(), /HTTPS/);
});

test("MCP resolves an SSE response without waiting for the server to close its stream", async t => {
  let closed; const disconnected = new Promise(r => closed = r);
  const base = await server(t, (req, res) => { let raw = ""; req.on("data", c => raw += c); req.on("end", () => { const body = JSON.parse(raw); res.writeHead(200, { "content-type": "text/event-stream" }); res.write('event: message\r\ndata: ' + JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { text: "Ready ✓" } }) + '\r\n\r\n'); res.on("close", closed); }); });
  const mcp = new McpConnection({ name: "fixture", transport: "http", url: base });
  assert.deepEqual(await mcp._httpRpc("tools/list", {}, { timeoutMs: 1500 }), { text: "Ready ✓" });
  await disconnected;
});

test("Agent Network Stop cancels an already connected request", async t => {
  let connected; const ready = new Promise(r => connected = r);
  const base = await server(t, (_req, _res) => connected());
  const transport = new Transport({ allowLoopback: true });
  const pending = transport.request(base, "/agent-network/v1/config");
  const refused = assert.rejects(pending, /abort/i); await ready; transport.stop(); await refused;
  assert.equal(transport.active.size, 0);
});

test("SMTP refuses a plaintext server before sending credentials or email", async t => {
  const { EmailService } = require("../lib/email"), net = require("node:net");
  const commands = [], sockets = new Set();
  const smtp = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    socket.write("220 fixture ESMTP ready\r\n");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2); commands.push(line);
        if (/^EHLO /.test(line)) socket.write("250-fixture\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (line === "STARTTLS") socket.write("454 TLS unavailable\r\n");
        else socket.write("500 unsupported\r\n");
      }
    });
  });
  await new Promise(r => smtp.listen(0, "127.0.0.1", r));
  t.after(() => { for (const s of sockets) s.destroy(); smtp.close(); });
  const email = new EmailService({ dataDir: temp(t) });
  email.saveConfig({ email: "fixture@example.com", pass: "fixture-only-secret", imapHost: "127.0.0.1", smtpHost: "127.0.0.1", smtpPort: smtp.address().port });
  await assert.rejects(email.send({ to: "recipient@example.com", subject: "Fixture", text: "No message should be transmitted" }), /STARTTLS|TLS|454/i);
  assert.ok(commands.includes("STARTTLS"));
  assert.equal(commands.some(c => /^(AUTH|MAIL|RCPT|DATA)\b/.test(c)), false);
});

test("viewing earnings in Local-Only with earning stopped sends no scheduler request", async t => {
  let requests = 0;
  const base = await server(t, (_req, res) => { requests++; res.end(JSON.stringify({ ok: true, kai: "7" })); });
  const { createCore } = require("../server");
  const core = await createCore({ dataDir: temp(t), port: 0, onEvent() {} });
  t.after(() => core.stop());
  core.settings.set("earn.schedulerUrl", base);
  core.gateway.earn.createWallet({ password: "fixture password 123" });
  core.settings.set("network.privacyMode", "local-only");
  assert.equal((await core.gateway.earn.status()).earnings, null);
  assert.equal(requests, 0);
  core.settings.set("network.privacyMode", "local-first");
  assert.equal((await core.gateway.earn.status()).earnings.kai, "7");
  assert.equal(requests, 1);
  core.settings.set("network.privacyMode", "local-only");
  assert.equal((await core.gateway.earn.status()).earnings, null);
  assert.equal(requests, 1);
  let stopped = false;
  core.remote = { stop() { stopped = true; } };
  await core.stop();
  assert.equal(stopped, true, "Core shutdown stops remote polling");
});
