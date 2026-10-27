"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { CreditService } = require("../../electron/credit-service"), { SessionFreeChat } = require("../../electron/session-free-chat");
const P = require("../lib/koin-network/job-protocol");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-guest-recovery-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifest = structuredClone(require("../lib/koin-network/credit-service.json"));
  const state = { guest: { accountId: "guest_" + P.hash("installation"), owner: "account-" + P.hash("verified-account:installation"), sessionToken: "df_first",
    scope: "device-free", schedulerUrl: manifest.config.schedulerUrl, deviceFree: true, sessionOnly: true, freeOnly: true, expiresAt: Date.now() + 86400000 }, paid: null, paidError: "signin-required", calls: 0 };
  const deviceFree = { creditAuthorization: async () => ({ ...state.guest }), assertCreditAuthorization: auth => assert.deepEqual(auth, state.guest), clear() {}, dispose() {} };
  const account = { settings: { get: () => "network" }, creditAuthorization: async () => {
    if (!state.paid) throw Object.assign(Error("Saved wallet access is not open"), { code: state.paidError }); return state.paid;
  }, assertCreditAuthorization: auth => assert.deepEqual(auth, state.paid) };
  const service = new CreditService({ dataDir: dir, service: manifest, account, deviceFreeAccount: deviceFree, storage: { isEncryptionAvailable: () => false },
    fetchImpl: async () => { state.calls++; throw Error("Context renewal must not submit or retry a chat"); } });
  t.after(() => service.dispose()); return { dir, service, state };
}
function savePending(c) {
  const value = { model: "koinos-network", messages: [{ role: "user", content: "Keep this private pending question" }], max_tokens: 16, freeOnly: true, paidFirst: false };
  const input = c.flow.input(value), id = P.hash("pending-guest-request");
  c.flow.save({ schema: 1, owner: c.config.owner, deployment: P.hash(JSON.stringify(c.config)), id, session: P.hash("prepaid-account:" + c.config.owner),
    requestHash: P.hash(JSON.stringify(input)), state: "pending", maxPaid: "0", input: c.flow.storage.encryptString(JSON.stringify(value)).toString("base64") });
  return { value, id };
}

test("same-device token renewal retains the private recovery key and request ID without resubmitting chat", async t => {
  const f = fixture(t), first = await f.service.context(), pending = savePending(first), originalStore = f.service.sessionStore;
  const bytes = fs.readFileSync(first.flow.file); assert.equal(bytes.includes(pending.value.messages[0].content), false);
  f.state.guest = { ...f.state.guest, sessionToken: "df_renewed", expiresAt: Date.now() + 86400000 };
  const renewed = await f.service.context(); assert.equal(f.service.sessionStore, originalStore); assert.equal(renewed.recoverable.length, 1);
  assert.equal(renewed.recoverable[0].record.id, pending.id); assert.equal(f.state.calls, 0);
  let recovered;
  t.mock.method(SessionFreeChat.prototype, "chat", async function(_window, value) {
    assert.equal(this.access.authorize(this.config.schedulerUrl).sessionToken, "df_renewed");
    assert.equal(this.read().id, pending.id); recovered = value; return { recovered: pending.id };
  });
  const result = await f.service.run("chat-recover", undefined, AbortSignal.timeout(1000));
  assert.deepEqual(recovered, pending.value); assert.equal(result.completion.recovered, pending.id); assert.equal(f.state.calls, 0);
  assert.deepEqual(fs.readFileSync(first.flow.file), bytes);
  assert.throws(() => first.flow.access.authorize(first.config.schedulerUrl), /deep-equal/, "old bearer contexts are still invalidated");
});

test("paid identity conflicts cannot be masked by free access; identity or paid-access switches erase prior free recovery keys", async t => {
  const f = fixture(t), first = await f.service.context(), pending = savePending(first), originalStore = f.service.sessionStore;
  f.state.paidError = "wallet-changed"; await assert.rejects(f.service.context(), { code: "wallet-changed" });
  assert.equal(f.service.sessionStore, originalStore); assert.equal(first.flow.read().id, pending.id);
  f.state.paidError = "signin-required";
  f.state.guest = { ...f.state.guest, accountId: "guest_" + P.hash("other"), owner: "account-" + P.hash("verified-account:other"), sessionToken: "df_other" };
  const different = await f.service.context(); assert.notEqual(f.service.sessionStore, originalStore); assert.equal(originalStore.key, null); assert.equal(originalStore.records.size, 0); assert.equal(different.recoverable.length, 0);
  savePending(different); const otherStore = f.service.sessionStore;
  f.state.paid = { accountId: "paid-wallet-account", owner: f.service.service.config.deployment.masterNode, sessionToken: "wc_paid" };
  const paid = await f.service.context(); assert.equal(paid.auth, f.state.paid); assert.equal(f.service.sessionStore, null); assert.equal(otherStore.key, null); assert.equal(otherStore.records.size, 0);
});

test("a different deployment retires the free in-memory recovery capability even when a bearer identity is reused", async t => {
  const f = fixture(t), first = await f.service.context(); savePending(first); const store = f.service.sessionStore;
  f.service.service.config.policyHash = P.hash("different-policy");
  await f.service.context(); assert.notEqual(f.service.sessionStore, store); assert.equal(store.key, null); assert.equal(store.records.size, 0);
});
