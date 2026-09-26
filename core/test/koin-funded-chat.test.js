"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), { Signer, utils } = require("koilib");
const P = require("../lib/koin-network/job-protocol"), D = require("../lib/koin-network/session-delegation"), F = require("../lib/koin-network/funded-protocol");
const { verify, consume } = require("../lib/koin-network/funded-chat"), { Worker } = require("../lib/worker");
const provider = Signer.fromSeed("funded-chat-worker"), owner = Signer.fromSeed("funded-chat-owner").getAddress();
async function fixture() {
  const tariff = Object.fromEntries(Object.entries({ model: "fixture", version: 1, inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "2000000",
    modelHash: P.hash("model"), tokenizerHash: P.hash("tokenizer"), templateHash: P.hash("template"), maxOutputTokens: 64, contextTokens: 4096, maxLatencyMs: 5000 }).sort(([a], [b]) => a.localeCompare(b)));
  const target = { chainId: utils.encodeBase64url(Buffer.from("1220" + P.hash("chain"), "hex")), credits: owner,
    creditsHash: "0x1220" + P.hash("wasm"), domain: "shadow:funded-chat", policyHash: P.hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", tariff])) };
  const terms = D.terms({ schema: 1, mode: "funded-rehearsal", target, owner, session: P.hash("session"), accountId: "acc_fixture", grantId: "grant_fixture",
    model: "fixture", version: 1, maxOutput: 16, amount: "500", perJob: "100", maxJobs: 3, issuedAt: 1000, expires: 50000, nonce: P.hash("nonce") });
  const messages = [{ role: "user", content: "2+2?" }], prompt = JSON.stringify(messages), requestId = P.hash("job");
  let quote = { schema: 2, mode: "shadow", domain: target.domain, policyHash: target.policyHash, tariff, requestHash: P.hash(JSON.stringify(messages)),
    promptHash: P.hash(prompt), inputIdsHash: P.hash("ids"), inputTokens: 10, maxOutput: 16, maxCharge: "42", at: 1100, expires: 301100 };
  quote = { ...quote, hash: P.hash(JSON.stringify(quote)) };
  const job = { id: requestId, type: "koin-funded-rehearsal-chat", paymentsEnabled: false, target, session: terms.session,
    model: "fixture", prompt, quote, attempt: P.hash("attempt"), dispatchedAt: 1200, deadline: 6200 };
  const receipt = { mode: "funded-rehearsal", id: requestId, session: terms.session, provider: provider.getAddress(), attempt: job.attempt,
    quoteHash: quote.hash, outputHash: P.hash("4"), signature: Buffer.from(await provider.signHash(F.fundedResultHash(target, job, "4"))).toString("base64"),
    usage: { inputTokens: 10, outputTokens: 1, amount: "12" }, dispatchedAt: 1200, completedAt: 1300 };
  const result = { id: requestId, model: "koinos-network", servedModel: "fixture", costUsd: 0, choices: [{ message: { content: "4" } }],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }, koin: { mode: "funded-rehearsal", paymentsEnabled: false, state: "verified", target,
      delegationId: D.id(terms), quote, tariffs: [tariff], receipt, receiptHash: P.hash(JSON.stringify(receipt)), settlement: { state: "waiting" } } };
  return { job, result, options: { terms, messages, model: "auto", maxOutput: 16, requestId },
    authorization: { owner, sessionToken: "private-fixture-token", accountId: terms.accountId, grantId: terms.grantId } };
}

test("funded response proves the approved deployment, model tariff, worker, usage and prepared charge", async () => {
  const f = await fixture(), answer = verify(f.result, f.options);
  assert.equal(answer.choices[0].message.content, "4"); assert.match(answer.warning, /no KOIN was spent/);
  const r = f.result.koin.receipt, intent = { id: r.id, session_id: r.session, provider: r.provider, policy_hash: f.job.target.policyHash,
    receipt_hash: f.result.koin.receiptHash, amount: "12", dispatched_at: "1200", nonce: "1" };
  f.result.koin.state = "prepared"; f.result.koin.settlement = { state: "prepared", intent, hash: P.hash(JSON.stringify(intent)) };
  assert.equal(verify(f.result, f.options).koin.settlement.intent.amount, "12");
  for (const alter of [
    x => { x.koin.paymentsEnabled = true; }, x => { x.koin.target.creditsHash = "0x1220" + P.hash("wrong"); },
    x => { x.koin.tariffs[0].inputAtomsPerMillion = "1"; }, x => { x.koin.delegationId = P.hash("other"); },
    x => { x.choices[0].message.content = "forged"; }, x => { x.koin.receipt.provider = owner; },
    x => { x.koin.receipt.usage.amount = "1"; }, x => { x.koin.receipt.session = P.hash("other"); },
    x => { x.koin.receipt.secret = "unexpected"; }, x => { x.koin.settlement.intent.amount = "99"; },
  ]) { const bad = structuredClone(f.result); alter(bad); assert.throws(() => verify(bad, f.options)); }
  const legacy = structuredClone(f.result);
  legacy.koin.receipt.signature = Buffer.from(await provider.signHash(P.resultHash(f.job.quote.domain, f.job.id, f.job.attempt, f.job.quote.hash, "4"))).toString("base64");
  legacy.koin.receiptHash = P.hash(JSON.stringify(legacy.koin.receipt));
  assert.throws(() => verify(legacy, f.options), /Signature mismatch/);
});

test("funded transport sends the account grant and session ID without a certificate or per-request signature", async () => {
  const f = await fixture(); let calls = 0;
  const request = { ...f.options, authorization: f.authorization, schedulerUrl: "http://127.0.0.1:1234/scheduler", observationId: P.hash("observation"),
    fetchImpl: async (url, options) => {
      calls++; assert.equal(url, "http://127.0.0.1:1234/scheduler/consume/chat/completions"); assert.equal(options.redirect, "error");
      const body = JSON.parse(options.body); assert.equal(body.billing, "koin-funded-rehearsal");
      for (const k of ["signature", "terms", "owner", "accountId"]) assert.equal(body[k], undefined);
      return Response.json({ ...f.result, secret: "not-public" });
    } };
  assert.ok(!JSON.stringify(await consume(request)).includes("not-public")); assert.equal(calls, 1);
  await assert.rejects(consume({ ...request, model: "other" })); assert.equal(calls, 1);
  await assert.rejects(consume({ ...request, authorization: { ...f.authorization, accountId: "other" } })); assert.equal(calls, 1);
  await assert.rejects(consume({ ...request, fetchImpl: async () => Response.json({ error: { message: f.authorization.sessionToken } }, { status: 400 }) }), /redacted/);
});

test("workers require a separate funded opt-in and an approved public model with exact prompt commitment", async () => {
  const f = await fixture(), catalog = { aliases: { fixture: { package: "fixture" } }, packages: { fixture: { sha256: P.hash("model") } } };
  assert.equal(F.validateJob(f.job, catalog, 1500).id, f.job.id);
  for (const change of [{ paymentsEnabled: true }, { type: "chat" }, { prompt: "changed" }, { accountId: "private" }]) assert.throws(() => F.validateJob({ ...f.job, ...change }, catalog, 1500));
  catalog.aliases.fixture.custom = true; assert.throws(() => F.validateJob(f.job, catalog, 1500));
  const worker = new Worker({ schedulerUrl: "http://127.0.0.1:9", koinShadowJobs: true, koinFundedRehearsalJobs: false });
  await assert.rejects(worker._execute(f.job), /opt-in/);
});
