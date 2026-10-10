"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createProtectedStore } = require("../lib/plugins/protected-store");
const { createInstallationHost, envelope } = require("../lib/plugins/installation-host");
const { validateManifest } = require("../lib/plugins/permissions");
const linux = { skip: process.platform !== "linux" };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-store-")); fs.chmodSync(directory, 0o700);
  const integrityKey = crypto.randomBytes(32), stores = [];
  t.after(() => { for (const store of stores) { try { store.close(); } catch {} } fs.rmSync(directory, { recursive: true, force: true }); });
  const open = (key = integrityKey) => { const s = createProtectedStore({ directory, integrityKey: key }); stores.push(s); return s; };
  const keys = crypto.generateKeyPairSync("ed25519");
  function host(store) {
    const h = createInstallationHost({ publishers: [["host", keys.publicKey.export({ type: "spki", format: "pem" })]], store, localInference: async () => "ok" });
    t.after(() => h.close()); return h;
  }
  function signed(version = "1.0.0") {
    const artifact = Buffer.from(`first-party ${version}`), manifest = validateManifest({ schemaVersion: 1, id: "compare", version,
      permissions: [{ kind: "local-inference", resource: "model:a", action: "infer" }] });
    const signature = crypto.sign(null, envelope(manifest, "host", crypto.createHash("sha256").update(artifact).digest("hex")), keys.privateKey).toString("base64");
    return { manifest, publisher: "host", artifact, signature };
  }
  return { directory, integrityKey, open, host, signed };
}
function grant(host, handle) {
  return host.approveConsent(host.prepareConsent(handle, { scope: host.inspect(handle).manifest.permissions[0], expiresAt: Date.now() + 5000,
    limits: { calls: 2, inputChars: 20, outputTokens: 10 } }));
}
const request = grantId => ({ grantId, resource: "model:a", prompt: "hi", maxOutputTokens: 10 });
test("protected inventory restarts without grants; snapshots are read-only copies and updates retain recovery bytes", linux, async t => {
  const f = fixture(t), store = f.open(), host = f.host(store), v1 = f.signed();
  const old = host.install(v1), oldHash = host.inspect(old).artifactSha256, oldGrant = grant(host, old), oldClient = host.connect(old);
  const copy = store.readArtifact(oldHash); copy.fill(0); assert.deepEqual(store.readArtifact(oldHash), v1.artifact);
  assert.equal(fs.statSync(path.join(f.directory, `${oldHash}.artifact`)).mode & 0o777, 0o400);
  const fresh = host.install(f.signed("1.0.1")); await assert.rejects(oldClient.infer(request(oldGrant)));
  assert.deepEqual(store.readArtifact(oldHash), v1.artifact);
  const freshGrant = grant(host, fresh); host.close(); store.close();
  const restartedStore = f.open(), restarted = f.host(restartedStore), handle = restarted.lookup("compare");
  await assert.rejects(restarted.connect(handle).infer(request(freshGrant)));
  assert.equal(await restarted.connect(handle).infer(request(grant(restarted, handle))), "ok");
  restarted.uninstall(handle); assert.throws(() => restarted.lookup("compare"));
  assert.deepEqual(restartedStore.readArtifact(oldHash), v1.artifact);
});
test("single writer and stale lock fail closed; insecure roots and symlink roots are refused", linux, t => {
  const f = fixture(t), store = f.open(); assert.throws(() => f.open()); store.close();
  fs.writeFileSync(path.join(f.directory, "writer.lock"), "stale", { mode: 0o600 }); assert.throws(() => f.open());
  fs.unlinkSync(path.join(f.directory, "writer.lock")); fs.chmodSync(f.directory, 0o755); assert.throws(() => f.open()); fs.chmodSync(f.directory, 0o700);
  const alias = f.directory + "-alias"; fs.symlinkSync(f.directory, alias); t.after(() => fs.unlinkSync(alias));
  assert.throws(() => createProtectedStore({ directory: alias, integrityKey: f.integrityKey }));
});
test("tampering, wrong keys and replayed in-process registry revisions are rejected", linux, t => {
  const f = fixture(t), store = f.open(), host = f.host(store); host.install(f.signed());
  const file = path.join(f.directory, "inventory.json"), original = fs.readFileSync(file);
  host.install(f.signed("1.0.1")); fs.writeFileSync(file, original); assert.throws(() => store.load());
  host.close(); store.close();
  const wrong = f.open(crypto.randomBytes(32)); assert.throws(() => wrong.load()); wrong.close();
  const data = JSON.parse(original); data.payload = data.payload.replace("1.0.0", "9.0.0"); fs.writeFileSync(file, JSON.stringify(data));
  const changed = f.open(); assert.throws(() => changed.load());
});
test("symlink, hardlink, writable and corrupted artifacts block restart/inference", linux, async t => {
  for (const kind of ["symlink", "hardlink", "writable", "corrupt"]) {
    const f = fixture(t), store = f.open(), host = f.host(store), handle = host.install(f.signed());
    const hash = host.inspect(handle).artifactSha256, file = path.join(f.directory, `${hash}.artifact`), id = grant(host, handle);
    if (kind === "symlink") { fs.renameSync(file, file + ".old"); fs.symlinkSync(file + ".old", file); }
    if (kind === "hardlink") fs.linkSync(file, file + ".link");
    if (kind === "writable") fs.chmodSync(file, 0o600);
    if (kind === "corrupt") { fs.chmodSync(file, 0o600); fs.writeFileSync(file, "corrupt"); fs.chmodSync(file, 0o400); }
    await assert.rejects(host.connect(handle).infer(request(id))); assert.throws(() => store.load());
  }
});
test("failed inventory commit retains old state, leaves only unreferenced snapshot and revokes live grants", linux, async t => {
  const f = fixture(t), store = f.open(); let failWrite = false;
  const wrapper = { ...store, save: state => { if (failWrite) throw Error("disk full"); store.save(state); } };
  const host = f.host(wrapper), old = host.install(f.signed()), client = host.connect(old), id = grant(host, old);
  const before = fs.readFileSync(path.join(f.directory, "inventory.json")); failWrite = true;
  assert.throws(() => host.install(f.signed("1.0.1"))); await assert.rejects(client.infer(request(id)));
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "inventory.json")), before);
  assert.equal(fs.readdirSync(f.directory).filter(file => file.endsWith(".artifact")).length, 2);
});
test("invalid publisher signatures never stage artifacts; path and asynchronous hooks fail closed", linux, async t => {
  const f = fixture(t), store = f.open(), host = f.host(store);
  assert.throws(() => host.install({ ...f.signed(), signature: "A".repeat(86) + "==" }));
  assert.equal(fs.readdirSync(f.directory).filter(file => file.endsWith(".artifact")).length, 0);
  assert.throws(() => store.readArtifact("../inventory.json"));
  const asyncStage = f.host({ ...store, stageArtifact: () => Promise.reject(Error("async stage")) });
  assert.throws(() => asyncStage.install(f.signed()));
  const asyncRead = f.host({ ...store, verifyArtifact: () => Promise.reject(Error("async verify")) }), handle = asyncRead.install(f.signed());
  await assert.rejects(asyncRead.connect(handle).infer(request(grant(asyncRead, handle))));
  await new Promise(resolve => setImmediate(resolve));
});
test("directory replacement and registry symlink/hardlink substitution fail without writing outside the anchor", linux, t => {
  for (const kind of ["directory", "symlink", "hardlink"]) {
    const f = fixture(t), store = f.open(), host = f.host(store); host.install(f.signed());
    const file = path.join(f.directory, "inventory.json"), original = fs.readFileSync(file);
    if (kind === "directory") {
      const moved = f.directory + "-moved"; fs.renameSync(f.directory, moved); fs.mkdirSync(f.directory, { mode: 0o700 });
      t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
      assert.throws(() => store.save({ schemaVersion: 1, installations: [] }));
      assert.deepEqual(fs.readdirSync(f.directory), []);
      assert.deepEqual(fs.readFileSync(path.join(moved, "inventory.json")), original);
    } else {
      if (kind === "symlink") { fs.renameSync(file, file + ".target"); fs.symlinkSync(file + ".target", file); }
      else fs.linkSync(file, file + ".target");
      assert.throws(() => store.load()); assert.throws(() => store.save({ schemaVersion: 1, installations: [] }));
      assert.deepEqual(fs.readFileSync(file + ".target"), original);
    }
  }
});
test("writer exclusion also holds across processes", linux, t => {
  const f = fixture(t); f.open();
  const { spawnSync } = require("node:child_process");
  const script = `const {createProtectedStore}=require(${JSON.stringify(require.resolve("../lib/plugins/protected-store"))});
    try { createProtectedStore({directory:${JSON.stringify(f.directory)},integrityKey:Buffer.alloc(32)}); process.exitCode=1; }
    catch { process.exitCode=0; }`;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
});
test("protected update invalidates a live transport while retaining the prior inert artifact", linux, async t => {
  const { createPluginTransport } = require("../lib/plugins/transport"), { once } = require("node:events");
  const f = fixture(t), store = f.open(), host = f.host(store), installed = host.install(f.signed());
  const priorHash = host.inspect(installed).artifactSha256;
  const review = host.prepareConsent(installed, { scope: host.inspect(installed).manifest.permissions[0], expiresAt: Date.now() + 5000,
    limits: { calls: 2, inputChars: 20, outputTokens: 10 } });
  const session = createPluginTransport({ host, installation: installed, review });
  t.after(() => { session.close(); session.port.close(); });
  async function call(id) {
    const reply = once(session.port, "message", { signal: AbortSignal.timeout(5000) });
    session.port.postMessage(JSON.stringify({ id, prompt: "hi", maxOutputTokens: 10 })); return JSON.parse((await reply)[0]);
  }
  assert((await call(1)).ok);
  host.install(f.signed("1.0.1")); assert.equal((await call(2)).ok, false);
  assert.equal(store.readArtifact(priorHash).toString(), "first-party 1.0.0");
});
