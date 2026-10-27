"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { readProviderStatus } = require("../../electron/koin-provider-status");
test("runtime readiness is a distinct two-check observation, never a quality score or raw evidence", async () => {
  const now = Date.now(), config = { schedulerUrl: "https://test.example", owner: "provider", model: "fast", mode: "mainnet-pilot" };
  const q = { kind: "runtime-readiness", readinessVersion: 1, state: "failed", passed: 1, completed: 2, total: 2, required: 2, retryAt: now + 300000,
    failure: { code: "response", wrongAnswers: 1, deadlines: 0, unknown: 0 }, nonce: "private check nonce", output: "private output" };
  const row = { address: config.owner, model: config.model, state: "qualification-failed", asOf: now, validUntil: now + 15000, qualification: q };
  const value = { mode: config.mode, mainnetPaymentsEnabled: true, providers: [row] };
  const options = { config, access: { authorize: () => ({ sessionToken: "private" }) }, signal: new AbortController().signal, clock: () => now, fetchImpl: async () => Response.json(value) };
  const status = await readProviderStatus(options);
  assert.equal(status.qualification.kind, "runtime-readiness"); assert.equal(status.state, "qualification-failed");
  assert.deepEqual(status.qualification.failure, q.failure); assert.equal(JSON.stringify(status).includes("private"), false);
  assert.equal(status.qualification.readinessVersion, 1);
  for (const patch of [{ kind: "quality-passed" }, { readinessVersion: undefined }, { readinessVersion: 2 }, { total: 12 }, { required: 1 }, { failure: { ...q.failure, code: "quality" } }]) {
    row.qualification = { ...q, ...patch }; await assert.rejects(readProviderStatus(options), /readiness|qualification/);
  }
  row.qualification = { ...q }; delete row.qualification.kind;
  await assert.rejects(readProviderStatus(options), /qualification/, "readiness-specific failures need the explicit versioned mode");
});
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

test("network qualification progress survives both status mappings without copying evidence or implying ONLINE", async () => {
  const now = Date.now(), config = { schedulerUrl: "https://test.example", owner: "provider", model: "smart", mode: "mainnet-pilot" };
  const qualification = { state: "failed", passed: 0, completed: 12, total: 12, retryAt: now + 300000, evidence: "private fixture evidence" };
  const row = { address: config.owner, model: config.model, state: "qualification-failed", detail: "Quality or latency failed", asOf: now, validUntil: now + 15000, qualification };
  const value = { mode: config.mode, mainnetPaymentsEnabled: true, providers: [{ ...row, models: [row], readyModels: [] }] };
  const options = { config, access: { authorize: () => ({ sessionToken: "private" }) }, signal: new AbortController().signal, clock: () => now, fetchImpl: async () => Response.json(value) };
  let status = await readProviderStatus(options);
  assert.equal(status.label, "NETWORK CHECK FAILED"); assert.equal(status.state, "qualification-failed");
  const expected = { state: "failed", passed: 0, completed: 12, total: 12, retryAt: now + 300000 };
  assert.deepEqual(status.qualification, expected); assert.deepEqual(status.models[0].qualification, expected);
  assert.match(status.detail, /automatically/); assert.doesNotMatch(status.detail, /quality|latency/i);
  assert.equal(JSON.stringify(status).includes("private"), false);
  delete value.providers[0].qualification; delete row.qualification;
  status = await readProviderStatus(options);
  assert.equal(status.label, "NETWORK CHECK FAILED"); assert.equal(status.qualification, undefined, "older servers may omit progress");
});

