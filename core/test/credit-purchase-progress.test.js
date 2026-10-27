"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events");
const { purchaseProgress } = require("../../electron/credit-purchase-progress");
const { CreditService } = require("../../electron/credit-service");
const { registerTestPaymentIPC } = require("../../electron/koin-test-ipc");
const progress = () => ({ operationId: "a".repeat(64), stage: "awaiting-confirmation", startedAt: 1000, updatedAt: 2000,
  txId: "0x1220" + "b".repeat(64), blockHeight: "40570878", irreversibleHeight: "40570874" });

test("payment progress exposes public stages and heights without leaking credentials, envelopes or RPC errors", () => {
  const value = progress();
  assert.deepEqual(purchaseProgress({ ...value, sessionToken: "secret", signed: { signature: "secret" }, detail: "raw RPC credentials", error: "secret" }), value);
  assert.equal(purchaseProgress({ ...value, stage: "raw RPC credentials" }), null);
  assert.equal(purchaseProgress({ ...value, operationId: "session-token" }), null);
  assert.equal(purchaseProgress({ ...value, updatedAt: 999 }), null);
  const invalid = purchaseProgress({ ...value, txId: "secret", blockHeight: -1, irreversibleHeight: "<script>" });
  for (const key of ["txId", "blockHeight", "irreversibleHeight"]) assert.equal(Object.hasOwn(invalid, key), false);
  assert.equal(purchaseProgress({ ...value, stage: "complete", outcome: "credited" }).outcome, "credited");
  assert.equal(Object.hasOwn(purchaseProgress({ ...value, outcome: "unexpected" }), "outcome"), false);
});

test("payment progress remains behind the current main document and stops after navigation or disposal", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-purchase-progress-")), sent = [];
  const origin = "http://127.0.0.1:9000";
  const w = Object.assign(new EventEmitter(), { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: new EventEmitter() });
  w.webContents.mainFrame = { url: origin + "/" };
  w.webContents.send = (channel, value) => sent.push({ channel, value });
  t.mock.method(global, "setInterval", () => ({ unref() {} }));
  let handler, emit;
  t.mock.method(CreditService.prototype, "run", async function () {
    emit = this.purchases.progress;
    emit({ ...progress(), sessionToken: "secret" });
    return { quote: { id: "fixture" } };
  });
  const core = { gateway: { network: { trackShadowRequest: () => () => {} } } };
  const registration = registerTestPaymentIPC({ dataDir, core, isTest: true, dialog: {}, origin, getMainWindow: () => w,
    ipcMain: { handle: (_name, fn) => { handler = fn; } } });
  t.after(() => { registration.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame };
  await handler(event, "purchase-preview", { usd: "1" });
  assert.deepEqual(sent, [{ channel: "koin:purchase-progress", value: progress() }]);
  w.webContents.mainFrame.url = "https://untrusted.invalid/";
  emit(progress()); assert.equal(sent.length, 1, "in-flight events cannot reach a navigated document");
  w.webContents.mainFrame.url = origin + "/other-page";
  emit(progress()); assert.equal(sent.length, 1, "same-origin unrelated pages do not receive financial progress");
  w.webContents.mainFrame.url = origin + "/";
  registration.dispose(); emit(progress()); assert.equal(sent.length, 1, "late events after shutdown stay suppressed");
});

test("purchase-info sanitizes the current context's progress without requesting model or network data", async () => {
  const service = new CreditService({ service: require("../lib/koin-network/credit-service.json"), dataDir: "/unused", account: {} });
  const context = { auth: { accountId: "buyer" } };
  service.context = async () => context;
  service.purchases.status = async () => ({ state: "pending", txId: progress().txId });
  service.purchases.cancelled = async () => [];
  service.purchases.progressSnapshot = c => { assert.equal(c, context); return { ...progress(), token: "private" }; };
  assert.deepEqual((await service.purchaseInfo()).purchaseProgress, progress());
});
