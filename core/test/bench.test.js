"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { BenchRunner, SUITES, evaluate } = require("../lib/bench");

/*
 * Bench (task #61, phase B). The model is scripted, so what's pinned here is
 * the MACHINERY: the mechanical checks, the scoring math, the team-case
 * routing, the one-at-a-time guard, and the saved report.
 */

test("evaluate: each check kind judges mechanically", () => {
  assert.strictEqual(evaluate("It is 391.", { regex: "\\b391\\b" }).pass, true);
  assert.strictEqual(evaluate("It is 3911.", { regex: "\\b391\\b" }).pass, false, "word boundary holds");
  assert.strictEqual(evaluate("PONG!", { regex: "^\\W*PONG\\W*$", flags: "i" }).pass, true);
  assert.strictEqual(evaluate("I say PONG to you", { regex: "^\\W*PONG\\W*$", flags: "i" }).pass, false);
  assert.strictEqual(evaluate("Red, blue and Yellow", { icontains: ["red", "blue", "yellow"] }).pass, true);
  assert.strictEqual(evaluate("red and blue", { icontains: ["red", "blue", "yellow"] }).pass, false);
  assert.strictEqual(evaluate("x", { contains: ["X"] }).pass, false, "contains is case-sensitive");
  assert.strictEqual(evaluate("  ", { minChars: 1 }).pass, false);
  const j = evaluate('Sure: {"ok": true, "n": 3} there you go', { json: { ok: true, n: 3 } });
  assert.strictEqual(j.pass, true, "JSON is fished out of surrounding chatter");
  assert.strictEqual(evaluate('{"ok": true, "n": 4}', { json: { ok: true, n: 3 } }).pass, false);
  assert.strictEqual(evaluate("no json here", { json: { ok: true } }).pass, false);
});

test("run: scores a mixed run correctly and reports per-case rows", async () => {
  // Right answers for exactly 5 of the 8 chat cases, in suite order.
  const answers = [
    "391", // arithmetic — pass
    "pong it is", // exact-word — FAIL (not the word alone)
    '{"ok": true, "n": 3}', // json-shape — pass
    "1933", // extraction — FAIL (wrong year)
    "3", // letter-count — pass
    "32", // sequence — pass
    "red\ngreen\nyellow", // primary-colors — FAIL (green, no blue)
    "YES", // parity — pass
  ];
  const chatFn = async () => answers.shift();
  // Team cases answered by a fake runner: both pass.
  const teams = { run: async () => ({ answer: "hello — BENCHMARK", modelCalls: 3, trace: [] }) };
  const rows = [];
  const r = await new BenchRunner({ chatFn, teams }).run({ model: "m", onCase: (row) => rows.push(row) });
  assert.strictEqual(r.summary.total, 10);
  assert.strictEqual(r.summary.passed, 7, "5 chat + 2 team");
  assert.strictEqual(rows.length, 10, "every case streamed a row");
  const byId = Object.fromEntries(r.results.map((x) => [x.id, x]));
  assert.strictEqual(byId["exact-word"].pass, false);
  assert.match(byId["exact-word"].why, /no match/);
  assert.strictEqual(byId["agent-file-tools"].pass, true);
  assert.strictEqual(byId["agent-file-tools"].modelCalls, 3, "team cases report the pipeline's real call count");
  assert.strictEqual(r.summary.modelCalls, 8 * 1 + 3 + 3);
});

test("run: without a team runner the team cases fail honestly, the suite completes", async () => {
  const chatFn = async () => "whatever";
  const r = await new BenchRunner({ chatFn, teams: null }).run({ model: "m" });
  assert.strictEqual(r.summary.total, 10, "no crash — every case produced a row");
  const teamRows = r.results.filter((x) => x.kind === "team");
  assert.ok(teamRows.every((x) => !x.pass && /teams are unavailable/.test(x.why)));
});

test("run: one benchmark at a time; unknown suite and missing model are refused", async () => {
  const slow = () => new Promise((res) => setTimeout(() => res("x"), 5));
  const runner = new BenchRunner({ chatFn: slow, teams: { run: () => slow().then(() => ({ answer: "x", modelCalls: 1 })) } });
  const first = runner.run({ model: "m" });
  await assert.rejects(() => runner.run({ model: "m" }), /already running/);
  await first; // and the guard releases:
  await assert.rejects(() => runner.run({ suite: "nope", model: "m" }), /unknown bench suite/);
  await assert.rejects(() => runner.run({ model: "  " }), /needs a model/);
});

test("run: the report is saved to <dataDir>/bench-last.json", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-bench-"));
  const chatFn = async () => "391";
  await new BenchRunner({ chatFn, teams: null, dataDir: dir }).run({ model: "m" });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "bench-last.json"), "utf8"));
  assert.strictEqual(saved.summary.total, 10);
  assert.strictEqual(saved.results.length, 10);
  assert.strictEqual(saved.summary.model, "m");
});

test("the suite definition itself: fixed size, objective checks only, no sensitive tools", () => {
  const core = SUITES.find((s) => s.id === "core");
  assert.strictEqual(core.cases.length, 10, "the suite is FIXED — scores stay comparable across versions");
  for (const c of core.cases) {
    assert.ok(c.expect && typeof c.expect === "object", `${c.id} has a mechanical check`);
    const tools = c.spec?.tools || [];
    assert.ok(!tools.includes("run_code"), "a benchmark must never be the thing that runs code");
  }
});
