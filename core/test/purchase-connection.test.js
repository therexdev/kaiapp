"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events"), { Signer } = require("koilib");
const { CreditService } = require("../../electron/credit-service"), { registerTestPaymentIPC } = require("../../electron/koin-test-ipc");
const other = Signer.fromSeed("purchase-connection-other").getAddress();
function fixture() {
  const state = { address: Signer.fromSeed("purchase-connection-wallet").getAddress(), unlocked: true, protected: true,
    privacy: "local-first", token: "saved", sessionOnly: false, visible: true, minimized: false, destroyed: false,
    authorizationError: null, owner: null, reviews: [], connections: 0, reads: 0, response: 1 };
  const wallet = { get address() { return state.address; }, status: () => ({ address: state.address, unlocked: state.unlocked }) };
  const storage = { isEncryptionAvailable: () => state.protected, getSelectedStorageBackend: () => state.protected ? "gnome_libsecret" : "basic_text" };
  const account = { wallet, settings: { get: () => state.privacy }, _token: () => state.token,
    creditAuthorization: async () => {
      state.reads++; await state.readWait;
      if (state.authorizationError) throw state.authorizationError;
      if (!state.token) throw Object.assign(Error("Connect wallet"), { code: "signin-required" });
      return { owner: state.owner || state.address, localWallet: state.address, sessionOnly: state.sessionOnly };
    },
    connectWallet: async (_config, options, signal) => {
      state.connections++; assert.equal(options.sessionOnly, false, "Buy never requests temporary paid access");
      const accepted = await options.review({ address: state.address, serviceOrigin: "https://credits.invalid", deviceId: "fixture", sessionOnly: false });
      signal?.throwIfAborted();
      if (!accepted) return { state: "cancelled" };
      state.token = "new-saved"; state.sessionOnly = false; state.authorizationError = null;
      return { state: "connected", address: state.address, sessionOnly: false };
    } };
  const window = { isVisible: () => state.visible, isMinimized: () => state.minimized, isDestroyed: () => state.destroyed };
  const service = new CreditService({ service: require("../lib/koin-network/credit-service.json"), dataDir: "/unused", account, storage,
    dialog: { showMessageBox: async (_window, detail) => { assert.equal(_window, window); state.reviews.push(detail); await state.reviewWait; return { response: state.response }; } } });
  service.context = async (_signal, auth) => { assert.equal(auth.owner, state.address); return { auth }; };
  service.purchases.status = async () => { state.statusReads = (state.statusReads || 0) + 1; await state.statusWait; return state.localPurchase || null; };
  service.purchases.cancelled = async () => [];
  for (const method of ["preview", "run", "sync"]) service.purchases[method] = () => { throw Error("Connection must not create a quote or payment"); };
  return { state, service, window, account };
}
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("Buy reuses the existing matching saved wallet connection without another account or connection prompt", async () => {
  const f = fixture();
  const result = await f.service.preparePurchase(f.window);
  assert.equal(result.state, "ready"); assert.equal(result.address, f.state.address);
  assert.equal(result.purchaseInfo.activation, "ready"); assert.equal(result.purchaseInfo.localPurchase, null);
  assert.equal(f.state.reads, 1); assert.equal(f.state.connections, 0); assert.deepEqual(f.state.reviews, []);
});

test("Buy connects a missing or expired wallet session with one native proof review and no payment", async () => {
  for (const mode of ["missing", "expired", "temporary"]) {
    const f = fixture();
    if (mode === "missing") f.state.token = null;
    if (mode === "expired") f.state.authorizationError = Object.assign(Error("Reconnect wallet"), { code: "wallet-reauthorization-required" });
    if (mode === "temporary") f.state.sessionOnly = true;
    const result = await f.service.preparePurchase(f.window);
    assert.equal(result.state, "connected"); assert.equal(result.address, f.state.address); assert.equal(result.purchaseInfo.activation, "ready");
    assert.equal(f.state.connections, 1); assert.equal(f.state.reviews.length, 1); assert.equal(f.state.reads, 2);
    assert.equal(f.state.reviews[0].title, "Connect wallet to network credits");
    assert.match(f.state.reviews[0].detail, /does not transfer KOIN/); assert.equal(f.state.sessionOnly, false);
  }
});

test("cancelled Buy connection returns without replacing authority or continuing to payment", async () => {
  const f = fixture(); f.state.token = null; f.state.response = 0;
  assert.deepEqual(await f.service.preparePurchase(f.window), { state: "cancelled", address: f.state.address });
  assert.equal(f.state.token, null); assert.equal(f.state.reads, 1); assert.equal(f.state.connections, 1);
});

test("Buy returns saved payment recovery with the same verified authority and fences changes during that read", async () => {
  const f = fixture(); f.state.localPurchase = { state: "pending", txId: "fixture", recovery: "resume-payment" };
  const result = await f.service.preparePurchase(f.window);
  assert.deepEqual(result.purchaseInfo.localPurchase, f.state.localPurchase); assert.equal(f.state.reads, 1);
  const waiting = defer(); f.state.statusWait = waiting.promise;
  const next = f.service.preparePurchase(f.window);
  while (f.state.statusReads < 2) await new Promise(resolve => setImmediate(resolve));
  f.state.token = "different"; waiting.resolve(); await assert.rejects(next, /changed/);
});

test("wallet access exposes saving a temporary connection once its keyring is available", async () => {
  const f = fixture(); f.state.sessionOnly = true; f.state.protected = false;
  let info = await f.service.walletInfo();
  assert.equal(info.connected, true); assert.equal(info.canConnect, false); assert.equal(info.state, "ready");
  f.state.protected = true; f.state.unlocked = false; info = await f.service.walletInfo();
  assert.equal(info.connected, true); assert.equal(info.state, "wallet-unlock-required"); assert.equal(info.canConnect, false);
  f.state.unlocked = true; info = await f.service.walletInfo();
  assert.equal(info.state, "ready"); assert.equal(info.canConnect, true); assert.equal(info.sessionOnly, true);
  assert.match(info.detail, /Save this wallet connection/); assert.equal(f.state.connections, 0);
});

