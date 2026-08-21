"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

/*
 * Koinos Code projects + sessions (task #72): the store that turns a one-shot
 * command into a workspace. Unit tests cover the store's rules; the HTTP tests
 * drive the real stack and prove a run through a project becomes a session
 * whose earlier turns actually reach the model on the NEXT run.
 */

const { CodeProjects, validateDir } = require("../lib/code-projects");

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("a project folder is validated the same way the agent validates its root", () => {
  const dir = tmp("kai-proj-");
  assert.strictEqual(validateDir(dir), fs.realpathSync.native ? path.resolve(dir) : path.resolve(dir));
  assert.throws(() => validateDir(""), /full path/);
  assert.throws(() => validateDir("/definitely/not/here"), /does not exist/);
  const file = path.join(dir, "f.txt");
  fs.writeFileSync(file, "x");
  assert.throws(() => validateDir(file), /file, not a folder/);
  // The most expensive typo available.
  assert.throws(() => validateDir(path.parse(dir).root), /filesystem root/);
});

test("adding the same folder twice returns the project you already have", () => {
  const store = new CodeProjects(tmp("kai-store-"));
  const dir = tmp("kai-p-");
  const a = store.add({ dir, name: "first" });
  const b = store.add({ dir, name: "second" });
  assert.strictEqual(a.id, b.id, "same folder is the same project");
  assert.strictEqual(store.list().length, 1);
  // Re-adding is how people re-find things; it must not be an error.
  assert.strictEqual(store.list()[0].name, "first");
});

test("a project defaults to its folder's name, and can be renamed", () => {
  const store = new CodeProjects(tmp("kai-store-"));
  const dir = tmp("kai-named-");
  const p = store.add({ dir });
  assert.strictEqual(p.name, path.basename(dir));
  assert.strictEqual(store.rename(p.id, "  My App  ").name, "My App");
  assert.throws(() => store.rename(p.id, "   "), /give the project a name/);
  assert.throws(() => store.rename("nope", "x"), /no such project/);
});

test("forgetting a project never touches the folder", () => {
  const store = new CodeProjects(tmp("kai-store-"));
  const dir = tmp("kai-keep-");
  fs.writeFileSync(path.join(dir, "work.txt"), "months of work");
  const p = store.add({ dir });
  assert.strictEqual(store.remove(p.id), true);
  assert.strictEqual(store.list().length, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, "work.txt"), "utf8"), "months of work");
  assert.strictEqual(store.remove(p.id), false, "removing twice is not an error");
});

test("a folder that moved is flagged, not silently dropped", () => {
  const store = new CodeProjects(tmp("kai-store-"));
  const dir = tmp("kai-gone-");
  const p = store.add({ dir });
  assert.strictEqual(store.list()[0].missing, false);
  fs.rmSync(dir, { recursive: true, force: true });
  const row = store.list()[0];
  assert.strictEqual(row.id, p.id, "still listed");
  assert.strictEqual(row.missing, true, "and honest about why it cannot be used");
});

test("sessions: titled by the first thing asked, newest first, bounded", () => {
  const store = new CodeProjects(tmp("kai-store-"));
  const p = store.add({ dir: tmp("kai-s-") });
  const s = store.newSession(p.id, {});
  assert.strictEqual(s.title, "New session");
  store.appendTurn(p.id, s.id, { role: "user", content: "add a --version flag" });
  store.appendTurn(p.id, s.id, { role: "assistant", content: "done" });
  const list = store.sessions(p.id);
  assert.strictEqual(list[0].title, "add a --version flag");
  assert.strictEqual(list[0].turns, 2);
  assert.throws(() => store.appendTurn(p.id, s.id, { role: "system", content: "x" }), /user or assistant/);
  assert.strictEqual(store.deleteSession(p.id, s.id), true);
  assert.strictEqual(store.sessions(p.id).length, 0);
});

