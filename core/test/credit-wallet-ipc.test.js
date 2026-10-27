"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { EventEmitter } = require("node:events");
const { CreditService } = require("../../electron/credit-service"), { CreditProvider } = require("../../electron/credit-provider"), { registerTestPaymentIPC } = require("../../electron/koin-test-ipc");
for (const isTest of [false, true]) test(`${isTest ? "Test" : "Live"} wallet/device enrollment stays behind the visible main document and explicit native action`, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-wallet-ipc-"));
  let visible = true, handler, calls = [], stopSignal;
  const w = Object.assign(new EventEmitter(), { isDestroyed: () => false, isVisible: () => visible, isMinimized: () => false, webContents: new EventEmitter() });
  w.webContents.mainFrame = { url: "http://127.0.0.1:9000/" };
  t.mock.method(global, "setInterval", () => ({ unref() {} }));
  t.mock.method(CreditService.prototype, "walletInfo", async () => ({ state: "wallet-connection-required", detail: "Connect wallet" }));
  t.mock.method(CreditService.prototype, "connectWallet", async (_window, input, signal) => { calls.push(["credits", input]); stopSignal = signal; assert.equal(_window, w); return { state: "connected" }; });
  t.mock.method(CreditProvider.prototype, "authorize", async (_window, input, signal) => { calls.push(["provider", input]); stopSignal = signal; assert.equal(_window, w); return { state: "authorized" }; });
  t.mock.method(CreditProvider.prototype, "revoke", async (_window, signal) => { calls.push(["revoke"]); stopSignal = signal; assert.equal(_window, w); return { state: "revoked" }; });
  const core = { gateway: { network: { trackShadowRequest: () => () => {} } } };
  const registration = registerTestPaymentIPC({ dataDir, core, isTest, dialog: {}, origin: "http://127.0.0.1:9000", getMainWindow: () => w, ipcMain: { handle: (_name, fn) => { handler = fn; } } });
  t.after(() => { registration.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame };
  assert.equal((await handler(event, "wallet-info")).state, "wallet-connection-required"); assert.equal(calls.length, 0);
  for (const action of ["wallet-connect", "provider-public-authorize", "provider-public-revoke"]) {
    await assert.rejects(handler({ ...event, senderFrame: { url: event.senderFrame.url } }, action), /access denied/);
    visible = false; await assert.rejects(handler(event, action), /visible app/); visible = true;
    for (const input of [{ sessionOnly: "true" }, { sessionOnly: true, wallet: "other" }, [], null]) await assert.rejects(handler(event, action, input));
  }
  assert.equal(calls.length, 0);
  assert.equal((await handler(event, "wallet-connect", { sessionOnly: true })).state, "connected");
  assert.equal((await handler(event, "provider-public-authorize", { sessionOnly: false })).state, "authorized");
  assert.equal((await handler(event, "provider-public-revoke")).state, "revoked");
  assert.deepEqual(calls, [["credits", { sessionOnly: true }], ["provider", { sessionOnly: false }], ["revoke"]]);
  assert.ok(stopSignal instanceof AbortSignal);
  if (!isTest) for (const action of ["fund-rewards", "reserve", "import", "purchase", "worker-start", "correct-mana"]) assert.equal((await handler(event, action)).enabled, false, "Live does not gain historical custody controls");
  assert.deepEqual(fs.readdirSync(dataDir), [], "status and mocked approvals do not write custody records");
});
