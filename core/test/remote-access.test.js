"use strict";

/*
 * Remote access (task #94): the app's local API served through the relay.
 *
 * The relay itself lives in the kai repo; what can go wrong HERE is the
 * device loop — the keys gate, the hello/poll/respond protocol, streaming,
 * the /v1-only re-check, and clean stop. A minimal in-test relay speaks
 * the exact wire protocol (hello -> {tunnelId, base}; poll -> {job};
 * respond/<id> with x-kai-status/x-kai-headers and a streamed body).
 */

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { RemoteAccess } = require("../lib/remote-access");

const makeSettings = () => {
  const store = new Map();
  return {
    get: (k, d) => (store.has(k) ? store.get(k) : d),
    set: (k, v) => store.set(k, v),
    store,
  };
};

/* A pocket relay: one queued job at a time, answers captured. */
function makeStubRelay() {
  const state = { pollSeen: 0, queue: [], answers: new Map(), waiters: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/relay/hello") {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, tunnelId: "t123", base: "http://relay.test/r/t123/v1" }));
    }
    if (req.method === "GET" && url.pathname === "/relay/poll") {
      state.pollSeen++;
      const job = state.queue.shift();
      res.writeHead(job ? 200 : 204, { "content-type": "application/json" });
      return res.end(job ? JSON.stringify({ ok: true, job }) : undefined);
    }
    const m = /^\/relay\/respond\/(.+)$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const answer = {
          status: req.headers["x-kai-status"],
          headers: JSON.parse(Buffer.from(String(req.headers["x-kai-headers"] || ""), "base64").toString("utf8") || "{}"),
          body: Buffer.concat(chunks).toString("utf8"),
        };
        state.answers.set(m[1], answer);
        for (const w of state.waiters.splice(0)) w(answer);
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  state.nextAnswer = () => new Promise((r) => state.waiters.push(r));
  return { server, state };
}

const startServer = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));

test("start() refuses while no API key exists", async () => {
  const remote = new RemoteAccess({
    relayUrl: "http://127.0.0.1:9",
    settings: makeSettings(),
    keys: { required: () => false },
    localBase: () => "http://127.0.0.1:9",
  });
  await assert.rejects(() => remote.start(), /API key/);
  assert.strictEqual(remote.status().enabled, false);
});

test("round trip: job in, local API called, streamed answer out", async () => {
  const { server: relaySrv, state } = makeStubRelay();
  const relayUrl = await startServer(relaySrv);

  let sawAuth = null;
  const local = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      sawAuth = req.headers.authorization || null;
      assert.strictEqual(req.url, "/v1/chat/completions");
      assert.strictEqual(JSON.parse(raw).model, "koinos-fast");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const localBase = await startServer(local);

  const settings = makeSettings();
  const remote = new RemoteAccess({
    relayUrl,
    settings,
    keys: { required: () => true },
    localBase: () => localBase,
  });
  await remote.start();
  assert.strictEqual(settings.get("remote.enabled"), true);

  state.queue.push({
    reqId: "job-1",
    method: "POST",
    path: "/v1/chat/completions",
    headers: { authorization: "Bearer caller-key", "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ model: "koinos-fast", stream: true, messages: [] })).toString("base64"),
  });
  const answer = await state.nextAnswer();
  assert.strictEqual(answer.status, "200");
  assert.strictEqual(answer.headers["content-type"], "text/event-stream");
  assert.ok(answer.body.includes('"content":"hi"'));
  assert.ok(answer.body.includes("data: [DONE]"));
  assert.strictEqual(sawAuth, "Bearer caller-key");

  // the hello round-trip surfaced the stable public base
  assert.strictEqual(remote.status().base, "http://relay.test/r/t123/v1");

  remote.stop();
  assert.strictEqual(settings.get("remote.enabled"), false);
  relaySrv.close();
  local.close();
});

test("a job outside /v1 is refused with a 502 answer, local API untouched", async () => {
  const { server: relaySrv, state } = makeStubRelay();
  const relayUrl = await startServer(relaySrv);
  let localHit = false;
  const local = http.createServer((req, res) => { localHit = true; res.writeHead(200); res.end(); });
  const localBase = await startServer(local);

  const remote = new RemoteAccess({
    relayUrl,
    settings: makeSettings(),
    keys: { required: () => true },
    localBase: () => localBase,
  });
  await remote.start();
  state.queue.push({ reqId: "job-2", method: "POST", path: "/core/tools/call", headers: {}, body: "" });
  const answer = await state.nextAnswer();
  assert.strictEqual(answer.status, "502");
  assert.ok(/only the \/v1 API/.test(answer.body));
  assert.strictEqual(localHit, false);

  remote.stop();
  relaySrv.close();
  local.close();
});

test("token is generated once and reused", async () => {
  const settings = makeSettings();
  const remote = new RemoteAccess({ relayUrl: "http://127.0.0.1:9", settings, keys: { required: () => true }, localBase: () => "" });
  const t1 = remote._token();
  const t2 = remote._token();
  assert.strictEqual(t1, t2);
  assert.ok(/^[0-9a-f]{64}$/.test(t1));
});