test("history is bounded by BOTH turn count and characters", () => {
  const store = new CodeProjects(tmp("kai-store-"));
  const p = store.add({ dir: tmp("kai-h-") });
  const s = store.newSession(p.id, {});
  for (let i = 0; i < 30; i++) {
    store.appendTurn(p.id, s.id, { role: "user", content: `ask ${i}` });
    store.appendTurn(p.id, s.id, { role: "assistant", content: "y".repeat(500) });
  }
  const h = store.history(p.id, s.id, { maxTurns: 6, maxChars: 800 });
  assert.ok(h.length <= 6, "turn cap holds");
  const chars = h.reduce((n, m) => n + m.content.length, 0);
  assert.ok(chars <= 800, `char cap holds, got ${chars}`);
  // The MOST RECENT turns are what survive — an old thread must not crowd out
  // what was just said.
  assert.match(h[h.length - 1].content, /^y+$/);
  // A session that does not exist is empty, not a throw: history is context,
  // and missing context must never take down a run.
  assert.deepStrictEqual(store.history(p.id, "nope"), []);
});

test("the store survives a restart", () => {
  const dataDir = tmp("kai-store-");
  const dir = tmp("kai-persist-");
  const a = new CodeProjects(dataDir);
  const p = a.add({ dir, name: "keeps" });
  const s = a.newSession(p.id, {});
  a.appendTurn(p.id, s.id, { role: "user", content: "remember me" });

  const b = new CodeProjects(dataDir);
  assert.strictEqual(b.list().length, 1);
  assert.strictEqual(b.list()[0].name, "keeps");
  assert.strictEqual(b.sessions(p.id)[0].title, "remember me");
  assert.deepStrictEqual(b.history(p.id, s.id), [{ role: "user", content: "remember me" }]);
});

// ---------------------------------------------------------------- HTTP tests

function coreDir() {
  const dataDir = tmp("kai-corep-");
  fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  return dataDir;
}

async function startCore(dataDir, replies, { record = false } = {}) {
  if (replies) {
    const script = path.join(dataDir, "script.json");
    fs.writeFileSync(script, JSON.stringify(replies));
    process.env.FAKE_LLAMA_SCRIPT = script;
  }
  if (record) process.env.FAKE_LLAMA_RECORD = path.join(dataDir, "requests.jsonl");
  const { createCore } = require("../server");
  const core = await createCore({
    dataDir,
    port: 0,
    llamaBin: path.join(__dirname, "fixtures", "fake-llama-server"),
    onEvent: () => {},
  });
  return { core, base: `http://127.0.0.1:${await core.start()}` };
}

