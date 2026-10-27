"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { CreditService } = require("../../electron/credit-service");

test("purchase availability and recovery do not wait for model availability or chat capabilities", async () => {
  const service = new CreditService({ service: require("../lib/koin-network/credit-service.json"), dataDir: "/unused", account: {} });
  let networkReads = 0;
  service.context = async () => ({ flow: {
    models() { networkReads++; throw Error("Provider catalog offline"); },
    call() { networkReads++; throw Error("Chat capabilities offline"); },
  } });
  const saved = { state: "pending", txId: "saved-payment", recovery: "resume-cancellation" };
  service.purchases.status = async () => saved;
  service.purchases.cancelled = async () => [];
  const result = await service.purchaseInfo(AbortSignal.timeout(1000));
  assert.equal(result.activation, "ready");
  assert.deepEqual(result.localPurchase, saved);
  assert.equal(networkReads, 0);
  service.purchases.status = async () => null;
  assert.equal((await service.purchaseInfo()).localPurchase, null);
  assert.equal(networkReads, 0);
});

test("an unreadable saved payment cannot enable a new purchase", async () => {
  const service = new CreditService({ service: require("../lib/koin-network/credit-service.json"), dataDir: "/unused", account: {} });
  service.context = async () => ({});
  service.purchases.status = async () => { throw Error("Unreadable journal"); };
  service.purchases.cancelled = async () => [];
  assert.equal((await service.purchaseInfo()).localPurchase.state, "unavailable");
  service.context = async () => { throw Error("Sign in to the credit account"); };
  assert.equal((await service.purchaseInfo()).activation, "signin-required");
});


test("purchase display support uses the pinned independent market before wallet connection without account or capability reads", async () => {
  const service = new CreditService({ service: require("../lib/koin-network/credit-service.json"), dataDir: "/unused", account: { settings: { get: () => "local-first" } } });
  service.context = () => { throw Error("Display capabilities must not open an account"); };
  assert.deepEqual(await service.purchaseCapabilities(), { purchasePricePreview: true, purchasePriceSource: "market-estimate" });
  service.service.config.pricingPolicyHash = "a".repeat(64);
  assert.deepEqual(await service.purchaseCapabilities(), { purchasePricePreview: false, purchasePriceSource: "unavailable" });
});

test("fresh-wallet display estimates create no credentials, signed quotes, payment intent or account records", async () => {
  const now = Date.now(); let reads = 0, privacy = "local-first";
  const service = new CreditService({ service: require("../lib/koin-network/credit-service.json"), dataDir: "/unused", account: {
    settings: { get: () => privacy }, creditAuthorization() { throw Error("No account is needed for an estimate"); }, connectWallet() { throw Error("Display cannot connect a wallet"); } },
    marketReader: { read: async () => { reads++; return { usdPerKoinAtoms: "25000000", observedAt: now, expiresAt: now + 30000,
      anchorHash: "0x" + "a".repeat(64), referenceKind: "market-estimate", windowSeconds: 0, source: "uniswap-v4:vKOIN/USDT" }; } } });
  const quotes = service.purchases.quotes, prior = { saved: true }; quotes.quotes.set("existing", prior); quotes.intent = prior;
  for (const usd of ["1", "5"]) {
    const { estimate } = await service.run("purchase-estimate", { usd });
    assert.equal(estimate.koin, String(Number(usd) * 4)); assert.equal(estimate.priceDetails.referenceKind, "market-estimate");
    assert.equal(Object.hasOwn(estimate, "id"), false);
  }
  assert.equal(reads, 2); assert.equal(quotes.quotes.get("existing"), prior); assert.equal(quotes.quotes.size, 1); assert.equal(quotes.intent, prior);
  privacy = "local-only";
  await assert.rejects(service.purchaseCapabilities(), { code: "online-required" });
  await assert.rejects(service.run("purchase-estimate", { usd: "1" }), { code: "online-required" }); assert.equal(reads, 2);
  privacy = "local-first";
  await assert.rejects(service.run("purchase-estimate", { usd: "1" }, AbortSignal.abort())); assert.equal(reads, 2);
  const read = service.purchases.quotes.market.read;
  service.purchases.quotes.market.read = async signal => { const result = await read(signal); privacy = "local-only"; return result; };
  await assert.rejects(service.run("purchase-estimate", { usd: "1" }), { code: "online-required" });
});
