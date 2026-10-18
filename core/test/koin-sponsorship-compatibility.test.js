"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { Serializer } = require("koilib");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
test("new sponsor ABI preserves old verified-policy hashes and pending signed funding recovery", async t => {
  const f = fixture(t), current = f.client.serializer, legacy = structuredClone(f.client.abis.credits.types);
  delete legacy.nested.koin.nested.Config.fields.sponsor_daily_limit;
  delete legacy.nested.koin.nested.Config.fields.sponsor_account_daily_limit;
  f.client.serializer = new Serializer(legacy);
  const before = JSON.stringify(await f.client.verify()); await f.runner().start(f.id, f.request);
  const signed = structuredClone(f.state.submissions[0]); f.client.serializer = current;
  assert.equal(JSON.stringify(await f.client.verify()), before);
  const checked = await f.journal.advance(f.id, { allowSubmit: false });
  assert.notEqual(checked.reason, "funding_policy_changed");
  await f.include(signed, { irreversible: true }); assert.equal((await f.journal.advance(f.id, { allowSubmit: false })).state, "funded");
  assert.equal(f.state.signed, 1); assert.equal(f.state.submissions.length, 1);
});
