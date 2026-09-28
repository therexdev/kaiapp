"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { Signer, Transaction, Contract, utils } = require("koilib");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
const { ProducerVault } = require("../lib/koinos/producer-vault");
const { VaultRecovery } = require("../lib/koinos/vault-recovery");
const { buildSwapTransaction } = require("../lib/koinos/koindx");
const { buildRedeemTransaction } = require("../lib/koinos/koinos-bridge");
const { hash } = require("../lib/koin-network/job-protocol");
const { TOKEN_ABI } = require("../lib/koinos/constants");
async function setup(t) {
  const f = fixture(t), owner = f.signer.getAddress(), sponsor = Signer.fromSeed("isolated vault sponsor"), sent = [];
  const token = new Contract({ id: f.d.token, abi: TOKEN_ABI });
  const { operation } = await token.functions.transfer({ from: owner, to: f.d.admin, value: "1" }, { onlyOperation: true });
  const operations = [operation], summary = { action: "transfer", producer: owner, network: "isolated" };
  const state = { lost: false, status: "pending", connected: false, txId: null };
  const custody = { config: () => ({ mode: "external", address: owner }), requireExternal: () => {}, operations: async () => ({ operations, summary }) };
  const chain = { network: () => ({ id: "isolated" }), provider: () => f.provider, isValidAddress: a => a === owner };
  const request = async (route, body) => {
    if (route === "config") return { network: "isolated", features: { kaiProducer: true } };
    if (route === "dapp/create") return { sessionId: "s".repeat(24), secret: "q".repeat(43), expiresAt: f.state.now + 1800000 };
    if (route === "dapp/status") return { connected: true, address: owner };
    if (route === "dapp/disconnect") return {};
    if (route === "dapp/request-status") return { status: state.status, txid: state.txId };
    if (route === "dapp/request") { sent.push(structuredClone(body)); if (state.lost) throw Error("lost approval response"); return { requestId: "r".repeat(24), expiresAt: f.state.now + 600000 }; }
    throw Error(route);
  };
  const open = (j = f.journal) => new ProducerVault({ custody, chain, request, now: () => f.state.now,
    recovery: new VaultRecovery({ mode: "isolated-rehearsal", nonces: j.nonceCoordinator, payer: sponsor.getAddress(), maxRc: "10000000" }) });
  const vault = open(); await vault.connect(); await vault.status();
  const prepare = v => (v || vault).prepare({ action: "transfer" });
  const send = async (v = vault) => v.send({ confirm: true, draftId: (await prepare(v)).id });
  const signed = async (changes = {}) => {
    const tx = new Transaction({ options: { payer: sponsor.getAddress(), payee: owner, rcLimit: "9000000", ...changes } });
    for (const op of operations) await tx.pushOperation(op);
    await tx.prepare({ chainId: f.d.chainId, nonce: "KAE=" });
    await f.signer.signTransaction(tx.transaction); await sponsor.signTransaction(tx.transaction); return tx.transaction;
  };
  const include = async (tx, options = {}) => { await f.include(tx, options); f.state.block.receipt.transaction_receipts[0].payer = tx.header.payer; };
  return { ...f, owner, sponsor, sent, operations, stateVault: state, vault, openVault: open, prepare, send, signed, includeSponsored: include, chain, custody, vaultRequest: request };
}

test("remote approval reserves the payee before exposure and survives restart, expiry and disconnect without session secrets", async t => {
  const f = await setup(t); f.stateVault.lost = true;
  await assert.rejects(f.send(), /lost approval/); const id = f.vault.pending.nonceReservation;
  assert.equal(f.sent.length, 1); assert.equal(f.journal.nonceCoordinator.status(id).owner, f.owner);
  await assert.rejects(f.journal.begin(f.id, f.request), /owns this wallet nonce/);
  await f.vault.disconnect(); assert.equal(f.vault.hasPending(), true);
  f.state.now += 2 * 86400000; f.journal.close(); const reopened = f.open(), v = f.openVault(reopened);
  assert.equal(v.session, null); assert.equal(v.hasPending(), true);
  await assert.rejects(f.send(v), /existing/); await assert.rejects(reopened.begin(f.id, f.request), /owns this wallet nonce/);
  assert.throws(() => v.guardMutation(), /Finish or cancel/);
  for (const file of fs.readdirSync(f.dir).filter(n => n.startsWith("wallet-nonces.sqlite")))
    assert.equal(fs.readFileSync(path.join(f.dir, file)).includes(Buffer.from("q".repeat(43))), false);
  assert.equal(f.sent.length, 1);
});

