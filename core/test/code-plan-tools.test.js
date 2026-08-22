"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

/*
 * Plan mode and registry (MCP) tools inside the coding agent (task #75).
 *
 * The properties worth pinning are both about what the agent CANNOT do:
 * a planning pass has no editing tools at all, and a sensitive registry tool
 * cannot run without the same approval card a shell command needs.
 */

const { CodeAgent, registryTools, MAX_EXTRA_TOOLS } = require("../lib/code-agent");
const { makeTools } = require("../../cli/koinos-code");

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

const noopIo = {
  showDiff() {},
  askEdit: async () => ({ approved: false }),
  askCommand: async () => ({ approved: false }),
  note() {},
};

test("plan mode removes the editing tools entirely — not by asking nicely", () => {
  const act = makeTools("/tmp", { io: noopIo }).map((t) => t.name);
  const plan = makeTools("/tmp", { io: noopIo, readOnly: true }).map((t) => t.name);
  assert.deepStrictEqual(plan, ["list_files", "read_file", "search_files"]);
  for (const dangerous of ["write_file", "edit_file", "run_cmd"]) {
    assert.ok(act.includes(dangerous), `${dangerous} exists in act mode`);
    assert.ok(!plan.includes(dangerous), `${dangerous} must NOT exist in plan mode`);
  }
});

test("plan mode drops host tools too — a plan is formed from the project", () => {
  const extra = [{ name: "mcp_send_email", description: "d", params: {}, handler: async () => "sent" }];
  const act = makeTools("/tmp", { io: noopIo, extraTools: extra }).map((t) => t.name);
  const plan = makeTools("/tmp", { io: noopIo, readOnly: true, extraTools: extra }).map((t) => t.name);
  assert.ok(act.includes("mcp_send_email"));
  // An MCP tool may well have side effects; planning should not fire them.
  assert.ok(!plan.includes("mcp_send_email"));
});

/** A minimal stand-in with the real ToolRegistry's shape. */
function fakeRegistry(tools) {
  return {
    list: () => tools.map(({ name, description, params, egress, sensitive }) => ({ name, description, params, egress, sensitive })),
    call: async (name, args) => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`Unknown tool: ${name}`);
      return t.run(args);
    },
  };
}

test("registry tools: opt-in per project, bounded, and never wider than what was allowed", () => {
  const reg = fakeRegistry([
    { name: "a", description: "A", params: {}, sensitive: false, run: async () => "ra" },
    { name: "b", description: "B", params: {}, sensitive: false, run: async () => "rb" },
  ]);
  // Nothing allowed = nothing lent. A coding agent does not silently inherit
  // every tool on the machine.
  assert.deepStrictEqual(registryTools(reg, { allow: [], io: noopIo }), []);
  assert.deepStrictEqual(registryTools(null, { allow: ["a"], io: noopIo }), []);
  // Only what was named.
  assert.deepStrictEqual(registryTools(reg, { allow: ["a"], io: noopIo }).map((t) => t.name), ["a"]);
  // Asking for something the registry does not offer yields nothing, not a throw.
  assert.deepStrictEqual(registryTools(reg, { allow: ["nope"], io: noopIo }).map((t) => t.name), []);

  // Bounded: a 4k context cannot hold an unbounded tool menu.
  const many = fakeRegistry(
    Array.from({ length: 30 }, (_, i) => ({ name: `t${i}`, description: "x", params: {}, sensitive: false, run: async () => "" }))
  );
  const lent = registryTools(many, { allow: Array.from({ length: 30 }, (_, i) => `t${i}`), io: noopIo });
  assert.strictEqual(lent.length, MAX_EXTRA_TOOLS);
});

test("a SENSITIVE registry tool needs the same approval card a shell command needs", async () => {
  let ran = false;
  const reg = fakeRegistry([
    { name: "danger", description: "D", params: {}, sensitive: true, run: async () => { ran = true; return "did it"; } },
  ]);

  // Declined: the tool never runs, and the model is told honestly.
  const asked = [];
  const denyIo = { ...noopIo, askCommand: async (c) => { asked.push(c); return { approved: false, reason: "the user declined this in the app" }; } };
  const [denied] = registryTools(reg, { allow: ["danger"], io: denyIo });
  const out = await denied.handler({ x: 1 });
  assert.strictEqual(ran, false, "a declined sensitive tool must not run");
  assert.match(out, /declined/);
  assert.strictEqual(asked.length, 1, "it asked");
  assert.match(asked[0], /danger/);

  // Approved: it runs.
  const okIo = { ...noopIo, askCommand: async () => ({ approved: true }) };
  const [allowed] = registryTools(reg, { allow: ["danger"], io: okIo });
  assert.strictEqual(await allowed.handler({}), "did it");
  assert.strictEqual(ran, true);
});

