"use strict";

/*
 * Field bug 2026-08-27: flaky public RPC made the Koinos Node dashboard
 * show 0 mana / $0.00 until the next successful poll. Two layers fixed:
 * chain.balances() no longer swallows a FAILED mana read into "0", and the
 * dashboard serves last-good numbers (marked stale) through short blips.
 * This tests the hold policy — the pure part where the rules live.
 */

const test = require("node:test");
const assert = require("node:assert");
const { holdBalances } = require("../lib/koinos-node");

const GOOD = { koin: "4308560000", vhp: "228813610000", mana: "3822790000" };
const ADDR = "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK";

test("a good read passes through and becomes the held copy", () => {
  const { balances, lastGood } = holdBalances(GOOD, null, ADDR, 1_000);
  assert.strictEqual(balances, GOOD);
  assert.deepStrictEqual(lastGood, { values: GOOD, at: 1_000, address: ADDR });
});

test("a failed read inside the window serves held values, stale, with NO error field", () => {
  const held = { values: GOOD, at: 1_000, address: ADDR };
  const { balances } = holdBalances({ error: "context deadline exceeded" }, held, ADDR, 1_000 + 9 * 60_000);
  assert.strictEqual(balances.koin, GOOD.koin);
  assert.strictEqual(balances.mana, GOOD.mana);
  assert.strictEqual(balances.stale, true);
  // valuation/returns guard on `error` — the held shape must not carry one
  assert.strictEqual("error" in balances, false);
});

test("past the hold window the honest error shows", () => {
  const held = { values: GOOD, at: 1_000, address: ADDR };
  const fresh = { error: "context deadline exceeded" };
  const { balances } = holdBalances(fresh, held, ADDR, 1_000 + 11 * 60_000);
  assert.strictEqual(balances, fresh);
});

test("held values never cross addresses (wallet switch mid-blip)", () => {
  const held = { values: GOOD, at: 1_000, address: ADDR };
  const fresh = { error: "context deadline exceeded" };
  const { balances } = holdBalances(fresh, held, "1DifferentAddressHere", 2_000);
  assert.strictEqual(balances, fresh, "someone else's numbers are worse than an error");
});

test("recovery replaces the held copy", () => {
  const held = { values: GOOD, at: 1_000, address: ADDR };
  const next = { koin: "1", vhp: "2", mana: "3" };
  const { balances, lastGood } = holdBalances(next, held, ADDR, 5_000);
  assert.strictEqual(balances, next);
  assert.strictEqual(lastGood.values, next);
  assert.strictEqual(lastGood.at, 5_000);
});
