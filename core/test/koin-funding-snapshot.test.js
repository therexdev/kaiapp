"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
const { FundingObserver } = require("../lib/koin-network/funding-observer");
const { utils } = require("koilib");

test("a new block discards mixed funding reads and retries without replacing the deposit", async t => {
  const f = fixture(t), read = f.provider.readContract;
  const draft = await f.journal.begin(f.id, f.request);
  await f.journal.stage(f.id, await f.sign(draft));
  const original = f.journal.nonceCoordinator.envelope(f.id);
  let changed = false;
  f.provider.readContract = async op => {
    const result = await read(op);
    if (!changed && op.contract_id === f.d.token && op.entry_point === utils.tokenAbi.methods.allowance.entry_point) {
      changed = true; f.state.height++; f.state.lib = f.state.height;
      f.state.liquid = "100"; // The discarded capture saw the previous balance.
    }
    return result;
  };
  assert.equal((await f.runner().tick(f.id)).action, "await_finality");
  assert.equal(changed, true); assert.equal(f.state.signed, 1);
  assert.deepEqual(f.state.submissions, [original]);
});

test("continuous block changes are bounded read-only waits and retain the original envelope", async t => {
  const f = fixture(t), draft = await f.journal.begin(f.id, f.request);
  await f.journal.stage(f.id, await f.sign(draft));
  const original = f.journal.nonceCoordinator.envelope(f.id), getHead = f.provider.getHeadInfo;
  let heads = 0;
  f.provider.getHeadInfo = async () => { heads++; f.state.height++; f.state.lib = f.state.height; return getHead(); };
  assert.equal((await f.runner().tick(f.id)).reason, "funding_moving");
  assert.equal(heads, 6); assert.equal(f.journal.status(f.id).attempts, 0);
  assert.equal(f.state.submissions.length, 0); assert.equal(f.state.signed, 1);
  f.provider.getHeadInfo = getHead;
  assert.equal((await f.journal.advance(f.id, { allowSubmit: false })).reason, "funding_resume_review_required");
  assert.equal(f.state.submissions.length, 0);
  assert.equal((await f.runner().tick(f.id)).action, "await_finality");
  assert.deepEqual(f.state.submissions, [original]); assert.equal(f.state.signed, 1);
});

test("elapsed RPC time is not backwards time and evidence is stamped after verification", async t => {
  const f = fixture(t), read = f.provider.readContract;
  f.provider.readContract = async op => { const result = await read(op); f.state.now += 1001; return result; };
  const observer = new FundingObserver(f.client, { clock: () => f.state.now });
  const before = f.state.now, evidence = await observer.inspect(f.request);
  assert.equal(evidence.state, "verified");
  assert.ok(evidence.checkedAt > before + 5000);
  assert.equal(evidence.checkedAt, f.state.now);
  assert.equal((await f.runner().start(f.id, f.request)).action, "await_finality");
  assert.equal(f.state.signed, 1); assert.equal(f.state.submissions.length, 1);
  await f.include(f.state.submissions[0], { irreversible: true });
  const blocks = f.provider.getBlocks;
  f.provider.getBlocks = async (...args) => { const result = await blocks(...args); f.state.now += 6001; return result; };
  assert.equal((await f.journal.nonceCoordinator.reconcile(f.id)).state, "finalized");
  assert.equal((await f.journal.advance(f.id, { allowSubmit: false })).state, "funded");
  assert.equal(f.state.signed, 1); assert.equal(f.state.submissions.length, 1);
});

test("a real backwards clock or changed contract still blocks funding during a retry", async t => {
  for (const reason of ["clock", "contract"]) {
    const f = fixture(t), read = f.provider.readContract;
    const draft = await f.journal.begin(f.id, f.request); await f.journal.stage(f.id, await f.sign(draft));
    let changed = false;
    f.provider.readContract = async op => {
      const result = await read(op);
      if (!changed) {
        changed = true;
        if (reason === "clock") f.state.now--;
        else { f.state.height++; f.provider.invokeGetContractMetadata = async () => ({ value: { hash: "wrong" } }); }
      }
      return result;
    };
    await assert.rejects(f.runner().tick(f.id), reason === "clock" ? /clock moved backwards/ : /bytecode changed/);
    assert.equal(f.state.submissions.length, 0); assert.equal(f.state.signed, 1);
  }
});
