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