async function j(base, p, opts = {}) {
  const r = await fetch(`${base}${p}`, { headers: { "content-type": "application/json" }, ...opts });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** Drive a run and collect the SSE frames. */
async function run(base, body) {
  const resp = await fetch(`${base}/core/code/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) return { status: resp.status, body: await resp.json().catch(() => ({})), frames: [] };
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  const frames = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        frames.push(JSON.parse(line.slice(6)));
      } catch {
        /* skip */
      }
    }
  }
  return { status: 200, frames, done: frames.find((f) => f.done), session: frames.find((f) => f.session)?.session };
}

test("HTTP: the switch gates every project route, and can be read while off", async () => {
  const dataDir = coreDir();
  const { core, base } = await startCore(dataDir);
  try {
    // Off by default on a fresh install (dev.tools is off, and the switch
    // seeds from it), and everything behind it refuses in words.
    assert.strictEqual((await j(base, "/core/code-switch")).body.enabled, false);
    for (const [p, opts] of [
      ["/core/code/projects", {}],
      ["/core/code/projects", { method: "POST", body: "{}" }],
      ["/core/code/run", { method: "POST", body: "{}" }],
    ]) {
      const r = await j(base, p, opts);
      assert.strictEqual(r.status, 403, `${p} must be gated`);
      assert.match(r.body.error, /Koinos Code is switched off/);
    }
    // The switch itself is reachable precisely when it is off — otherwise
    // there would be no way to turn it on.
    await j(base, "/core/code-switch", { method: "POST", body: JSON.stringify({ enabled: true }) });
    assert.strictEqual((await j(base, "/core/code-switch")).body.enabled, true);
    assert.strictEqual((await j(base, "/core/code/projects")).status, 200);
  } finally {
    await core.stop();
  }
});

test("HTTP: the switch seeds itself from Developer tools, so nobody loses access", async () => {
  // Koinos Code used to live behind the developer switch. Anyone who turned
  // that on to get it must still have it after the upgrade.
  const dataDir = coreDir();
  const { core, base } = await startCore(dataDir);
  try {
    await j(base, "/core/dev", { method: "POST", body: JSON.stringify({ enabled: true }) });
    // First read of the code switch happens now, with dev already on.
    assert.strictEqual((await j(base, "/core/code-switch")).body.enabled, true);
    // And it is independent from here: turning it off leaves dev tools alone.
    await j(base, "/core/code-switch", { method: "POST", body: JSON.stringify({ enabled: false }) });
    assert.strictEqual((await j(base, "/core/code-switch")).body.enabled, false);
    assert.strictEqual((await j(base, "/core/dev")).body.enabled, true);
  } finally {
    await core.stop();
  }
});

test("HTTP: a run through a project opens a session and records both turns", async () => {
  const dataDir = coreDir();
  const project = tmp("kai-run-");
  fs.writeFileSync(path.join(project, "a.txt"), "hello\n");
  const { core, base } = await startCore(dataDir, ['{"tool":"list_files","args":{}}', '{"answer":true}', "There is one file."]);
  try {
    await j(base, "/core/code-switch", { method: "POST", body: JSON.stringify({ enabled: true }) });
    const add = await j(base, "/core/code/projects", { method: "POST", body: JSON.stringify({ dir: project, name: "demo" }) });
    const pid = add.body.project.id;

    // No sessionId given: one is opened, and its id comes back on the stream
    // BEFORE the work starts, so the UI can attach to it.
    const r = await run(base, { projectId: pid, task: "what files are here", model: "dev-tiny" });
    assert.ok(r.session?.sessionId, "a session id streamed out");
    assert.strictEqual(r.done.answer, "There is one file.");
    assert.strictEqual(r.done.projectId, pid);

    const sessions = await j(base, `/core/code/projects/${pid}/sessions`);
    assert.strictEqual(sessions.body.sessions.length, 1);
    assert.strictEqual(sessions.body.sessions[0].title, "what files are here");
    assert.strictEqual(sessions.body.sessions[0].turns, 2);
  } finally {
    delete process.env.FAKE_LLAMA_SCRIPT;
    await core.stop();
  }
});

test("HTTP: the SECOND run in a session actually carries the first — that is the whole point", async () => {
  const dataDir = coreDir();
  const project = tmp("kai-mem-");
  const { core, base } = await startCore(
    dataDir,
    ['{"answer":true}', "First answer.", '{"answer":true}', "Second answer."],
    { record: true }
  );
  try {
    await j(base, "/core/code-switch", { method: "POST", body: JSON.stringify({ enabled: true }) });
    const pid = (await j(base, "/core/code/projects", { method: "POST", body: JSON.stringify({ dir: project }) })).body.project.id;

    const first = await run(base, { projectId: pid, task: "rename the widget to gadget", model: "dev-tiny" });
    const sid = first.session.sessionId;
    const second = await run(base, { projectId: pid, sessionId: sid, task: "now do the same in the tests", model: "dev-tiny" });
    assert.strictEqual(second.done.answer, "Second answer.");

    const sent = fs
      .readFileSync(path.join(dataDir, "requests.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // The FIRST run must not carry history — there was none.
    const firstSystem = sent[0].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    assert.ok(!/EARLIER IN THIS SESSION/.test(firstSystem), "a fresh session carries no history");

    // The LAST run must carry it, or "do the same" means nothing.
    const lastSystem = sent[sent.length - 1].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    assert.match(lastSystem, /EARLIER IN THIS SESSION/);
    assert.match(lastSystem, /rename the widget to gadget/);
    assert.match(lastSystem, /First answer\./);
    // Framed as context, never as work to repeat.
    assert.match(lastSystem, /already done, do not redo/);
  } finally {
    delete process.env.FAKE_LLAMA_SCRIPT;
    delete process.env.FAKE_LLAMA_RECORD;
    await core.stop();
  }
});

test("HTTP: a bare dir still works — the CLI and older scripts are untouched", async () => {
  const dataDir = coreDir();
  const project = tmp("kai-bare-");
  const { core, base } = await startCore(dataDir, ['{"answer":true}', "Bare answer."]);
  try {
    await j(base, "/core/code-switch", { method: "POST", body: JSON.stringify({ enabled: true }) });
    const r = await run(base, { dir: project, task: "anything", model: "dev-tiny" });
    assert.strictEqual(r.done.answer, "Bare answer.");
    assert.strictEqual(r.done.projectId, null, "no project was invented");
    // And nothing was silently added to the project list.
    assert.strictEqual((await j(base, "/core/code/projects")).body.projects.length, 0);
  } finally {
    delete process.env.FAKE_LLAMA_SCRIPT;
    await core.stop();
  }
});

test("HTTP: a proxied request is refused on the project routes too", async () => {
  // Adding a project chooses where the agent may write — exactly as powerful
  // as starting a run, and gated identically.
  const dataDir = coreDir();
  const { core, base } = await startCore(dataDir);
  try {
    await j(base, "/core/code-switch", { method: "POST", body: JSON.stringify({ enabled: true }) });
    const r = await fetch(`${base}/core/code/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({ dir: tmp("kai-x-") }),
    });
    assert.strictEqual(r.status, 403);
    assert.match((await r.json()).error, /KAI_CORE_TOKEN/);
  } finally {
    await core.stop();
  }
});

