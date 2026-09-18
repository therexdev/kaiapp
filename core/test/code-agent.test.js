"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

/*
 * Koinos Code in the app (task #60 v3): the CLI's coding agent hosted by
 * Core, permission gates routed to approval cards. Unit tests drive the
 * runner with a scripted chatFn; the HTTP test runs the REAL stack
 * (createCore + scripted fake llama) and answers an approval card while
 * the SSE response is open.
 */

const { CodeAgent } = require("../lib/code-agent");

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kai-codeagent-"));
}

/** chatFn that shifts scripted replies and records every request. */
function scriptedChat(replies) {
  const calls = [];
  return {
    calls,
    chatFn: async ({ model, messages }) => {
      calls.push({ model, messages });
      return replies.length ? replies.shift() : '{"answer": true}';
    },
  };
}

test("run validation: missing dir, non-dir, filesystem root, empty task", async () => {
  const agent = new CodeAgent({ chatFn: async () => "" });
  await assert.rejects(() => agent.run({ dir: "/nope/never/here", task: "x" }), /does not exist/);
  const dir = tmpProject();
  const file = path.join(dir, "f.txt");
  fs.writeFileSync(file, "x");
  await assert.rejects(() => agent.run({ dir: file, task: "x" }), /not a directory/);
  await assert.rejects(() => agent.run({ dir: path.parse(dir).root, task: "x" }), /filesystem root/);
  await assert.rejects(() => agent.run({ dir, task: "  " }), /give the agent a task/);
});

test("a write pauses on an approval card; approve -> the file lands; the card carries the diff", async () => {
  const dir = tmpProject();
  const { chatFn } = scriptedChat([
    '{"tool": "write_file", "args": {"path": "note.txt", "content": "hello panel\\n"}}',
    "Created the note.",
  ]);
  const agent = new CodeAgent({ chatFn });
  const traces = [];
  const done = agent.run({
    dir,
    task: "make a note",
    onTrace: (e) => {
      traces.push(e);
      if (e.type === "approval-request") {
        assert.strictEqual(e.kind, "edit");
        assert.strictEqual(e.path, "note.txt");
        assert.match(e.diff, /\+ hello panel/);
        assert.strictEqual(agent.provideApproval(e.approvalId, true), true);
      }
    },
  });
  const r = await done;
  assert.strictEqual(r.reason, "answered");
  assert.strictEqual(r.answer, "Created the note.");
  assert.strictEqual(fs.readFileSync(path.join(dir, "note.txt"), "utf8"), "hello panel\n");
  assert.ok(traces.some((e) => e.type === "start" && e.runId), "start event named the run");
  assert.ok(traces.some((e) => e.type === "tool" && e.name === "write_file"), "tool trace streamed");
});

test("decline leaves the disk untouched and the model is told honestly", async () => {
  const dir = tmpProject();
  const { calls, chatFn } = scriptedChat([
    '{"tool": "write_file", "args": {"path": "no.txt", "content": "nope"}}',
    "Understood, not writing.",
  ]);
  const agent = new CodeAgent({ chatFn });
  const r = await agent.run({
    dir,
    task: "try a write",
    onTrace: (e) => {
      if (e.type === "approval-request") agent.provideApproval(e.approvalId, false);
    },
  });
  assert.strictEqual(r.answer, "Understood, not writing.");
  assert.strictEqual(fs.existsSync(path.join(dir, "no.txt")), false);
  const obsTurn = JSON.stringify(calls[1].messages);
  assert.match(obsTurn, /declined this in the app/, "the refusal became the observation");
});

test("an unanswered card times out as a decline — the run continues, nothing written", async () => {
  const dir = tmpProject();
  const { calls, chatFn } = scriptedChat([
    '{"tool": "write_file", "args": {"path": "slow.txt", "content": "zzz"}}',
    "Gave up on the write.",
  ]);
  const agent = new CodeAgent({ chatFn, approvalTimeoutMs: 40 });
  const r = await agent.run({ dir, task: "write something" });
  assert.strictEqual(r.reason, "answered");
  assert.strictEqual(fs.existsSync(path.join(dir, "slow.txt")), false);
  assert.match(JSON.stringify(calls[1].messages), /approval timed out/);
});

