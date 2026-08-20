"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

/*
 * Developer tools (task #61) through the REAL stack: createCore + the
 * fake-llama engine. Pins the switch's default (off), its persistence, and
 * that it actually gates what it claims to gate — custom team specs and the
 * bench — while leaving templates alone.
 */

async function sse(base, pathName, body) {
  const resp = await fetch(`${base}${pathName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.headers.get("content-type")?.includes("event-stream")) {
    return { status: resp.status, json: await resp.json().catch(() => ({})) };
  }
  const events = (await resp.text())
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
  return { status: resp.status, events, done: events.find((e) => e.done) };
}

test("dev toggle: off by default, gates custom specs and bench, persists in settings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-dev-"));
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
    // ---- default: OFF ----
    let d = await (await fetch(`${base}/core/dev`)).json();
    assert.strictEqual(d.enabled, false, "developer tools ship OFF");

    // ---- while off: custom specs and bench refuse; templates still work ----
    const refusedSpec = await sse(base, "/core/teams/run", {
      spec: { stages: ["write"] },
      question: "q",
      model: "dev-tiny",
    });
    assert.strictEqual(refusedSpec.status, 403);
    assert.match(refusedSpec.json.error, /Developer tools/);
    const refusedBench = await sse(base, "/core/bench/run", { model: "dev-tiny" });
    assert.strictEqual(refusedBench.status, 403);
    const template = await sse(base, "/core/teams/run", { template: "review", question: "say hello", model: "dev-tiny" });
    assert.strictEqual(template.done.answer, "Hello from fake llama", "templates are NOT developer-gated");

    // ---- flip on: persists to settings.json ----
    const on = await (
      await fetch(`${base}/core/dev`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      })
    ).json();
    assert.strictEqual(on.enabled, true);
    const settingsOnDisk = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    assert.strictEqual(settingsOnDisk.dev.tools, true, "the switch survives a restart");

    // ---- custom spec now runs through the real loopback ----
    const specRun = await sse(base, "/core/teams/run", {
      spec: { stages: ["write"], label: "just write" },
      question: "say hello",
      model: "dev-tiny",
    });
    assert.strictEqual(specRun.done.error, undefined);
    assert.strictEqual(specRun.done.answer, "Hello from fake llama");
    assert.strictEqual(specRun.done.modelCalls, 1, "the write-only spec made exactly one real completion");
    // A bad spec fails loudly inside the stream, not silently.
    const badSpec = await sse(base, "/core/teams/run", {
      spec: { stages: ["plan"] },
      question: "q",
      model: "dev-tiny",
    });
    assert.match(badSpec.done.error, /needs the "write" stage/);

    // ---- bench list + a full real run ----
    const list = await (await fetch(`${base}/core/bench`)).json();
    assert.strictEqual(list.enabled, true);
    assert.strictEqual(list.suites[0].id, "core");
    assert.strictEqual(list.suites[0].cases.length, 10);
    const bench = await sse(base, "/core/bench/run", { suite: "core", model: "dev-tiny" });
    assert.strictEqual(bench.done.error, undefined, `bench ran: ${bench.done.error}`);
    assert.strictEqual(bench.done.summary.total, 10);
    // The fake model answers "Hello from fake llama" to everything: every
    // objective chat check fails, the tool-agent case fails, and only the
    // team-review case (non-empty answer) passes. Deterministic score: 1/10.
    assert.strictEqual(bench.done.summary.passed, 1);
    const caseRows = bench.events.filter((e) => e.case).map((e) => e.case);
    assert.strictEqual(caseRows.length, 10, "every case streamed live");
    assert.ok(caseRows.find((c) => c.id === "team-review").pass);
    // The report survived to disk for the UI / API to re-read.
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "bench-last.json"), "utf8"));
    assert.strictEqual(saved.summary.passed, 1);

    // ---- flip back off: the gate closes again ----
    await fetch(`${base}/core/dev`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const closed = await sse(base, "/core/teams/run", { spec: { stages: ["write"] }, question: "q", model: "dev-tiny" });
    assert.strictEqual(closed.status, 403);
  } finally {
    await core.stop();
  }
});
