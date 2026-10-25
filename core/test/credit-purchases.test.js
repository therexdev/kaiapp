"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path"), { EventEmitter } = require("events"), { Signer } = require("koilib");
const { fixture } = require("./helpers/koin-funding-recovery-fixture"), P = require("../lib/koin-network/job-protocol"), USD = require("../lib/koin-network/purchase-quote");
const { CreditPurchases } = require("../../electron/credit-purchases");
const Prices = require("./helpers/purchase-price-fixture");
function setup(t, { mainnet = false, maxRcPerDay = "20000000" } = {}) {
  const f = fixture(t, { usd: true, mainnet }); let response = 1, revoked = false, signatures = 0, reviews = 0;
  const signer = Signer.fromSeed("funding-recovery-verifier"), wallet = { address: f.signer.getAddress(), signer: f.signer };
  const sign = f.signer.signTransaction.bind(f.signer); f.signer.signTransaction = async tx => { signatures++; return sign(tx); };
  f.provider.call = async (_method, { transaction }) => { f.state.submissions.push(structuredClone(transaction)); throw Error("Lost fixture response"); };
  f.provider.getAccountRc = async () => "14938227003";
  const config = { mode: mainnet ? "mainnet-pilot" : "isolated-rehearsal", deployment: f.d, owner: wallet.address, schedulerUrl: "https://fixture.invalid/scheduler", version: 1, pricingPolicyHash: Prices.pricingPolicyHash,
    maxRcPerTransaction: "10000000", maxRcPerDay, limits: { amount: "500000000" } };
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

test("purchase failures identify the stopped stage without exposing errors or signing", async t => {
  for (const scenario of ["rpc", "unknown", "dialog", "reserve"]) {
    const f = setup(t, { mainnet: true }), signal = new AbortController().signal;
    const prepare = f.client.prepare.bind(f.client); let calls = 0;
    const privateError = Object.assign(Error("private-session raw-price-signature C:\\private\\wallet.json"),
      scenario === "rpc" ? { code: "koin_rpc_unavailable" } : {});
    if (scenario === "dialog") f.options.dialog.showMessageBox = async () => { throw privateError; };
    else f.client.prepare = async (...args) => {
      if (scenario !== "reserve" || ++calls === 2) throw privateError;
      return prepare(...args);
    };
    const first = await f.controller.preview(f.c, { usd: "1" }, signal);
    const expected = scenario === "rpc" ? "prepare/rpc-unavailable" : `${scenario === "unknown" ? "prepare" : scenario}/unavailable`;
    await assert.rejects(f.controller.run(f.c, f.window, "purchase-approve", first.quote.id, signal), error => {
      assert.ok(error.message.includes(expected), error.message);
      assert.equal(/private-session|raw-price-signature|wallet\.json/.test(error.message), false);
      assert.ok(error.message.includes(scenario === "rpc" ? "fresh quote" : "before trying another purchase"));
      return true;
    });
    assert.equal(f.counts().signatures, 0); assert.equal(f.state.submissions.length, 0);
    await assert.rejects(f.controller.run(f.c, f.window, "purchase-approve", first.quote.id, signal), /Refresh/);
  }
});

test("a failed preparation can use a fresh quote without reusing the consumed approval", async t => {
  const f = setup(t), signal = new AbortController().signal, prepare = f.client.prepare.bind(f.client);
  f.client.prepare = async () => { throw Object.assign(Error("unavailable"), { code: "koin_rpc_unavailable" }); };
  const first = await f.controller.preview(f.c, { usd: "1" }, signal);
  await assert.rejects(f.controller.run(f.c, f.window, "purchase-approve", first.quote.id, signal), /prepare\/rpc-unavailable/);
  f.client.prepare = prepare;
  const next = await f.controller.preview(f.c, { usd: "1" }, signal);
  const result = await f.controller.run(f.c, f.window, "purchase-approve", next.quote.id, signal);
  assert.equal(result.state, "pending"); assert.equal(f.counts().signatures, 1);
  assert.equal(f.state.submissions.length, 1); assert.equal(f.counts().reviews, 1);
});

test("a saved simulation failure remains visible after restart without another signature or broadcast", async t => {
  const f = setup(t, { mainnet: true }), signal = new AbortController().signal, calls = [];
  f.provider.call = async (method, args) => {
    assert.equal(method, "chain.submit_transaction"); calls.push(args.broadcast);
    return { receipt: { id: args.transaction.id, payer: f.signer.getAddress(), rc_used: "1000", reverted: true } };
  };
  assert.equal(await f.controller.status(f.c, signal), null);
  const quote = await f.controller.preview(f.c, { usd: "1" }, signal);
  const result = await f.controller.run(f.c, f.window, "purchase-approve", quote.quote.id, signal);
  assert.equal(result.state, "pending"); assert.deepEqual(calls, [false]); assert.equal(f.counts().signatures, 1);
  const restarted = new CreditPurchases(f.options), status = await restarted.status(f.c, signal);
  assert.equal(status.txId, result.purchase.txId); assert.equal(status.issue, "funding_simulation_failed");
  assert.match(status.detail, /pre-submission check/); assert.equal(status.quoteExpired, false);
  assert.doesNotMatch(JSON.stringify(status), /private-session|price_signature|signatures|purchase_quote/);
  f.state.now += 300001;
  const expired = await restarted.status(f.c, signal);
  assert.equal(expired.quoteExpired, true); assert.match(expired.detail, /quote expired/);
  assert.equal(expired.txId, status.txId); assert.deepEqual(calls, [false]); assert.equal(f.counts().signatures, 1);
  f.revoke(); await assert.rejects(restarted.status(f.c, signal), /Signed out/);
});

function savedPayment(f) {
  const { DatabaseSync } = require("node:sqlite"), directory = require("../../electron/credit-purchase-journals").purchaseDirectory(f.dir, f.c.directory, f.c.config);
  const db = new DatabaseSync(path.join(directory, "wallet-nonces.sqlite"), { readOnly: true });
  try { return JSON.parse(db.prepare("SELECT data FROM reservations ORDER BY rowid DESC LIMIT 1").get().data); } finally { db.close(); }
}
async function expiredPurchase(t, options = {}) {
  const f = setup(t, { ...options, mainnet: true }), signal = new AbortController().signal;
  f.provider.call = async () => { throw Object.assign(Error("RPC unavailable"), { code: "koin_rpc_unavailable" }); };
  const quote = await f.controller.preview(f.c, { usd: "1" }, signal);
  const payment = await f.controller.run(f.c, f.window, "purchase-approve", quote.quote.id, signal);
  f.state.now += 300001; f.state.height++;
  const original = savedPayment(f).transaction, calls = [];
  f.provider.call = async (method, args) => {
    assert.equal(method, "chain.submit_transaction"); calls.push(structuredClone(args));
    return { receipt: { id: args.transaction.id, payer: f.c.config.owner, rc_used: "1000", reverted: false } };
  };
  return { ...f, signal, payment, original, calls };
}
test("expired purchase cancellation transfers zero, retains both signatures, waits for finality and permits a fresh purchase", async t => {
  const f = await expiredPurchase(t);
  assert.equal((await f.controller.status(f.c, f.signal)).recovery, "cancel-expired");
  const result = await f.controller.run(f.c, f.window, "purchase-retry", undefined, f.signal);
  assert.equal(result.state, "pending"); assert.equal(f.counts().signatures, 2);
  const saved = savedPayment(f), cancel = saved.cancellation.transaction;
  assert.deepEqual(saved.transaction, f.original);
  assert.equal(cancel.header.nonce, f.original.header.nonce);
  assert.equal(cancel.header.rc_limit, f.original.header.rc_limit);
  assert.deepEqual(cancel.operations, [require("../lib/koin-network/funding-cancel").operation(f.d, f.c.config.owner)]);
  assert.deepEqual(f.calls.map(c => c.broadcast), [false, true]);
  assert.deepEqual(f.calls[0].transaction, f.calls[1].transaction);
  assert.equal(f.registrations.includes(cancel.id), false, "a cancellation is never registered as a credit purchase");
  const restarted = new CreditPurchases(f.options);
  assert.equal((await restarted.status(f.c, f.signal)).recovery, "resume-cancellation");
  await f.include(cancel, { zeroTransfer: true });
  await restarted.sync(f.c, f.signal);
  assert.ok(await restarted.status(f.c, f.signal), "a reversible cancellation cannot unlock another purchase");
  assert.deepEqual(await restarted.cancelled(f.c, f.signal), []);
  f.state.lib = f.state.height;
  await restarted.sync(f.c, f.signal);
  assert.equal(await restarted.status(f.c, f.signal), null);
  assert.equal((await restarted.cancelled(f.c, f.signal))[0].txId, f.original.id);
  assert.equal((await restarted.cancelled(f.c, f.signal))[0].cancellationTxId, cancel.id);
  assert.equal(f.state.available, "0");
  f.state.record = null; f.state.height++;
  const next = await restarted.preview(f.c, { usd: "1" }, f.signal);
  const purchase = await restarted.run(f.c, f.window, "purchase-approve", next.quote.id, f.signal);
  assert.equal(purchase.state, "pending"); assert.equal(f.counts().signatures, 3);
  assert.notEqual(purchase.purchase.txId, f.original.id);
  assert.equal(savedPayment(f).draft.header.nonce, "KAI=");
});
test("lost cancellation submission resumes the exact saved envelope after restart", async t => {
  const f = await expiredPurchase(t), call = f.provider.call;
  f.provider.call = async (method, args) => { const result = await call(method, args); if (args.broadcast) throw Error("Lost response"); return result; };
  await f.controller.run(f.c, f.window, "purchase-retry", undefined, f.signal);
  const saved = savedPayment(f); f.state.now += 1001; f.state.height++;
  const restarted = new CreditPurchases(f.options);
  await restarted.run(f.c, f.window, "purchase-retry", undefined, f.signal);
  assert.equal(f.counts().signatures, 2); assert.deepEqual(savedPayment(f).cancellation.transaction, saved.cancellation.transaction);
  assert.equal(f.calls.filter(c => c.broadcast).length, 2);
  assert.deepEqual(f.calls.filter(c => c.broadcast)[0], f.calls.filter(c => c.broadcast)[1]);
  await assert.rejects(restarted.use(f.c, f.signal, async payments => {
    const other = await restarted.preview(f.c, { usd: "1" }, f.signal);
    return restarted.run(f.c, f.window, "purchase-approve", other.quote.id, f.signal);
  }), /Finish/);
});
test("pending cancellation avoids duplicate purchase checks and background polling does not reread contract policies", async t => {
  const f = await expiredPurchase(t), verify = f.client.verify.bind(f.client); let checks = 0;
  f.client.verify = async () => { checks++; return verify(); };
  await f.controller.run(f.c, f.window, "purchase-retry", undefined, f.signal);
  assert.ok(checks <= 4, `Recovery made ${checks} full policy reads`);
  const signatures = f.counts().signatures, submissions = f.calls.length, registrations = f.registrations.length;
  checks = 0;
  f.provider.readContract = async () => { throw Error("Background cancellation must not read purchase policies"); };
  await f.controller.sync(f.c, f.signal);
  assert.equal(checks, 0); assert.equal(f.counts().signatures, signatures); assert.equal(f.calls.length, submissions);
  assert.equal(f.registrations.length, registrations);
  assert.equal((await f.controller.status(f.c, f.signal)).recovery, "resume-cancellation");
});
test("an RPC failure after cancellation signing preserves the signature and identifies the exact stopped check", async t => {
  const f = await expiredPurchase(t), lookup = f.provider.getTransactionsById;
  const sign = f.signer.signTransaction.bind(f.signer);
  f.signer.signTransaction = async tx => {
    const result = await sign(tx);
    f.provider.getTransactionsById = async () => { throw Object.assign(Error("private-signature private-session"), { code: "koin_rpc_rate_limited" }); };
    return result;
  };
  await assert.rejects(f.controller.run(f.c, f.window, "purchase-retry", undefined, f.signal), error => {
    assert.match(error.message, /cancellation\/saved-transaction-lookup\/rate_limited/);
    assert.doesNotMatch(error.message, /private-signature|private-session/); return true;
  });
  const saved = savedPayment(f).cancellation;
  assert.ok(saved.transaction); assert.equal(saved.submissions.length, 0); assert.equal(f.calls.length, 0);
  assert.match((await f.controller.status(f.c, f.signal)).detail, /signed but has not been submitted/);
  f.provider.getTransactionsById = lookup;
  await f.controller.run(f.c, f.window, "purchase-retry", undefined, f.signal);
  assert.deepEqual(savedPayment(f).cancellation.transaction, saved.transaction);
  assert.equal(f.counts().signatures, 2); assert.deepEqual(f.calls.map(c => c.broadcast), [false, true]);
});
test("cancellation needs native approval and fresh chain expiry, nonce, deployment and account", async t => {
  for (const scenario of ["decline", "chain-time", "nonce", "code", "account", "locked"]) {
    const f = await expiredPurchase(t), before = f.counts();
    if (scenario === "decline") f.cancel();
    if (scenario === "chain-time") { const head = f.provider.getHeadInfo; f.provider.getHeadInfo = async () => ({ ...await head(), head_block_time: String(f.state.now - 1) }); }
    if (scenario === "nonce") f.state.nonce = "KAI=";
    if (scenario === "code") f.provider.invokeGetContractMetadata = async () => ({ value: { hash: "0x1220" + "9".repeat(64) } });
    if (scenario === "account") f.revoke();
    if (scenario === "locked") Object.defineProperty(f.options.account.wallet, "signer", { get() { throw Error("Unlock wallet"); } });
    const recovery = f.controller.run(f.c, f.window, "purchase-retry", undefined, f.signal);
    if (scenario === "decline") assert.equal((await recovery).state, "cancelled"); else await assert.rejects(recovery);
    assert.equal(f.counts().signatures, before.signatures, scenario); assert.equal(f.calls.length, 0, scenario);
    assert.equal(savedPayment(f).cancellation, undefined, scenario); assert.deepEqual(savedPayment(f).transaction, f.original);
  }
});
test("a cancellation cannot sign twice after a lost signing result and Stop retains a late signature", async t => {
  for (const stop of [false, true]) {
    const f = await expiredPurchase(t), originalSign = f.signer.signTransaction.bind(f.signer); let attempted = 0;
    f.signer.signTransaction = async tx => { attempted++; await originalSign(tx); if (stop) f.window.emit("hide"); else throw Error("Lost signing response"); return tx; };
    await assert.rejects(f.controller.run(f.c, f.window, "purchase-retry", undefined, f.signal));
    const saved = savedPayment(f);
    assert.ok(saved.cancellation); assert.equal(!!saved.cancellation.transaction, stop); assert.equal(f.calls.length, 0);
    if (!stop) {
      const restarted = new CreditPurchases(f.options);
      await assert.rejects(restarted.run(f.c, f.window, "purchase-retry", undefined, f.signal), /cannot be signed again/);
      assert.equal(attempted, 1);
    }
    assert.deepEqual(saved.transaction, f.original);
  }
});
test("an original purchase finalized during cancellation review is credited once without signing cancellation", async t => {
  const f = await expiredPurchase(t);
  const op = f.original.operations.find(o => o.call_contract.contract_id === f.d.credits).call_contract;
  f.request.args = await f.client.serializer.deserialize(op.args, "koin.Request");
  f.options.dialog.showMessageBox = async () => { await f.include(f.original, { irreversible: true }); return { response: 1 }; };
  const result = await f.controller.run(f.c, f.window, "purchase-retry", undefined, f.signal);
  assert.equal(result.state, "complete"); assert.equal(result.purchase.state, "funded");
  assert.equal(f.counts().signatures, 1); assert.equal(f.calls.length, 0); assert.equal(savedPayment(f).cancellation, undefined);
  assert.deepEqual(await f.controller.cancelled(f.c, f.signal), []);
});

test("a live purchase Mana review stays within the daily limit and registers the saved corrected transaction", async t => {
  const f = setup(t, { mainnet: true }), signal = new AbortController().signal;
  f.provider.call = async () => { throw Error("insufficient rc"); };
  const quote = await f.controller.preview(f.c, { usd: "1" }, signal);
  const purchase = await f.controller.run(f.c, f.window, "purchase-approve", quote.quote.id, signal);
  assert.equal((await f.controller.status(f.c, signal)).recovery, "correct-mana");
  const calls = []; f.provider.call = async (_method, args) => { calls.push(args); return { receipt: { id: args.transaction.id, payer: f.c.config.owner, rc_used: "12000000" } }; };
  const recovered = await f.controller.run(f.c, f.window, "purchase-retry", undefined, signal);
  const saved = savedPayment(f);
  assert.equal(recovered.state, "pending"); assert.equal(f.counts().signatures, 2);
  assert.equal(saved.correction.draft.header.rc_limit, f.c.config.maxRcPerDay);
  assert.equal(saved.correction.draft.header.nonce, saved.draft.header.nonce);
  assert.deepEqual(saved.correction.draft.operations, saved.draft.operations);
  assert.deepEqual(calls.map(c => c.broadcast), [false, true]);
  assert.equal(f.registrations.at(-1), saved.correction.draft.id);
  assert.notEqual(f.registrations.at(-1), purchase.purchase.txId);
});
test("a purchase after cancellation uses only the remaining daily Mana allowance or stops before another signature", async t => {
  for (const budget of ["30000000", "20000000"]) {
    const f = await expiredPurchase(t, { maxRcPerDay: budget });
    await f.controller.run(f.c, f.window, "purchase-retry", undefined, f.signal);
    const cancellation = savedPayment(f).cancellation.transaction;
    await f.include(cancellation, { zeroTransfer: true, irreversible: true });
    await f.controller.sync(f.c, f.signal);
    assert.equal(await f.controller.status(f.c, f.signal), null);
    f.state.record = null; f.state.height++;
    f.provider.call = async () => { throw Error("insufficient rc"); };
    const quote = await f.controller.preview(f.c, { usd: "1" }, f.signal);
    await f.controller.run(f.c, f.window, "purchase-approve", quote.quote.id, f.signal);
    const original = savedPayment(f).transaction;
    assert.equal(f.counts().signatures, 3);
    const calls = [];
    f.provider.call = async (_method, args) => { calls.push(args); return { receipt: { id: args.transaction.id, payer: f.c.config.owner, rc_used: "12000000" } }; };
    if (budget === "20000000") {
      await assert.rejects(f.controller.run(f.c, f.window, "purchase-retry", undefined, f.signal), /remaining wallet allowance/);
      assert.equal(f.counts().signatures, 3); assert.equal(savedPayment(f).correction, undefined); assert.deepEqual(calls, []);
      continue;
    }
    await f.controller.run(f.c, f.window, "purchase-retry", undefined, f.signal);
    const corrected = savedPayment(f).correction.transaction;
    assert.equal(corrected.header.rc_limit, "20000000");
    assert.equal(BigInt(cancellation.header.rc_limit) + BigInt(corrected.header.rc_limit), BigInt(budget));
    assert.equal(corrected.header.nonce, original.header.nonce); assert.deepEqual(corrected.operations, original.operations);
    assert.equal(f.counts().signatures, 4); assert.deepEqual(calls.map(c => c.broadcast), [false, true]);
    const op = corrected.operations.find(o => o.call_contract.contract_id === f.d.credits).call_contract;
    f.request.args = await f.client.serializer.deserialize(op.args, "koin.Request");
    await f.include(corrected, { irreversible: true });
    await f.controller.sync(f.c, f.signal);
    assert.equal(await f.controller.status(f.c, f.signal), null);
    assert.equal(f.registrations.at(-1), corrected.id);
  }
});
test("a price expiring during Mana review cannot create another signature", async t => {
  const f = setup(t, { mainnet: true }), signal = new AbortController().signal;
  f.provider.call = async () => { throw Error("insufficient rc"); };
  const quote = await f.controller.preview(f.c, { usd: "1" }, signal);
  await f.controller.run(f.c, f.window, "purchase-approve", quote.quote.id, signal);
  f.state.now += 240000; f.state.height++;
  f.options.dialog.showMessageBox = async () => { f.state.now += 60001; f.state.height++; return { response: 1 }; };
  await assert.rejects(f.controller.run(f.c, f.window, "purchase-retry", undefined, signal), /expired/);
  assert.equal(f.counts().signatures, 1); assert.equal(savedPayment(f).correction, undefined);
  assert.equal((await f.controller.status(f.c, signal)).recovery, "cancel-expired");
});

test("payment confirmation retains its working RPC provider across reads and retries", async t => {
  const f = setup(t), signal = new AbortController().signal; let created = 0;
  f.options.clientFactory = () => { created++; return f.client; };
  const controller = new CreditPurchases(f.options);
  const quote = await controller.preview(f.c, { usd: "1" }, signal);
  await controller.run(f.c, f.window, "purchase-approve", quote.quote.id, signal);
  await controller.status(f.c, signal); await controller.sync(f.c, signal); await controller.cancelled(f.c, signal);
  assert.equal(created, 1);
  await new CreditPurchases(f.options).status(f.c, signal); assert.equal(created, 2);
});
