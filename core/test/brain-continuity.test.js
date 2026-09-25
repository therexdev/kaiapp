"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), { EventEmitter } = require("node:events");
const { CompanionHub, registerCompanionIPC } = require("../../electron/companion-hub");
const { CompanionStore } = require("../../electron/companion-store");
const Agents = require("../../ui/agents"), Mascot = require("../../ui/mascot-tools");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-continuity-")), key = crypto.randomBytes(32);
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(s) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, c.update(s), c.final(), c.getAuthTag()]); },
    decryptString(b) { const c = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12)); c.setAuthTag(b.subarray(-16)); return Buffer.concat([c.update(b.subarray(12, -16)), c.final()]).toString(); } };
  const options = { dataDir: dir, safeStorage, privacyMode: () => "local-only", canUseModel: m => ["local", "desktop:fixture"].includes(m), models: () => [], runLocal: async () => "unused", fetchImpl: async () => { throw Error("No network calls expected"); } };
  const hub = new CompanionHub(options); t.after(() => { hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (name, args, confirm = async () => true, signal) => hub.tool(name, args, "local", confirm, signal);
  return { hub, call, options, dir };
}
const memory = (hub, query = "launch") => hub.brain.memories({ query })[0];

test("memory corrections retain identity, tags, pins and source ownership across encrypted restart", async t => {
  const { hub, call, options, dir } = fixture(t);
  const original = hub.store.note({ title: "Launch", text: "Launch is Friday", category: "projects", tags: ["release"], pinned: true });
  hub.store.change(d => { d.notes[0].insightId = "reviewed-insight"; });
  const found = memory(hub); let preview;
  const result = await call("brain_update", { id: found.id, revision: found.revision, text: "Launch is Monday" }, async (_name, details, permission) => { preview = details; assert.equal(permission, undefined); return true; });
  assert.equal(preview.before.text, "Launch is Friday"); assert.equal(preview.after.text, "Launch is Monday"); assert.equal(result.updated, true);
  assert.equal(hub.store.data.notes.length, 1); const n = hub.store.data.notes[0];
  for (const field of ["id", "createdAt", "tags", "pinned", "source", "category"]) assert.deepEqual(n[field], original[field]);
  assert.equal(n.insightId, "reviewed-insight"); assert.equal(hub.store.data.brain.changes[0].kind, "modified");
  assert.equal(new CompanionStore(options).data.notes[0].text, "Launch is Monday");
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "companion-hub.json"), "utf8"), /Launch|Monday/);
});

test("memory corrections reject stale revisions, imported sources, declined and cancelled review", async t => {
  const { hub, call } = fixture(t); hub.store.note({ title: "Launch", text: "Friday" });
  const input = { ...memory(hub), text: "Monday" };
  await assert.rejects(call("brain_update", { ...input, revision: undefined }), /revision/);
  await assert.rejects(call("brain_update", input, async () => false), /declined/);
  const stop = new AbortController(); await assert.rejects(call("brain_update", input, async () => { stop.abort(); return true; }, stop.signal), /abort/i);
  assert.equal(hub.store.data.notes[0].text, "Friday");
  await assert.rejects(call("brain_update", input, async () => { hub.store.note({ ...hub.store.data.notes[0], title: "New launch title" }); return true; }), /changed/);
  assert.equal(hub.store.data.notes[0].text, "Friday");
  hub.importText("Source", "Imported launch facts"); const source = hub.store.data.notes.find(n => n.sourceId);
  await assert.rejects(call("brain_update", { id: source.id, revision: hub.brain.memoryResult(source).revision, text: "replace source" }), /Sources/);
  const long = hub.store.note({ title: "Long note", text: "a".repeat(1501) });
  await assert.rejects(call("brain_update", { id: long.id, revision: hub.brain.memoryResult(long).revision, text: "partial replacement" }), /full note/);
  assert.equal(hub.store.data.notes.find(n => n.id === long.id).text.length, 1501);
});

test("recalled source data reports sync failure and dates without exposing connection secrets or paths", async t => {
  const { hub, call } = fixture(t); hub.importText("Launch source", "Launch snapshot ".repeat(150));
  hub.store.change(d => { Object.assign(d.sources[0], { kind: "connection", lastSync: 1234567890000, error: "secret-error-value", variables: { token: "secret-variable" }, folder: "/private/folder" }); });
  const found = (await call("brain_search", { query: "launch" }))[0];
  assert.equal(found.provenance.status, "sync_failed"); assert.equal(found.provenance.lastSync, 1234567890000);
  assert.match(JSON.stringify(found).slice(0, 1200), /sync_failed/, "freshness survives the small-model observation budget");
  assert.equal(found.imported, true); assert.equal(found.provenance.sourceId, hub.store.data.sources[0].id);
  const context = hub.store.context("launch"); assert.match(context, /last sync failed/); assert.match(context, /not live app state/);
  assert.doesNotMatch(JSON.stringify(found) + context, /secret-error|secret-variable|private\/folder/);
});

