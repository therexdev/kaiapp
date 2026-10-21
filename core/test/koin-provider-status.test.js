"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { readProviderStatus } = require("../../electron/koin-provider-status");
test("provider status needs a fresh matching server acknowledgment; older servers never imply ONLINE", async () => {
  const config = { schedulerUrl: "https://test.example", owner: "provider", model: "approved", mode: "mainnet-pilot" }, now = Date.now();
  const value = { mode: config.mode, mainnetPaymentsEnabled: true, providers: [{ address: config.owner, model: config.model, state: "online", asOf: now, validUntil: now + 15000 }] };
  const options = { config, access: { authorize: () => ({ sessionToken: "private" }) }, signal: new AbortController().signal, clock: () => now,
    fetchImpl: async (_url, init) => { assert.equal(init.headers.authorization, "Bearer private"); return Response.json(value); } };
  assert.equal((await readProviderStatus(options)).label, "ONLINE");
  value.providers[0].validUntil = now - 1; await assert.rejects(readProviderStatus(options), /stale/);
  value.providers = undefined; assert.equal((await readProviderStatus(options)).state, "checking");
  value.mode = "test-deployment"; await assert.rejects(readProviderStatus(options), /verified/);
});

test("aggregate provider readiness recognizes a ready non-default model and rejects fabricated aggregate ONLINE", async () => {
  const now = Date.now(), config = { schedulerUrl: "https://test.example", owner: "provider", model: "fast", mode: "mainnet-pilot" };
  const row = (model, state) => ({ address: config.owner, model, state, asOf: now, validUntil: now + 15000 });
  const fast = row("fast", "preparing"), smart = row("smart", "online");
  const provider = { ...smart, models: [fast, smart], readyModels: ["smart"] };
  const value = { mode: config.mode, mainnetPaymentsEnabled: true, providers: [provider] };
  const options = { config, approvedModels: ["fast", "smart"], access: { authorize: () => ({ sessionToken: "private" }) }, signal: new AbortController().signal, clock: () => now, fetchImpl: async () => Response.json(value) };
  const ready = await readProviderStatus(options);
  assert.equal(ready.label, "ONLINE"); assert.equal(ready.model, "smart"); assert.deepEqual(ready.readyModels, ["smart"]);
  assert.equal(ready.models.find(m => m.model === "fast").state, "preparing");
  provider.models = [fast, row("smart", "preparing")]; provider.readyModels = [];
  await assert.rejects(readProviderStatus(options), /inconsistent/);
  provider.models = [fast, smart]; provider.readyModels = ["smart", "fast"];
  await assert.rejects(readProviderStatus(options), /inconsistent/);
  provider.readyModels = ["smart"]; provider.models[1] = { ...smart, address: "another-provider" };
  await assert.rejects(readProviderStatus(options), /identity/);
  provider.models[1] = { ...smart, validUntil: now - 1 };
  await assert.rejects(readProviderStatus(options), /stale/);
  provider.models[1] = { ...smart, model: "private" };
  await assert.rejects(readProviderStatus(options), /identity/);
});
