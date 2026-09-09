"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto"), vm = require("vm");
const { CompanionHub } = require("../../electron/companion-hub");
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-brain-")), key = crypto.randomBytes(32), iv = crypto.randomBytes(16);
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => { const c = crypto.createCipheriv("aes-256-cbc", key, iv); return Buffer.concat([c.update(s), c.final()]); }, decryptString: b => { const c = crypto.createDecipheriv("aes-256-cbc", key, iv); return Buffer.concat([c.update(b), c.final()]).toString(); } };
  let privacy = "local-first", calls = [];
  const options = { dataDir: dir, safeStorage, privacyMode: () => privacy, models: () => [{ alias: "local", status: "ready" }], canUseModel: () => true, runLocal: async p => { calls.push(p); return JSON.stringify({ decision: "review", summary: "A grounded local summary.", insights: [{ title: "Next step", text: "Review the launch notes.", kind: "task" }] }); }, ...extra };
  const hub = new CompanionHub(options); t.after(() => { hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { hub, dir, options, calls, privacy: p => { privacy = p; } };
}
const settings = (more = {}) => ({ mode: "observe", model: "local", includeNotes: true, includeGoals: false, sourceIds: [], events: true, intervalMinutes: 20, maxPerHour: 6, ...more });
test("catalog bundles the same 1,516 unique apps, fixed categories, and honest auth metadata for either project", () => {
  const box = { window: {} }; vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../../ui/connection-catalog.js"), "utf8"), box);
  const d = box.window.KaiConnectionCatalog; assert.equal(d.items.length, 1516); assert.equal(new Set(d.items.map(i => i.slug)).size, 1516); assert.equal(d.categories.length, 8);
  for (const i of d.items) { assert.ok(d.categories.some(c => c.id === i.category)); assert.equal(typeof i.toolCount, "number"); assert.ok(Array.isArray(i.authSchemes)); }
  for (const slug of ["apaleo", "blackbaud", "google_analytics", "google_search_console", "googlesuper", "ticktick", "zoho_books", "zoho_mail", "digital_ocean", "slackbot", "prisma", "convex", "servicem8", "ynab", "zoom"]) assert.ok(d.items.some(i => i.slug === slug), slug);
  assert.ok(d.items.find(i => i.slug === "convex").authSchemes.includes("API_KEY"));
});
test("Brain indexes source/topic provenance, keeps unchanged chunks stable and records bounded encrypted diffs", t => {
  const { hub, dir } = fixture(t); hub.importText("Launch notes", "Launch planning and launch milestones.\n".repeat(100));
  const first = hub.store.data.notes[0], changes = hub.store.data.brain.changes.length;
  hub.importText("Launch notes", "Launch planning and launch milestones.\n".repeat(100)); assert.equal(hub.store.data.brain.changes.length, changes);
  hub.importText("Launch notes", "Launch planning and launch milestones.\n".repeat(100) + "Next date confirmed.");
  assert.deepEqual(hub.store.data.notes[0], first); assert.equal(hub.store.data.brain.changes[0].kind, "modified");
  const index = hub.brain.index(); assert.ok(index.topics.some(t => t.name === "launch")); assert.ok(index.edges.length); assert.equal(index.metrics.sources, 1);
  const sourceId = hub.store.data.sources[0].id; assert.ok(hub.brain.search({ query: "launch", sourceId }).every(n => n.sourceId === sourceId));
  assert.ok(!fs.readFileSync(hub.store.file, "utf8").includes("Next date"));
  hub.brain.checkpoint("Launch reviewed"); assert.equal(hub.brain.index().metrics.changes, 0);
  const exported = hub.brain.exportVault(dir); assert.ok(fs.readFileSync(path.join(exported.folder, "KAI Brain.md"), "utf8").includes("[[Sources/"));
  const second = hub.brain.exportVault(dir); assert.notEqual(second.folder, exported.folder); assert.equal(fs.readdirSync(path.join(exported.folder, "Memories")).length, hub.store.data.notes.length);
});
test("Awareness is opt-in, rejects remote/provider models, and scopes local reasoning to selected memory", async t => {
  const { hub, calls } = fixture(t); hub.store.note({ text: "Launch notes are ready.", title: "Launch notes" }); hub.importText("Unselected secret project", "Unshared project instructions and plans.");
  await hub.awareness.tick({ force: true }); assert.equal(calls.length, 0); assert.throws(() => hub.awareness.enqueue(), /Turn on/);
  for (const model of ["desktop:openai:gpt", "koinos-network", "missing"]) assert.throws(() => hub.awareness.settings(settings({ model })), /local model/);
  hub.awareness.settings(settings()); await hub.awareness.tick({ force: true });
  assert.equal(calls.length, 1); assert.match(calls[0].prompt, /Launch notes/); assert.ok(!calls[0].prompt.includes("Unshared project"));
  assert.equal(hub.store.data.notes.length, 2, "proposals cannot become facts without review");
  const insight = hub.store.data.brain.insights[0]; assert.equal(insight.status, "pending"); assert.equal(insight.noteIds.length, 1);
  hub.brain.review({ id: insight.id, decision: "task" }); assert.equal(hub.store.data.brain.tasks.length, 1); assert.throws(() => hub.brain.review({ id: insight.id, decision: "remember" }), /already been reviewed/);
});
test("Awareness has one worker, bounded promotions, and discards results after scope changes or stop", async t => {
  let resolve; const { hub } = fixture(t, { runLocal: () => new Promise(r => { resolve = r; }) }); hub.store.note({ text: "Private task", title: "Task" }); hub.awareness.settings(settings({ maxPerHour: 1 }));
  const run = hub.awareness.tick({ force: true }); await hub.awareness.tick({ force: true }); assert.equal(hub.store.data.brain.activity.filter(a => a.type === "started").length, 1);
  hub.awareness.settings(settings({ mode: "off" })); resolve(JSON.stringify({ decision: "review", summary: "Discard me", insights: [{ title: "Discard", text: "Cancelled data" }] })); await run;
  assert.equal(hub.store.data.brain.insights.length, 0); assert.equal(hub.awareness.active, null);
  hub.awareness.settings(settings({ model: "", maxPerHour: 1 })); await hub.awareness.tick({ force: true }); assert.equal(hub.store.data.brain.activity.filter(a => a.type === "started").length, 1, "manual checks respect hourly budget");
});
test("source changes during inference supersede stale results and are picked up by the next check", async t => {
  let resolve; const { hub } = fixture(t, { runLocal: () => new Promise(r => { resolve = r; }) }); const n = hub.store.note({ text: "Old launch date", title: "Launch" }); hub.awareness.settings(settings());
  const first = hub.awareness.tick({ force: true }); hub.store.note({ ...n, text: "New launch date" }); resolve(JSON.stringify({ decision: "review", summary: "Old", insights: [] })); await first;
  assert.equal(hub.store.data.brain.insights.length, 0); assert.ok(hub.store.data.brain.jobs.some(j => j.status === "superseded")); assert.equal(hub.store.data.brain.awareness.fingerprint, "");
  const second = hub.awareness.tick(); resolve(JSON.stringify({ decision: "skip", summary: "Current", insights: [] })); await second;
  // The queued old briefing also gets superseded; the current reflection remains queued.
  assert.ok(hub.store.data.brain.jobs.some(j => j.fingerprint === hub.awareness.fingerprint()));
});
test("failed analysis retries three times without advancing its content cursor or flooding the queue", async t => {
  const { hub } = fixture(t, { runLocal: async () => { throw new Error("Synthetic failure"); } }); hub.store.note({ title: "Task", text: "Review this task" }); hub.awareness.settings(settings());
  await hub.awareness.tick({ force: true }); const first = hub.store.data.brain.jobs.find(j => j.kind === "reflection");
  assert.equal(hub.store.data.brain.awareness.fingerprint, ""); assert.equal(hub.store.data.brain.awareness.lastTick, 0);
  for (let i = 0; i < 3; i++) { hub.store.change(d => { for (const j of d.brain.jobs) j.retryAt = 0; }); await hub.awareness.tick(); }
  assert.equal(hub.store.data.brain.jobs.find(j => j.id === first.id).status, "failed");
  const count = hub.store.data.brain.jobs.length; hub.awareness.enqueue(); assert.equal(hub.store.data.brain.jobs.length, count);
});
test("unfinished read jobs recover after restart and source deletion purges derived history and briefing", async t => {
  const { hub, options } = fixture(t); hub.importText("Project source", "Launch plans and milestones"); const sourceId = hub.store.data.sources[0].id;
  hub.awareness.settings(settings({ includeNotes: false, sourceIds: [sourceId] })); await hub.awareness.tick({ force: true });
  const insight = hub.store.data.brain.insights[0]; hub.brain.review({ id: insight.id, decision: "remember" });
  hub.store.change(d => { d.brain.jobs[0].status = "running"; d.brain.briefing = { text: "Launch plans", noteIds: [d.notes[0].id] }; });
  const restarted = new CompanionHub(options); assert.ok(restarted.store.data.brain.jobs.some(j => j.status === "queued"));
  restarted.store.remove("sources", sourceId); assert.equal(restarted.store.data.notes.length, 0); assert.equal(restarted.store.data.brain.insights.length, 0); assert.equal(restarted.store.data.brain.changes.length, 0); assert.equal(restarted.store.data.brain.briefing, undefined); assert.equal(restarted.store.data.brain.jobs.length, 0); restarted.stop();
});
test("folder sources honor explicit roots, exclude links and secrets, dedupe updates and cap reads", async t => {
  const { hub, dir } = fixture(t); const folder = path.join(dir, "chosen"); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, "plan.md"), "Launch details"); fs.writeFileSync(path.join(folder, "passwords.txt"), "Do not ingest"); fs.mkdirSync(path.join(folder, ".hidden")); fs.writeFileSync(path.join(folder, ".hidden", "note.md"), "Hidden data");
  if (process.platform !== "win32") fs.symlinkSync(path.join(dir, "companion-hub.json"), path.join(folder, "linked.md"));
  assert.throws(() => hub.sources.save({ kind: "folder", name: "No grant" }), /folder picker/);
  const s = hub.sources.save({ kind: "folder", name: "Selected notes", recursive: true, extensions: "md,txt" }, folder); await hub.sync(s.id); assert.match(hub.store.context("Launch"), /Launch details/); assert.ok(!hub.store.data.notes.some(n => n.text.includes("Do not ingest") || n.text.includes("Hidden data")));
  const changes = hub.store.data.brain.changes.length; await hub.sync(s.id); assert.equal(hub.store.data.brain.changes.length, changes);
  fs.writeFileSync(path.join(folder, "too-large.txt"), "x".repeat(210000)); await assert.rejects(hub.sync(s.id), /200 KB/); assert.match(hub.store.context("Launch"), /Launch details/, "failed sync preserves previous content");
});
test("conversation sources read only selected chats, and public sources stop at Local-Only/private redirects", async t => {
  let fetched = 0; const chats = { list: () => [{ id: "one", title: "Chosen" }, { id: "two", title: "Other" }], get: id => ({ title: id, messages: [{ role: "user", content: id === "one" ? "Chosen context" : "Never shared" }, { role: "system", content: "Excluded system text" }] }) };
  const { hub, privacy } = fixture(t, { chats, lookup: async () => [{ address: "93.184.216.34", family: 4 }], fetchImpl: async () => { fetched++; return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } }); } });
  const c = hub.sources.save({ kind: "chats", name: "Chat", chatIds: ["one", "missing"] }); await hub.sync(c.id); assert.match(hub.store.context("Chosen"), /Chosen context/); assert.ok(!hub.store.data.notes[0].text.includes("Never shared")); assert.ok(!hub.store.data.notes[0].text.includes("Excluded"));
  const web = hub.sources.save({ kind: "web", name: "Website", url: "https://example.com/" }); privacy("local-only"); await assert.rejects(hub.sync(web.id), /Local-Only/); assert.equal(fetched, 0);
  privacy("local-first"); await assert.rejects(hub.sync(web.id)); assert.equal(fetched, 1, "private redirect never fetched");
});
