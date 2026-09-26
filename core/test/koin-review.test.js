"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { koin, validateReview, createShadowReview, exampleTerms, registerKoinReviewIPC } = require("../../electron/koin-review");
const P = require("../lib/koin-network/job-protocol");

function windowFixture() {
  const window = new EventEmitter();
  Object.assign(window, { visible: true, destroyed: false, minimized: false,
    isVisible() { return this.visible; }, isDestroyed() { return this.destroyed; }, isMinimized() { return this.minimized; } });
  window.webContents = new EventEmitter();
  window.webContents.mainFrame = { url: "http://127.0.0.1:1234/" };
  return window;
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; }
function changedQuote(terms, key, value) {
  terms.quote[key] = value;
  const { hash: _old, ...quote } = terms.quote;
  terms.quote.hash = P.hash(JSON.stringify(quote));
}

test("KOIN display retains all eight decimals and uint64 precision", () => {
  assert.equal(koin("1"), "0.00000001 KOIN");
  assert.equal(koin("64000"), "0.00064000 KOIN");
  assert.equal(koin("18446744073709551615"), "184467440737.09551615 KOIN");
  for (const bad of [1, "01", "-1", "1.2", "1e8", "18446744073709551616"]) assert.throws(() => koin(bad));
});

test("review checks committed quote against the intended model, request and session", () => {
  const t = exampleTerms(1000);
  assert.equal(validateReview(t, 1000).quote.maxCharge, "64000");
  for (const mutate of [
    t => { t.quote.maxCharge = "1"; },
    t => { t.quote.tariff.model = "different-model"; },
    t => { t.expected.requestHash = "a".repeat(64); },
    t => { t.expected.domain = "shadow:other"; },
    t => { t.expected.policyHash = "b".repeat(64); },
    t => { t.expected.model = "different-model"; },
    t => { t.expected.tariffVersion++; },
    t => { t.expected.maxOutput++; },
    t => { t.expected.session = "c".repeat(64); },
    t => { t.expected.owner = "other-owner"; },
    t => { t.session.owner = t.expected.owner = "fake-wallet"; },
    t => { t.session.policyHash = "d".repeat(64); },
    t => { t.session.paymentsEnabled = true; },
    t => { t.session.mode = "funded"; },
    t => { t.session.revokedAt = 1000; },
    t => { t.session.remainingJobs = 0; },
    t => { t.session.remainingJobs = 11; },
    t => { t.session.perJob = "63999"; },
    t => { t.session.amount = "2063999"; t.session.available = "63999"; },
    t => { t.session.available = "8000001"; },
    t => { t.session.held = "-1"; },
    t => { t.session.openedAt = 1001; },
    t => { t.session.expires = 1000; },
  ]) {
    const terms = structuredClone(t); mutate(terms);
    assert.throws(() => validateReview(terms, 1000));
  }
  assert.throws(() => validateReview(t, 999));
  assert.throws(() => validateReview(t, 301000));
});

test("native review displays exact limits with cancellation as default and returns no authority", async () => {
  const window = windowFixture(), terms = exampleTerms(1000);
  let calls = 0;
  const review = createShadowReview({ clock: () => 1000, dialog: { async showMessageBox(parent, options) {
    calls++; assert.equal(parent, window);
    assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
    assert.deepEqual(options.buttons, ["Cancel", "Mark example reviewed"]);
    for (const text of ["Example prices only", "Model: example-model", "Maximum request cost: 0.00064000 KOIN",
      "Per-request limit: 0.01000000 KOIN", "Session available: 0.08000000 KOIN", "Session total limit: 0.10000000 KOIN",
      "Requests remaining: 8 / 10", "Maximum output tokens: 256", terms.quote.hash, terms.session.id, "does not sign or submit"]) assert.ok(options.detail.includes(text), text);
    return { response: 1 };
  } } });
  assert.deepEqual(await review.review(window, () => terms, { example: true }), { status: "reviewed", mode: "shadow", paymentsEnabled: false });
  assert.equal(calls, 1);
  assert.equal(window.listenerCount("hide"), 0);
  assert.equal(window.webContents.listenerCount("did-start-navigation"), 0);
});