test("browse: directories only, never files — and it starts somewhere sane", () => {
  const { browseDir } = require("../lib/code-projects");
  // No path: sensible starting points, not the filesystem root.
  const start = browseDir("");
  assert.strictEqual(start.start, true);
  assert.ok(start.entries.some((e) => e.name === "Home"));

  const dir = tmp("kai-browse-");
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, ".hidden"));
  fs.writeFileSync(path.join(dir, "secret-notes.txt"), "x");
  const out = browseDir(dir);

  const names = out.entries.map((e) => e.name);
  assert.deepStrictEqual(names, ["src", ".hidden"], "directories only, dot-folders last");
  // The point of directories-only: it cannot be used to enumerate documents.
  assert.ok(!JSON.stringify(out).includes("secret-notes.txt"), "file names are never disclosed");
  assert.strictEqual(out.parent, path.dirname(dir));

  assert.throws(() => browseDir(path.join(dir, "secret-notes.txt")), /file, not a folder/);
  assert.throws(() => browseDir("/definitely/not/here"), /does not exist/);
});

test("HTTP: browse is gated by the switch and refuses proxied callers", async () => {
  const dataDir = coreDir();
  const { core, base } = await startCore(dataDir);
  try {
    const off = await j(base, "/core/code/browse", { method: "POST", body: JSON.stringify({ dir: "" }) });
    assert.strictEqual(off.status, 403);
    assert.match(off.body.error, /Koinos Code is switched off/);

    await j(base, "/core/code-switch", { method: "POST", body: JSON.stringify({ enabled: true }) });
    const on = await j(base, "/core/code/browse", { method: "POST", body: JSON.stringify({ dir: "" }) });
    assert.strictEqual(on.status, 200);
    assert.ok(on.body.entries.length > 0);

    const proxied = await fetch(`${base}/core/code/browse`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({ dir: "" }),
    });
    assert.strictEqual(proxied.status, 403);
    assert.match((await proxied.json()).error, /KAI_CORE_TOKEN/);
  } finally {
    await core.stop();
  }
});
