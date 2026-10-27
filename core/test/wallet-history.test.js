"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Signer, utils } = require("koilib");
const { WalletHistory, normalize } = require("../lib/koinos/wallet-history");
const { buildChannels } = require("../lib/koinos-node");
const { MAINNET_CHAIN } = require("../lib/koin-network/payment-network");
const { ChainService } = require("../lib/koinos/chain");
const account = Signer.fromSeed("wallet history owner").getAddress(), other = Signer.fromSeed("wallet history peer").getAddress();
const contracts = { koin: Signer.fromSeed("native koin").getAddress(), vhp: Signer.fromSeed("native vhp").getAddress() };
const objectId = n => "0x1220" + String(n).padStart(64, "0");
const varint = number => { let n = BigInt(number), out = []; do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; out.push(b); } while (n); return Buffer.from(out); };
const field = (n, address) => Buffer.concat([Buffer.from([n * 8 + 2, 25]), Buffer.from(utils.decodeBase58(address))]);
const transfer = (from, to, amount) => Buffer.concat([field(1, from), field(2, to), Buffer.from([24]), varint(amount)]).toString("base64url");
function entry(n = 1, options = {}) {
  const transaction = { id: objectId(n), header: { chain_id: MAINNET_CHAIN, payer: other }, operations: [] };
  const event = { source: contracts.koin, name: "token.transfer_event", data: transfer(other, account, "123456789"), sequence: 1 };
  return { seq_num: String(n), trx: { transaction, receipt: { id: transaction.id, payer: other, events: [event] } }, ...options };
}
function fixture() {
  let network = "mainnet", rpc = ["https://configured.invalid"], recent = [entry()], final = [entry()], metadataFails = false;
  const calls = [], wallet = { address: account, get signer() { throw Error("No signing allowed"); } };
  const provider = {
    getChainId: async () => MAINNET_CHAIN,
    invokeGetContractAddress: async name => ({ value: { address: contracts[name] } }),
    call: async (method, params) => { calls.push({ method, params }); return { values: structuredClone(params.irreversible ? final : recent) }; },
    getTransactionsById: async ids => { if (metadataFails) throw Error("metadata offline"); return { transactions: ids.map(id => ({ transaction: { id, header: { chain_id: MAINNET_CHAIN } }, containing_blocks: [objectId(99)] })) }; },
    getBlocksById: async () => ({ block_items: [{ block_id: objectId(99), block: { id: objectId(99), header: { height: "90", timestamp: "1000" }, transactions: recent.map(e => e.trx.transaction) } }] }),
  };
  const chain = { network: () => ({ id: network, tokenSymbol: network === "mainnet" ? "KOIN" : "tKOIN" }), rpcUrls: () => rpc, provider: () => provider };
  const history = new WalletHistory({ wallet, chain, clock: () => 100000 });
  return { wallet, chain, history, provider, calls, network: v => network = v, rpc: v => rpc = v, recent: v => recent = v, final: v => final = v, metadataFails: () => metadataFails = true };
}
test("wallet history reads only its locked wallet and configured network, with irreversible receipt evidence and bounded pagination", async () => {
  const f = fixture(); f.recent(Array.from({ length: 20 }, (_, i) => entry(100 - i))); f.final([entry(100)]);
  const r = await f.history.read();
  assert.equal(r.address, account); assert.equal(r.network, "mainnet"); assert.equal(r.rows.length, 20);
  assert.equal(r.rows[0].status, "confirmed"); assert.equal(r.rows[1].status, "confirming");
  assert.deepEqual(r.rows[0].changes, [{ asset: "KOIN", direction: "in", amount: "123456789", formatted: "1.23456789" }]);
  assert.equal(r.rows[0].timestamp, 1000); assert.equal(r.rows[0].height, "90"); assert.equal(r.rows[0].counterparty, other);
  assert.ok(r.nextCursor); assert.equal(f.calls.length, 2);
  for (const c of f.calls) { assert.equal(c.method, "account_history.get_account_history"); assert.equal(c.params.address, account); assert.equal(c.params.limit, 20); }
  await f.history.read(); assert.equal(f.calls.length, 2, "cached for fifteen seconds");
  f.recent([entry(80)]); f.final([entry(80)]); await f.history.read({ cursor: r.nextCursor });
  assert.equal(f.calls[2].params.seq_num, "80");
  await assert.rejects(f.history.read({ address: other }), /Invalid wallet history request/);
  f.wallet.address = other; await assert.rejects(f.history.read({ cursor: r.nextCursor }), /another wallet/);
});
test("confirmation needs the same receipt, failures never invent empty history or successful movements", async () => {
  const f = fixture(), changed = entry(); changed.trx.receipt.events[0].data = transfer(other, account, "1"); f.final([changed]); f.metadataFails();
  let r = await f.history.read(); assert.equal(r.rows[0].status, "confirming"); assert.equal(r.rows[0].timestamp, null); assert.equal(r.rows[0].height, null);
  const g = fixture(); g.provider.call = async () => { throw Error("history unavailable"); }; await assert.rejects(g.history.read(), /history unavailable/);
  const reverted = entry(); reverted.trx.receipt.reverted = true;
  const row = normalize(reverted, { account, contracts, chainId: MAINNET_CHAIN, tokenSymbol: "KOIN", confirmed: true });
  assert.equal(row.status, "failed"); assert.deepEqual(row.changes, []);
  const empty = fixture(); empty.provider.call = async () => ({}); assert.deepEqual((await empty.history.read()).rows, []);
});
test("native token identity, exact wire values, self transfers and receipt event duplication stay distinct", () => {
  const ctx = { account, contracts, chainId: MAINNET_CHAIN, tokenSymbol: "KOIN", confirmed: true };
  let e = entry(); e.trx.receipt.events[0].source = other; assert.equal(normalize(e, ctx), null);
  e = entry(); e.trx.receipt.events[0].name = "fake.transfer_event"; assert.equal(normalize(e, ctx), null);
  e = entry(); e.trx.receipt.events[0].source = contracts.vhp; e.trx.receipt.events.push(structuredClone(e.trx.receipt.events[0]));
  assert.deepEqual(normalize(e, ctx).changes.map(v => v.asset), ["VHP"]);
  e.trx.receipt.events[1].data = transfer(other, account, "99"); assert.throws(() => normalize(e, ctx), /Conflicting/);
  e = entry(); e.trx.receipt.events[0].data = transfer(account, account, "100"); assert.equal(normalize(e, ctx).label, "Self transfer"); assert.deepEqual(normalize(e, ctx).changes, []);
  e = entry(); e.trx.receipt.events[0].data = transfer(other, account, 1n << 64n); assert.throws(() => normalize(e, ctx), /overflow/);
  e = entry(); const data = Buffer.from(e.trx.receipt.events[0].data, "base64url"); e.trx.receipt.events[0].data = data.subarray(0, data.length - 1).toString("base64url"); assert.throws(() => normalize(e, ctx), /Truncated/);
  e = entry(); e.trx.transaction.header.chain_id = "wrong-chain"; assert.throws(() => normalize(e, ctx), /chain mismatch/);
});
test("wallet, network, RPC and chain changes discard in-flight history without caching cross-context results", async () => {
  for (const change of [f => f.wallet.address = other, f => f.network("harbinger"), f => f.rpc(["https://changed.invalid"])]) {
    const f = fixture(), call = f.provider.call; f.provider.call = async (...args) => { const r = await call(...args); change(f); return r; };
    await assert.rejects(f.history.read(), /Wallet or network changed/); assert.equal(f.history.cache.size, 0);
  }
  const f = fixture(); let n = 0; f.provider.getChainId = async () => ++n === 1 ? MAINNET_CHAIN : "wrong";
  await assert.rejects(f.history.read(), /chain changed/);
  const wrong = fixture(); wrong.provider.getChainId = async () => Buffer.alloc(34).toString("base64"); await assert.rejects(wrong.history.read(), /network mismatch/);
});
test("reviewed sends reject changed identity before password signing and across asynchronous preparation", async () => {
  let signerCalls = 0, sent = 0, net = "mainnet";
  const wallet = { address: account, signerFor() { signerCalls++; return { getAddress: () => account }; } };
  const chain = { network: () => ({ id: net }), rpcUrls: () => [], transfer: async (_signer, args) => { args.assertContext(); sent++; return { txId: objectId(1) }; } };
  const channels = buildChannels({ wallet, chain, settings: { get: (_k, d) => d }, state: {}, nodeMgr: {}, rewards: {} });
  const send = channels.get("chain:send"), args = { to: other, amount: "1", token: "koin", password: "fixture", expectedAddress: account, expectedNetwork: "mainnet" };
  await assert.rejects(send({ ...args, expectedAddress: other }), /changed/); assert.equal(signerCalls, 0);
  await assert.rejects(send({ ...args, expectedNetwork: undefined }), /changed/); assert.equal(signerCalls, 0);
  await send(args); assert.equal(sent, 1);
  const service = new ChainService({ get: (_k, d) => d });
  service.balances = async () => { net = "harbinger"; return { koin: "1000000000", mana: "1000000000" }; };
  service.provider = () => { throw Error("Must not reach transaction preparation"); };
  await assert.rejects(service.transfer({ getAddress: () => account }, { to: other, amountSat: "1", assertContext: () => { if (net !== "mainnet") throw Error("Network changed"); } }), /Network changed/);
});
test("reviewed transfer context remains fenced after preparation and reservation; late signed bytes are staged before stopping", async () => {
  for (const changedAt of ["prepare", "reserve", "sign"]) {
    let valid = true, signed = 0, staged = 0, sent = 0;
    const service = new ChainService({ get: (_k, d) => d });
    service.nonceCoordinator = { assertProvider() {}, async reserve() { if (changedAt === "reserve") valid = false; return { action: "sign_original" }; }, async stage() { staged++; }, assertReservation() {}, async reconcile() { throw Error("Must stop before reconcile"); } };
    const tx = { provider: {}, transaction: { id: objectId(55) }, async prepare() { if (changedAt === "prepare") valid = false; }, async sign() { signed++; if (changedAt === "sign") valid = false; }, async send() { sent++; } };
    await assert.rejects(service._coordinatedSend(tx, "send", () => { if (!valid) throw Error("Wallet context changed"); }), /context changed/);
    assert.equal(sent, 0); assert.equal(signed, changedAt === "sign" ? 1 : 0); assert.equal(staged, changedAt === "sign" ? 1 : 0);
  }
});