test("Buy reports local wallet and keyring prerequisites directly without signing, creating an account or changing privacy", async () => {
  for (const [key, value, expected] of [["address", null, "wallet-required"], ["unlocked", false, "wallet-unlock-required"],
    ["protected", false, "secure-storage-required"], ["privacy", "local-only", "online-required"]]) {
    const f = fixture(); f.state[key] = value;
    const result = await f.service.preparePurchase(f.window);
    assert.equal(result.state, expected); assert.equal(result.address, f.state.address); assert.ok(result.detail.length < 300);
    assert.equal(f.state.reads, 0); assert.equal(f.state.connections, 0); assert.equal(f.state[key], value); assert.equal(f.state.token, "saved");
  }
  const temporary = fixture(); temporary.state.sessionOnly = true; temporary.state.protected = false;
  assert.equal((await temporary.service.preparePurchase(temporary.window)).state, "secure-storage-required");
  assert.equal(temporary.state.connections, 0); assert.equal(temporary.state.sessionOnly, true);
});

test("Buy preserves prior identity on unavailable service, conflicting wallet, and unknown authorization failures", async () => {
  for (const code of ["service-unavailable", "identity-unverified", "identity-changed", "wallet-changed", "secure-storage-required", undefined]) {
    const f = fixture(), error = Object.assign(Error("Fixture authorization failure"), { code }); f.state.authorizationError = error;
    await assert.rejects(f.service.preparePurchase(f.window), value => value === error);
    assert.equal(f.state.token, "saved"); assert.equal(f.state.connections, 0);
  }
  const f = fixture(); f.state.owner = other;
  await assert.rejects(f.service.preparePurchase(f.window), { code: "wallet-changed" });
  assert.equal(f.state.connections, 0); assert.equal(f.state.token, "saved");
});

test("wallet, saved identity, privacy, storage, visibility and Stop changes fence asynchronous Buy preparation", async () => {
  for (const change of [f => { f.state.address = other; }, f => { f.state.token = "changed"; }, f => { f.state.unlocked = false; },
    f => { f.state.protected = false; }, f => { f.state.privacy = "local-only"; }, f => { f.state.visible = false; },
    f => { f.state.minimized = true; }, f => { f.state.destroyed = true; }, (_f, controller) => controller.abort()]) {
    const f = fixture(), waiting = defer(), controller = new AbortController(); f.state.readWait = waiting.promise;
    const preparation = f.service.preparePurchase(f.window, controller.signal);
    change(f, controller); waiting.resolve(); await assert.rejects(preparation);
    assert.equal(f.state.connections, 0);
  }
  for (const kind of ["hidden", "stopped"]) {
    const f = fixture(), waiting = defer(), controller = new AbortController(); f.state.token = null; f.state.reviewWait = waiting.promise;
    const preparation = f.service.preparePurchase(f.window, controller.signal);
    while (!f.state.reviews.length) await new Promise(resolve => setImmediate(resolve));
    if (kind === "hidden") f.state.visible = false; else controller.abort();
    waiting.resolve(); await assert.rejects(preparation); assert.equal(f.state.token, null);
  }
});

for (const isTest of [false, true]) test(`${isTest ? "Test" : "Live"} Buy connection is visible, trusted, single-flight and stopped with payment controls`, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-purchase-connect-"));
  let handler, visible = true, calls = 0, activeSignal, release;
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, isVisible: () => visible, isMinimized: () => false, webContents: new EventEmitter() });
  window.webContents.mainFrame = { url: "http://127.0.0.1:9000/" };
  t.mock.method(global, "setInterval", () => ({ unref() {} }));
  t.mock.method(CreditService.prototype, "preparePurchase", async (_window, signal) => {
    assert.equal(_window, window); calls++; activeSignal = signal;
    return new Promise((resolve, reject) => {
      release = () => resolve({ state: "ready", address: other });
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const core = { gateway: { network: { trackShadowRequest: () => () => {} } } };
  const registration = registerTestPaymentIPC({ dataDir, core, isTest, dialog: {}, origin: "http://127.0.0.1:9000", getMainWindow: () => window, ipcMain: { handle: (_name, fn) => { handler = fn; } } });
  t.after(() => { registration.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  for (const input of [null, {}, { sessionOnly: false }, "wallet"]) await assert.rejects(handler(event, "purchase-connect", input), /no arguments/);
  await assert.rejects(handler({ ...event, senderFrame: { url: event.senderFrame.url } }, "purchase-connect"), /access denied/);
  visible = false; await assert.rejects(handler(event, "purchase-connect"), /visible app/); visible = true; assert.equal(calls, 0);
  for (const stop of ["purchase-stop", "hide"]) {
    const first = handler(event, "purchase-connect");
    await assert.rejects(handler(event, "purchase-connect"), /Finish or cancel/);
    await assert.rejects(handler(event, "wallet-connect"), /Finish or cancel/);
    await assert.rejects(handler(event, "purchase-approve", "quote"), /Finish or cancel/);
    if (stop === "hide") window.emit("hide"); else assert.equal((await handler(event, stop)).state, "stopped");
    await assert.rejects(first, /Payment review stopped/); assert.equal(activeSignal.aborted, true);
  }
  const success = handler(event, "purchase-connect"); release();
  assert.deepEqual(await success, { state: "ready", address: other }); assert.equal(calls, 3);
});
