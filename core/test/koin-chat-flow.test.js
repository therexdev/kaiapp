"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const { ChatFlow, request } = require("../../electron/koin-chat-flow"), { hash } = require("../lib/koin-network/job-protocol");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-chat-flow-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { owner: "owner", model: "approved", maxOutput: 128, schedulerUrl: "https://example.test/scheduler" };
  const calls = [], status = { balances: { available: "10000000" }, transactions: [] };
  const client = { hasSavedApproval: () => true, retry: async () => ({ state: "active", remainingJobs: 2, available: "1000" }),
    requestStatus: async () => ({ state: "dispatched" }), consume: async input => {
      calls.push(input); return { id: input.requestId, choices: [{ message: { content: "Verified answer" } }] };
    } };
  const pair = { config: { session: hash("session"), expires: Date.now() + 100000 }, client, run: async () => { throw Error("Unexpected new approval"); } };
  const payments = { status: async () => status, run: async (_w, action) => { calls.push(action); return { id: "deposit", state: "finalized" }; } };
  // A reversible fake cipher lets the test prove plaintext never reaches disk.
  const storage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s).map(b => b ^ 42), decryptString: b => b.map(n => n ^ 42).toString() };
  const options = { file: path.join(dir, "request.json"), config, storage, payments, session: async () => pair, wait: async () => {}, attempts: 2 };
  const body = { model: "koinos-network:approved", messages: [{ role: "user", content: "Private original question" }], stream: true };
  return { flow: new ChatFlow(options), options, config, client, pair, payments, status, calls, body, signal: new AbortController().signal };
}
test("normal chat persists encrypted recovery and restart delivers the same verified answer without another charge", async t => {
  const f = fixture(t), first = await f.flow.chat({}, f.body, f.signal);
  const disk = fs.readFileSync(f.options.file, "utf8");
  assert.ok(!disk.includes("Private original question")); assert.ok(!disk.includes("Verified answer"));
  const restarted = new ChatFlow(f.options), recovered = await restarted.recover({}, f.signal);
  assert.deepEqual(recovered.completion, first); assert.deepEqual(recovered.messages, f.body.messages); assert.equal(f.calls.length, 1);
  restarted.acknowledge(first.id); assert.equal(restarted.read().state, "delivered"); assert.equal(restarted.read().answer, undefined);
});
test("a lost response reuses its durable request ID and blocks a different prompt", async t => {
  const f = fixture(t); let fail = true;
  f.client.consume = async input => { f.calls.push(input.requestId); if (fail) throw Error("Connection lost"); return { id: input.requestId, choices: [] }; };
  await assert.rejects(f.flow.chat({}, f.body, f.signal), /Connection lost/);
  const different = { ...f.body, messages: [{ role: "user", content: "Something else" }] };
  await assert.rejects(new ChatFlow(f.options).chat({}, different, f.signal), /previous request/);
  assert.equal(f.calls.length, 1); fail = false;
  await new ChatFlow(f.options).recover({}, f.signal);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0], f.calls[1]);
});
test("expired pending work is checked before any new reservation, and settled work is never silently repeated", async t => {
  const f = fixture(t); f.client.consume = async () => { throw Error("Lost"); };
  await assert.rejects(f.flow.chat({}, f.body, f.signal), /Lost/); f.pair.config.expires = 1;
  f.client.requestStatus = async () => ({ state: "settled" });
  f.payments.status = async () => { throw Error("Must not reserve"); };
  await assert.rejects(f.flow.recover({}, f.signal), /charged once/); assert.equal(f.flow.read().state, "settled");
});
test("confirmation polls the original payment and never resubmits or creates a replacement", async t => {
  const f = fixture(t); let reads = 0;
  f.payments.run = async (_w, action, id) => { assert.equal(action, "check"); assert.equal(id, "original"); return { state: ++reads > 1 ? "finalized" : "signed" }; };
  await f.flow.confirm({}, { id: "original" }, f.signal); assert.equal(reads, 2);
  f.payments.run = async () => ({ state: "signed", reason: "credit_saved_review_required" });
  await assert.rejects(f.flow.confirm({}, { id: "original" }, f.signal), /saved payment needs review/);
});
test("normal chat explains finality waits and reuses the existing reserved session", async t => {
  const f = fixture(t), progress = []; let reviews = 0;
  f.status.balances.available = "0";
  f.client.hasSavedApproval = () => false;
  f.client.status = async () => ({ state: "unapproved" });
  f.pair.run = async () => ++reviews === 1
    ? { state: "unavailable", retryable: true, error: "Your KOIN is reserved. Waiting for irreversible confirmation…" }
    : { state: "active", remainingJobs: 2, available: "1000" };
  const flow = new ChatFlow({ ...f.options, progress: message => progress.push(message) });
  await flow.chat({}, f.body, f.signal);
  assert.equal(reviews, 2); assert.equal(f.calls.length, 1); assert.equal(typeof f.calls[0], "object");
  assert(progress.some(message => message.includes("irreversible confirmation")));
});
test("a bounded approval wait dispatches nothing and the next send resumes the same reservation", async t => {
  const f = fixture(t); let reviews = 0;
  f.status.balances.available = "0";
  f.client.hasSavedApproval = () => false;
  f.client.status = async () => ({ state: "unapproved" });
  f.pair.run = async () => { reviews++; return { state: "unavailable", retryable: true, error: "Waiting for confirmation" }; };
  await assert.rejects(f.flow.chat({}, f.body, f.signal), /existing reservation is preserved/);
  assert.equal(reviews, 2); assert.equal(f.calls.length, 0); assert.equal(f.flow.read(), null);
  f.pair.run = async () => ({ state: "active", remainingJobs: 2, available: "1000" });
  await f.flow.chat({}, f.body, f.signal); assert.equal(f.calls.length, 1);
});
test("cancelled approval, unavailable secure storage and hostile renderer fields cannot dispatch", async t => {
  const f = fixture(t); f.options.session = async () => null; f.payments.run = async () => ({ state: "cancelled" });
  await assert.rejects(new ChatFlow(f.options).chat({}, f.body, f.signal), /cancelled/); assert.equal(f.calls.length, 0);
  f.options.storage.isEncryptionAvailable = () => false;
  await assert.rejects(new ChatFlow(f.options).chat({}, f.body, f.signal), /secure storage/);
  for (const body of [{ ...f.body, sessionToken: "bad" }, { ...f.body, model: "https://other" }, { ...f.body, max_tokens: 129 }]) assert.throws(() => request(body, f.config));
});
