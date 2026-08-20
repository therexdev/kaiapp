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
const { jailed, unifiedDiff, makeTools } = require(CLI);

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
