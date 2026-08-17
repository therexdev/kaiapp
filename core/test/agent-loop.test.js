"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const { extractJson, parseAgentAction, buildAgentSystem } = require("../../ui/agents");

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