test("stop while blocked on a card ends the run; the stale card answers 404-style false", async () => {
  const dir = tmpProject();
  const { chatFn } = scriptedChat(['{"tool": "run_cmd", "args": {"cmd": "echo hi"}}']);
  const agent = new CodeAgent({ chatFn });
  let staleId = null;
  const done = agent.run({
    dir,
    task: "run a command",
    onTrace: (e) => {
      if (e.type === "approval-request") {
        staleId = e.approvalId;
        assert.strictEqual(e.kind, "command");
        assert.strictEqual(agent.stop(e.runId), true);
      }
    },
  });
  const r = await done;
  assert.strictEqual(r.reason, "stopped");
  assert.match(r.answer, /Stopped/i, "stop leaves a human-readable outcome, not an empty string");
  assert.ok(!/\{\s*"answer"\s*:\s*true\s*\}/.test(r.answer), "stop must not surface protocol JSON");
  assert.strictEqual(agent.provideApproval(staleId, true), false, "the card died with the run");
});

test("after declined writes, a protocol-marker closing reply becomes honest prose", async () => {
  const { isProtocolMarker, truthfulAnswer } = require("../lib/code-agent");
  assert.strictEqual(isProtocolMarker('{"answer":true}'), true);
  assert.strictEqual(isProtocolMarker('{"answer": true}'), true);
  assert.strictEqual(isProtocolMarker("All done."), false);
  assert.match(truthfulAnswer('{"answer":true}', false), /Nothing was written/i);
  assert.ok(!/\{\s*"answer"\s*:\s*true\s*\}/.test(truthfulAnswer('{"answer":true}', false)));

  const dir = tmpProject();
  const { chatFn } = scriptedChat([
    '{"tool": "write_file", "args": {"path": "hello.txt", "content": "hi\\n"}}',
    '{"answer": true}',
    '{"answer":true}',
  ]);
  const agent = new CodeAgent({ chatFn });
  const r = await agent.run({
    dir,
    task: "create hello.txt",
    onTrace: (e) => {
      if (e.type === "approval-request") agent.provideApproval(e.approvalId, false);
    },
  });
  assert.strictEqual(r.reason, "answered");
  assert.strictEqual(fs.existsSync(path.join(dir, "hello.txt")), false);
  assert.ok(!isProtocolMarker(r.answer), `answer must not be protocol JSON: ${r.answer}`);
  assert.match(r.answer, /Nothing was written|declined|not written/i);
});

/*
 * The run loop corrects its own answer, and then the gateway corrects it again
 * through sessionAnswer() before storing the session turn. The correction has
 * to be idempotent or the person reads "Nothing was written to disk" twice in
 * one message — which reads like two separate failures.
 */
test("the nothing-written correction is idempotent across both correction points", () => {
  const { truthfulAnswer, sessionAnswer } = require("../lib/code-agent");
  const claim = "I created hello.txt for you.";

  const once = truthfulAnswer(claim, false, "answered");
  const twice = truthfulAnswer(once, false, "answered");
  const thrice = truthfulAnswer(twice, false, "answered");
  const count = (s) => s.split("Nothing was written to disk").length - 1;
  assert.strictEqual(count(once), 1, "the correction must appear once");
  assert.strictEqual(count(twice), 1, "re-correcting an already-corrected answer must not append again");
  assert.strictEqual(twice, once);
  assert.strictEqual(thrice, once);

  // The real double-correction path: finish() then the gateway's sessionAnswer().
  const stored = sessionAnswer({ answer: once, wrote: false, reason: "answered" });
  assert.strictEqual(count(stored), 1, "gateway storage must not append a second correction");
  assert.strictEqual(stored, once);

  // A run that really did write is left alone.
  assert.strictEqual(truthfulAnswer(claim, true, "answered"), claim);
});

/*
 * Plan mode closes through the same protocol as a normal run, so it can end on
 * a bare {"answer":true}. That must never be shown as "the plan".
 */