test("a NON-sensitive registry tool runs without a card, and its errors are observations", async () => {
  const reg = fakeRegistry([
    { name: "safe", description: "S", params: {}, sensitive: false, run: async () => "fine" },
    { name: "boom", description: "B", params: {}, sensitive: false, run: async () => { throw new Error("upstream is down"); } },
  ]);
  let asked = 0;
  const io = { ...noopIo, askCommand: async () => { asked++; return { approved: true }; } };
  const tools = registryTools(reg, { allow: ["safe", "boom"], io });
  assert.strictEqual(await tools[0].handler({}), "fine");
  assert.strictEqual(asked, 0, "a non-sensitive tool does not interrupt anyone");
  // A failing tool must never take the run down.
  assert.match(await tools[1].handler({}), /tool error: upstream is down/);
});

test("a planning run answers with a plan and touches nothing on disk", async () => {
  const dir = tmp("kai-plan-");
  fs.writeFileSync(path.join(dir, "app.js"), "console.log(1);\n");
  const before = fs.readdirSync(dir);

  // The script tries to WRITE first. In plan mode that tool does not exist, so
  // the action is unparseable as a tool call and becomes the plan text.
  const replies = [
    '{"tool": "write_file", "args": {"path": "sneaky.txt", "content": "nope"}}',
    "1. Change app.js to log 2 instead of 1.",
  ];
  const agent = new CodeAgent({ chatFn: async () => replies.shift() ?? "done" });
  const r = await agent.run({ dir, task: "make it log 2", mode: "plan" });

  assert.strictEqual(r.reason, "planned", "a planning run reports that it planned");
  assert.deepStrictEqual(fs.readdirSync(dir), before, "plan mode wrote nothing");
  assert.strictEqual(fs.existsSync(path.join(dir, "sneaky.txt")), false);
});

test("an approved plan rides into the acting run as the thing to follow", async () => {
  const dir = tmp("kai-act-");
  const seen = [];
  const agent = new CodeAgent({
    chatFn: async ({ messages }) => {
      seen.push(messages.map((m) => m.content).join("\n"));
      return "Done.";
    },
  });
  await agent.run({ dir, task: "do it", mode: "act", plan: "1. Edit app.js\n2. Run the tests" });
  assert.match(seen[0], /THE APPROVED PLAN/);
  assert.match(seen[0], /Run the tests/);

  // And without a plan, no such section appears — the ordinary path is unchanged.
  const seen2 = [];
  const agent2 = new CodeAgent({ chatFn: async ({ messages }) => { seen2.push(messages.map((m) => m.content).join("\n")); return "Done."; } });
  await agent2.run({ dir, task: "do it" });
  assert.ok(!/THE APPROVED PLAN/.test(seen2[0]));
});

test("a tool call for a tool it does not have is corrected, not surfaced as an answer", async () => {
  // parseAgentAction returns null both for prose AND for a tool call naming
  // something unavailable, and the loop treats null as "this is the answer".
  // That is how a refused write ended up displayed to a person as raw JSON
  // pretending to be a plan.
  const dir = tmp("kai-nudge-");
  const seen = [];
  const replies = [
    '{"tool": "write_file", "args": {"path": "x.txt", "content": "no"}}',
    "1. A real plan, in words.",
  ];
  const agent = new CodeAgent({
    chatFn: async ({ messages }) => {
      seen.push(messages[messages.length - 1].content);
      return replies.shift() ?? "done";
    },
  });
  const traces = [];
  const r = await agent.run({ dir, task: "plan it", mode: "plan", onTrace: (e) => traces.push(e) });

  assert.strictEqual(r.answer, "1. A real plan, in words.", "the PLAN is returned, not the JSON");
  assert.ok(!/write_file/.test(r.answer));
  // It was told what it actually has.
  assert.match(seen[1], /no tools to change anything while planning/);
  assert.match(seen[1], /list_files/);
  assert.ok(traces.some((t) => t.type === "note" && /not available while planning/.test(t.text)));
});

test("the nudge is bounded — a model that will not stop still finishes", async () => {
  const dir = tmp("kai-nudge2-");
  let calls = 0;
  const agent = new CodeAgent({
    chatFn: async () => {
      calls++;
      return '{"tool": "write_file", "args": {"path": "x", "content": "y"}}'; // never gives up
    },
  });
  const r = await agent.run({ dir, task: "plan it", mode: "plan" });
  // Two nudges, then the loop accepts and returns rather than spinning.
  assert.strictEqual(r.reason, "planned");
  assert.strictEqual(calls, 3, `expected 1 try + 2 nudges, got ${calls}`);
});
