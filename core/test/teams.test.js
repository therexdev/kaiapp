"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const { TeamRunner } = require("../lib/teams");
const { ToolRegistry } = require("../lib/tools");

/*
 * AI Teams (task #58 phase A). The model is SCRIPTED — chatFn shifts from a
 * queue — so every pipeline decision (revise vs pass, plan fan-out, tool
 * actions, budgets, the sensitive gate) is pinned deterministically.
 */

function scripted(responses) {
  const queue = [...responses];
  const calls = [];
  const fn = async ({ messages }) => {
    calls.push(messages);
    if (!queue.length) throw new Error("script exhausted — the runner asked more than the test expected");
    return queue.shift();
  };
  fn.calls = calls;
  return fn;
}

test("review team: draft -> critique with issues -> revised answer", async () => {
  const chatFn = scripted(["the draft", "too vague, name the mechanism", "the revised answer"]);
  const runner = new TeamRunner({ chatFn });
  const r = await runner.run({ template: "review", question: "explain X", model: "m" });
  assert.strictEqual(r.answer, "the revised answer");
  assert.strictEqual(r.modelCalls, 3);
  const stages = r.trace.filter((t) => t.type === "model").map((t) => t.stage);
  assert.deepStrictEqual(stages, ["writer", "critic", "reviser"]);
  assert.ok(r.trace.some((t) => t.detail === "revision requested"));
});

test("review team: a PASS from the critic ships the draft untouched", async () => {
  const chatFn = scripted(["the draft", "PASS"]);
  const r = await new TeamRunner({ chatFn }).run({ template: "review", question: "explain X", model: "m" });
  assert.strictEqual(r.answer, "the draft");
  assert.strictEqual(r.modelCalls, 2, "no reviser call happened");
});

test("research team: plan fans out, workers use tools, notes reach the writer", async () => {
  const registry = new ToolRegistry({ privacyMode: () => "network" });
  const searched = [];
  registry.register({
    name: "web_search",
    description: "search",
    params: { query: "q" },
    egress: true,
    sensitive: false,
    handler: ({ query }) => {
      searched.push(query);
      return `RESULT(${query})`;
    },
  });
  const chatFn = scripted([
    "1. history of X\n2. price of X", // planner
    '{"tool": "web_search", "args": {"query": "history of X"}}', // worker1 action
    '{"answer": true}', // worker1 done
    "NOTE-ONE", // worker1 summary
    '{"tool": "web_search", "args": {"query": "price of X"}}', // worker2 action
    '{"answer": true}',
    "NOTE-TWO",
    "the synthesis", // writer
    "PASS", // critic
  ]);
  const r = await new TeamRunner({ chatFn, registry }).run({ template: "research", question: "tell me about X", model: "m" });
  assert.strictEqual(r.answer, "the synthesis");
  assert.deepStrictEqual(searched, ["history of X", "price of X"], "each sub-task drove its own real tool call");
  // The writer's user message carried both workers' notes.
  const writerMsgs = chatFn.calls[7];
  assert.match(writerMsgs[1].content, /NOTE-ONE/);
  assert.match(writerMsgs[1].content, /NOTE-TWO/);
  // Tool observations are in the trace for the UI to render.
  assert.ok(r.trace.some((t) => t.type === "tool" && /web_search -> RESULT/.test(t.detail)));
});

test("sensitive tools: refused without upfront consent, run with it — same script", async () => {
  const makeRegistry = () => {
    const reg = new ToolRegistry({ privacyMode: () => "local-only" });
    let ran = 0;
    reg.register({
      name: "run_code",
      description: "run code",
      params: { code: "js" },
      egress: false,
      sensitive: true,
      handler: () => {
        ran += 1;
        return "42";
      },
    });
    return { reg, ranCount: () => ran };
  };
  const script = () => [
    "1. compute the answer", // planner
    '{"tool": "run_code", "args": {"code": "6*7"}}', // worker action
    '{"answer": true}',
    "the summary", // worker summary
    "the report", // writer
  ];

  const denied = makeRegistry();
  const r1 = await new TeamRunner({ chatFn: scripted(script()), registry: denied.reg }).run({
    template: "analyst",
    question: "what is 6*7",
    model: "m",
    allowSensitive: false,
  });
  assert.strictEqual(denied.ranCount(), 0, "no consent -> the code NEVER ran");
  assert.ok(
    r1.trace.some((t) => t.type === "tool" && /needs your confirmation/.test(t.detail)),
    "the refusal is visible in the trace as an observation"
  );

  const granted = makeRegistry();
  await new TeamRunner({ chatFn: scripted(script()), registry: granted.reg }).run({
    template: "analyst",
    question: "what is 6*7",
    model: "m",
    allowSensitive: true,
  });
  assert.strictEqual(granted.ranCount(), 1, "upfront consent -> the tool executed");
});

