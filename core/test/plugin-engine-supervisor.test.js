"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { fork } = require("node:child_process"), { once } = require("node:events");
const { createEngineSupervisor } = require("../lib/plugins/engine-supervisor");
const { createEnginePlatform } = require("../lib/plugins/engine-platform");
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
async function fixture(t, host = "127.0.0.1") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-engine-")), model = path.join(dir, "model.gguf");
  fs.writeFileSync(model, "inert model fixture");
  const entrypoint = fs.realpathSync(path.join(__dirname, "fixtures/plugin-local-engine.cjs"));
  const child = fork(entrypoint, [model, host], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: {} });
  t.after(() => { child.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });
  const [ready] = await once(child, "message");
  const spec = { resource: `model:fixture-${child.pid}`, child, port: ready.port, apiKey: ready.apiKey, timeoutMs: 1000,
    executablePath: fs.realpathSync(process.execPath), executableSha256: digest(process.execPath), modelPath: model,
    modelSha256: digest(model), entrypointPath: entrypoint, entrypointSha256: digest(entrypoint) };
  const supervisor = createEngineSupervisor();
  const input = () => ({ resource: spec.resource, prompt: "hello", maxOutputTokens: 10, signal: new AbortController().signal });
  return { spec, child, supervisor, input, model };
}
const linux = { skip: process.platform !== "linux" };
test("Linux verifies executable/model handles and exact PID-owned loopback listener before inference", linux, async t => {
  const f = await fixture(t), session = await f.supervisor.supervise(f.spec);
  assert.equal(await session.infer(f.input()), "local answer"); assert(await session.close());
});
test("wrong executable/model/script hashes, missing model handle and another process endpoint are denied", linux, async t => {
  for (const key of ["executableSha256", "modelSha256", "entrypointSha256"]) {
    const f = await fixture(t); await assert.rejects(f.supervisor.supervise({ ...f.spec, [key]: "0".repeat(64) }));
  }
  const owner = await fixture(t), other = await fixture(t);
  await assert.rejects(owner.supervisor.supervise({ ...owner.spec, port: other.spec.port, apiKey: other.spec.apiKey }));
  const wrongModel = await fixture(t), closedModel = path.join(path.dirname(wrongModel.model), "other.gguf");
  fs.copyFileSync(wrongModel.model, closedModel);
  await assert.rejects(wrongModel.supervisor.supervise({ ...wrongModel.spec, modelPath: closedModel }));
});
test("model mutation and child exit after admission deny later dispatch", linux, async t => {
  const f = await fixture(t), session = await f.supervisor.supervise(f.spec);
  fs.writeFileSync(f.model, "changed model"); await assert.rejects(session.infer(f.input()));
  assert(await session.close());
  const other = await fixture(t), otherSession = await other.supervisor.supervise(other.spec);
  const exit = once(other.child, "exit"); other.child.kill("SIGKILL"); await exit;
  await assert.rejects(otherSession.infer(other.input())); assert(await otherSession.close());
});
test("resource/PID/port reservations are synchronous across supervisor instances", linux, async t => {
  const f = await fixture(t), pending = f.supervisor.supervise(f.spec);
  await assert.rejects(createEngineSupervisor().supervise(f.spec));
  const session = await pending;
  const other = await fixture(t);
  await assert.rejects(other.supervisor.supervise({ ...other.spec, resource: f.spec.resource }));
  assert(await session.close());
  const replacement = await other.supervisor.supervise({ ...other.spec, resource: f.spec.resource });
  // Repeated close from the old owner must not clear the replacement reservation.
  assert(await session.close());
  await assert.rejects(createEngineSupervisor().supervise({ ...other.spec, resource: f.spec.resource }));
  assert(await replacement.close());
});
test("abort during verification terminates engine and never dispatches", linux, async t => {
  const f = await fixture(t), real = createEnginePlatform(); let checks = 0, finish;
  const platform = { supported: true, verify: spec => ++checks === 1 ? real.verify(spec) : new Promise(resolve => { finish = resolve; }) };
  const session = await createEngineSupervisor({ platform }).supervise(f.spec);
  const controller = new AbortController(), pending = session.infer({ ...f.input(), signal: controller.signal });
  const rejected = assert.rejects(pending);
  await Promise.resolve();
  const exit = once(f.child, "exit"); controller.abort(); await exit;
  finish(true); await rejected; assert(await session.close());
});
test("unsupported Windows verification fails closed without claiming a sandbox", async t => {
  const f = await fixture(t);
  await assert.rejects(createEngineSupervisor({ platform: createEnginePlatform("win32") }).supervise(f.spec));
  assert.equal(f.child.killed, false); // Admission did not take ownership.
});
test("verification timeout and cancellation settle without waiting for verifier or allowing late dispatch", linux, async t => {
  const f = await fixture(t);
  await assert.rejects(createEngineSupervisor({ platform: { supported: true, verify: () => new Promise(() => {}) } })
    .supervise({ ...f.spec, timeoutMs: 30 }));
  assert(f.child.killed);
  const other = await fixture(t); let calls = 0;
  const real = createEnginePlatform();
  const session = await createEngineSupervisor({ platform: { supported: true,
    verify: spec => ++calls === 1 ? real.verify(spec) : new Promise(() => {}) } }).supervise(other.spec);
  const controller = new AbortController(), pending = session.infer({ ...other.input(), signal: controller.signal });
  controller.abort(); await assert.rejects(pending); assert(await session.close());
});
test("a verifier must explicitly confirm ownership", linux, async t => {
  for (const result of [false, undefined]) {
    const f = await fixture(t);
    await assert.rejects(createEngineSupervisor({ platform: { supported: true, verify: async () => result } }).supervise(f.spec));
    assert(f.child.killed);
  }
});
test("wildcard listeners and a closed model descriptor cannot establish ownership", linux, async t => {
  const wildcard = await fixture(t, "0.0.0.0");
  await assert.rejects(wildcard.supervisor.supervise(wildcard.spec));
  const f = await fixture(t), session = await f.supervisor.supervise(f.spec);
  const reply = once(f.child, "message"); f.child.send("close-model"); await reply;
  await assert.rejects(session.infer(f.input())); assert(await session.close());
});
test("unconfirmed shutdown quarantines resource reservations across supervisors", linux, async t => {
  const f = await fixture(t), session = await f.supervisor.supervise(f.spec), kill = f.child.kill;
  f.child.kill = () => { throw Error("cannot terminate"); };
  try {
    assert.equal(await session.close(), false);
    const other = await fixture(t);
    await assert.rejects(other.supervisor.supervise({ ...other.spec, resource: f.spec.resource }));
  } finally { f.child.kill = kill; f.child.kill("SIGKILL"); }
});
test("host-only consent expiry and uninstall terminate a supervised child with no late dispatch", linux, async t => {
  const { createInstallationHost, envelope } = require("../lib/plugins/installation-host");
  const { validateManifest } = require("../lib/plugins/permissions");
  for (const mode of ["expiry", "uninstall"]) {
    const f = await fixture(t), session = await f.supervisor.supervise(f.spec);
    const keys = crypto.generateKeyPairSync("ed25519"), artifact = Buffer.from("reviewed fixture plugin");
    const manifest = validateManifest({ schemaVersion: 1, id: "compare", version: "1.0.0",
      permissions: [{ kind: "local-inference", resource: f.spec.resource, action: "infer" }] });
    const signature = crypto.sign(null, envelope(manifest, "publisher", crypto.createHash("sha256").update(artifact).digest("hex")), keys.privateKey).toString("base64");
    let saved = null;
    const host = createInstallationHost({ publishers: [["publisher", keys.publicKey.export({ type: "spki", format: "pem" })]],
      store: { load: () => saved, save: value => { saved = structuredClone(value); } }, localInference: session.infer });
    t.after(() => host.close());
    const installation = host.install({ manifest, publisher: "publisher", artifact, signature });
    const grantId = host.approveConsent(host.prepareConsent(installation, { scope: manifest.permissions[0],
      expiresAt: Date.now() + (mode === "expiry" ? 30 : 5000), limits: { calls: 1, inputChars: 20, outputTokens: 10 } }));
    const exit = once(f.child, "exit");
    const pending = host.connect(installation).infer({ grantId, resource: f.spec.resource, prompt: "hang", maxOutputTokens: 10 });
    const rejected = assert.rejects(pending);
    if (mode === "uninstall") host.uninstall(installation);
    await rejected; await exit; assert(await session.close());
  }
});
