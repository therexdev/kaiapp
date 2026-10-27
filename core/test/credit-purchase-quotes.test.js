"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { Signer } = require("koilib");
const { CreditPurchaseQuotes } = require("../../electron/credit-purchase-quotes");
const USD = require("../lib/koin-network/purchase-quote"), P = require("../lib/koin-network/job-protocol");
const Prices = require("./helpers/purchase-price-fixture");
function fixture() {
  let now = 1792180000000, override, alterResponse;
  const signer = Signer.fromSeed("quote-fixture-verifier"), address = name => Signer.fromSeed(name).getAddress();
  const config = { owner: address("quote-fixture-buyer"), version: 1, pricingPolicyHash: Prices.pricingPolicyHash, limits: { amount: "10000000000" }, schedulerUrl: "https://fixture.invalid", deployment: {
    product: "prepaid-usd-v1", chainId: require("../lib/koin-network/payment-network").MAINNET_CHAIN, credits: address("quote-fixture-credits"), verifier: signer.getAddress(), masterNode: require("../lib/koin-network/product").MASTER_NODE } };
  const c = { config, auth: { accountId: "verified-user" }, flow: { call: async (route, body) => {
    assert.equal(route, "quote-usd"); const price = "33333333";
    const result = await Prices.issue({ deployment: config.deployment, signer, account: config.owner, amount: USD.nativeForDollars(body.dollars, price), usdPerKoin: price, version: 1, now });
    if (override) result.args = override(result.args);
    return alterResponse ? alterResponse(result) : result;
  } } };
  return { c, quotes: new CreditPurchaseQuotes({ clock: () => now }), advance: n => { now += n; }, override: f => { override = f; }, alter: f => { alterResponse = f; } };
}
test("private quote cache verifies USD conversion and consumes exact signed bytes once", async () => {
  const f = fixture(), { quote } = await f.quotes.preview(f.c, { usd: "1" });
  assert.equal(quote.koin, "3.00000004"); assert.equal(quote.credits, "1000"); assert.equal(quote.usd, "1");
  assert.equal(quote.observedAt, 1792180000000 - 17 * 60000, "show the exchange observation, not the later signing time");
  assert.deepEqual(quote.priceDetails, { usdPerKoin: "0.33333333", windowSeconds: 1800, referenceKind: "merchant-exchange-reference" });
  assert.equal(Object.hasOwn(quote, "price_signature"), false);
  const args = await f.quotes.consume(f.c, quote.id);
  assert.equal(args.amount, "300000004"); await USD.verify(f.c.config.deployment, args);
  await assert.rejects(f.quotes.consume(f.c, quote.id), /Refresh/);
});
test("purchase review requires signed evidence, exact market details and the configured pricing policy", async () => {
  for (const mutate of [
    r => { delete r.priceDetails; },
    r => { r.priceDetails.summary.usdPerKoinAtoms = "40000000"; },
    r => { r.priceDetails.summary.marketObservedAt++; },
    r => { r.priceDetails.summary.referenceKind = "signed-parity"; },
    r => { r.priceDetails.evidenceHash = P.hash("different-evidence"); },
    r => { r.priceDetails.summary.market.protocol = "uniswap-v3"; },
  ]) {
    const f = fixture(); f.alter(r => { mutate(r); return r; });
    await assert.rejects(f.quotes.preview(f.c, { usd: "1" })); assert.equal(f.quotes.quotes.size, 0);
  }
  const wrongPin = fixture(); wrongPin.c.config.pricingPolicyHash = P.hash("another-policy");
  await assert.rejects(wrongPin.quotes.preview(wrongPin.c, { usd: "1" }), /details do not match/);
  const noPin = fixture(); delete noPin.c.config.pricingPolicyHash;
  noPin.c.flow.call = () => { throw Error("must not request a quote without a pin"); };
  await assert.rejects(noPin.quotes.preview(noPin.c, { usd: "1" }), /approved pricing configuration/);
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
test("a lost quote response reuses its intent while a subsequent same-amount purchase gets a new intent", async () => {
  const f = fixture(), call = f.c.flow.call, ids = []; let fail = true;
  f.c.flow.call = async (route, body) => {
    assert.match(body.intentId, /^[0-9a-f]{64}$/); ids.push(body.intentId);
    const result = await call(route, body);
    if (fail) { fail = false; throw Error("Response lost"); }
    return result;
  };
  await assert.rejects(f.quotes.preview(f.c, { usd: "1" }), /Response lost/);
  const retry = await f.quotes.preview(f.c, { usd: "1" });
  assert.equal(ids[0], ids[1]); await f.quotes.consume(f.c, retry.quote.id);
  await f.quotes.preview(f.c, { usd: "1" }); assert.notEqual(ids[1], ids[2]);
});

test("read-only purchase estimates calculate exact rounding without issuing or replacing a signed quote", async () => {
  const f = fixture(), signed = await f.quotes.preview(f.c, { usd: "1" });
  const cached = f.quotes.quotes.get(signed.quote.id), intent = f.quotes.intent;
  const price = structuredClone(cached.provenance.summary), calls = [];
  f.c.flow.call = async (action, body) => { calls.push({ action, body }); return { price }; };
  for (const usd of ["1", "5", "10", "1.23"]) {
    const { estimate } = await f.quotes.estimate(f.c, { usd });
    assert.equal(estimate.koin, USD.dollars(USD.nativeForDollars(usd, price.usdPerKoinAtoms)));
    assert.equal(Object.hasOwn(estimate, "id"), false);
  }
  assert.deepEqual(calls, Array.from({ length: 4 }, () => ({ action: "purchase-price", body: {} })));
  assert.equal(f.quotes.intent, intent); assert.equal(f.quotes.quotes.size, 1);
  assert.equal(f.quotes.quotes.get(signed.quote.id), cached);
  await f.quotes.consume(f.c, signed.quote.id);
});

test("purchase estimates reject stale, mismatched or excessive pricing and never fall back to signed issuance", async () => {
  for (const mutate of [
    p => { p.expiresAt = 1792180000000; },
    p => { p.marketObservedAt = 1792180006000; },
    p => { p.pricingPolicyHash = P.hash("wrong policy"); },
    p => { p.market.poolId = "0x" + "0".repeat(64); },
    p => { p.maxPurchaseUsdAtoms = "1"; },
    p => { p.maxPurchaseKoinAtoms = "1"; },
  ]) {
    const f = fixture(), { quote } = await f.quotes.preview(f.c, { usd: "1" });
    const price = structuredClone(f.quotes.quotes.get(quote.id).provenance.summary); mutate(price);
    f.quotes.clear(); let calls = 0;
    f.c.flow.call = async (action, body) => { assert.equal(action, "purchase-price"); assert.deepEqual(body, {}); calls++; return { price }; };
    await assert.rejects(f.quotes.estimate(f.c, { usd: "1" }));
    assert.equal(calls, 1); assert.equal(f.quotes.quotes.size, 0); assert.equal(f.quotes.intent, null);
  }
  const f = fixture(); f.c.flow.call = async action => { assert.equal(action, "purchase-price"); throw Error("Not found"); };
  await assert.rejects(f.quotes.estimate(f.c, { usd: "1" }), /Not found/);
  await assert.rejects(f.quotes.estimate(f.c, { usd: "1", quote: "replace" }), /Select/);
  await assert.rejects(f.quotes.estimate(f.c, { usd: "1.234" }), /decimal/);
  assert.equal(f.quotes.quotes.size, 0);
});
