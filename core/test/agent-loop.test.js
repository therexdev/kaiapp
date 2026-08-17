"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const { extractJson, parseAgentAction, buildAgentSystem, toolAliases, selectTools, trimConvo, TOOL_PROMPT_MAX_CHARS } = require("../../ui/agents");
const { estimateMessageTokens } = require("../lib/gateway");

/*
 * The agent loop's contract with SMALL local models: their output is messy
 * (prose, fences, half-JSON). These helpers are the seatbelt — pin down
 * exactly what survives parsing and what is rejected.
 */

test("extractJson: finds the object in prose, fences, and nested braces", () => {
  assert.deepStrictEqual(extractJson('Sure! {"tool": "web_search", "args": {"query": "cats"}}'), { tool: "web_search", args: { query: "cats" } });
  assert.deepStrictEqual(extractJson('```json\n{"answer": true}\n```'), { answer: true });
  assert.deepStrictEqual(extractJson('{"a": {"b": "}"}}'), { a: { b: "}" } }, "brace inside a string does not break balancing");
  assert.strictEqual(extractJson("no json here at all"), null);
  assert.deepStrictEqual(extractJson('broken {"x": } then good {"y": 1}'), { y: 1 }, "skips a malformed block and finds the next");
});

test("parseAgentAction: accepts known tools + answer signals, rejects hallucinated tools", () => {
  const tools = ["web_search", "memory_save"];
  assert.deepStrictEqual(parseAgentAction('{"tool": "web_search", "args": {"query": "x"}}', tools), { tool: "web_search", args: { query: "x" } });
  assert.deepStrictEqual(parseAgentAction('{"answer": true}', tools), { answer: true });
  assert.deepStrictEqual(parseAgentAction('{"done": true}', tools), { answer: true }, "done/final variants count as answer");
  assert.strictEqual(parseAgentAction('{"tool": "rm_rf_slash", "args": {}}', tools), null, "unknown tool → no action, never a guess");
  assert.deepStrictEqual(parseAgentAction('{"tool": "memory_save", "arguments": {"text": "x"}}', tools), { tool: "memory_save", args: { text: "x" } }, "args/arguments/parameters spellings all land");
  assert.deepStrictEqual(parseAgentAction('{"tool": "web_search"}', tools), { tool: "web_search", args: {} }, "missing args defaults to empty object");
});

test("agent system prompt lists tools with their args and demands pure JSON", () => {
  const p = buildAgentSystem([
    { name: "web_search", description: "Search the web.", params: { query: "search terms" } },
    { name: "list_files", description: "List workspace files.", params: {} },
  ]);
  assert.match(p, /web_search: Search the web\. Args: query \(search terms\)/);
  assert.match(p, /list_files: List workspace files\./);
  assert.match(p, /ONLY a JSON object/);
  assert.match(p, /\{"answer": true\}/);
});

/*
 * ---- field report, v0.27.3 (third-party koinos-ai-mcp, 29 tools) ----
 *
 * Two independent failures, both of them ours:
 *   1. the tool menu overran the 4096-token local context, Core refused every
 *      step, and the UI fell back to "answering without tools";
 *   2. registry names like mcp:srvmsxq1a2b:network_status are unspeakable for
 *      a small model — it answered {"mcp": "srvmsxq1a2b:network_status"},
 *      which parsed to nothing.
 *
 * These reproduce that server's shape, so they FAIL on the code that shipped.
 */

const SRV = "srvmsxq1a2b"; // the field server's generated id
const bigServer = () =>
  [
    ["network_overview", "Overview of the Koinos AI network: workers online, jobs completed, tokens per second."],
    ["network_status", "Live status for one worker or the whole network, including privacy mode and lease state."],
    ["network_models", "List the models the network currently advertises with their context class and price."],
    ["network_pricing", "Current per-token pricing from the scheduler oracle, including the EMA and step cap."],
  ]
    .concat(Array.from({ length: 25 }, (_, i) => [`extra_tool_${i}`, `Some other capability number ${i} that this server exposes to callers.`]))
    .map(([name, description]) => ({
      // Descriptions sized the way real ones arrive: mcp.js caps them at 300
      // chars and servers routinely spend all of it on a confirm contract.
      name: `mcp:${SRV}:${name}`,
      description: `[Koinos AI MCP] ${description} Read-only; never mutates scheduler state. Call this before any write tool so the confirm prompt can quote live numbers back to the user rather than stale ones.`.slice(0, 300),
      params: {
        target: "which worker id or scope to report on, or 'all'",
        verbose: "include the full per-worker breakdown rather than totals",
        since: "ISO 8601 timestamp lower bound for the window",
        format: "one of table, json or summary",
      },
    }));

test("agent tools: a real MCP server's menu still fits the 4k local context", () => {
  const tools = bigServer();
  const system = buildAgentSystem(tools, { question: "how is the koinos network doing right now?" });

  assert.ok(system.length <= TOOL_PROMPT_MAX_CHARS + 400, `menu is bounded (${system.length} chars)`);
  // The real gate, not a proxy: this is what Core measures before refusing.
  const est = estimateMessageTokens([
    { role: "system", content: system },
    { role: "user", content: "how is the koinos network doing right now?" },
  ]);
  // 4096 ctx − 512 completion headroom, minus room for the loop's own
  // observations (CONVO_KEEP_STEPS × OBS_CAP ≈ 900 tokens).
  assert.ok(est < 4096 - 512 - 900, `prompt leaves room for the loop (~${est} tokens)`);

  // Subsetting must still be RELEVANT, not just small.
  assert.match(system, /network_overview/, "the question's own subject survives the cut");
  assert.ok(!/extra_tool_24/.test(system), "the long tail does not");
});