test("budgets: a worker that never stops is cut off at the action cap", async () => {
  const registry = new ToolRegistry({ privacyMode: () => "network" });
  let toolCalls = 0;
  registry.register({
    name: "web_search",
    description: "s",
    params: {},
    egress: true,
    sensitive: false,
    handler: () => {
      toolCalls += 1;
      return "more";
    },
  });
  // Planner gives one task; the worker replies with a tool action FOREVER.
  const always = async ({ messages }) => {
    if (messages[0].content.includes("planner of a small team")) return "1. dig";
    if (messages[0].content.includes("Summarize")) return "note";
    if (messages[0].content.includes("final answer")) return "done";
    if (messages[0].content.includes("critic")) return "PASS";
    return '{"tool": "web_search", "args": {}}';
  };
  const r = await new TeamRunner({ chatFn: always, registry }).run({ template: "research", question: "dig forever", model: "m" });
  assert.strictEqual(toolCalls, 4, "MAX_ACTIONS_PER_WORK bounded the loop");
  assert.strictEqual(r.answer, "done");
});

test("budgets: the stage caps compose to EXACTLY the ceiling — worst case completes, never hangs", async () => {
  // Maximal pressure: 4 sub-tasks, every worker burns its full action
  // budget, the critic demands a revision. plan(1) + 4x(4 actions +
  // 1 summary) + write + critique + revise = 24 = MAX_MODEL_CALLS. The
  // per-stage caps are sized so a legitimate worst case fits under the
  // absolute ceiling instead of dying one call short of the finish line.
  const registry = new ToolRegistry({ privacyMode: () => "network" });
  registry.register({ name: "web_search", description: "s", params: {}, egress: true, sensitive: false, handler: () => "x" });
  const always = async ({ messages }) => {
    if (messages[0].content.includes("planner of a small team")) return "1. alpha task\n2. beta task\n3. gamma task\n4. delta task";
    if (messages[0].content.includes("Summarize")) return "note";
    if (messages[0].content.includes("reviser")) return "the revised answer";
    return '{"tool": "web_search", "args": {}}'; // workers act forever; the critic's non-PASS forces revision
  };
  const r = await new TeamRunner({ chatFn: always, registry }).run({ template: "research", question: "q", model: "m" });
  assert.strictEqual(r.modelCalls, 24, "worst case lands exactly on the ceiling");
  assert.strictEqual(r.answer, "the revised answer");
});

test("bad input: unknown template and empty question are refused", async () => {
  const runner = new TeamRunner({ chatFn: scripted([]) });
  await assert.rejects(() => runner.run({ template: "nope", question: "q", model: "m" }), /unknown team template/);
  await assert.rejects(() => runner.run({ template: "review", question: "  ", model: "m" }), /needs a question/);
});

test("templates() lists the three built-ins with their tool needs", () => {
  const list = new TeamRunner({ chatFn: scripted([]) }).templates();
  assert.deepStrictEqual(list.map((t) => t.id), ["research", "analyst", "review"]);
  assert.ok(list.find((t) => t.id === "analyst").tools.includes("run_code"));
});

test("integration: /core/teams + /core/teams/run stream a real pipeline through the gateway loopback", async () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-teams-"));
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const { createCore } = require("../server");
  const core = await createCore({
    dataDir: dir,
    port: 0,
    llamaBin: path.join(__dirname, "fixtures", "fake-llama-server"),
    onEvent: () => {},
  });
  const base = `http://127.0.0.1:${await core.start()}`;
  try {
    const t = await (await fetch(`${base}/core/teams`)).json();
    assert.deepStrictEqual(t.templates.map((x) => x.id), ["research", "analyst", "review"]);

    // The review template is tool-less: three completions through the REAL
    // gateway -> runtime -> fake-llama chain. The fake model answers the
    // same thing every time, so the critic's non-PASS reply forces one
    // revision — proving the whole loop, not just the happy path.
    const resp = await fetch(`${base}/core/teams/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "review", question: "say hello", model: "dev-tiny" }),
    });
    assert.strictEqual(resp.headers.get("content-type"), "text/event-stream");
    const events = (await resp.text())
      .split("\n\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    const done = events.find((e) => e.done);
    assert.ok(done, "a terminal event arrived");
    assert.strictEqual(done.error, undefined, `no error: ${done.error}`);
    assert.strictEqual(done.answer, "Hello from fake llama");
    assert.strictEqual(done.modelCalls, 3, "writer + critic + reviser, each a real completion");
    assert.ok(events.some((e) => e.trace?.stage === "writer"), "trace streamed live");
  } finally {
    await core.stop();
  }
});
