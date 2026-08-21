"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFile } = require("child_process");

/*
 * Koinos Code (task #60) — the CLI against a SCRIPTED OpenAI-shaped gateway,
 * so every loop decision is deterministic: the write flow with --yes, the
 * path jail, the command gate (refused headless without --allow-commands,
 * runs with it), and the {"answer": true} closing handshake.
 */

const CLI = path.join(__dirname, "..", "..", "cli", "koinos-code.js");
const { jailed, unifiedDiff, makeTools, projectContext, runTeam } = require(CLI);

function fakeGateway(replies) {
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/models") {
        res.end(JSON.stringify({ object: "list", data: [{ id: "scripted" }] }));
        return;
      }
      bodies.push(JSON.parse(raw || "{}"));
      const content = replies.length ? replies.shift() : '{"answer": true}';
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, bodies, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

function runCli(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code ?? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kai-code-"));
}

test("jailed: inside stays, any escape is null", () => {
  const root = "/tmp/proj";
  assert.strictEqual(jailed(root, "a/b.txt"), "/tmp/proj/a/b.txt");
  assert.strictEqual(jailed(root, "."), "/tmp/proj");
  assert.strictEqual(jailed(root, "../other"), null);
  assert.strictEqual(jailed(root, "a/../../etc/passwd"), null);
  assert.strictEqual(jailed(root, "/etc/passwd"), null);
  assert.strictEqual(jailed(root, "/tmp/projX/file"), null, "prefix trickery does not escape");
});

test("unifiedDiff: additions, removals, context, and the no-change case", () => {
  const d = unifiedDiff("one\ntwo\nthree\nfour\nfive\nsix\nseven", "one\ntwo\nTHREE\nfour\nfive\nsix\nseven");
  assert.match(d, /^- three$/m);
  assert.match(d, /^\+ THREE$/m);
  assert.match(d, /^ {2}two$/m, "context line kept");
  assert.ok(!/seven/.test(d), "far-away lines elided");
  assert.strictEqual(unifiedDiff("same", "same"), "(no changes)");
});

test("tools directly: read_file windows with line numbers; search finds; both jailed", async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "a.txt"), "alpha\nbravo NEEDLE\ncharlie");
  const tools = makeTools(dir, { yes: true, allowCommands: false });
  const read = tools.find((t) => t.name === "read_file");
  const search = tools.find((t) => t.name === "search_files");
  assert.match(await read.handler({ path: "a.txt" }), /2\tbravo NEEDLE/);
  assert.match(await read.handler({ path: "../nope" }), /refused: path escapes/);
  assert.match(await search.handler({ query: "needle" }), /a\.txt:2: bravo NEEDLE/);
});

test("e2e: write_file with --yes writes the file and the answer lands on stdout", async () => {
  const dir = tmpProject();
  const g = await fakeGateway([
    '{"tool": "write_file", "args": {"path": "hello.txt", "content": "HI\\n"}}',
    "Created hello.txt with a greeting.",
  ]);
  try {
    const r = await runCli(["--url", g.base, "--model", "scripted", "--dir", dir, "--yes", "create hello.txt"], dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(path.join(dir, "hello.txt"), "utf8"), "HI\n");
    assert.match(r.stdout, /Created hello\.txt with a greeting\./);
    assert.match(r.stdout, /\+ HI/, "the diff was shown before writing");
  } finally {
    g.srv.close();
  }
});

