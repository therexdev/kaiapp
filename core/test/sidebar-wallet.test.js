"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildChannels } = require("../lib/koinos-node");

function fixture() {
  const wallet = { address: "earning-wallet", get signer() { throw new Error("Must not sign"); } };
  let network = "mainnet", balance = "123456789000", reads = [], priceReads = 0;
  let price = { usdPerKoin: 0.05, stale: false };
  const chain = { network: () => ({ id: network, tokenSymbol: network === "mainnet" ? "KOIN" : "tKOIN" }),
    balances: async address => { reads.push(address); return { koin: balance, vhp: "90000000000000", mana: "90000000000000" }; } };
  const channels = buildChannels({ wallet, chain, settings: { get: (key, fallback) => key === "producer.mode" ? "external" : fallback },
    state: {}, nodeMgr: {}, rewards: {}, priceCache: { snapshot() { priceReads++; return price; } } });
  return { wallet, chain, summary: channels.get("wallet:summary"), reads,
    network: value => { network = value; }, balance: value => { balance = value; },
    price: value => { price = value; }, priceReads: () => priceReads };
}
test("sidebar values only liquid KOIN in the earning wallet, without a signer or node", async () => {
  const f = fixture(), value = await f.summary();
  assert.deepEqual(f.reads, ["earning-wallet"]);
  assert.equal(value.koin, "1234.56789");
  assert.ok(Math.abs(value.usd - 61.7283945) < 1e-10);
  f.balance("0"); assert.equal((await f.summary()).usd, 0);
  f.wallet.address = null;
  const before = f.priceReads();
  assert.equal((await f.summary()).koin, null);
  assert.equal(f.priceReads(), before, "no price fetch without a wallet");
});
test("missing, stale and testnet prices never produce a false dollar value", async () => {
  const f = fixture();
  for (const price of [{ usdPerKoin: null }, { usdPerKoin: 0.05, stale: true }, { usdPerKoin: NaN }]) {
    f.price(price); const value = await f.summary();
    assert.equal(value.usd, null); assert.equal(value.koin, "1234.56789");
  }
  f.price({ usdPerKoin: 0.05 }); f.network("harbinger");
  const before = f.priceReads(), value = await f.summary();
  assert.equal(value.usd, null); assert.equal(value.tokenSymbol, "tKOIN");
  assert.equal(f.priceReads(), before, "testnet never queries a dollar price");
  f.chain.balances = async () => { throw new Error("RPC offline"); };
  await assert.rejects(f.summary, /RPC offline/);
});
test("wallet changes during a read discard the old account's balance", async () => {
  const f = fixture();
  f.chain.balances = async () => { f.wallet.address = "replacement"; return { koin: "100000000" }; };
  await assert.rejects(f.summary, /Wallet or network changed/);
});
