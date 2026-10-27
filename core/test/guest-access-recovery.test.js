"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { CreditService } = require("../../electron/credit-service");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
const P = require("../lib/koin-network/job-protocol");

function setup(t, replies = [401, 200]) {
  const f = fixture(t, { mainnet: true, usd: true });
  const config = { schema: 1, mode: "mainnet-pilot", deployment: f.d, schedulerUrl: "https://credit.invalid/scheduler", policyHash: P.hash("tariff"), version: 1,
    model: "fixture", maxOutput: 32, maxRcPerTransaction: "1", maxRcPerDay: "2", limits: { amount: "10", perJob: "10", maxJobs: 10, durationMs: 60000 } };
  const accountId = "guest_" + P.hash("installation"), owner = "account-" + P.hash("verified-account:" + accountId);
  let current, issued = 0, invalidated = 0;
  const deviceFree = {
    async creditAuthorization() { return current ||= { sessionToken: "df_" + ++issued, accountId, owner, schedulerUrl: config.schedulerUrl, deviceFree: true, sessionOnly: true, freeOnly: true, scope: "device-free" }; },
    assertCreditAuthorization(auth, pin) { assert.equal(auth, current); assert.equal(pin, config.schedulerUrl); },
    invalidate(auth) { if (auth === current) { current = null; invalidated++; } },
    dispose() {}, clear() { current = null; },
  };
  const requests = [];
  const account = { creditAuthorization: async () => { throw Object.assign(Error("No wallet connection"), { code: "signin-required" }); } };
  const service = new CreditService({ dataDir: f.dir, account, deviceFreeAccount: deviceFree, service: { schema: 1, state: "ready", config },
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      const status = replies[Math.min(requests.length - 1, replies.length - 1)];
      return Response.json(status === 200 ? { ok: true, product: "prepaid-usd-v1", owner, mode: "mainnet-pilot", paymentsEnabled: true,
        credits: { available: "37", purchased: { available: "0" }, free: { available: "37", state: "available" }, version: "2", unit: "USD-1e-8" } } : { error: "Expired session" }, { status });
    } });
  t.after(() => service.dispose());
  return { service, account, requests, owner, counts: () => ({ issued, invalidated }) };
}

test("expired automatic access reconnects once for the same free balance without a chat or purchase", async t => {
  const f = setup(t), signal = AbortSignal.timeout(2000);
  const before = await f.service.context(signal), store = f.service.sessionStore;
  const ciphertext = store.encryptString("pending private response");
  const result = await f.service.run("credit-status", undefined, signal);
  assert.equal(result.owner, f.owner); assert.equal(result.accessKind, "device-free");
  assert.equal(result.credits.free.available, "37");
  assert.deepEqual(f.counts(), { issued: 2, invalidated: 1 });
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(r => r.url.endsWith("/koin/prepaid/status") && r.body.creditWallet === null));
  assert.notEqual(f.requests[0].body.sessionToken, f.requests[1].body.sessionToken);
  assert.equal(f.service.sessionStore, store, "same installation keeps its pending chat key through token renewal");
  assert.equal(store.decryptString(ciphertext), "pending private response");
  assert.equal((await f.service.context(signal)).config.owner, before.config.owner);
});

test("rejected free access is bounded and never automatically repeats a submitted chat", async t => {
  const f = setup(t, [403]);
  await assert.rejects(f.service.run("credit-status", undefined, AbortSignal.timeout(2000)), { code: "credit-access-expired", status: 403 });
  assert.equal(f.requests.length, 2, "one read retry only");
  const context = await f.service.context();
  await assert.rejects(context.flow.call("chat", { requestId: P.hash("existing-request"), messages: [] }), { code: "credit-access-expired" });
  assert.equal(f.requests.filter(r => r.url.endsWith("/consume/chat/completions")).length, 1);
  assert.equal(f.requests.at(-1).body.requestId, P.hash("existing-request"));
});

test("paid identity errors cannot silently switch a request to installation credits", async t => {
  const f = setup(t);
  for (const code of ["wallet-changed", "identity-changed", "service-unavailable"]) {
    f.account.creditAuthorization = async () => { throw Object.assign(Error("Existing account must be preserved"), { code }); };
    await assert.rejects(f.service.context(), { code });
  }
  assert.deepEqual(f.counts(), { issued: 0, invalidated: 0 }); assert.equal(f.requests.length, 0);
});