test("tasks are goal-linked personal records; partial updates preserve details and persist", async t => {
  const { hub, call, options } = fixture(t); const goal = hub.store.goal({ title: "Ship launch" });
  const created = await call("brain_task", { operation: "create", changes: { title: "Review launch", detail: "Inspect the release checklist", due: "2026-10-01", goalId: goal.id } });
  assert.equal(created.task.goalTitle, "Ship launch");
  const found = (await call("brain_tasks", { query: "launch" })).tasks[0];
  const saved = await call("brain_task", { operation: "update", id: found.id, revision: found.revision, changes: { status: "done" } });
  assert.equal(saved.task.status, "done"); assert.equal(saved.task.detail, "Inspect the release checklist"); assert.equal(saved.task.due, "2026-10-01"); assert.equal(saved.task.goalId, goal.id);
  assert.equal((await call("brain_tasks", {})).tasks.length, 0);
  assert.equal((await call("brain_tasks", { status: "done" })).tasks[0].id, found.id);
  assert.equal(new CompanionStore(options).data.brain.tasks[0].status, "done");
  assert.equal(hub.store.data.runs.length, 0); assert.equal(hub.store.data.workflows.length, 0);
});

test("task validation, denial, cancellation and changed goal/task never apply unreviewed changes", async t => {
  const { hub, call } = fixture(t); let reviews = 0;
  const confirm = async () => { reviews++; return true; };
  for (const changes of [{ title: "Task", due: "2026-02-30" }, { title: "Task", due: "tomorrow" }, { title: "Task", status: "complete" }, { title: "Task", goalId: "missing" }, { title: "Task", runWorkflow: true }]) {
    await assert.rejects(call("brain_task", { operation: "create", changes }, confirm));
  }
  assert.equal(reviews, 0); assert.equal(hub.store.data.brain.tasks.length, 0);
  const goal = hub.store.goal({ title: "Goal" });
  const args = { operation: "create", changes: { title: "Task", goalId: goal.id } };
  await assert.rejects(call("brain_task", args, async () => false), /declined/);
  await assert.rejects(call("brain_task", args, async () => { hub.store.goal({ ...goal, title: "Changed" }); return true; }), /Goal changed/);
  const stop = new AbortController(); await assert.rejects(call("brain_task", args, async () => { stop.abort(); return true; }, stop.signal), /abort/i);
  assert.equal(hub.store.data.brain.tasks.length, 0);
  const task = (await call("brain_task", args)).task;
  const update = { operation: "update", id: task.id, revision: task.revision, changes: { status: "done" } };
  await assert.rejects(call("brain_task", update, async () => { hub.brain.task({ ...hub.store.data.brain.tasks[0], detail: "Changed in UI" }); return true; }), /Task changed/);
  assert.equal(hub.store.data.brain.tasks[0].status, "todo");
  await assert.rejects(call("brain_task", update), /revision/);
});

test("task lists are bounded and explicitly report omitted results", async t => {
  const { hub, call } = fixture(t);
  for (let i = 0; i < 22; i++) hub.brain.task({ title: "Launch " + i, detail: "x".repeat(800) });
  const result = await call("brain_tasks", {}); assert.equal(result.total, 22); assert.equal(result.tasks.length, 20); assert.equal(result.truncated, true);
  assert.equal(result.tasks[0].detail.length, 600); assert.equal(result.tasks[0].truncated, true);
  assert.match(result.notice, /does not schedule/);
});

