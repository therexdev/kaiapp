"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createCreditState } = require("../../ui/credit-account");
const value = version => ({ product: "prepaid-usd-v1", owner: "fixture-account", credits: { version, unit: "USD-1e-8", available: "120", purchased: { available: "100" }, free: { state: "available", available: "20" } } });
test("all subscribers receive the same versioned balance; older reads cannot overwrite newer state", () => {
  const store = createCreditState({ read: async () => value("1") }), a = [], b = [];
  store.subscribe(v => a.push(v)); store.subscribe(v => b.push(v)); store.accept(value("2")); store.accept(value("1"));
  assert.deepEqual(a, b); assert.equal(store.get().snapshot.credits.version, "2");
  a.at(-1).snapshot.credits.available = "0"; assert.equal(store.get().snapshot.credits.available, "120");
});
test("a lost balance request preserves the last known balance and marks it unavailable instead of zero", async () => {
  let calls = 0; const store = createCreditState({ read: async () => { calls++; throw Error("offline"); } });
  store.accept(value("4")); await Promise.all([store.refresh(), store.refresh()]);
  assert.equal(calls, 1); assert.equal(store.get().status, "unavailable"); assert.equal(store.get().snapshot.credits.available, "120");
});
test("invalid combined balance cannot replace the account's trusted state", () => {
  const store = createCreditState({ read: async () => value("1") }); store.accept(value("1"));
  const bad = value("2"); bad.credits.available = "999";
  assert.throws(() => store.accept(bad), /verified/); assert.equal(store.get().snapshot.credits.version, "1");
});

test("sign-out clears the prior balance and rejects a late response from that session", async () => {
  let resolve; const store = createCreditState({ read: () => new Promise(done => { resolve = done; }) });
  store.accept(value("1")); const refresh = store.refresh(); await Promise.resolve();
  store.clear(); resolve(value("2")); await refresh;
  assert.equal(store.get().snapshot, null); assert.equal(store.get().status, "unavailable");
});
