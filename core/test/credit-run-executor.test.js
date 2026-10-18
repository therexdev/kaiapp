"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), P = require("../lib/koin-network/job-protocol"), { CreditRunExecutor } = require("../../electron/credit-run-executor");
function setup(mode, responses) {
  const calls = [], traces = [], id = P.hash("run"), c = { config: { schedulerUrl: "https://fixture.invalid/scheduler", maxOutput: 32 }, auth: {} };
  const service = { runs: { read: () => ({ id, mode, model: "fixture" }), chat: async (_c, input, signal) => {
    signal.throwIfAborted(); calls.push(input); const text = responses.shift(); if (text instanceof Error) throw text; if (text === undefined) throw Error("Unexpected model call");
    return { choices: [{ message: { content: text } }] };
  } }, progress: value => traces.push(value) };
  const core = { account: { assertCreditAuthorization() {} }, gateway: { dev: { status: () => ({ enabled: true }) }, tools: { list: () => [], call() { throw Error("No tool permission"); } } } };
  return { calls, traces, id, c, service, core, executor: new CreditRunExecutor({ service, core }) };
}
test("team planning and review use only metered subcalls with the approved output ceiling", async () => {
  const f = setup("team", ["A useful draft", "PASS"]);
  const result = await f.executor.execute(f.c, { runId: f.id, kind: "team", body: { template: "review", question: "Write a note", model: "koinos-network", allowSensitive: false } }, AbortSignal.timeout(5000));
  assert.equal(result.answer, "A useful draft"); assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(c => c.runId === f.id && c.request.max_tokens === 32 && c.request.model === "koinos-network:fixture"));
  assert.notEqual(f.calls[0].callId, f.calls[1].callId); assert.ok(f.traces.every(t => t.runId === f.id));
});
test("budget exhaustion and unauthorized custom definitions never fall back to another model route", async () => {
  const f = setup("team", [new Error("Total run budget reached")]);
  await assert.rejects(f.executor.execute(f.c, { runId: f.id, kind: "team", body: { template: "review", question: "Write", model: "koinos-network" } }, AbortSignal.timeout(5000)), /budget reached/);
  assert.equal(f.calls.length, 1);
  f.core.gateway.dev.status = () => ({ enabled: false });
  await assert.rejects(f.executor.execute(f.c, { runId: f.id, kind: "team", body: { spec: { stages: ["write"] }, question: "Write", model: "koinos-network" } }, AbortSignal.timeout(5000)), /Developer tools/);
  assert.equal(f.calls.length, 1);
});
test("group human input remains run-scoped and Stop ends a pending human turn without a model charge", async () => {
  const f = setup("agents", ["Finished TERMINATE"]), spec = { agents: [{ name: "Human", human: true }, { name: "Writer", systemPrompt: "Write" }], mode: "round_robin" };
  let ready; const inputRequested = new Promise(r => { ready = r; });
  f.service.progress = value => { f.traces.push(value); if (value.trace?.type === "input-request") ready(value.trace.inputId); };
  const running = f.executor.execute(f.c, { runId: f.id, kind: "agents", body: { spec, task: "Help", model: "koinos-network" } }, AbortSignal.timeout(5000));
  const inputId = await inputRequested;
  assert.equal(f.executor.input({ runId: P.hash("wrong"), inputId, text: "No" }).accepted, false);
  assert.equal(f.executor.input({ runId: f.id, inputId, text: "Please continue" }).accepted, true);
  await running; assert.equal(f.calls.length, 1);
  let next; const again = new Promise(r => { next = r; }); f.service.progress = v => { if (v.trace?.type === "input-request") next(); };
  const stopped = f.executor.execute(f.c, { runId: f.id, kind: "agents", body: { spec, task: "Help again", model: "koinos-network" } }, AbortSignal.timeout(5000));
  await again; f.executor.stop(f.id); await stopped;
  assert.equal(f.calls.length, 1);
});
