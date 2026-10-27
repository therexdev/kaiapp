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


test("purchase preview support prefers the advertised service and otherwise uses the pinned independent market without delaying Buy", async () => {
  const service = new CreditService({ service: require("../lib/koin-network/credit-service.json"), dataDir: "/unused", account: {} });
  let response = { capabilities: {} }, calls = 0, account = 0;
  service.context = async () => ({ config: service.service.config, auth: { accountId: String(account++) }, flow: { call: async (action, body) => {
    assert.equal(action, "capabilities"); assert.deepEqual(body, {}); calls++; return response;
  } } });
  service.purchases.status = async () => null; service.purchases.cancelled = async () => [];
  assert.deepEqual(await service.purchaseCapabilities(), { purchasePricePreview: true, purchasePriceSource: "market-estimate" });
  response = { capabilities: { purchasePricePreview: "true" } };
  assert.deepEqual(await service.purchaseCapabilities(), { purchasePricePreview: true, purchasePriceSource: "market-estimate" });
  response = { capabilities: { purchasePricePreview: true } };
  assert.deepEqual(await service.purchaseCapabilities(), { purchasePricePreview: true, purchasePriceSource: "service" });
  assert.equal((await service.purchaseInfo()).activation, "ready"); assert.equal(calls, 3, "Buy availability never waits for capability lookup");
});