test("routing exposes read-only task tools for reads and excludes mutations from unrelated requests", () => {
  const tools = ["brain_search", "brain_remember", "brain_update", "brain_forget", "brain_tasks", "brain_task", "brain_goals", "workflow_control", "connected_call", "web_search"].map(name => ({ name }));
  for (const q of ["What are my open tasks?", "Show my Brain tasks", "List my tasks due tomorrow"]) {
    const route = Agents.routeTurn(q); assert.equal(route.lane, "brain-tasks", q);
    assert.deepEqual(Agents.turnTools(tools, route).map(t => t.name), ["brain_tasks", "brain_goals"]);
  }
  for (const q of ["Add a Brain task to review the launch", "Add a Brain task to review Google Drive", "Mark my launch task as done", "Reopen my launch task", "Change my Brain task due date to tomorrow"]) {
    const route = Agents.routeTurn(q); assert.equal(route.lane, "brain-tasks", q); assert.ok(Agents.turnTools(tools, route).some(t => t.name === "brain_task"));
    assert.ok(!Agents.turnTools(tools, route).some(t => t.name === "workflow_control" || t.name === "connected_call"));
  }
  for (const q of ["Correct my saved memory: launch is Monday", "Update your memory that I live in Berlin", "Correct my remembered wallet address", "Update your memory about my preferred model"]) {
    const route = Agents.routeTurn(q); assert.equal(route.lane, "memory-write"); assert.ok(Agents.turnTools(tools, route).some(t => t.name === "brain_update"));
  }
  for (const q of ["Find a file", "What is my home town?", "Search the web for launch news", "Create a task in Todoist", "Run my workflow"]) {
    assert.ok(!Agents.turnTools(tools, Agents.routeTurn(q)).some(t => ["brain_update", "brain_task"].includes(t.name)), q);
  }
  assert.equal(Agents.routeTurn("Create a Google Doc from my Brain tasks").lane, "connected");
});

test("main chat and desktop KAI use the same Brain correction and task actions through trusted IPC", async t => {
  const { hub } = fixture(t), handlers = new Map();
  const windows = ["", "mascot.html"].map((route, i) => {
    const wc = new EventEmitter(); wc.id = i + 1; wc.mainFrame = { url: "http://127.0.0.1:41100/" + route }; wc.getURL = () => wc.mainFrame.url; wc.isDestroyed = () => false;
    const w = new EventEmitter(); w.webContents = wc; w.isDestroyed = () => false; w.isVisible = () => true; return w;
  });
  const reviews = [];
  const ipc = registerCompanionIPC({ ipcMain: { handle: (k, fn) => handlers.set(k, fn), removeHandler: k => handlers.delete(k) }, service: hub, origin: "http://127.0.0.1:41100", getMainWindow: () => windows[0], getMascotWindow: () => windows[1], dialog: { showMessageBox: async (_w, spec) => { reviews.push(spec); return { response: 1 }; } } });
  t.after(() => ipc.dispose()); hub.store.change(d => { d.settings.approvalGrants = [{ key: "brain:remember" }]; });
  for (const [i, w] of windows.entries()) {
    const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame };
    const json = async (url, input) => {
      const result = url === "/core/tools" ? await handlers.get("companion:tools")(event, "local") : await handlers.get("companion:tool")(event, JSON.parse(input.body).name, JSON.parse(input.body).args, "local");
      if (!result.ok) throw Error(result.error);
      return url === "/core/tools" ? { tools: result.result } : { ok: true, result: result.result };
    };
    const note = hub.store.note({ title: "Launch " + i, text: "Friday" }); let step = 0;
    const ask = async () => JSON.stringify(step++ === 0 ? { tool: "brain_search", args: { query: "Launch " + i } } : step === 2 ? { tool: "brain_update", args: { id: note.id, revision: hub.brain.memoryResult(hub.store.data.notes.find(n => n.id === note.id)).revision, text: "Monday" } } : { answer: true });
    const q = "Correct my saved memory: launch is Monday";
    if (i) await Mascot.run({ question: q, json, askModel: ask }); else await Agents.makeRuntime({ json, askModelOnce: ask }).runAgent(q, "local");
    assert.equal(hub.store.data.notes.find(n => n.id === note.id).text, "Monday");
    step = 0;
    const taskAsk = async () => JSON.stringify(step++ === 0 ? { tool: "brain_task", args: { operation: "create", changes: { title: "Review launch " + i } } } : { answer: true });
    const taskQ = "Add a Brain task to review the launch";
    if (i) await Mascot.run({ question: taskQ, json, askModel: taskAsk }); else await Agents.makeRuntime({ json, askModelOnce: taskAsk }).runAgent(taskQ, "local");
    assert.ok(hub.store.data.brain.tasks.some(x => x.title === "Review launch " + i));
  }
  assert.equal(reviews.length, 4, "remember grant does not grant corrections or task writes");
  assert.ok(reviews.every(r => r.buttons.length === 2));
  assert.deepEqual(hub.toolList("koinos-network"), []);
  await assert.rejects(hub.tool("brain_tasks", {}, "koinos-network", async () => true), /unavailable/);
});
