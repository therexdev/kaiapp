"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createPermissionHost, validateManifest } = require("../lib/plugins/permissions");
const example = require("../../docs/plugins/compare-models.manifest.json");
const copy = x => structuredClone(x);
function fixture(adapter = async () => "answer") {
  let time = 1000;
  const host = createPermissionHost({ localInference: adapter, now: () => time });
  const manifestDigest = host.install(example);
  const approval = { caller: example.id, manifestDigest, scope: example.permissions[0], expiresAt: 2000,
    limits: { calls: 2, inputChars: 20, outputTokens: 10 } };
  const client = host.connect(example.id);
  const request = grantId => ({ grantId, resource: example.permissions[0].resource, prompt: "hello", maxOutputTokens: 10 });
  return { host, approval, client, request, tick: () => { time = 2000; } };
}
test("strict immutable manifests: unknown fields, wildcard, duplicates and versions fail closed", () => {
  const validated = validateManifest(example);
  assert(Object.isFrozen(validated.permissions[0]));
  for (const mutate of [m => m.extra = true, m => m.schemaVersion = 2, m => m.version = "latest",
    m => m.permissions[0].resource = "*", m => m.permissions.push(m.permissions[0]),
    m => m.permissions[0].action = "sign", m => m.permissions[0].kind = ["local-inference"],
    m => m.permissions[0].kind = "toString"]) {
    const m = copy(example); mutate(m); assert.throws(() => validateManifest(m));
  }
});
test("install has no privileges; exact owner-approved model scopes exercise Compare Models with fake inference", async () => {
  const seen = [], f = fixture(async x => { seen.push(x); return x.resource; });
  await assert.rejects(f.client.infer(f.request("invented")));
  for (const scope of example.permissions) {
    const id = f.host.approve({ ...f.approval, scope });
    assert.equal(await f.client.infer({ ...f.request(id), resource: scope.resource }), scope.resource);
  }
  assert.equal(seen.length, 2);
  assert.deepEqual(Object.keys(seen[0]).sort(), ["maxOutputTokens", "prompt", "resource", "signal"]);
});
test("caller, resource, arguments and non-transitive scope cannot be forged", async () => {
  const f = fixture(), id = f.host.approve(f.approval);
  f.host.install({ ...example, id: "other" });
  await assert.rejects(f.host.connect("other").infer(f.request(id)));
  for (const patch of [{ resource: "model:example-b" }, { caller: example.id }, { prompt: "x".repeat(21) },
    { maxOutputTokens: 11 }, { maxOutputTokens: NaN }, { delegate: "other" }, { background: true }]) {
    await assert.rejects(f.client.infer({ ...f.request(id), ...patch }));
  }
  assert.equal(f.client.approve, undefined);
  assert.throws(() => f.host.approve({ ...f.approval, delegate: "other" }));
});
test("revocation, expiry, stale approval and uninstall/reinstall invalidate authority", async () => {
  const f = fixture(), id = f.host.approve(f.approval);
  assert(f.host.revoke(id)); await assert.rejects(f.client.infer(f.request(id)));
  const id2 = f.host.approve(f.approval); f.tick(); await assert.rejects(f.client.infer(f.request(id2)));
  assert.throws(() => f.host.approve(f.approval));
  const a = fixture(), old = a.host.approve(a.approval);
  a.host.uninstall(example.id); a.host.install(example);
  await assert.rejects(a.client.infer(a.request(old)));
  const fresh = a.host.approve(a.approval);
  await assert.rejects(a.client.infer(a.request(fresh)));
});
test("any manifest change requires fresh owner approval, including privilege expansion", async () => {
  const f = fixture(), id = f.host.approve(f.approval);
  const changed = copy(example); changed.permissions.push({ kind: "wallet", action: "sign", resource: "wallet:own" });
  f.host.install(changed);
  await assert.rejects(f.client.infer(f.request(id)));
  assert.throws(() => f.host.approve(f.approval));
  const hash = f.host.install(changed);
  assert.throws(() => f.host.approve({ ...f.approval, manifestDigest: hash, scope: changed.permissions[2] }));
});
test("paid/network, background, accounts, personal data and other plugins have no adapters", () => {
  for (const [kind, action] of [["network-spend", "spend"], ["background-work", "run"], ["connected-account", "use"],
    ["personal-data", "read"], ["plugin", "invoke"]]) {
    const f = fixture(), scope = { kind, action, resource: "resource:own" };
    const hash = f.host.install({ ...example, permissions: [scope] });
    assert.throws(() => f.host.approve({ ...f.approval, manifestDigest: hash, scope }));
  }
});
test("concurrent calls reserve budget before dispatch; adapter errors do not refund", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw Error("failed"); }), id = f.host.approve(f.approval);
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => f.client.infer(f.request(id))));
  assert(results.every(x => x.status === "rejected")); assert.equal(calls, 2);
});
test("revoking an in-flight call signals cancellation and suppresses late results", async () => {
  let finish, signal;
  const f = fixture(x => { signal = x.signal; return new Promise(resolve => { finish = resolve; }); });
  const id = f.host.approve(f.approval), pending = f.client.infer(f.request(id));
  f.host.revoke(id); assert(signal.aborted); finish("late"); await assert.rejects(pending);
});
test("owner input is copied, bounded and expiry also suppresses in-flight results", async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  for (const patch of [{ expiresAt: Infinity }, { expiresAt: 1000 }, { expiresAt: 86401001 },
    { limits: { calls: 0, inputChars: 20, outputTokens: 10 } }, { manifestDigest: "stale" }]) {
    assert.throws(() => f.host.approve({ ...f.approval, ...patch }));
  }
  const id = f.host.approve(f.approval);
  f.approval.limits.outputTokens = 100;
  await assert.rejects(f.client.infer({ ...f.request(id), maxOutputTokens: 100 }));
  const pending = f.client.infer(f.request(id)); f.tick(); finish("late"); await assert.rejects(pending);
});
test("canonical scope order is stable; caller manifest mutation cannot expand installation", async () => {
  const f = fixture(), id = f.host.approve(f.approval);
  const reordered = copy(example); reordered.permissions.reverse();
  assert.equal(f.host.install(reordered), f.approval.manifestDigest);
  reordered.permissions[0].resource = "model:unapproved";
  assert.equal(await f.client.infer(f.request(id)), "answer");
  assert.throws(() => f.host.approve({ ...f.approval, scope: reordered.permissions[0] }));
});
test("version changes invalidate clients and process restart retains no grants", async () => {
  const f = fixture(), id = f.host.approve(f.approval);
  const hash = f.host.install({ ...example, version: "0.1.1" });
  const fresh = f.host.approve({ ...f.approval, manifestDigest: hash });
  await assert.rejects(f.client.infer(f.request(fresh)));
  assert.equal(await f.host.connect(example.id).infer(f.request(fresh)), "answer");
  const restarted = fixture(); await assert.rejects(restarted.client.infer(restarted.request(id)));
});
test("real expiry aborts an in-flight adapter, without accepting its late output", async () => {
  const host = createPermissionHost({ localInference: ({ signal }) => new Promise(resolve => {
    signal.addEventListener("abort", () => resolve("late"), { once: true });
  }) });
  const manifestDigest = host.install(example);
  const id = host.approve({ caller: example.id, manifestDigest, scope: example.permissions[0],
    expiresAt: Date.now() + 50, limits: { calls: 1, inputChars: 20, outputTokens: 10 } });
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(host.connect(example.id).infer({ grantId: id, resource: example.permissions[0].resource,
      prompt: "hello", maxOutputTokens: 10 }));
  } finally { clearTimeout(keepAlive); }
});
test("accessors cannot expand grants or revoke between validation and dispatch", async () => {
  let dispatches = 0, reads = 0;
  const f = fixture(async () => { dispatches++; return "ok"; });
  const limits = { calls: 2, inputChars: 20, get outputTokens() { reads++; return reads === 1 ? 10 : 1000000; } };
  assert.throws(() => f.host.approve({ ...f.approval, limits }));
  const id = f.host.approve(f.approval), request = f.request(id);
  Object.defineProperty(request, "prompt", { enumerable: true, get() { reads++; f.host.revoke(id); return "hi"; } });
  await assert.rejects(f.client.infer(request), /Plugin permission denied/);
  assert.equal(reads, 0); assert.equal(dispatches, 0);
});
test("prototype, path, symbol, sparse and custom-array inputs fail before dispatch", async () => {
  const f = fixture(), id = f.host.approve(f.approval);
  for (const request of [Object.assign(Object.create({ caller: "other" }), f.request(id)),
    { ...f.request(id), [Symbol("hidden")]: true }, { ...f.request(id), resource: "../wallet" }]) {
    await assert.rejects(f.client.infer(request));
  }
  for (const permissions of [Array(1), Object.assign(copy(example.permissions), { map: () => [] }),
    [Object.assign(Object.create({ admin: true }), example.permissions[0])]]) {
    assert.throws(() => validateManifest({ ...example, permissions }));
  }
  for (const resource of ["../wallet", "C:\\wallet", "file:../key", "model:%2fwallet"]) {
    assert.throws(() => validateManifest({ ...example, permissions: [{ ...example.permissions[0], resource }] }));
  }
  const polluted = JSON.parse('{"schemaVersion":1,"id":"x","version":"1.0.0","permissions":[],"__proto__":{"admin":true}}');
  assert.throws(() => validateManifest(polluted)); assert.equal({}.admin, undefined);
});
test("revocation and expiry settle even if an adapter ignores abort forever", async () => {
  const f = fixture(() => new Promise(() => {})), id = f.host.approve(f.approval);
  const pending = f.client.infer(f.request(id)); f.host.revoke(id);
  await assert.rejects(pending, { message: "Plugin permission denied" });
  const host = createPermissionHost({ localInference: () => new Promise(() => {}) });
  const manifestDigest = host.install(example);
  const expiring = host.approve({ ...f.approval, manifestDigest, expiresAt: Date.now() + 25 });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(host.connect(example.id).infer(f.request(expiring))); }
  finally { clearTimeout(keepAlive); }
});
test("adapter exceptions are redacted and observed expiry cannot resurrect after clock rollback", async () => {
  const f = fixture(async () => { throw Error("SECRET API TOKEN /private/profile"); }), id = f.host.approve(f.approval);
  await assert.rejects(f.client.infer(f.request(id)), { message: "Plugin permission denied" });
  let time = 1000;
  const host = createPermissionHost({ localInference: async () => "ok", now: () => time });
  const manifestDigest = host.install(example);
  const grant = host.approve({ ...f.approval, manifestDigest });
  time = 2000; await assert.rejects(host.connect(example.id).infer(f.request(grant)));
  time = 1000; await assert.rejects(host.connect(example.id).infer(f.request(grant)));
});
test("expiry first observed after completion is terminal across clock rollback", async () => {
  let time = 1000, finish;
  const host = createPermissionHost({ localInference: () => new Promise(resolve => { finish = resolve; }), now: () => time });
  const manifestDigest = host.install(example), approval = fixture().approval;
  const grantId = host.approve({ ...approval, manifestDigest });
  const client = host.connect(example.id), request = { grantId, resource: example.permissions[0].resource, prompt: "hi", maxOutputTokens: 10 };
  const pending = client.infer(request);
  time = 2000; finish("late"); await assert.rejects(pending);
  time = 1000; await assert.rejects(client.infer(request));
});
test("synchronous adapter revocation plus throw produces no unhandled rejection", () => {
  const { spawnSync } = require("node:child_process");
  const script = `
    const { createPermissionHost } = require(${JSON.stringify(require.resolve("../lib/plugins/permissions"))});
    const manifest = ${JSON.stringify(example)};
    let grantId;
    const host = createPermissionHost({ localInference: () => { host.revoke(grantId); throw Error("private"); } });
    const manifestDigest = host.install(manifest);
    grantId = host.approve({ caller: manifest.id, manifestDigest, scope: manifest.permissions[0],
      expiresAt: Date.now() + 1000, limits: { calls: 1, inputChars: 20, outputTokens: 10 } });
    host.connect(manifest.id).infer({ grantId, resource: manifest.permissions[0].resource, prompt: "hi", maxOutputTokens: 10 })
      .catch(error => { if (error.message !== "Plugin permission denied") process.exitCode = 1; });
    setTimeout(() => {}, 20);
  `;
  const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", "-e", script], { encoding: "utf8", timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
});
