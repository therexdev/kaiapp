"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { GroupChatRunner, GroupDefs, normalizeGroupSpec } = require("../lib/groupchat");
const { ToolRegistry } = require("../lib/tools");

/*
 * Multi-agent group chats (task #64). The model is SCRIPTED, so every
 * decision is pinned: turn order per mode, each termination condition, the
 * absolute ceiling, tools inside a turn, the consent gate, and the
 * human-in-the-loop pause/resume/timeout/stop paths.
 */

function scripted(responses) {
  const queue = [...responses];
  const fn = async () => {
    if (!queue.length) throw new Error("script exhausted — the runner asked more than the test expected");
    return queue.shift();
  };
  fn.left = () => queue.length;
  return fn;
}

const A = (name, extra = {}) => ({ name, systemPrompt: `You are ${name}.`, ...extra });

test("normalizeGroupSpec: every validation rule fires with its own message", () => {
  assert.throws(() => normalizeGroupSpec({ agents: [A("Solo")] }), /at least 2 agents/);
  assert.throws(() => normalizeGroupSpec({ agents: Array.from({ length: 9 }, (_, i) => A(`a${i}`)) }), /at most 8/);
  assert.throws(() => normalizeGroupSpec({ agents: [A("1bad"), A("Ok")] }), /needs a name/);
  assert.throws(() => normalizeGroupSpec({ agents: [A("Twin"), A("twin")] }), /duplicate agent name/);
  assert.throws(() => normalizeGroupSpec({ agents: [A("Hu", { human: true, tools: ["x"] }), A("Bot")] }), /cannot hold tools/);
  assert.throws(() => normalizeGroupSpec({ agents: [A("Hu", { human: true }), A("Man", { human: true })] }), /at least one agent must be a model/);
  assert.throws(() => normalizeGroupSpec({ agents: [A("Al"), A("Bo")], mode: "chaos" }), /unknown mode/);
  assert.throws(() => normalizeGroupSpec({ agents: [A("Al", { tools: ["laser"] }), A("Bo")] }, ["web_search"]), /unknown tool "laser"/);
  const s = normalizeGroupSpec({
    agents: [A("Al"), A("Bo")],
    termination: { maxMessages: 9999, maxModelCalls: 9999, textMention: "DONE" },
    maxToolActionsPerTurn: 99,
  });
  assert.strictEqual(s.termination.maxMessages, 60, "message ceiling holds");
  assert.strictEqual(s.termination.maxModelCalls, 120, "call ceiling holds");
  assert.strictEqual(s.maxToolActionsPerTurn, 6, "per-turn tool ceiling holds");
  assert.strictEqual(s.termination.textMention, "DONE");
  assert.strictEqual(normalizeGroupSpec({ agents: [A("Al"), A("Bo")] }).termination.textMention, "TERMINATE", "the default termination phrase");
  assert.strictEqual(normalizeGroupSpec({ agents: [A("Al"), A("Bo")], termination: { textMention: "" } }).termination.textMention, null, "explicitly disabled");
});

test("round_robin: agents speak in order, the message limit ends it", async () => {
  const chatFn = scripted(["m1", "m2", "m3", "m4"]);
  const r = await new GroupChatRunner({ chatFn }).run({
    spec: { agents: [A("Alice"), A("Bob")], termination: { maxMessages: 4, textMention: "" } },
    task: "discuss",
    model: "m",
  });
  assert.deepStrictEqual(r.transcript.map((m) => m.name), ["task", "Alice", "Bob", "Alice", "Bob"]);
  assert.strictEqual(r.reason, "message limit reached");
  assert.strictEqual(r.modelCalls, 4);
});

test("textMention: the phrase ends the conversation the moment it lands", async () => {
  const chatFn = scripted(["thinking…", "all set. TERMINATE"]);
  const r = await new GroupChatRunner({ chatFn }).run({
    spec: { agents: [A("Alice"), A("Bob")] },
    task: "finish fast",
    model: "m",
  });
  assert.strictEqual(r.transcript.length, 3, "task + 2 turns");
  assert.match(r.reason, /"TERMINATE" spoken/);
});

test("selector: the moderator's pick speaks; garbage degrades to round-robin, never a crash", async () => {
  const chatFn = scripted([
    "opening", // Alice (first turn is round-robin — nothing to moderate yet)
    "Bob", // selector pick
    "bob speaks", // Bob
    "nobody-here-matches", // selector garbage
    "fallback speaks", // round-robin fallback
  ]);
  const r = await new GroupChatRunner({ chatFn }).run({
    spec: { agents: [A("Alice"), A("Bob")], mode: "selector", termination: { maxMessages: 3, textMention: "" } },
    task: "q",
    model: "m",
  });
  assert.deepStrictEqual(r.transcript.map((m) => m.name).slice(1), ["Alice", "Bob", "Alice"], "pick honored, then garbage falls back to the round-robin cursor");
  assert.strictEqual(r.modelCalls, 5, "selector calls count against the ceiling");
});

test("handoff: the speaker keeps the floor until it hands off by name; the marker never leaks", async () => {
  const chatFn = scripted(["digging in HANDOFF: Bob", "bob turn one", "bob turn two"]);
  const r = await new GroupChatRunner({ chatFn }).run({
    spec: { agents: [A("Alice"), A("Bob")], mode: "handoff", termination: { maxMessages: 3, textMention: "" } },
    task: "q",
    model: "m",
  });
  assert.deepStrictEqual(r.transcript.map((m) => m.name).slice(1), ["Alice", "Bob", "Bob"]);
  assert.strictEqual(r.transcript[1].content, "digging in", "the HANDOFF marker is stripped");
});

