"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { buildChannels } = require("../lib/koinos-node");
function fixture() {
  const wallet = { address: "earning-wallet", get signer() { throw new Error("Must not sign"); } };
  let network = "mainnet", mode = "external", address = "cold-producer", healthy = true;
  let balances = { koin: "123456789000", vhp: "200000000000", mana: "99999999999999" };
  let price = { usdPerKoin: 0.05, stale: false }, reads = [], priceReads = 0;
  const settings = { health: () => ({ ok: healthy }), get: (key, fallback) => ({
    "producer.mode": mode, network, ["producer.addresses." + network]: address,
  })[key] ?? fallback };
  const chain = { network: () => ({ id: network, tokenSymbol: network === "mainnet" ? "KOIN" : "tKOIN" }),
    balances: async addr => { reads.push(addr); return balances; } };
  const channels = buildChannels({ wallet, chain, settings, state: {}, nodeMgr: {}, rewards: {},
    priceCache: { snapshot() { priceReads++; return price; } } });
  return { wallet, chain, reads, summary: channels.get("producer:summary"),
    balance: value => { balances = value; }, price: value => { price = value; },
    network: value => { network = value; }, address: value => { address = value; },
    mode: value => { mode = value; }, healthy: value => { healthy = value; }, priceReads: () => priceReads };
}
test("Master sidebar values the configured producer's KOIN + VHP without mana or signing", async () => {
  const f = fixture(), value = await f.summary();
  assert.deepEqual(f.reads, ["cold-producer"]);
  assert.equal(value.koin, "1234.56789"); assert.equal(value.vhp, "2000");
  assert.ok(Math.abs(value.usd - 161.7283945) < 1e-10);
  f.mode("local"); await f.summary(); assert.equal(f.reads.at(-1), "earning-wallet");
  f.balance({ koin: "0", vhp: "0" }); assert.equal((await f.summary()).usd, 0);
});
test("unknown balances and prices never become misleading dollar amounts", async () => {
  const f = fixture();
  for (const price of [{ usdPerKoin: null }, { usdPerKoin: 0.05, stale: true }, { usdPerKoin: NaN }, { usdPerKoin: -1 }, { usdPerKoin: 0 }]) {
    f.price(price); const value = await f.summary();
    assert.equal(value.usd, null); assert.equal(value.vhp, "2000");
  }
  for (const balance of [null, { koin: "0" }, { koin: "0", vhp: "-1" }, { koin: "1.2", vhp: "0" }, { koin: "0", vhp: "0", error: "offline" }]) {
    f.balance(balance); await assert.rejects(f.summary, /balances unavailable/);
  }
  f.chain.balances = async () => { throw new Error("RPC offline"); };
  await assert.rejects(f.summary, /RPC offline/);
});
test("testnet, missing producer and unresolved custody avoid price egress", async () => {
  const f = fixture(); f.network("harbinger");
  const value = await f.summary(); assert.equal(value.usd, null); assert.equal(value.tokenSymbol, "tKOIN");
  assert.equal(f.priceReads(), 0);
  f.network("mainnet"); f.address("");
  assert.equal((await f.summary()).address, null); assert.equal(f.reads.length, 1);
  f.address("cold-producer"); f.healthy(false);
  assert.equal((await f.summary()).address, null); assert.equal(f.reads.length, 1); assert.equal(f.priceReads(), 0);
});
test("producer and network changes during a read discard the old balances", async () => {
  for (const change of [f => f.address("replacement"), f => f.network("harbinger"), f => f.mode("local")]) {
    const f = fixture();
    f.chain.balances = async () => { change(f); return { koin: "100000000", vhp: "0" }; };
    await assert.rejects(f.summary, /Producer or network changed/);
    assert.equal(f.priceReads(), 0);
  }
});