test("plan mode never shows a raw protocol marker", () => {
  const { planAnswer, sessionAnswer, isProtocolMarker } = require("../lib/code-agent");
  for (const marker of ['{"answer":true}', '{"answer": true}', '{"done":true}', "  ", ""]) {
    const out = planAnswer(marker);
    assert.ok(!isProtocolMarker(out), `plan output must not be a marker: ${out}`);
    assert.ok(!/\{\s*"(?:answer|done|final)"/.test(out), `plan output must not contain protocol JSON: ${out}`);
    assert.match(out, /No plan was produced/i);
    assert.ok(!/Nothing was written to disk —/.test(out), "plan mode never claims declined edits");
  }
  // A real plan passes through untouched.
  const plan = "1. Edit src/a.js — add the guard.\n2. Edit test/a.test.js — cover it.";
  assert.strictEqual(planAnswer(plan), plan);
  assert.strictEqual(sessionAnswer({ reason: "planned", answer: plan, wrote: false }), plan);
  assert.match(sessionAnswer({ reason: "planned", answer: '{"answer":true}', wrote: false }), /No plan was produced/i);
});

test("a plan-mode run that closes on a marker returns readable prose", async () => {
  const dir = tmpProject();
  const { chatFn } = scriptedChat(['{"answer":true}']);
  const agent = new CodeAgent({ chatFn });
  const r = await agent.run({ dir, task: "plan a change", mode: "plan" });
  assert.strictEqual(r.reason, "planned");
  assert.ok(!/\{\s*"answer"\s*:\s*true\s*\}/.test(r.answer), `plan answer leaked protocol JSON: ${r.answer}`);
  assert.match(r.answer, /No plan was produced/i);
});

test("an approved command runs in the project directory", async () => {
  const dir = tmpProject();
  const { calls, chatFn } = scriptedChat([
    '{"tool": "run_cmd", "args": {"cmd": "echo made > marker.txt"}}',
    "Marker created.",
  ]);
  const agent = new CodeAgent({ chatFn });
  const r = await agent.run({
    dir,
    task: "make a marker",
    onTrace: (e) => {
      if (e.type === "approval-request") agent.provideApproval(e.approvalId, true);
    },
  });
  assert.strictEqual(r.answer, "Marker created.");
  assert.strictEqual(fs.existsSync(path.join(dir, "marker.txt")), true);
  assert.match(JSON.stringify(calls[1].messages), /exit 0/);
});

test("KOINOS.md project notes ride the system prompt here too", async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "KOINOS.md"), "PANEL-RULE-MARKER: prefer small diffs.");
  const { calls, chatFn } = scriptedChat(["Noted."]);
  const agent = new CodeAgent({ chatFn });
  await agent.run({ dir, task: "what are the rules?" });
  assert.match(calls[0].messages[0].content, /PANEL-RULE-MARKER/);
  assert.match(calls[0].messages[0].content, /Project notes from KOINOS\.md/);
});

/* --------------------------------------------- the REAL stack over HTTP ---- */

async function json(base, pathname, { method = "GET", body } = {}) {
  const r = await fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** Stream an SSE POST, invoking onEvent per frame as it ARRIVES — the
 *  approval test answers a card while the response is still open. */
async function sse(base, pathname, body, onEvent = () => {}) {
  const resp = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!(resp.headers.get("content-type") || "").includes("event-stream")) {
    return { status: resp.status, json: await resp.json().catch(() => ({})) };
  }
  const decoder = new TextDecoder();
  const events = [];
  let buf = "";
  for await (const chunk of resp.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!line.startsWith("data: ")) continue;
      const ev = JSON.parse(line.slice(6));
      events.push(ev);
      await onEvent(ev);
    }
  }
  return { status: resp.status, events, done: events.find((e) => e.done) };
}

