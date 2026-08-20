"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

/*
 * The multi-agent surface through the REAL stack (createCore + fake llama):
 * the developer gate, defs CRUD, a full SSE run, and the human-in-the-loop
 * round trip over HTTP — input-request out, /core/agents/input back in.
 */

async function json(base, pathname, { method = "GET", body } = {}) {
  const r = await fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** Stream an SSE POST, invoking onEvent per data frame as it ARRIVES —
 *  the HITL test answers an input-request while the response is open. */
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

test("multi-agent HTTP: gate, defs CRUD, an SSE run, and the HITL round trip", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-agents-"));
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
  const duo = {
    label: "writers",
    agents: [
      { name: "Drafter", systemPrompt: "You draft." },
      { name: "Critic", systemPrompt: "You critique." },
    ],
    termination: { maxMessages: 2, textMention: "" },
  };
  try {
    // ---- the whole surface is developer-gated ----
    let r = await json(base, "/core/agents/defs");
    assert.strictEqual(r.status, 403);
    assert.match(r.body.error, /Developer tools/);
    await json(base, "/core/dev", { method: "POST", body: { enabled: true } });

    // ---- defs CRUD: an unrunnable spec is refused with the exact rule ----
    r = await json(base, "/core/agents/defs", { method: "POST", body: { spec: { agents: [{ name: "Solo" }] } } });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /at least 2 agents/);
    r = await json(base, "/core/agents/defs", { method: "POST", body: { spec: duo } });
    assert.strictEqual(r.body.ok, true);
    const defId = r.body.def.id;
    r = await json(base, "/core/agents/defs");
    assert.strictEqual(r.body.defs.length, 1);
    assert.strictEqual(r.body.defs[0].label, "writers");

    // ---- a run by defId through the real engine chain ----
    const run = await sse(base, "/core/agents/run", { defId, task: "write a haiku", model: "dev-tiny" });
    assert.strictEqual(run.done.error, undefined);
    assert.deepStrictEqual(run.done.transcript.map((m) => m.name), ["task", "Drafter", "Critic"]);
    assert.strictEqual(run.done.transcript[1].content, "Hello from fake llama", "a REAL completion, not a mock");
    assert.strictEqual(run.done.modelCalls, 2);
    assert.match(run.done.reason, /message limit/);

    // ---- human in the loop over HTTP: answer while the stream is open ----
    const hitl = await sse(
      base,
      "/core/agents/run",
      {
        spec: {
          agents: [{ name: "Ana", human: true }, { name: "Bot" }],
          termination: { maxMessages: 2, textMention: "" },
        },
        task: "ask the person",
        model: "dev-tiny",
      },
      async (ev) => {
        if (ev.trace?.type === "input-request") {
          const ans = await json(base, "/core/agents/input", {
            method: "POST",
            body: { inputId: ev.trace.inputId, text: "the person's answer" },
          });
          assert.strictEqual(ans.body.ok, true);
        }
      }
    );
    assert.strictEqual(hitl.done.error, undefined);
    assert.deepStrictEqual(hitl.done.transcript.map((m) => m.name), ["task", "Ana", "Bot"]);
    assert.strictEqual(hitl.done.transcript[1].content, "the person's answer");
    // A stale input id answers 404, honestly.
    const stale = await json(base, "/core/agents/input", { method: "POST", body: { inputId: "deadbeef", text: "x" } });
    assert.strictEqual(stale.status, 404);

    // ---- delete ----
    r = await json(base, `/core/agents/defs/${defId}`, { method: "DELETE" });
    assert.strictEqual(r.body.removed, true);
    r = await json(base, "/core/agents/defs");
    assert.strictEqual(r.body.defs.length, 0);
  } finally {
    await core.stop();
  }
});
