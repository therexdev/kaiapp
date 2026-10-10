"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { once } = require("node:events"), { Worker } = require("node:worker_threads");
const { createInstallationHost, envelope } = require("../lib/plugins/installation-host");
const { validateManifest } = require("../lib/plugins/permissions");
const { createPluginTransport } = require("../lib/plugins/transport");
function fixture(t, inference = async () => "local answer", duration = 5000) {
  const keys = crypto.generateKeyPairSync("ed25519"), artifact = Buffer.from("first-party fixture");
  const manifest = validateManifest({ schemaVersion: 1, id: "firstparty.compare", version: "1.0.0",
    permissions: [{ kind: "local-inference", resource: "model:fixture", action: "infer" }] });
  const signed = m => ({ manifest: m, publisher: "host", artifact, signature: crypto.sign(null,
    envelope(m, "host", crypto.createHash("sha256").update(artifact).digest("hex")), keys.privateKey).toString("base64") });
  let state = null;
  const host = createInstallationHost({ publishers: [["host", keys.publicKey.export({ type: "spki", format: "pem" })]],
    store: { load: () => state, save: s => { state = structuredClone(s); } }, localInference: inference });
  const installation = host.install(signed(manifest));
  const review = host.prepareConsent(installation, { scope: manifest.permissions[0], expiresAt: Date.now() + duration,
    limits: { calls: 3, inputChars: 20, outputTokens: 10 } });
  const session = createPluginTransport({ host, installation, review });
  t.after(() => { session.close(); session.port.close(); host.close(); });
  return { host, installation, review, session, signed, manifest };
}
const wire = id => JSON.stringify({ id, prompt: "hello", maxOutputTokens: 10 });
async function send(port, message) {
  const reply = once(port, "message", { signal: AbortSignal.timeout(5000) }); port.postMessage(message);
  return JSON.parse((await reply)[0]);
}
test("host-created port works in a real trusted worker with no caller/grant/owner APIs", async t => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(f.session), ["port", "close"]);
  assert.throws(() => createPluginTransport({ host: f.host, installation: f.installation, review: f.review }));
  const worker = new Worker(`const {workerData,parentPort}=require('node:worker_threads');
    workerData.port.once('message', reply=>{parentPort.postMessage(reply);workerData.port.close();});
    workerData.port.postMessage(${JSON.stringify(wire(1))});`, { eval: true, workerData: { port: f.session.port }, transferList: [f.session.port] });
  t.after(() => worker.terminate());
  assert.deepEqual(JSON.parse((await once(worker, "message"))[0]), { id: 1, ok: true, text: "local answer" });
});
test("forged identity, approval, resource, paths, object payloads and oversized messages fail closed", async t => {
  for (const input of [JSON.stringify({ id: 1, prompt: "hi", maxOutputTokens: 10, caller: "other" }),
    JSON.stringify({ id: 1, prompt: "hi", maxOutputTokens: 10, approved: true }),
    JSON.stringify({ id: 1, prompt: "hi", maxOutputTokens: 10, resource: "../wallet" }),
    '{"id":1,"prompt":"hi","maxOutputTokens":10,"__proto__":{"admin":true}}',
    JSON.stringify({ id: 1, operation: "install" }), { id: 1, prompt: "hi", maxOutputTokens: 10 },
    "x".repeat(128 * 1024 + 1), JSON.stringify({ id: 1, prompt: "hi", maxOutputTokens: 1000 })]) {
    let calls = 0; const f = fixture(t, async () => { calls++; return "bad"; });
    assert.equal((await send(f.session.port, input)).ok, false); assert.equal(calls, 0);
  }
});
test("replayed request IDs never spend a second call", async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; return "ok"; });
  assert((await send(f.session.port, wire(1))).ok);
  assert.equal((await send(f.session.port, wire(1))).ok, false); assert.equal(calls, 1);
});
test("concurrent messages close and revoke the exclusive grant with no late output", async t => {
  let started, finish, signal;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(t, request => { signal = request.signal; started(); return new Promise(resolve => { finish = resolve; }); });
  f.session.port.postMessage(wire(1)); await ready;
  assert.equal((await send(f.session.port, wire(2))).ok, false);
  assert(signal.aborted); finish("late");
});
test("port closure cancels outstanding inference", async t => {
  let started, aborted;
  const ready = new Promise(resolve => { started = resolve; }), stopped = new Promise(resolve => { aborted = resolve; });
  const f = fixture(t, ({ signal }) => { signal.addEventListener("abort", aborted, { once: true }); started(); return new Promise(() => {}); });
  f.session.port.postMessage(wire(1)); await ready; f.session.port.close(); await stopped;
});
test("update and expiry deny outstanding work without transferring consent", async t => {
  for (const mode of ["update", "expiry"]) {
    let started; const ready = new Promise(resolve => { started = resolve; });
    const f = fixture(t, () => { started(); return new Promise(() => {}); }, mode === "expiry" ? 100 : 5000);
    const result = send(f.session.port, wire(1)); await ready;
    if (mode === "update") f.host.install(f.signed(validateManifest({ ...f.manifest, version: "1.0.1" })));
    assert.equal((await result).ok, false);
  }
});