test("e2e: the jail refuses an escape and the refusal reaches the model as an observation", async () => {
  const dir = tmpProject();
  const g = await fakeGateway([
    '{"tool": "write_file", "args": {"path": "../escape.txt", "content": "pwned"}}',
    "done",
  ]);
  try {
    const r = await runCli(["--url", g.base, "--model", "scripted", "--dir", dir, "--yes", "write outside"], dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(fs.existsSync(path.join(dir, "..", "escape.txt")), false, "nothing written outside the project");
    const second = JSON.stringify(g.bodies[1] || {});
    assert.match(second, /refused: path escapes the project directory/, "the model was told, honestly");
  } finally {
    g.srv.close();
  }
});

test("e2e: run_cmd is refused headless without --allow-commands, runs with it", async () => {
  const dir = tmpProject();
  const script = () => ['{"tool": "run_cmd", "args": {"cmd": "echo made > marker.txt"}}', "finished"];

  const denied = await fakeGateway(script());
  try {
    const r = await runCli(["--url", denied.base, "--model", "scripted", "--dir", dir, "--yes", "make a marker"], dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(fs.existsSync(path.join(dir, "marker.txt")), false, "no TTY, no flag -> the command NEVER ran");
    assert.match(JSON.stringify(denied.bodies[1] || {}), /--allow-commands/, "the refusal names the way out");
  } finally {
    denied.srv.close();
  }

  const allowed = await fakeGateway(script());
  try {
    const r = await runCli(["--url", allowed.base, "--model", "scripted", "--dir", dir, "--allow-commands", "make a marker"], dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(fs.existsSync(path.join(dir, "marker.txt")), true, "explicit flag -> the command ran");
    assert.match(JSON.stringify(allowed.bodies[1] || {}), /exit 0/, "the exit code came back as the observation");
  } finally {
    allowed.srv.close();
  }
});

test('e2e: {"answer": true} triggers one closing completion for the final prose', async () => {
  const dir = tmpProject();
  const g = await fakeGateway(['{"answer": true}', "All finished."]);
  try {
    const r = await runCli(["--url", g.base, "--model", "scripted", "--dir", dir, "say when done"], dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /All finished\./);
    const closing = JSON.stringify(g.bodies[1] || {});
    assert.match(closing, /final answer to the task now/, "the closing handshake asked for plain text");
  } finally {
    g.srv.close();
  }
});

/* ------------------------------------------------------------ v2 below ---- */

test("projectContext: absent -> empty; present -> framed notes; huge -> truncated honestly", () => {
  const dir = tmpProject();
  assert.strictEqual(projectContext(dir), "");
  fs.writeFileSync(path.join(dir, "KOINOS.md"), "Use tabs. Never touch vendor/.");
  const ctx = projectContext(dir);
  assert.match(ctx, /Project notes from KOINOS\.md/);
  assert.match(ctx, /Use tabs\. Never touch vendor\//);
  fs.writeFileSync(path.join(dir, "KOINOS.md"), "x".repeat(9000));
  assert.match(projectContext(dir), /truncated at 4000 chars/);
});

test("edit_file: exactly-once replaces; zero and many matches refuse with a way forward; jail holds", async () => {
  const dir = tmpProject();
  const file = path.join(dir, "code.js");
  fs.writeFileSync(file, "const a = 1;\nconst b = 2;\nconst c = 1;\n");
  const tools = makeTools(dir, { yes: true, allowCommands: false });
  const edit = tools.find((t) => t.name === "edit_file");

  assert.match(await edit.handler({ path: "code.js", find: "const b = 2;", replace: "const b = 20;" }), /wrote code\.js/);
  assert.strictEqual(fs.readFileSync(file, "utf8"), "const a = 1;\nconst b = 20;\nconst c = 1;\n");

  assert.match(await edit.handler({ path: "code.js", find: "const z = 9;", replace: "x" }), /not found: that exact text/);
  assert.match(await edit.handler({ path: "code.js", find: "= 1;", replace: "= 7;" }), /ambiguous: that text occurs 2 times/);
  assert.strictEqual(fs.readFileSync(file, "utf8"), "const a = 1;\nconst b = 20;\nconst c = 1;\n", "refusals changed nothing");

  assert.match(await edit.handler({ path: "missing.js", find: "a", replace: "b" }), /use write_file to create one/);
  assert.match(await edit.handler({ path: "../esc.js", find: "a", replace: "b" }), /refused: path escapes/);
});

test("e2e: KOINOS.md notes ride in the system prompt of every task", async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "KOINOS.md"), "HOUSE-RULE-MARKER: two-space indent everywhere.");
  const g = await fakeGateway(["The rules are noted."]);
  try {
    const r = await runCli(["--url", g.base, "--model", "scripted", "--dir", dir, "what are the project rules?"], dir);
    assert.strictEqual(r.code, 0, r.stderr);
    const system = String(g.bodies[0]?.messages?.[0]?.content || "");
    assert.match(system, /Project notes from KOINOS\.md/);
    assert.match(system, /HOUSE-RULE-MARKER/);
    assert.match(r.stdout, /KOINOS\.md found/, "the person is told the notes are in play");
  } finally {
    g.srv.close();
  }
});

test("e2e: a scripted surgical edit lands via edit_file with the diff shown", async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "app.js"), "function greet() {\n  return \"hi\";\n}\n");
  const g = await fakeGateway([
    '{"tool": "edit_file", "args": {"path": "app.js", "find": "return \\"hi\\";", "replace": "return \\"hello\\";"}}',
    "Changed the greeting.",
  ]);
  try {
    const r = await runCli(["--url", g.base, "--model", "scripted", "--dir", dir, "--yes", "change the greeting"], dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(path.join(dir, "app.js"), "utf8"), "function greet() {\n  return \"hello\";\n}\n");
    assert.match(r.stdout, /-\s+return "hi";/, "old line in the diff");
    assert.match(r.stdout, /\+\s+return "hello";/, "new line in the diff");
  } finally {
    g.srv.close();
  }
});

