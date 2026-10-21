"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path"), { EventEmitter } = require("events"), { Signer } = require("koilib");
const { fixture } = require("./helpers/koin-funding-recovery-fixture"), P = require("../lib/koin-network/job-protocol"), USD = require("../lib/koin-network/purchase-quote");
const { CreditPurchases } = require("../../electron/credit-purchases");
const Prices = require("./helpers/purchase-price-fixture");
function setup(t) {
  const f = fixture(t, { usd: true }); let response = 1, revoked = false, signatures = 0, reviews = 0;
  const signer = Signer.fromSeed("funding-recovery-verifier"), wallet = { address: f.signer.getAddress(), signer: f.signer };
  const sign = f.signer.signTransaction.bind(f.signer); f.signer.signTransaction = async tx => { signatures++; return sign(tx); };
  f.provider.call = async (_method, { transaction }) => { f.state.submissions.push(structuredClone(transaction)); throw Error("Lost fixture response"); };
  const config = { mode: "isolated-rehearsal", deployment: f.d, owner: wallet.address, schedulerUrl: "https://fixture.invalid/scheduler", version: 1, pricingPolicyHash: Prices.pricingPolicyHash,
    maxRcPerTransaction: "10000000", maxRcPerDay: "20000000", limits: { amount: "500000000" } };
  const directory = path.join(f.dir, "credit-account-v2", P.hash("account"), P.hash(JSON.stringify(config))); fs.mkdirSync(directory, { recursive: true });
  const registrations = [], c = { config, directory, auth: { accountId: "account", sessionToken: "private-session" }, flow: { call: async (route, body) => {
    if (route === "purchase") { registrations.push(body.txId); return {}; }
    assert.equal(route, "quote-usd"); return Prices.issue({ deployment: f.d, signer, account: wallet.address, amount: USD.nativeForDollars(body.dollars, "25000000"), usdPerKoin: "25000000", version: 1, now: f.state.now });
  } } };
  const options = { dataDir: f.dir, account: { wallet, assertCreditAuthorization: () => { if (revoked) throw Error("Signed out"); } }, storage: {
    isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() }, clock: () => f.state.now, clientFactory: () => f.client,
    dialog: { showMessageBox: async () => { reviews++; return { response }; } }, fetchImpl: async (_url, init) => {
      assert.equal(init.headers.authorization, "Bearer private-session"); return Response.json({ granted: true, owner: wallet.address, installation: JSON.parse(init.body).installation, mode: config.mode, chainId: f.d.chainId });
    } };
  const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false, isVisible: () => true, isMinimized: () => false });
  return { ...f, c, options, window, controller: new CreditPurchases(options), registrations, cancel: () => { response = 0; }, revoke: () => { revoked = true; }, counts: () => ({ signatures, reviews }) };
}
test("public purchase approval persists one signed transaction; repeat and restart recover the original", async t => {
  const f = setup(t), signal = new AbortController().signal;
  const first = await f.controller.preview(f.c, { usd: "1" }, signal);
  const started = await f.controller.run(f.c, f.window, "purchase-approve", first.quote.id, signal);
  assert.equal(started.state, "pending"); assert.ok(started.purchase.txId); assert.equal(f.counts().signatures, 1);
  await assert.rejects(f.controller.run(f.c, f.window, "purchase-approve", first.quote.id, signal), /Refresh/);
  const second = await f.controller.preview(f.c, { usd: "0.5" }, signal);
  const repeated = await f.controller.run(f.c, f.window, "purchase-approve", second.quote.id, signal);
  assert.equal(repeated.purchase.txId, started.purchase.txId); assert.equal(f.counts().signatures, 1); assert.equal(f.counts().reviews, 1);
  const restarted = new CreditPurchases(f.options); f.state.now += 1001;
  await restarted.run(f.c, f.window, "purchase-retry", undefined, signal);
  assert.equal(f.counts().signatures, 1); assert.equal(f.state.submissions.length, 2); assert.deepEqual(f.state.submissions[0], f.state.submissions[1]);
  const operation = f.state.submissions[0].operations.find(op => op.call_contract?.contract_id === f.d.credits).call_contract;
  f.request.args = await f.client.serializer.deserialize(operation.args, "koin.Request");
  await f.include(f.state.submissions[0], { irreversible: true });
  await restarted.sync(f.c, signal); assert.equal(f.counts().signatures, 1);
  assert.equal((await restarted.run(f.c, f.window, "purchase-retry", undefined, signal)).state, "complete");
});
test("public payment cancellation and account revocation never sign", async t => {
  const f = setup(t), signal = new AbortController().signal; f.cancel();
  const first = await f.controller.preview(f.c, { usd: "1" }, signal);
  assert.equal((await f.controller.run(f.c, f.window, "purchase-approve", first.quote.id, signal)).state, "cancelled");
  const next = await f.controller.preview(f.c, { usd: "1" }, signal); f.revoke();
  await assert.rejects(f.controller.run(f.c, f.window, "purchase-approve", next.quote.id, signal), /Signed out/);
  assert.equal(f.counts().signatures, 0); assert.equal(f.state.submissions.length, 0);
});
