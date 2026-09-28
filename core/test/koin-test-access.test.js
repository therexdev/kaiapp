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
  assert.equal(service.authorize(config.schedulerUrl).sessionToken, credential.token);
  assert.throws(() => service.authorize("https://live.example/scheduler"), /changed/);
  assert.throws(() => service.install({ ...credential, owner: "different" }), /match/);
  online = false; assert.throws(() => service.authorize(config.schedulerUrl), /privacy/); online = true;
  wallet.address = "different"; assert.throws(() => service.authorize(config.schedulerUrl), /changed/);
});
test("Test access import fails before writing if OS encryption is unavailable", t => {
  const service = new TestAccess({ file: "/unused", config: { owner: "owner", schedulerUrl: "https://test.example/scheduler" } });
  assert.throws(() => service.install({ schema: 1, mode: "test-access", owner: "owner", schedulerUrl: "https://test.example/scheduler", accountId: "test", grantId: "test", token: "test_" + "a".repeat(43), expiresAt: Date.now() + 60000 }), /encryption/);
});
