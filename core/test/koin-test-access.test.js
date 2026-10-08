"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path"), os = require("os");
const { TestAccess } = require("../../electron/koin-test-access");
test("Test access is encrypted, pinned and separate from live account credentials", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-test-access-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { owner: "owner", schedulerUrl: "https://test.example/scheduler" }, wallet = { address: "owner" }; let online = true;
  const service = new TestAccess({ file: path.join(root, "access"), config, wallet, settings: { get: () => online ? "online" : "local-only" },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from("encrypted:" + s), decryptString: b => b.toString().slice(10) } });
  const credential = { schema: 1, mode: "test-access", owner: "owner", schedulerUrl: config.schedulerUrl, accountId: "test_account", grantId: "test_grant", token: "test_" + "a".repeat(43), expiresAt: Date.now() + 86400000 };
  assert.equal(service.install(credential).state, "access_imported");
  const installation = service.authorize(config.schedulerUrl).installation;
  service.install({ ...credential, token: "test_" + "b".repeat(43) });
  assert.equal(service.authorize(config.schedulerUrl).installation, installation);
  service.install(credential);
  assert.equal(service.authorize(config.schedulerUrl).sessionToken, credential.token);
  assert.throws(() => service.authorize("https://live.example/scheduler"), /changed/);
  assert.throws(() => service.install({ ...credential, owner: "different" }), /match/);
  online = false; assert.throws(() => service.authorize(config.schedulerUrl), /privacy/); online = true;
  wallet.address = "different"; assert.throws(() => service.authorize(config.schedulerUrl), /changed/);
});
for (const mode of ["test-deployment", "mainnet-pilot"]) test(mode + " host authorization verifies the exact backend, chain, wallet and encrypted installation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-test-lease-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { mode, owner: "owner", schedulerUrl: "https://test.example/scheduler", deployment: { chainId: "pinned-test-chain" } };
  let mismatch = false, captured;
  const service = new TestAccess({ file: path.join(root, "access"), config, wallet: { address: "owner" }, settings: { get: () => "online" },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() },
    fetchImpl: async (url, options) => { captured = { url, options }; const body = { mode: config.mode, chainId: config.deployment.chainId,
      owner: "owner", installation: mismatch ? "0".repeat(64) : JSON.parse(options.body).installation, granted: true };
      return { ok: true, body: [Buffer.from(JSON.stringify(body))] }; } });
  service.install({ schema: 1, mode: "test-access", owner: "owner", schedulerUrl: config.schedulerUrl, accountId: "test", grantId: "test", token: "test_" + "a".repeat(43), expiresAt: Date.now() + 60000 });
  assert.equal((await service.claimHost()).granted, true); assert.equal(captured.options.redirect, "error");
  assert.equal(captured.url, config.schedulerUrl + "/koin/test/lease"); assert.equal(captured.options.body.includes("test_"), false);
  mismatch = true; await assert.rejects(service.claimHost(), /host lease unavailable/);
});
test("Test access import fails before writing if OS encryption is unavailable", t => {
  const service = new TestAccess({ file: "/unused", config: { owner: "owner", schedulerUrl: "https://test.example/scheduler" } });
  assert.throws(() => service.install({ schema: 1, mode: "test-access", owner: "owner", schedulerUrl: "https://test.example/scheduler", accountId: "test", grantId: "test", token: "test_" + "a".repeat(43), expiresAt: Date.now() + 60000 }), /encryption/);
});
