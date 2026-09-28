"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite"), { Signer } = require("koilib");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
const { ChainService } = require("../lib/koinos/chain"), { ProducerCustody } = require("../lib/koinos/producer-custody");
const { WalletNonceCoordinator } = require("../lib/koinos/wallet-nonce");
const { JsonStore } = require("../lib/store"), { DEFAULT_SETTINGS } = require("../lib/koinos/constants");
const { hash } = require("../lib/koin-network/job-protocol");
function wallet(f, journal = f.journal) {
  const settings = new JsonStore(path.join(f.dir, "settings.json"), DEFAULT_SETTINGS), chain = new ChainService(settings, { nonceCoordinator: journal.nonceCoordinator });
  chain.provider = () => f.provider; chain.resolveContracts = async () => ({ koin: f.d.token, vhp: f.d.operations, pob: f.d.mining });
  chain._isAllowanceToken = async () => true; chain.balances = async () => ({ koin: "100000000000", vhp: "100000000000", mana: "100000000000" });
  f.provider.getAccountRc = async () => "10000000000";
  f.walletSubmissions ??= []; f.provider.sendTransaction = async tx => { f.walletSubmissions.push(structuredClone(tx)); return { transaction: structuredClone(tx), receipt: {} }; };
  const state = new JsonStore(path.join(f.dir, "producer-state.json"));
  settings.set("producer", { mode: "external", addresses: { mainnet: f.signer.getAddress() } });
  const custody = new ProducerCustody({ settings, state, chain, wallet: { address: f.d.admin }, nodeMgr: {}, rewards: {} });
  return { chain, custody, state, nonces: journal.nonceCoordinator, send: () => chain.transfer(f.signer, { to: f.d.admin, amountSat: "100000000", token: "koin" }) };
}

test("a held funding signature blocks sends, burns, registration and external drafts before signing", async t => {
  const f = fixture(t), w = wallet(f); await f.runner().start(f.id, f.request); f.journal.hold(f.id);
  const original = f.signer.signTransaction.bind(f.signer); let extraSignatures = 0;
  f.signer.signTransaction = async (...args) => { extraSignatures++; return original(...args); };
  for (const run of [w.send, () => w.chain.transfer(f.signer, { to: f.d.admin, amountSat: "1", token: "vhp" }),
    () => w.chain.burn(f.signer, "100000000"), () => w.chain.registerProducerKey(f.signer, "AQ=="),
    () => w.custody.prepare({ action: "transfer", to: f.d.admin, amount: "1", token: "koin" })]) await assert.rejects(run(), /owns this wallet nonce/);
  assert.equal(extraSignatures, 0); assert.equal(f.walletSubmissions.length, 0); assert.equal(f.state.submissions.length, 1);
  const unrelated = Signer.fromSeed("another isolated wallet");
  await w.chain.transfer(unrelated, { to: f.d.admin, amountSat: "1" }); assert.equal(f.walletSubmissions.length, 1);
});

test("a send with a lost response blocks funding across restart until its exact irreversible receipt", async t => {
  const f = fixture(t), w = wallet(f);
  f.provider.sendTransaction = async tx => { f.walletSubmissions.push(structuredClone(tx)); throw Error("lost response"); };
  await assert.rejects(w.send(), /lost response/); const tx = f.walletSubmissions[0], id = hash("wallet:send:" + tx.id);
  assert.deepEqual(w.nonces.envelope(id), tx); await assert.rejects(f.runner().start(f.id, f.request), /owns this wallet nonce/);
  f.journal.close(); const reopened = f.open(), next = wallet(f, reopened);
  assert.equal((await next.send()).txId, tx.id); assert.equal(f.walletSubmissions.length, 1);
  await f.include(tx); assert.equal((await next.nonces.reconcile(id)).state, "signed");
  await assert.rejects(reopened.begin(f.id, f.request), /owns this wallet nonce/);
  f.state.lib = f.state.height; assert.equal((await next.nonces.reconcile(id)).state, "finalized");
  assert.equal((await reopened.begin(f.id, f.request)).action, "prepare_funding");
});

test("burn and registration share the same fence and an irreversible revert releases it", async t => {
  for (const action of ["burn", "register"]) {
    const f = fixture(t), w = wallet(f);
    const result = action === "burn" ? await w.chain.burn(f.signer, "100000000") : await w.chain.registerProducerKey(f.signer, "AQ==");
    assert.equal(result.confirmed, false); await assert.rejects(f.journal.begin(f.id, f.request), /owns this wallet nonce/);
    const tx = f.walletSubmissions[0]; assert.equal(tx.operations.length, action === "burn" ? 2 : 1);
    await f.include(tx, { reverted: true, irreversible: true });
    assert.equal((await w.nonces.reconcile(result.nonceReservation)).state, "reverted");
    assert.equal((await f.journal.begin(f.id, f.request)).action, "prepare_funding");
  }
});

