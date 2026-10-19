"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createInstallationHost, envelope } = require("../lib/plugins/installation-host");
const { validateManifest } = require("../lib/plugins/permissions");
const manifest = { schemaVersion: 1, id: "compare", version: "1.0.0",
  permissions: [{ kind: "local-inference", resource: "model:fixture", action: "infer" }] };
const approval = () => ({ scope: manifest.permissions[0], expiresAt: Date.now() + 10000,
  limits: { calls: 2, inputChars: 20, outputTokens: 10 } });
const request = grantId => ({ grantId, resource: "model:fixture", prompt: "hi", maxOutputTokens: 10 });
function fixture(t, localInference = async () => "ok") {
  const keys = new Map(["publisher-a", "publisher-b"].map(id => [id, crypto.generateKeyPairSync("ed25519")]));
  const publishers = [...keys].map(([id, key]) => [id, key.publicKey.export({ type: "spki", format: "pem" })]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-install-")), file = path.join(dir, "inventory.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Concrete atomic host-store fixture. No grants, keys or sessions go to disk.
  const store = { load: () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null,
    save: state => { fs.writeFileSync(file + ".tmp", JSON.stringify(state)); fs.renameSync(file + ".tmp", file); } };
  function open() { const host = createInstallationHost({ publishers, store, localInference }); t.after(() => host.close()); return host; }
  function signed(m = manifest, publisher = "publisher-a", artifact = Buffer.from("reviewed plugin")) {
    const artifactSha256 = crypto.createHash("sha256").update(artifact).digest("hex");
    const signature = crypto.sign(null, envelope(validateManifest(m), publisher, artifactSha256), keys.get(publisher).privateKey).toString("base64");
    return { manifest: m, publisher, artifact, signature };
  }
  return { open, signed, store, file, publishers };
}
test("only host-pinned signed publisher artifacts install; manifest cannot self-approve", t => {
  const f = fixture(t), host = f.open(), signed = f.signed();
  for (const patch of [{ publisher: "unknown" }, { signature: "A".repeat(86) + "==" }, { artifact: Buffer.from("changed") },
    { manifest: { ...manifest, version: "2.0.0" } }, { approved: true }]) assert.throws(() => host.install({ ...signed, ...patch }));
  const handle = host.install(signed), client = host.connect(handle);
  assert.deepEqual(Object.keys(client), ["infer"]);
  assert.throws(() => host.connect("compare")); assert.throws(() => host.connect({ id: "compare" }));
  assert.throws(() => host.approveConsent({ ...approval(), installation: host.inspect(handle) }));
});
test("one-use consent binds immutable owner review and rejects spoofed/reused tickets", async t => {
  const f = fixture(t), host = f.open(), handle = host.install(f.signed());
  const input = approval(), ticket = host.prepareConsent(handle, input);
  input.limits.outputTokens = 10000;
  assert.equal(ticket.limits.outputTokens, 10);
  assert.throws(() => host.approveConsent(structuredClone(ticket)));
  const grant = host.approveConsent(ticket);
  assert.throws(() => host.approveConsent(ticket));
  assert.equal(await host.connect(handle).infer(request(grant)), "ok");
  await assert.rejects(host.connect(handle).infer({ ...request(grant), caller: "compare", approved: true }));
});
test("publisher, version and artifact changes invalidate clients, grants and pending consent", async t => {
  for (const change of [f => f.signed(manifest, "publisher-b"), f => f.signed({ ...manifest, version: "2.0.0" }),
    f => f.signed(manifest, "publisher-a", Buffer.from("new artifact"))]) {
    const f = fixture(t), host = f.open(), old = host.install(f.signed()), client = host.connect(old);
    const ticket = host.prepareConsent(old, approval()), grant = host.approveConsent(host.prepareConsent(old, approval()));
    const replacement = host.install(change(f));
    assert.notEqual(host.inspect(replacement).installationId, ticket.installation.installationId);
    assert.throws(() => host.approveConsent(ticket)); await assert.rejects(client.infer(request(grant)));
    await assert.rejects(host.connect(replacement).infer(request(grant)));
  }
});
test("uninstall and identical reinstall require fresh identity and consent", async t => {
  const f = fixture(t), host = f.open(), old = host.install(f.signed());
  const before = host.inspect(old).installationId, client = host.connect(old);
  const grant = host.approveConsent(host.prepareConsent(old, approval()));
  host.uninstall(old); const replacement = host.install(f.signed());
  assert.notEqual(host.inspect(replacement).installationId, before);
  await assert.rejects(client.infer(request(grant))); await assert.rejects(host.connect(replacement).infer(request(grant)));
});
test("restart restores signed inventory only, never revoked/live grants, tickets or sessions", async t => {
  const f = fixture(t), oldHost = f.open(), old = oldHost.install(f.signed());
  const id = oldHost.inspect(old).installationId, ticket = oldHost.prepareConsent(old, approval());
  const revoked = oldHost.approveConsent(oldHost.prepareConsent(old, approval())); oldHost.revoke(revoked);
  const live = oldHost.approveConsent(oldHost.prepareConsent(old, approval())); oldHost.close();
  const host = f.open(), handle = host.lookup("compare");
  assert.equal(host.inspect(handle).installationId, id);
  assert.throws(() => host.connect(old)); assert.throws(() => host.approveConsent(ticket));
  for (const grant of [revoked, live]) await assert.rejects(host.connect(handle).infer(request(grant)));
  assert(!fs.readFileSync(f.file, "utf8").includes(live));
  assert.equal(await host.connect(handle).infer(request(host.approveConsent(host.prepareConsent(handle, approval())))), "ok");
});
test("tampered/corrupt stored identities and imported grants fail closed", t => {
  const f = fixture(t), host = f.open(); host.install(f.signed()); host.close();
  const original = f.store.load();
  for (const mutate of [s => s.grants = [], s => s.installations[0].publisher = "publisher-b",
    s => s.installations[0].manifest.version = "99.0.0", s => s.installations.push(s.installations[0])]) {
    const state = structuredClone(original); mutate(state); f.store.save(state); assert.throws(() => f.open());
  }
});
test("failed durable mutation revokes live authority and closes the host", async t => {
  const f = fixture(t), host = f.open(), handle = host.install(f.signed());
  const client = host.connect(handle), grant = host.approveConsent(host.prepareConsent(handle, approval()));
  f.store.save = () => { throw Error("disk full"); };
  assert.throws(() => host.uninstall(handle)); await assert.rejects(client.infer(request(grant)));
  assert.throws(() => host.lookup("compare"));
});
test("owner revocation settles in-flight inference; concurrent budget cannot self-renew", async t => {
  const f = fixture(t, () => new Promise(() => {})), host = f.open(), handle = host.install(f.signed());
  const grant = host.approveConsent(host.prepareConsent(handle, { ...approval(), limits: { calls: 1, inputChars: 20, outputTokens: 10 } }));
  const client = host.connect(handle), pending = client.infer(request(grant));
  await assert.rejects(client.infer(request(grant))); host.revoke(grant); await assert.rejects(pending);
});
test("unsupported asynchronous store operations fail closed without unhandled rejection", async t => {
  const f = fixture(t);
  const load = f.store.load;
  f.store.load = () => Promise.reject(Error("async storage unavailable"));
  assert.throws(() => f.open());
  f.store.load = load;
  const host = f.open();
  f.store.save = () => Promise.reject(Error("async write unavailable"));
  assert.throws(() => host.install(f.signed())); assert.throws(() => host.lookup("compare"));
  await new Promise(resolve => setImmediate(resolve));
});
