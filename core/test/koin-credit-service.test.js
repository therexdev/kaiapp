"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { CreditService, manifest } = require("../../electron/credit-service"), { fixture } = require("./helpers/koin-funding-recovery-fixture");
const P = require("../lib/koin-network/job-protocol");
function setup(t) {
  const f = fixture(t, { mainnet: true, usd: true });
  const config = { schema: 1, mode: "mainnet-pilot", deployment: f.d, schedulerUrl: "https://credit.invalid/scheduler", policyHash: P.hash("tariff"), version: 1,
    model: "fixture", maxOutput: 32, maxRcPerTransaction: "1", maxRcPerDay: "2", limits: { amount: "10", perJob: "10", maxJobs: 10, durationMs: 60000 } };
  const auth = { accountId: "verified-email-account", owner: "account-" + P.hash("verified-account:verified-email-account"), sessionToken: "private-token" };
  let signedIn = true;
  const service = new CreditService({ dataDir: f.dir, service: { schema: 1, state: "ready", config }, storage: { isEncryptionAvailable: () => true },
    account: { creditAuthorization: async () => { if (!signedIn) throw Error("Sign in"); return auth; }, assertCreditAuthorization: () => { if (!signedIn) throw Error("Sign in"); } },
    fetchImpl: async (_url, init) => {
      assert.equal(JSON.parse(init.body).sessionToken, auth.sessionToken);
      return Response.json({ ok: true, product: "prepaid-usd-v1", owner: auth.owner, mode: "mainnet-pilot", paymentsEnabled: true, balance: { available: "0" } });
    } });
  return { ...f, service, config, auth, logout: () => { signedIn = false; } };
}
test("a verified account activates USD chat without a wallet or changing earlier journals", async t => {
  const f = setup(t), old = path.join(f.dir, "koin-prepaid-v1"); fs.mkdirSync(old);
  const preserved = Buffer.from('signed old purchase and 0.1 KOIN obligation'); fs.writeFileSync(path.join(old, "journal.json"), preserved);
  const info = await f.service.info(); assert.equal(info.activation, "ready");
  const context = await f.service.context(); assert.equal(context.config.owner, f.auth.owner);
  assert.equal((await f.service.run("credit-status")).owner, f.auth.owner);
  assert.deepEqual(fs.readFileSync(path.join(old, "journal.json")), preserved);
  const root = path.join(f.dir, "credit-account-v2", P.hash(f.auth.accountId));
  const metadata = fs.readFileSync(path.join(root, fs.readdirSync(root)[0], "context.json"), "utf8");
  assert.ok(!metadata.includes(f.auth.sessionToken));
  f.logout(); await assert.rejects(f.service.run("credit-status"), /Sign in/);
});
test("activation refuses reuse of an earlier custody or rewards address and leaves bytes intact", async t => {
  const f = setup(t), old = path.join(f.dir, "koin-foundation-test"); fs.mkdirSync(old);
  const file = path.join(old, "deployment.json"), bytes = JSON.stringify({ deployment: { credits: f.d.rewards, rewards: f.d.credits } }); fs.writeFileSync(file, bytes);
  await assert.rejects(f.service.context(), /fresh contracts/); assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.equal(fs.existsSync(path.join(f.dir, "credit-account-v2")), false);
});
test("activation discovers an earlier USD recovery record without moving or changing it", async t => {
  const f = setup(t); f.auth.owner = f.signer.getAddress();
  const root = path.join(f.dir, "koin-prepaid-usd-v1"); fs.mkdirSync(root);
  const config = require("../../electron/koin-test-config").configuration({ ...f.config, owner: f.auth.owner });
  fs.writeFileSync(path.join(root, "deployment.json"), JSON.stringify(config));
  const record = { schema: 1, owner: f.auth.owner, deployment: P.hash(JSON.stringify(config)), state: "pending", id: P.hash("earlier-job"), session: P.hash("earlier-session"), requestHash: P.hash("earlier-message"), input: "encrypted-input" };
  const bytes = JSON.stringify(record), file = path.join(root, "prepaid-chat-recovery.json"); fs.writeFileSync(file, bytes);
  const context = await f.service.context(); assert.equal(context.recoverable.length, 1); assert.equal(context.recoverable[0].record.id, record.id);
  assert.equal((await f.service.info()).recoveryAvailable, true); assert.equal(fs.readFileSync(file, "utf8"), bytes);
});
test("missing commercial deployment stays unavailable without initiating account or wallet actions", async () => {
  const service = new CreditService({ dataDir: "/unused", service: { schema: 1, state: "unavailable", reason: "Awaiting approved service configuration" }, account: new Proxy({}, { get() { throw Error("No account action"); } }) });
  assert.equal((await service.info()).activation, "unavailable");
  await assert.rejects(service.run("chat-completion", {}), /Awaiting/);
  assert.throws(() => manifest({ schema: 1, state: "ready", config: { owner: "injected-wallet" } }), /Separate USD/);
});