test("expiry, revoked budgets and changed identities during a native review fail closed", async () => {
  for (const change of [
    (t, clock) => { clock.now = t.quote.expires; },
    t => { t.session.revokedAt = 1000; },
    t => { t.session.available = "7000000"; t.session.held = "2000000"; },
    t => { t.session.remainingJobs--; },
    t => { t.session.amount = "20000000"; t.session.available = "18000000"; },
    t => { t.session.id = t.expected.session = "e".repeat(64); },
    t => { changedQuote(t, "requestHash", "f".repeat(64)); t.expected.requestHash = "f".repeat(64); },
  ]) {
    const terms = exampleTerms(1000), clock = { now: 1000 };
    const review = createShadowReview({ clock: () => clock.now, dialog: { async showMessageBox() { change(terms, clock); return { response: 1 }; } } });
    assert.notEqual((await review.review(windowFixture(), () => terms)).status, "reviewed");
  }
});

test("window lifecycle and Stop invalidate reviews even if the window becomes visible again", async () => {
  for (const event of ["hide", "minimize", "closed", "navigation", "crash", "stop"]) {
    const window = windowFixture(), terms = exampleTerms(1000);
    const review = createShadowReview({ clock: () => 1000, dialog: { async showMessageBox() {
      if (event === "navigation") window.webContents.emit("did-start-navigation", {}, "http://127.0.0.1:1234/", false, true);
      else if (event === "crash") window.webContents.emit("render-process-gone");
      else if (event === "stop") review.cancel();
      else window.emit(event);
      return { response: 1 };
    } } });
    assert.equal((await review.review(window, () => terms)).status, "cancelled", event);
  }
});

test("only one review can be pending, including while terms are being fetched", async () => {
  const window = windowFixture(), terms = exampleTerms(1000), ready = deferred();
  let calls = 0;
  const review = createShadowReview({ clock: () => 1000, dialog: { async showMessageBox() { calls++; return { response: 0 }; } } });
  const first = review.review(window, () => ready.promise);
  assert.equal((await review.review(window, () => terms)).status, "cancelled");
  assert.equal(calls, 0);
  ready.resolve(terms);
  assert.equal((await first).status, "cancelled");
  assert.equal(calls, 1);
  assert.equal((await review.review(window, () => terms)).status, "cancelled");
  assert.equal(calls, 2, "cancellation releases the pending lock");
});

test("hidden windows and broken dialogs never approve, failures release the pending lock", async () => {
  const window = windowFixture(), terms = exampleTerms(1000); let calls = 0;
  const review = createShadowReview({ clock: () => 1000, dialog: { async showMessageBox() { calls++; throw Error("native failure"); } } });
  window.visible = false;
  assert.equal((await review.review(window, () => terms)).status, "cancelled");
  assert.equal(calls, 0);
  window.visible = true;
  for (let i = 0; i < 2; i++) assert.equal((await review.review(window, () => terms)).status, "unavailable");
  assert.equal(calls, 2);
  assert.equal(window.listenerCount("hide"), 0);
});

test("preview IPC permits only the trusted main document and accepts no supplied terms", async () => {
  const handlers = new Map(), window = windowFixture(); let calls = 0;
  registerKoinReviewIPC({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: { async showMessageBox() { calls++; return { response: 1 }; } },
    origin: "http://127.0.0.1:1234", getMainWindow: () => window, clock: () => 1000 });
  assert.deepEqual([...handlers.keys()], ["koin:preview-review"]);
  const handler = handlers.get("koin:preview-review");
  const valid = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  for (const event of [
    { ...valid, sender: new EventEmitter() },
    { ...valid, senderFrame: { url: "http://127.0.0.1:1234/" } },
    { ...valid, senderFrame: null },
  ]) await assert.rejects(handler(event), /access denied/);
  for (const url of ["https://example.com/", "http://127.0.0.1:1234/mascot.html", "http://127.0.0.1:5678/", "file:///index.html"]) {
    window.webContents.mainFrame.url = url;
    await assert.rejects(handler(valid), /access denied/);
  }
  window.webContents.mainFrame.url = "http://127.0.0.1:1234/index.html";
  await assert.rejects(handler(valid, exampleTerms(1000)), /no arguments/);
  assert.equal(calls, 0);
  assert.deepEqual(await handler(valid), { status: "reviewed", mode: "shadow", paymentsEnabled: false });
  assert.equal(calls, 1);
});
