"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { validate, totals } = require("../../ui/reward-summary");
const DAY = 86400000, now = 2.5 * DAY;
const fixture = () => ({ schema: 1, account: "alice", current: { epoch: "2", closesAt: 3 * DAY, availability: "123456789", asOf: now - 60000 },
  pending: [{ epoch: "1", availability: "30000000", work: "10000000", state: "reviewing", reviewUntil: 3 * DAY + 1234 }] });
test("summary keeps exact atoms and excludes paid rewards from pending totals", () => {
  const summary = validate(fixture(), "alice", now);
  assert.deepEqual(summary, fixture());
  const result = totals(summary, [{ epoch: "0", state: "queued", availability: "1", work: "2" }, { state: "paid", availability: "999", work: "999" }, { state: "paid_elsewhere", availability: "999", work: "999" }]);
  assert.equal(result.availability, "30000001"); assert.equal(result.work, "10000002"); assert.equal(result.sending, 1); assert.equal(result.reviewUntil, 3 * DAY + 1234);
});
test("invalid, cross-wallet, wrong-day, duplicate and overflowing observations are rejected", () => {
  const changes = [v => v.account = "bob", v => v.current.epoch = "1", v => v.current.closesAt++, v => v.current.availability = "-1",
    v => v.current.availability = "18446744073709551616", v => v.current.asOf = now + 1,
    v => v.pending.push(v.pending[0]), v => v.pending[0].reviewUntil = 2 * DAY, v => v.pending[0].state = "paid",
    v => { v.pending[0].availability = "18446744073709551615"; v.pending[0].work = "1"; }];
  for (const change of changes) { const v = fixture(); change(v); assert.throws(() => validate(v, "alice", now)); }
  assert.throws(() => validate(fixture(), "alice", now, [{ epoch: "1" }]));
});
test("unknown estimates remain null; extra server metadata never enters the UI", () => {
  const v = fixture(); v.current.availability = v.current.asOf = null; v.private = "secret"; v.pending[0].signature = "secret";
  const clean = validate(v, "alice", now); assert.equal(clean.current.availability, null); assert.doesNotMatch(JSON.stringify(clean), /secret/);
});