/** OpenAI-shaped /v1 plus a scripted /core/teams/run SSE endpoint. */
function fakeTeamsGateway({ answer }) {
  const teamBodies = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ object: "list", data: [{ id: "scripted" }] }));
        return;
      }
      if (req.url === "/core/teams/run") {
        teamBodies.push(JSON.parse(raw || "{}"));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ trace: { stage: "team", detail: "Write & review on: …" } })}\n\n`);
        res.write(`data: ${JSON.stringify({ trace: { stage: "writer", detail: "drafting" } })}\n\n`);
        res.write(`data: ${JSON.stringify({ done: true, answer, modelCalls: 3 })}\n\n`);
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, teamBodies, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test("e2e: --team review streams the trace and prints the team's answer", async () => {
  const dir = tmpProject();
  const g = await fakeTeamsGateway({ answer: "PLAN: three steps, smallest first." });
  try {
    const r = await runCli(["--url", g.base, "--dir", dir, "--team", "review", "plan the refactor"], dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[writer\] drafting/, "trace streamed live");
    assert.match(r.stdout, /PLAN: three steps, smallest first\./);
    assert.strictEqual(g.teamBodies[0].template, "review");
    assert.strictEqual(g.teamBodies[0].question, "plan the refactor");
    assert.strictEqual(g.teamBodies[0].model, "scripted");
    assert.strictEqual(g.teamBodies[0].allowSensitive, false);
  } finally {
    g.srv.close();
  }
});

test("e2e against a REAL core: --team review rides /core/teams/run end to end", async () => {
  const dir = tmpProject();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-code-core-"));
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
  try {
    const r = await runCli(["--url", base, "--dir", dir, "--model", "dev-tiny", "--team", "review", "write one friendly line"], dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /Hello from fake llama/, "the team's answer came back through the real gateway");
    assert.match(r.stdout, /\[team\]/, "the trace streamed live");
  } finally {
    await core.stop();
  }
});

test("runTeam: unknown template and headless analyst both refuse with the way out", async () => {
  const opts = { url: "http://127.0.0.1:1", key: "", model: "m", allowCommands: false };
  await assert.rejects(() => runTeam(opts, "chaos", "task"), /unknown team template "chaos"/);
  await assert.rejects(() => runTeam(opts, "analyst", "task", { interactive: false }), /--allow-commands/);
});

test("e2e: no default model on the gateway is a clear error, not a hang", async () => {
  const dir = tmpProject();
  const srv = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ object: "list", data: [] }));
  });
  const base = await new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${srv.address().port}`)));
  try {
    const r = await runCli(["--url", base, "--dir", dir, "do something"], dir);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.stderr, /lists no models/);
  } finally {
    srv.close();
  }
});