test("the absolute model-call ceiling stops a chatty group mid-flight", async () => {
  const chatFn = async () => "more words";
  const r = await new GroupChatRunner({ chatFn }).run({
    spec: { agents: [A("Alice"), A("Bob")], termination: { maxModelCalls: 3, maxMessages: 60, textMention: "" } },
    task: "never stop",
    model: "m",
  });
  assert.strictEqual(r.modelCalls, 3);
  assert.strictEqual(r.reason, "model-call ceiling reached");
});

test("tools inside a turn: the same grammar, the same registry, the trace shows the call", async () => {
  const registry = new ToolRegistry({ privacyMode: () => "network" });
  let ran = 0;
  registry.register({
    name: "web_search",
    description: "s",
    params: { query: "q" },
    egress: true,
    sensitive: false,
    handler: ({ query }) => {
      ran += 1;
      return `RESULT(${query})`;
    },
  });
  const chatFn = scripted([
    '{"tool": "web_search", "args": {"query": "koinos"}}',
    '{"answer": true}',
    "here is what I found", // the spoken message
    "noted. TERMINATE", // Bob closes
  ]);
  const traces = [];
  const r = await new GroupChatRunner({ chatFn, registry }).run({
    spec: { agents: [A("Scout", { tools: ["web_search"] }), A("Bob")] },
    task: "look something up",
    model: "m",
    onTrace: (e) => traces.push(e),
  });
  assert.strictEqual(ran, 1, "the tool really ran");
  assert.strictEqual(r.transcript[1].content, "here is what I found");
  assert.ok(traces.some((e) => e.type === "tool" && /web_search -> RESULT\(koinos\)/.test(e.detail)));
});

test("sensitive tools: refused without upfront consent — the same law as teams", async () => {
  const registry = new ToolRegistry({ privacyMode: () => "local-only" });
  let ran = 0;
  registry.register({
    name: "run_code",
    description: "r",
    params: { code: "js" },
    egress: false,
    sensitive: true,
    handler: () => {
      ran += 1;
      return "42";
    },
  });
  const chatFn = scripted(['{"tool": "run_code", "args": {"code": "6*7"}}', "could not run it TERMINATE"]);
  await new GroupChatRunner({ chatFn, registry }).run({
    spec: { agents: [A("Coder", { tools: ["run_code"] }), A("Bob")] },
    task: "compute",
    model: "m",
    allowSensitive: false,
  });
  assert.strictEqual(ran, 0, "no consent -> the code NEVER ran");
});

test("human in the loop: the run pauses, provideInput resumes it, the answer joins the transcript", async () => {
  const chatFn = scripted(["thanks for the detail. TERMINATE"]);
  const runner = new GroupChatRunner({ chatFn });
  let request = null;
  const done = runner.run({
    spec: { agents: [A("Ana", { human: true }), A("Bot")] },
    task: "ask the person first",
    model: "m",
    onTrace: (e) => {
      if (e.type === "input-request") request = e;
    },
  });
  // Wait for the pause, answer it, then the model closes.
  await new Promise((res) => {
    const t = setInterval(() => {
      if (request) {
        clearInterval(t);
        res();
      }
    }, 5);
  });
  assert.strictEqual(request.name, "Ana");
  assert.strictEqual(runner.provideInput(request.inputId, "here are the details"), true);
  assert.strictEqual(runner.provideInput(request.inputId, "again"), false, "an input answers exactly once");
  const r = await done;
  assert.deepStrictEqual(r.transcript.map((m) => m.name), ["task", "Ana", "Bot"]);
  assert.strictEqual(r.transcript[1].content, "here are the details");
});

test("human in the loop: no answer ends the run honestly at the timeout", async () => {
  const runner = new GroupChatRunner({ chatFn: scripted([]) });
  const r = await runner.run({
    spec: { agents: [A("Ana", { human: true }), A("Bot")], inputTimeoutMs: 40 },
    task: "q",
    model: "m",
  });
  assert.match(r.reason, /no reply from Ana — input timed out/);
  assert.strictEqual(r.modelCalls, 0, "no model call was wasted waiting");
});

test("stop(): a run blocked on a person unblocks immediately as stopped", async () => {
  const runner = new GroupChatRunner({ chatFn: scripted([]) });
  let request = null;
  const done = runner.run({
    spec: { agents: [A("Ana", { human: true }), A("Bot")] },
    task: "q",
    model: "m",
    onTrace: (e) => {
      if (e.type === "input-request") request = e;
    },
  });
  await new Promise((res) => {
    const t = setInterval(() => {
      if (request) {
        clearInterval(t);
        res();
      }
    }, 5);
  });
  assert.strictEqual(runner.stop(request.runId), true);
  const r = await done;
  assert.strictEqual(r.reason, "stopped");
});

test("GroupDefs: saves validate, ids assign and upsert, remove removes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-defs-"));
  const defs = new GroupDefs(path.join(dir, "agent-teams.json"));
  assert.throws(() => defs.save({ spec: { agents: [A("Solo")] } }), /at least 2 agents/, "an unrunnable spec never lands in the store");
  const saved = defs.save({ spec: { label: "duo", agents: [A("Al"), A("Bo")] } });
  assert.ok(saved.id.length >= 6);
  assert.strictEqual(defs.list().length, 1);
  const again = defs.save({ id: saved.id, spec: { label: "duo v2", agents: [A("Al"), A("Bo")] } });
  assert.strictEqual(again.id, saved.id);
  assert.strictEqual(defs.list().length, 1, "same id upserts");
  assert.strictEqual(defs.list()[0].label, "duo v2");
  assert.strictEqual(defs.remove(saved.id), true);
  assert.strictEqual(defs.remove(saved.id), false);
  assert.strictEqual(defs.list().length, 0);
});