test("HTTP: a PROXIED code request is refused unless a core token is configured", async () => {
  // The code surface writes anywhere and runs commands — unlike teams'
  // run_code it is NOT workspace-sandboxed. Core binds loopback, so a
  // forwarded request means an operator put a proxy in front; _sameSite
  // trusts header-less callers, so this surface asks for the token instead.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-codeproxy-"));
  fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const { createCore } = require("../server");
  const core = await createCore({
    dataDir,
    port: 0,
    llamaBin: path.join(__dirname, "fixtures", "fake-llama-server"),
    onEvent: () => {},
  });
  const base = `http://127.0.0.1:${await core.start()}`;
  const project = tmpProject();
  try {
    await json(base, "/core/code-switch", { method: "POST", body: { enabled: true } });

    for (const header of ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"]) {
      const r = await fetch(`${base}/core/code/run`, {
        method: "POST",
        headers: { "content-type": "application/json", [header]: "203.0.113.7" },
        body: JSON.stringify({ dir: project, task: "write a file" }),
      });
      assert.strictEqual(r.status, 403, `${header} must be refused`);
      const body = await r.json();
      assert.match(body.error, /KAI_CORE_TOKEN/, `${header} refusal names the way out`);
    }

    // The approve and stop routes are gated the same way — answering a card
    // is as powerful as starting the run.
    const approve = await fetch(`${base}/core/code/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({ approvalId: "x", approved: true }),
    });
    assert.strictEqual(approve.status, 403);

    // A direct (non-proxied) call is unaffected — the desktop path.
    const direct = await json(base, "/core/code/stop", { method: "POST", body: { runId: "nope" } });
    assert.strictEqual(direct.status, 200);
    assert.strictEqual(direct.body.stopped, false);
  } finally {
    await core.stop();
  }
});

test("HTTP: gate, an SSE run with a live approval round trip, stale approve, stop route", async () => {
  const project = tmpProject();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-codeagent-core-"));
  fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  // Script the fake engine: one surgical write, then the closing answer
  // (the {"answer":true} handshake asks one more completion for prose).
  const script = path.join(dataDir, "llama-script.json");
  fs.writeFileSync(
    script,
    JSON.stringify([
      '{"tool": "write_file", "args": {"path": "hello.txt", "content": "from the panel\\n"}}',
      '{"answer": true}',
      "Wrote hello.txt for you.",
    ])
  );
  process.env.FAKE_LLAMA_SCRIPT = script;
  const { createCore } = require("../server");
  const core = await createCore({
    dataDir,
    port: 0,
    llamaBin: path.join(__dirname, "fixtures", "fake-llama-server"),
    onEvent: () => {},
  });
  const base = `http://127.0.0.1:${await core.start()}`;
  try {
    // Developer-gated like the rest of the track.
    let r = await json(base, "/core/code/approve", { method: "POST", body: {} });
    assert.strictEqual(r.status, 403);
    // Koinos Code has its own switch since task #72 — its own sidebar item,
    // its own gate, separate from the developer-tools surfaces.
    assert.match(r.body.error, /Koinos Code is switched off/);
    await json(base, "/core/code-switch", { method: "POST", body: { enabled: true } });

    // A bad directory is a clear terminal error on the stream, not a hang.
    const bad = await sse(base, "/core/code/run", { dir: "/definitely/not/here", task: "x" });
    assert.match(bad.done.error, /does not exist/);

    // The full round trip: approval card out, approve back in, answer lands.
    let card = null;
    const run = await sse(base, "/core/code/run", { dir: project, task: "create hello.txt", model: "dev-tiny" }, async (ev) => {
      if (ev.trace?.type === "approval-request") {
        card = ev.trace;
        assert.strictEqual(card.kind, "edit");
        assert.match(card.diff, /\+ from the panel/);
        const ok = await json(base, "/core/code/approve", { method: "POST", body: { approvalId: card.approvalId, approved: true } });
        assert.strictEqual(ok.status, 200);
      }
    });
    assert.ok(card, "an approval card streamed out");
    assert.strictEqual(run.done.reason, "answered");
    assert.strictEqual(run.done.answer, "Wrote hello.txt for you.");
    assert.strictEqual(fs.readFileSync(path.join(project, "hello.txt"), "utf8"), "from the panel\n");

    // A dead card answers honestly, and stop is a route.
    const stale = await json(base, "/core/code/approve", { method: "POST", body: { approvalId: card.approvalId, approved: true } });
    assert.strictEqual(stale.status, 404);
    const stop = await json(base, "/core/code/stop", { method: "POST", body: { runId: "nope" } });
    assert.strictEqual(stop.body.stopped, false);
  } finally {
    delete process.env.FAKE_LLAMA_SCRIPT;
    await core.stop();
  }
});
