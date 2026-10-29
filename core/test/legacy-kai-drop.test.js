"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { atoms, summary } = require("../../ui/legacy-kai-drop");
const snapshot = kai => ({ wallet: { address: "wallet-a", unlocked: false }, earnings: { address: "wallet-a", kai } });
test("drop estimate uses wallet KAI only and exact 1 KOIN per 5 KAI conversion while locked", () => {
  const s = snapshot("12345.67890123"); s.earnings.pendingKai = "9999";
  assert.deepEqual(summary(s), { wallet: "wallet-a", kai: "12,345.67890123", koin: "2,469.13578024" });
  assert.equal(summary(snapshot("0")).koin, "0");
  assert.equal(summary(snapshot("0.00000005")).koin, "0.00000001");
  assert.equal(atoms("5e-8"), 5n);
  assert.equal(atoms("184467440737.09551615"), 18446744073709551615n);
});
test("unknown, wrong-wallet and malformed balances never become a zero drop", () => {
  for (const value of [undefined, null, 1, "-1", "NaN", "Infinity", "0.000000001", "184467440738", "<img src=x>"]) assert.equal(summary(snapshot(value)), null);
  const wrong = snapshot("123"); wrong.earnings.address = "wallet-b"; assert.equal(summary(wrong), null);
  const failed = snapshot("123"); failed.earnings.error = "Unavailable"; assert.equal(summary(failed), null);
  assert.equal(summary({ wallet: { address: "wallet-a" } }), null);
});
