"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CodeRunner } = require("../lib/code-runner");
const { ToolRegistry } = require("../lib/tools");
const { registerBuiltinTools } = require("../lib/builtin-tools");

/*
 * The code sandbox (task #58). Every security claim in code-runner.js gets
 * its own test here — the sandbox is the feature, so the sandbox is what
 * gets pinned. Layout mirrors production: dataDir holds a fake keystore
 * OUTSIDE the workspace; the workspace is the only world the script sees.
 */

function makeDirs() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-coderun-"));
  const workspaceDir = path.join(dataDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "keystore.json"), JSON.stringify({ secret: "WALLET-SECRET-DO-NOT-READ" }));
  return { dataDir, workspaceDir };
}

const runner = () => new CodeRunner({ workspaceDir: makeDirs().workspaceDir });

test("run_code: availability probe finds a sandboxing node", () => {
  const r = runner();
  assert.deepStrictEqual(r.availability(), { ok: true });
});

test("run_code: computes, prints, and reads workspace files — the happy loop", async () => {
  const { workspaceDir } = makeDirs();
  fs.writeFileSync(path.join(workspaceDir, "numbers.txt"), "3\n4\n5\n");
  const r = new CodeRunner({ workspaceDir });
  const out = await r.run(`
    const fs = require("fs");
    const nums = fs.readFileSync("numbers.txt", "utf8").trim().split("\\n").map(Number);
    console.log("sum of squares:", nums.reduce((a, n) => a + n * n, 0));
  `);
  assert.match(out, /exit 0/);
  assert.match(out, /sum of squares: 50/);
});

test("run_code: scripts write INSIDE the workspace, and only there", async () => {
  const { dataDir, workspaceDir } = makeDirs();
  const r = new CodeRunner({ workspaceDir });
  const ok = await r.run(`require("fs").writeFileSync("made-by-script.txt", "hello"); console.log("wrote");`);
  assert.match(ok, /exit 0/);
  assert.strictEqual(fs.readFileSync(path.join(workspaceDir, "made-by-script.txt"), "utf8"), "hello");

  const escape = await r.run(`
    try { require("fs").writeFileSync(${JSON.stringify(path.join(dataDir, "escape.txt"))}, "pwned"); console.log("WROTE OUTSIDE"); }
    catch (e) { console.log("refused:", e.code || e.message); }
  `);
  assert.doesNotMatch(escape, /WROTE OUTSIDE/);
  assert.match(escape, /refused/);
  assert.ok(!fs.existsSync(path.join(dataDir, "escape.txt")), "nothing landed outside the workspace");
});

test("run_code: the wallet keystore is UNREADABLE from inside", async () => {
  const { dataDir, workspaceDir } = makeDirs();
  const r = new CodeRunner({ workspaceDir });
  const out = await r.run(`
    try { console.log("LEAK:", require("fs").readFileSync(${JSON.stringify(path.join(dataDir, "keystore.json"))}, "utf8")); }
    catch (e) { console.log("refused:", e.code || e.message); }
  `);
  assert.doesNotMatch(out, /WALLET-SECRET/);
  assert.match(out, /refused/);
});

test("run_code: no child processes", async () => {
  const out = await runner().run(`
    try { require("child_process").execSync("id"); console.log("SPAWNED"); }
    catch (e) { console.log("refused:", e.code || e.message); }
  `);
  assert.doesNotMatch(out, /SPAWNED/);
  assert.match(out, /refused/);
});

test("run_code: the network is patched out — fetch, http, raw sockets", async () => {
  const out = await runner().run(`
    (async () => {
      try { await fetch("https://example.com"); console.log("FETCHED"); }
      catch (e) { console.log("fetch refused:", e.message); }
      try { require("http").request("http://example.com"); console.log("HTTP OK"); }
      catch (e) { console.log("http refused:", e.message); }
      // Constructing a Socket is legal (node's own stdio uses one); the
      // network act — connecting — is what must throw.
      try { new (require("net").Socket)().connect(80, "example.com"); console.log("CONNECTED"); }
      catch (e) { console.log("net refused:", e.message); }
    })();
  `);
  assert.doesNotMatch(out, /FETCHED|HTTP OK|CONNECTED/);
  assert.match(out, /fetch refused: network access is disabled/);
  assert.match(out, /http refused: network access is disabled/);
  assert.match(out, /net refused: network access is disabled/);
});

test("run_code: an infinite loop is killed at the timeout", async () => {
  const started = Date.now();
  const out = await runner().run("for(;;){}", { timeoutSec: 1 });
  assert.match(out, /TIMED OUT after 1s/);
  assert.ok(Date.now() - started < 10000, "the kill was prompt, not the 30s default");
});

test("run_code: a print flood is truncated, not returned whole", async () => {
  const out = await runner().run(`for (let i = 0; i < 200000; i++) console.log("x".repeat(50));`, { timeoutSec: 20 });
  assert.match(out, /\[stdout truncated at \d+ bytes\]/);
  assert.ok(out.length < 40000, "the report stays model-context sized");
});

test("run_code: registered sensitive — code NEVER runs without explicit confirmation", async () => {
  const { dataDir } = makeDirs();
  const registry = new ToolRegistry({ privacyMode: () => "local-only" });
  registerBuiltinTools(registry, { dataDir });
  // Listed even in Local-Only: the sandbox has no egress.
  assert.ok(registry.list().some((t) => t.name === "run_code"), "available offline — nothing leaves the machine");
  await assert.rejects(
    () => registry.call("run_code", { code: "console.log(1)" }),
    (e) => e.needsConfirmation === true,
    "unconfirmed call is refused by the policy layer, server-side"
  );
  const out = await registry.call("run_code", { code: "console.log(6*7)" }, { confirmed: true });
  assert.match(out, /42/);
});
