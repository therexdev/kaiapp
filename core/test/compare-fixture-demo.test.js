"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { createCompareFixtureDemo, registerCompareFixtureIPC, MODELS } = require("../../electron/compare-fixture-demo");
const { demoAllowed, createDemoServer } = require("../../electron/compare-fixture-main");
function fixture(t, options = {}) {
  const window = new EventEmitter(), contents = new EventEmitter();
  contents.mainFrame = { url: "http://127.0.0.1:1234/" }; window.webContents = contents;
  window.isDestroyed = () => false; window.isVisible = () => true;
  const calls = [], dialog = { showMessageBox: async (_window, detail) => { calls.push(detail); return { response: 1 }; } };
  const service = createCompareFixtureDemo({ dialog, getWindow: () => window, grantMs: 5000, fixtureDelayMs: 5, ...options });
  t.after(() => service.dispose());
  return { service, window, contents, dialog, calls };
}
const approveBoth = async service => { for (const model of service.status().selected) await service.approve({ model }); };
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
test("development gate rejects packaged/default launches; static server exposes only fixture assets", async t => {
  assert.equal(demoAllowed({ isPackaged: false }, {}), false);
  assert.equal(demoAllowed({ isPackaged: true }, { KAI_COMPARE_FIXTURE_DEMO: "1" }), false);
  assert.equal(demoAllowed({ isPackaged: false }, { KAI_COMPARE_FIXTURE_DEMO: "1" }), true);
  const server = createDemoServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(origin); assert.match(await page.text(), /No real model runs/);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'none'/);
  for (const route of ["/core/earn", "/core/chat/completions", "/wallet.json", "/compare-fixture-preload.js", "/index.html?untrusted=1"]) assert.equal((await fetch(origin + route)).status, 404);
});
test("installation grants nothing; exact per-model native consent enables labelled fixture responses only", async t => {
  const f = fixture(t), s = f.service;
  await assert.rejects(s.run({ prompt: "hi" }), /Install/); s.install(); s.install();
  await assert.rejects(s.run({ prompt: "hi" }), /Access denied/);
  await s.approve({ model: MODELS[0].id });
  await assert.rejects(s.run({ prompt: "hi" }), /Access denied/); assert.equal(s.status().dispatched, 0);
  await assert.rejects(s.approve({ model: MODELS[0].id }), /already approved/);
  await s.approve({ model: MODELS[1].id });
  assert(f.calls.every(d => d.defaultId === 0 && d.cancelId === 0 && /No wallet/.test(d.detail) && /Calls: 1/.test(d.detail) && /Expires:/.test(d.detail)));
  const status = await s.run({ prompt: "hello" });
  assert.equal(status.dispatched, 2); assert.equal(status.results.length, 2);
  assert(status.results.every(r => r.text.includes("FIXTURE ONLY") && r.text.includes("No model was executed")));
  await assert.rejects(s.run({ prompt: "again" }), /Access denied/);
});
test("deny, canceled and expired native reviews never grant access", async t => {
  for (const mode of ["deny", "stop", "expired", "selection", "disable", "uninstall", "navigation"]) {
    let answer;
    const f = fixture(t, { grantMs: mode === "expired" ? 20 : 5000,
      dialog: { showMessageBox: () => new Promise(resolve => { answer = resolve; }) } });
    const s = f.service; s.install(); const pending = s.approve({ model: MODELS[0].id });
    await assert.rejects(s.approve({ model: MODELS[1].id }), /current action/);
    if (mode === "stop") s.stop();
    if (mode === "expired") await tick(35);
    if (mode === "selection") s.select({ models: [MODELS[2].id, MODELS[1].id] });
    if (mode === "disable") s.disable();
    if (mode === "uninstall") s.uninstall();
    if (mode === "navigation") s.invalidate();
    answer({ response: mode === "deny" ? 0 : 1 }); const result = await pending;
    assert.equal(result.reviewing, null); assert(result.models.every(m => m.permission === "not approved")); assert.equal(result.dispatched, 0);
  }
});
test("repeated runs reserve once and stop/revoke/disable/uninstall/selection/navigation reject late results", async t => {
  for (const mode of ["stop", "revoke", "disable", "uninstall", "selection", "navigation"]) {
    const f = fixture(t, { fixtureDelayMs: 60 }), s = f.service; s.install(); await approveBoth(s);
    const pending = s.run({ prompt: "hello" });
    await assert.rejects(s.run({ prompt: "second" }), /current action/);
    if (mode === "stop") s.stop();
    if (mode === "revoke") s.revoke({ model: MODELS[0].id });
    if (mode === "disable") s.disable();
    if (mode === "uninstall") s.uninstall();
    if (mode === "selection") s.select({ models: [MODELS[2].id, MODELS[1].id] });
    if (mode === "navigation") s.invalidate();
    const state = await pending; assert.equal(state.results.length, 0); assert.equal(state.running, false); assert(state.dispatched <= 1);
    assert(state.models.every(m => m.permission === "not approved"));
  }
});
test("per-model revoke preserves other idle grant; expiry and reinstall require fresh approval", async t => {
  const f = fixture(t), s = f.service; s.install(); await approveBoth(s); s.revoke({ model: MODELS[0].id });
  assert.equal(s.status().models[1].permission, "approved"); await assert.rejects(s.run({ prompt: "hi" }), /Access denied/);
  s.uninstall(); s.install(); assert(s.status().models.every(m => m.permission === "not approved"));
  const short = fixture(t, { grantMs: 30, fixtureDelayMs: 80 }).service; short.install(); await approveBoth(short);
  const state = await short.run({ prompt: "hello" }); assert.equal(state.results.length, 0); assert.match(state.notice, /expired/);
});
test("fixture callback has no external networking and accepts no resource or approval injection", async t => {
  const http = require("node:http"), https = require("node:https");
  const originals = [global.fetch, http.request, https.request]; let network = 0;
  const blocked = () => { network++; throw Error("Network forbidden"); };
  global.fetch = http.request = https.request = blocked;
  try {
    const s = fixture(t).service; s.install();
    await assert.rejects(s.approve({ model: "network:paid" }));
    await assert.rejects(s.approve({ model: MODELS[0].id, approved: true }));
    assert.throws(() => s.select({ models: [MODELS[0].id, MODELS[0].id] }));
    await approveBoth(s); await assert.rejects(s.run({ prompt: "hi", resource: "wallet:core" }));
    assert.equal((await s.run({ prompt: "hi" })).results.length, 2); assert.equal(network, 0);
  } finally { [global.fetch, http.request, https.request] = originals; }
});
test("private IPC rejects untrusted frames/documents/actions and navigation cancels pending consent", async t => {
  const f = fixture(t), handlers = new Map(), ipcMain = { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) };
  let answer;
  const registered = registerCompareFixtureIPC({ ipcMain, getWindow: () => f.window, origin: "http://127.0.0.1:1234",
    dialog: { showMessageBox: () => new Promise(resolve => { answer = resolve; }) } });
  t.after(() => registered.dispose());
  const call = handlers.get("compare-fixture:invoke"), event = { sender: f.contents, senderFrame: f.contents.mainFrame };
  for (const bad of [{ ...event, sender: {} }, { ...event, senderFrame: { url: "http://127.0.0.1:1234/" } }]) await assert.rejects(call(bad, "status"));
  f.contents.mainFrame.url = "http://127.0.0.1:1234/other"; await assert.rejects(call(event, "status")); f.contents.mainFrame.url = "http://127.0.0.1:1234/";
  await assert.rejects(call(event, "dispose")); assert.equal((await call(event, "install", { wallet: true })).ok, false);
  await call(event, "install"); const pending = call(event, "approve", { model: MODELS[0].id });
  const rejected = assert.rejects(pending, /window changed/);
  f.contents.emit("did-start-navigation", {}, "http://127.0.0.1:1234/", false, true); answer({ response: 1 }); await rejected;
  assert(registered.service.status().models.every(m => m.permission === "not approved"));
  assert.equal((await call(event, "status")).ok, true);
  for (const [emitter, name] of [[f.window, "hide"], [f.contents, "render-process-gone"], [f.contents, "destroyed"]]) {
    const review = call(event, "approve", { model: MODELS[0].id });
    const canceled = assert.rejects(review, /window changed/);
    emitter.emit(name); answer({ response: 1 }); await canceled;
    assert(registered.service.status().models.every(m => m.permission === "not approved"));
  }
  registered.dispose(); assert.equal(handlers.size, 0);
});