test("remote recovery uses exact sponsored signatures and releases only at irreversible finality", async t => {
  const f = await setup(t); await f.send(); const id = f.vault.pending.nonceReservation, tx = await f.signed();
  // RPC JSON may order object fields differently from the local proposal.
  tx.header = Object.fromEntries(Object.entries(tx.header).reverse());
  await f.includeSponsored(tx); await f.vault.disconnect();
  assert.equal((await f.vault.recover({ reservationId: id, txId: tx.id })).pending.status, "unknown");
  assert.equal(f.vault.hasPending(), true); f.state.lib = f.state.height;
  assert.equal((await f.vault.status()).pending.status, "confirmed"); assert.equal(f.vault.hasPending(), false);
  assert.equal((await f.journal.begin(f.id, f.request)).action, "prepare_funding");
  assert.equal(f.sent.length, 1);
});

test("disconnection during nonce preparation prevents remote exposure", async t => {
  const f = await setup(t), draft = await f.prepare(); let enter, release;
  const entered = new Promise(r => { enter = r; }), gate = new Promise(r => { release = r; });
  f.provider.getNextNonce = async () => { enter(); await gate; return "KAE="; };
  const sending = f.vault.send({ confirm: true, draftId: draft.id }); await entered;
  await f.vault.disconnect(); release(); await assert.rejects(sending, /connected|stopped/);
  assert.equal(f.sent.length, 0); assert.equal(f.journal.nonceCoordinator.pending(f.owner, "vault").length, 0);
});

test("separate vault handles retain the same fence and a later transaction cannot replace its recovered envelope", async t => {
  const f = await setup(t), second = f.openVault(f.open()); await second.connect(); await second.status();
  await f.send(); assert.throws(() => second.guardMutation(), /Finish or cancel/);
  const id = f.vault.pending.nonceReservation, original = await f.signed(); await f.includeSponsored(original);
  await second.recover({ reservationId: id, txId: original.id });
  const different = await f.signed({ rcLimit: "8000000" }); await f.includeSponsored(different, { irreversible: true });
  await assert.rejects(second.recover({ reservationId: id, txId: different.id }), /replace/);
  assert.equal(f.journal.nonceCoordinator.status(id).txId, original.id); assert.equal(second.hasPending(), true);
});

test("rejected, failed and expired remote reports never release an exposed request", async t => {
  for (const status of ["rejected", "failed", "pending"]) {
    const f = await setup(t); await f.send(); f.stateVault.status = status; await f.vault.status();
    f.state.now += 31 * 60000; await f.vault.status(); assert.equal(f.vault.hasPending(), true);
    await assert.rejects(f.journal.begin(f.id, f.request), /owns this wallet nonce/);
  }
});

