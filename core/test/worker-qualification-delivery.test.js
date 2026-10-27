"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const { submitQualificationResult } = require("../lib/koin-network/qualification-result");

const answer = () => ({ jobId: "a".repeat(64), output: "OK", signature: "one-existing-signature" });
const ack = { accepted: true, qualification: { state: "testing", completed: 1 } };
const json = (response, body, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
async function fixture(t, handler) {
  const bodies = [], server = http.createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    bodies.push(body); handler(response, bodies.length);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}/qualification`, bodies };
}

test("transient qualification failures replay the same serialized body and signature", async t => {
  for (const fault of [429, 502, 503, 504, "connection-reset", "response-stream-reset"]) {
    const body = answer(), original = JSON.stringify(body);
    const f = await fixture(t, (response, count) => {
      if (count > 1) return json(response, ack);
      body.output = "must never replace the signed answer";
      if (fault === "connection-reset") return response.destroy();
      if (fault === "response-stream-reset") {
        response.writeHead(200, { "content-type": "application/json" }); response.write('{"accepted":');
        setTimeout(() => response.destroy(), 10); return;
      }
      json(response, { error: "temporary failure" }, fault);
    });
    assert.deepEqual(await submitQualificationResult({ url: f.url, body }), ack, fault);
    assert.deepEqual(f.bodies, [original, original], fault);
  }
});

test("definitive rejections, malformed responses and missing acknowledgments never retry", async t => {
  const cases = [400, 401, 403, 404, 409, 500, "invalid-json", "oversized", "empty", "unacknowledged", "wrong-state"];
  for (const fault of cases) {
    const f = await fixture(t, response => {
      if (typeof fault === "number") return json(response, { error: "rejected" }, fault);
      if (fault === "empty") { response.writeHead(204); response.end(); return; }
      if (fault === "invalid-json") { response.end("not JSON"); return; }
      if (fault === "oversized") { response.end(JSON.stringify({ ...ack, excess: "x".repeat(4096) })); return; }
      json(response, fault === "wrong-state" ? { ...ack, qualification: { state: "online" } } : { accepted: false });
    });
    await assert.rejects(submitQualificationResult({ url: f.url, body: answer() }), undefined, fault);
    assert.equal(f.bodies.length, 1, fault);
  }
});

test("qualification delivery stops after three attempts and honors a longer server retry wait", async t => {
  const failed = await fixture(t, response => json(response, { error: "temporary" }, 503));
  await assert.rejects(submitQualificationResult({ url: failed.url, body: answer() }), /HTTP 503/);
  assert.equal(failed.bodies.length, 3);
  assert.equal(new Set(failed.bodies).size, 1);
  const throttled = await fixture(t, response => { response.setHeader("retry-after", "9999999999999999999999999999999999999999999999999999999999"); json(response, {}, 429); });
  await assert.rejects(submitQualificationResult({ url: throttled.url, body: answer() }), /HTTP 429/);
  assert.equal(throttled.bodies.length, 1, "do not retry before the requested wait or overflow a timer");
});

test("a stalled acknowledgment times out and recovers the same answer within the delivery budget", { timeout: 10000 }, async t => {
  const f = await fixture(t, (response, count) => { if (count > 1) json(response, ack); });
  assert.deepEqual(await submitQualificationResult({ url: f.url, body: answer() }), ack);
  assert.equal(f.bodies.length, 2);
  assert.equal(new Set(f.bodies).size, 1);
});

test("Stop aborts an in-flight result or retry wait without another submission", async t => {
  for (const pending of ["request", "backoff"]) {
    const controller = new AbortController(); let arrived;
    const first = new Promise(resolve => { arrived = resolve; });
    const f = await fixture(t, response => { if (pending === "backoff") json(response, {}, 503); arrived(); });
    const result = submitQualificationResult({ url: f.url, body: answer(), signal: controller.signal });
    const rejected = assert.rejects(result, /stopped/);
    await first;
    if (pending === "backoff") await new Promise(resolve => setTimeout(resolve, 30));
    controller.abort(Error("stopped")); await rejected;
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(f.bodies.length, 1, pending);
  }
});
