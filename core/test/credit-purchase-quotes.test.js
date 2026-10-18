"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { Signer } = require("koilib");
const { CreditPurchaseQuotes } = require("../../electron/credit-purchase-quotes");
const USD = require("../lib/koin-network/purchase-quote"), P = require("../lib/koin-network/job-protocol");
function fixture() {
  let now = 1792180000000, override;
  const signer = Signer.fromSeed("quote-fixture-verifier"), address = name => Signer.fromSeed(name).getAddress();
  const config = { owner: address("quote-fixture-buyer"), version: 1, limits: { amount: "10000000000" }, schedulerUrl: "https://fixture.invalid", deployment: {
    product: "prepaid-usd-v1", chainId: require("../lib/koin-network/payment-network").MAINNET_CHAIN, credits: address("quote-fixture-credits"), verifier: signer.getAddress(), masterNode: require("../lib/koin-network/product").MASTER_NODE } };
  const c = { config, auth: { accountId: "verified-user" }, flow: { call: async (route, body) => {
    assert.equal(route, "quote-usd"); const price = "33333333";
    const args = await USD.issue({ deployment: config.deployment, signer, account: config.owner, amount: USD.nativeForDollars(body.dollars, price), usdPerKoin: price, version: 1, now });
    return { args: override ? override(args) : args };
  } } };
  return { c, quotes: new CreditPurchaseQuotes({ clock: () => now }), advance: n => { now += n; }, override: f => { override = f; } };
}
test("private quote cache verifies USD conversion and consumes exact signed bytes once", async () => {
  const f = fixture(), { quote } = await f.quotes.preview(f.c, { usd: "1" });
  assert.equal(quote.koin, "3.00000004"); assert.equal(quote.credits, "1000"); assert.equal(quote.usd, "1");
  assert.equal(Object.hasOwn(quote, "price_signature"), false);
  const args = await f.quotes.consume(f.c, quote.id);
  assert.equal(args.amount, "300000004"); await USD.verify(f.c.config.deployment, args);
  await assert.rejects(f.quotes.consume(f.c, quote.id), /Refresh/);
});
test("quote cache rejects altered signatures, amount, account and configured limits", async () => {
  for (const mutate of [a => ({ ...a, amount: "1" }), a => ({ ...a, price_signature: "invalid" }), a => ({ ...a, account: "invalid" })]) {
    const f = fixture(); f.override(mutate); await assert.rejects(f.quotes.preview(f.c, { usd: "1" })); assert.equal(f.quotes.quotes.size, 0);
  }
  const f = fixture(); f.c.config.limits.amount = "1"; await assert.rejects(f.quotes.preview(f.c, { usd: "1" }), /limit/);
  f.c.config.owner = "account-" + P.hash("walletless"); await assert.rejects(f.quotes.preview(f.c, { usd: "1" }), /payment wallet/);
});
test("expired, replaced, stopped and changed-account quotes cannot authorize payment", async () => {
  const f = fixture(), first = await f.quotes.preview(f.c, { usd: "1" }), next = await f.quotes.preview(f.c, { usd: "2" });
  await assert.rejects(f.quotes.consume(f.c, first.quote.id), /Refresh/);
  f.advance(300001); await assert.rejects(f.quotes.consume(f.c, next.quote.id), /expired/);
  const third = await f.quotes.preview(f.c, { usd: "1" }); f.c.auth.accountId = "different-account";
  await assert.rejects(f.quotes.consume(f.c, third.quote.id), /Refresh/);
  const fourth = await f.quotes.preview(f.c, { usd: "1" });
  await assert.rejects(f.quotes.consume(f.c, fourth.quote.id, AbortSignal.abort()));
  await assert.rejects(f.quotes.consume(f.c, fourth.quote.id), /Refresh/);
  const fifth = await f.quotes.preview(f.c, { usd: "1" }); f.quotes.clear(); await assert.rejects(f.quotes.consume(f.c, fifth.quote.id), /Refresh/);
});