test("changed sponsor, nonce, operations, cost, partial or extra signatures and forks retain remote holds", async t => {
  const mutations = [
    tx => { tx.header.payer = Signer.fromSeed("other payer").getAddress(); },
    tx => { tx.header.nonce = "KAI="; }, tx => { tx.header.rc_limit = "10000001"; },
    tx => { tx.operations[0].call_contract.entry_point++; },
    tx => { tx.header.chain_id = utils.encodeBase64url(Buffer.alloc(34, 2)); },
  ];
  for (const mutate of mutations) {
    const f = await setup(t); await f.send(); const id = f.vault.pending.nonceReservation, tx = await f.signed();
    mutate(tx); tx.signatures = []; await Transaction.prepareTransaction(tx); await f.signer.signTransaction(tx); await f.sponsor.signTransaction(tx);
    await f.includeSponsored(tx, { irreversible: true });
    await assert.rejects(f.vault.recover({ reservationId: id, txId: tx.id })); assert.equal(f.vault.hasPending(), true);
  }
  for (const mutate of [tx => tx.signatures.pop(), tx => tx.signatures.push(tx.signatures[0])]) {
    const f = await setup(t); await f.send(); const id = f.vault.pending.nonceReservation, tx = await f.signed(); mutate(tx);
    await f.includeSponsored(tx, { irreversible: true }); await assert.rejects(f.vault.recover({ reservationId: id, txId: tx.id }), /signature/);
    assert.equal(f.vault.hasPending(), true);
  }
  const f = await setup(t); await f.send(); const id = f.vault.pending.nonceReservation, tx = await f.signed();
  await f.includeSponsored(tx, { irreversible: true }); f.state.fork = true;
  await f.vault.recover({ reservationId: id, txId: tx.id }); assert.equal(f.vault.hasPending(), true);
});

test("irreversible sponsored revert releases the nonce without reporting success", async t => {
  const f = await setup(t); await f.send(); const id = f.vault.pending.nonceReservation, tx = await f.signed();
  await f.includeSponsored(tx, { irreversible: true, reverted: true });
  assert.equal((await f.vault.recover({ reservationId: id, txId: tx.id })).pending.status, "reverted");
  assert.equal(f.vault.hasPending(), false);
});

test("funding blocks remote exposure and concurrent vault sends dispatch only once", async t => {
  const f = await setup(t); await f.journal.begin(f.id, f.request);
  await assert.rejects(f.send(), /owns this wallet nonce/); assert.equal(f.sent.length, 0);
  const g = await setup(t), d = await g.prepare();
  const results = await Promise.allSettled([g.vault.send({ confirm: true, draftId: d.id }), g.vault.send({ confirm: true, draftId: d.id })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(g.sent.length, 1);
});

test("isolated recovery cannot call the public wallet transport or attach to Mainnet", async t => {
  const f = await setup(t), recovery = f.vault.recovery;
  assert.throws(() => new ProducerVault({ custody: f.custody, chain: f.chain, recovery }), /fixture transport/);
  assert.throws(() => new ProducerVault({ custody: f.custody, chain: { ...f.chain, network: () => ({ id: "mainnet" }) }, recovery, request: f.vaultRequest }), /isolated fixture/);
});

test("sponsored bridge and swap builders reserve before signing and keep one immutable owner envelope", async t => {
  for (const kind of ["bridge", "swap"]) {
    const f = await setup(t), n = f.journal.nonceCoordinator; let signatures = 0;
    const original = f.signer.signTransaction.bind(f.signer); f.signer.signTransaction = async tx => { signatures++; return original(tx); };
    const options = { userSigner: f.signer, sponsorAddress: f.sponsor.getAddress(), rcLimit: "10000000", provider: f.provider, nonceCoordinator: n };
    const build = () => kind === "swap" ? buildSwapTransaction({ ...options, amountInSats: "1", amountOutMin: "1" }) : buildRedeemTransaction({ ...options,
      record: { id: "0x" + "1".repeat(64), recipient: f.owner, koinosToken: f.d.token, amount: "1", expiration: "10000000", signatures: ["0x" + "2".repeat(130)] } });
    const tx = await build(), id = hash("wallet:sponsored:" + tx.id); assert.equal(signatures, 1);
    assert.deepEqual(n.envelope(id), tx); await assert.rejects(build(), /existing sponsored/); assert.equal(signatures, 1);
    await assert.rejects(f.journal.begin(f.id, f.request), /owns this wallet nonce/);
    await f.sponsor.signTransaction(tx); await n.stage(id, tx);
    await f.includeSponsored(tx, { irreversible: true }); assert.equal((await n.reconcile(id)).state, "finalized");
  }
});