test("agent tools: tools are shown under short names, never the mcp:<id>: registry form", () => {
  const system = buildAgentSystem(bigServer(), { question: "network status" });
  assert.ok(!system.includes(`mcp:${SRV}:`), "no namespaced name reaches the model");
  assert.match(system, /^- network_status: /m, "just the bare tool name");
  assert.match(system, /Copy the tool name exactly/, "and it is told to copy it verbatim");
});

test("agent action: the exact shape the field model emitted now resolves", () => {
  const names = bigServer().map((t) => t.name);
  // Verbatim from the report — namespace became the KEY, no "tool" field.
  const emitted = '{"mcp": "srvmsxq1a2b:network_status", "args": {}}';
  assert.deepStrictEqual(parseAgentAction(emitted, names), { tool: `mcp:${SRV}:network_status`, args: {} });

  // And the short name it was actually shown.
  assert.deepStrictEqual(parseAgentAction('{"tool": "network_overview", "args": {}}', names), {
    tool: `mcp:${SRV}:network_overview`,
    args: {},
  });
  // Sloppy spellings a small model produces around the same name.
  assert.strictEqual(parseAgentAction('{"tool": "Network-Status"}', names).tool, `mcp:${SRV}:network_status`);
  assert.strictEqual(parseAgentAction(`{"tool": "mcp:${SRV}:network_models"}`, names).tool, `mcp:${SRV}:network_models`, "the full name still works");
  // OpenAI-ish, including arguments delivered as a JSON string.
  assert.deepStrictEqual(parseAgentAction('{"function": {"name": "network_status", "arguments": "{\\"target\\": \\"all\\"}"}}', names), {
    tool: `mcp:${SRV}:network_status`,
    args: { target: "all" },
  });
  // A tool that does not exist is still refused — aliasing is not guessing.
  assert.strictEqual(parseAgentAction('{"mcp": "srvmsxq1a2b:drop_database"}', names), null);
});

test("agent tools: two servers exporting the same tool stay unambiguous", () => {
  const names = ["mcp:srvA:read_file", "mcp:srvB:read_file", "web_search"];
  const map = toolAliases(names);
  assert.strictEqual(map.alias["mcp:srvA:read_file"], "read_file");
  assert.strictEqual(map.alias["mcp:srvB:read_file"], "read_file_2", "the collision is numbered, not silently merged");
  assert.strictEqual(map.resolve("read_file"), "mcp:srvA:read_file");
  assert.strictEqual(map.resolve("read_file_2"), "mcp:srvB:read_file");
  // The one spelling that genuinely cannot be attributed resolves to nothing.
  assert.strictEqual(map.resolve("readfile"), null, "ambiguous → no action, never a coin flip");
  assert.strictEqual(map.resolve("mcp:srvB:read_file"), "mcp:srvB:read_file", "exact names always win");

  // A numbered alias must never steal the name of a tool that is really
  // called read_file_2 somewhere else.
  const m2 = toolAliases(["mcp:srvA:read_file", "mcp:srvB:read_file", "mcp:srvC:read_file_2"]);
  const aliases = Object.values(m2.alias);
  assert.strictEqual(new Set(aliases).size, 3, `every tool keeps its own alias: ${aliases.join(", ")}`);
  assert.strictEqual(m2.alias["mcp:srvC:read_file_2"], "read_file_2", "the real name wins over a generated one");
  assert.strictEqual(m2.resolve("read_file_2"), "mcp:srvC:read_file_2");
  assert.strictEqual(m2.resolve("read_file_3"), "mcp:srvB:read_file", "the collision skips past the taken name");
});

test("agent loop: the conversation stops growing so late steps still fit", () => {
  const convo = [{ role: "system", content: "sys" }, { role: "user", content: "q" }];
  for (let i = 0; i < 6; i++) {
    convo.push({ role: "assistant", content: `call ${i}` });
    convo.push({ role: "user", content: `result ${i}` });
  }
  const t = trimConvo(convo);
  assert.strictEqual(t[0].content, "sys", "the tool menu never falls out");
  assert.strictEqual(t[1].content, "q", "neither does the question");
  assert.ok(t.length < convo.length, "older exchanges do");
  assert.strictEqual(t[t.length - 1].content, "result 5", "the newest observation is kept");
  assert.deepStrictEqual(trimConvo(convo.slice(0, 4)), convo.slice(0, 4), "short loops are untouched");
});

test("agent tools: a small toolset is listed whole, and built-ins survive a big server", () => {
  const few = [
    { name: "web_search", description: "Search the web.", params: { query: "search terms" } },
    { name: "memory_search", description: "Look up things you were asked to remember.", params: { query: "what to look for" } },
  ];
  assert.strictEqual(selectTools(few, "anything at all", null).length, 2, "no subsetting when everything fits");

  const mixed = few.concat(bigServer());
  const listed = selectTools(mixed, "what is the weather in Oslo", null).map((t) => t.name);
  assert.ok(listed.indexOf("web_search") !== -1, "a 29-tool server cannot crowd out the built-ins");
});