test("exported unsigned drafts never expire out of the nonce fence and lower-RC replacements are refused", async t => {
  const f = fixture(t), w = wallet(f), input = { action: "transfer", to: f.d.admin, amount: "1", token: "koin", offlineSigning: true };
  const draft = await w.custody.prepare(input);
  await assert.rejects(w.custody.prepare(input), /existing external/);
  await assert.rejects(f.journal.begin(f.id, f.request), /owns this wallet nonce/);
  f.state.now += 2 * 86400000;
  assert.equal((await w.nonces.reconcile(draft.nonceReservation)).state, "signing");
  const signed = await f.sign(draft);
  const lower = structuredClone(draft.transaction); lower.header.rc_limit = "5000000";
  const { Transaction } = require("koilib"); await Transaction.prepareTransaction(lower); await f.signer.signTransaction(lower);
  await assert.rejects(w.custody.broadcast({ transaction: lower, confirm: true }), /original transaction/);
  await w.custody.broadcast({ transaction: signed, confirm: true });
  assert.equal(w.nonces.status(draft.nonceReservation).state, "signed"); assert.equal(f.walletSubmissions.length, 1);
});

test("concurrent funding and send requests across handles elect one signing request", async t => {
  const f = fixture(t), second = f.open(), w = wallet(f, second); let signatures = 0;
  const sign = f.signer.signTransaction.bind(f.signer); f.signer.signTransaction = async (...args) => { signatures++; return sign(...args); };
  const results = await Promise.allSettled([f.runner().start(f.id, f.request), w.send()]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(signatures, 1);
  assert.equal(f.walletSubmissions.length + f.state.submissions.length, 1);
});

test("a staged shared envelope repairs a crash between journal writes without another signature", async t => {
  const f = fixture(t), decision = await f.journal.begin(f.id, f.request), signed = await f.sign(decision);
  await f.journal.nonceCoordinator.stage(f.id, signed);
  assert.equal(f.journal.saved(f.id).signed, false); f.journal.close(); const reopened = f.open();
  assert.equal((await f.runner(reopened).tick(f.id)).action, "await_finality");
  assert.equal(f.state.signed, 1); assert.deepEqual(f.state.submissions[0], signed);
});

test("a crash after reserving but before writing the funding row cannot sign a second time", async t => {
  const f = fixture(t), tx = await f.client.prepare(f.request.kind, f.request.method, f.request.args, { actor: f.request.actor, rcLimit: f.request.maxRc });
  await f.journal.nonceCoordinator.reserve(f.id, "funding", tx);
  assert.equal((await f.runner().start(f.id, f.request)).reason, "recover_signing_envelope");
  assert.equal(f.state.signed, 0); assert.equal(f.state.submissions.length, 0);
});

test("forks, reversible inclusion and malformed receipts cannot release a wallet reservation", async t => {
  for (const mutate of [f => { f.state.lib--; }, f => { f.state.fork = true; },
    f => { f.state.block.receipt.transaction_receipts[0].payer = f.d.admin; },
    f => { f.state.block.receipt.transaction_receipts[0].reverted = "false"; },
    f => { f.state.block.receipt.transaction_receipts = []; },
    f => { f.provider.getHeadInfo = async () => ({ rpc_error: "bad" }); }]) {
    const f = fixture(t), w = wallet(f), sent = await w.send();
    await f.include(f.walletSubmissions[0], { irreversible: true }); mutate(f);
    await w.nonces.reconcile(sent.nonceReservation).catch(() => {});
    assert.equal(w.nonces.status(sent.nonceReservation).state, "signed");
    await assert.rejects(f.journal.begin(f.id, f.request), /owns this wallet nonce/);
  }
});

test("missing, damaged or mismatched nonce journals fail closed", async t => {
  const f = fixture(t); await f.runner().start(f.id, f.request);
  const db = new DatabaseSync(path.join(f.dir, "wallet-nonces.sqlite")); db.exec("UPDATE reservations SET data='{}'"); db.close();
  assert.throws(() => f.journal.status(f.id), /damaged wallet/);
  f.journal.close(); fs.renameSync(path.join(f.dir, "wallet-nonces.sqlite"), path.join(f.dir, "nonce-backup.sqlite"));
  assert.throws(() => f.open(), /nonce journal missing/);
  assert.throws(() => new WalletNonceCoordinator(f.dir, { mode: "production", client: f.client }), /isolated/);
});

test("coordinated external import still prevents concurrent broadcasts", async t => {
  const f = fixture(t), w = wallet(f), d = await w.custody.prepare({ action: "transfer", to: f.d.admin, amount: "1" });
  const signed = await f.sign(d);
  await Promise.allSettled([w.custody.broadcast({ transaction: signed, confirm: true }), w.custody.broadcast({ transaction: signed, confirm: true })]);
  assert.equal(f.walletSubmissions.length, 1);
});