test("network qualification rejects malformed, inconsistent and overflowing progress and stale observations", async () => {
  const now = Date.now(), config = { schedulerUrl: "https://test.example", owner: "provider", model: "smart", mode: "mainnet-pilot" };
  const good = { state: "failed", passed: 0, completed: 12, total: 12, retryAt: now + 300000 };
  const row = { address: config.owner, model: config.model, state: "qualification-failed", asOf: now, validUntil: now + 15000, qualification: good };
  const value = { mode: config.mode, mainnetPaymentsEnabled: true, providers: [row] };
  const options = { config, access: { authorize: () => ({ sessionToken: "private" }) }, signal: new AbortController().signal, clock: () => now, fetchImpl: async () => Response.json(value) };
  for (const bad of [null, { passed: -1 }, { passed: 13 }, { completed: 13 }, { completed: "12" }, { total: 0 }, { total: 33 },
    { total: Number.MAX_SAFE_INTEGER + 1 }, { retryAt: Number.MAX_SAFE_INTEGER + 1 }, { retryAt: now + 86400001 }, { retryAt: -1 }, { state: "qualified" }]) {
    row.qualification = bad === null ? null : { ...good, ...bad };
    await assert.rejects(readProviderStatus(options), /qualification progress/);
  }
  row.qualification = good; row.validUntil = now;
  await assert.rejects(readProviderStatus(options), /stale/);
  row.validUntil = now + 15000; row.state = "qualifying";
  await assert.rejects(readProviderStatus(options), /qualification progress/);
  row.qualification = { state: "testing", passed: 3, completed: 4, total: 12, retryAt: null };
  assert.deepEqual((await readProviderStatus(options)).qualification, row.qualification);
});

test("qualification failure reasons and required scores are bounded, truthful, and never carry answer content", async () => {
  const now = Date.now(), config = { schedulerUrl: "https://test.example", owner: "provider", model: "fast", mode: "mainnet-pilot" };
  const good = { state: "failed", passed: 10, completed: 12, total: 12, required: 12, retryAt: now + 300000,
    failure: { code: "quality", wrongAnswers: 2, deadlines: 0, unknown: 0, output: "private answer" }, prompt: "private prompt" };
  const row = { address: config.owner, model: config.model, state: "qualification-failed", asOf: now, validUntil: now + 15000, qualification: good };
  const value = { mode: config.mode, mainnetPaymentsEnabled: true, providers: [row] };
  const options = { config, access: { authorize: () => ({ sessionToken: "private" }) }, signal: new AbortController().signal, clock: () => now, fetchImpl: async () => Response.json(value) };
  const status = await readProviderStatus(options);
  assert.equal(status.state, "qualification-failed"); assert.equal(status.qualification.required, 12);
  assert.deepEqual(status.qualification.failure, { code: "quality", wrongAnswers: 2, deadlines: 0, unknown: 0 });
  assert.equal(JSON.stringify(status).includes("private"), false);
  for (const patch of [{ required: 0 }, { required: 13 }, { required: "12" }, { phase: "answering" },
    { failure: null }, { failure: { code: "untrusted" } }, { failure: { code: "quality", wrongAnswers: 1, deadlines: 0, unknown: 0 } },
    { failure: { code: "quality", wrongAnswers: 0, deadlines: 2, unknown: 0 } }, { failure: { code: "deadline", wrongAnswers: 2, deadlines: 0, unknown: 0 } },
    { failure: { code: "quality_and_deadline", wrongAnswers: 2, deadlines: 0, unknown: 0 } }, { failure: { code: "unknown", wrongAnswers: -1, deadlines: 3, unknown: 0 } },
    { failure: { code: "preparation_timeout", wrongAnswers: 2, deadlines: 0, unknown: 0 } }]) {
    row.qualification = { ...good, ...patch }; await assert.rejects(readProviderStatus(options), /qualification/);
  }
  for (const code of ["preparation_timeout", "unknown"]) {
    row.qualification = { ...good, passed: 3, completed: 3, failure: { code, wrongAnswers: 0, deadlines: 0, unknown: 0 } };
    assert.equal((await readProviderStatus(options)).qualification.failure.code, code, "partial completed answers may all pass before preparation fails");
  }
  row.state = "qualifying"; row.qualification = { state: "testing", passed: 3, completed: 3, total: 12, required: 12, phase: "preparing", retryAt: null };
  assert.equal((await readProviderStatus(options)).qualification.phase, "preparing");
});
