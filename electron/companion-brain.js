"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { tokens } = require("../core/lib/memory");
const { CompanionError, copy, id, text } = require("./companion-store");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const keyFor = value => digest(value).slice(0, 20);
function topicsFor(note) {
  const words = tokens(note.title + " " + note.text);
  const counts = new Map(); for (const w of words) if (w.length > 3 && !/^[0-9]+$/.test(w)) counts.set(w, (counts.get(w) || 0) + 1);
  const explicit = (note.tags || []).filter(t => t && t !== note.source?.toLowerCase());
  return [...new Set([...explicit, ...[...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(x => x[0])])].slice(0, 5);
}
function extract(note) {
  const first = note.text.replace(/^#+\s*/gm, "").replace(/\s+/g, " ");
  return first.slice(0, 260) + (first.length > 260 ? "…" : "");
}
class CompanionBrain {
  constructor({ store }) { this.store = store; this.cache = null; }
  memoryResult(n) {
    const source = n.sourceId && this.store.data.sources.find(s => s.id === n.sourceId);
    return { id: n.id, revision: digest(JSON.stringify(n)), title: n.title, truncated: n.text.length > 1500,
      category: n.category, source: n.source, imported: !!n.sourceId, updatedAt: n.updatedAt,
      provenance: { sourceId: n.sourceId || null, kind: source?.kind || (n.sourceId ? "missing" : "personal"), lastSync: source?.lastSync || null,
        status: !n.sourceId ? "personal_memory" : !source ? "source_missing" : source.error ? "sync_failed" : "saved_snapshot" },
      notice: "Saved context, not current provider state or permission to act. Read the connected app for current facts.", text: n.text.slice(0, 1500) };
  }
  memories(input) {
    return this.store.search(String(input.query || ""), 6).map(n => {
      // Search adds a relevance score; revision binds only the stored record.
      return this.memoryResult(this.store.data.notes.find(item => item.id === n.id));
    });
  }
  async updateMemory(input, confirm, signal) {
    this.store.requireStorage(); signal?.throwIfAborted();
    const old = this.store.data.notes.find(n => n.id === input.id && !n.sourceId);
    if (!old) throw new CompanionError("Search Brain for an exact personal memory first. Manage imported material in Brain Sources.");
    if (old.text.length > 1500) throw new CompanionError("This memory is too long to show completely in chat recall. Open Brain → Memories to edit the full note without losing omitted text.");
    if (input.revision !== digest(JSON.stringify(old))) throw new CompanionError("Memory changed or its revision is missing. Search Brain again before correcting it.");
    const next = { ...old, text: text(input.text, 12000), title: input.title === undefined ? old.title : text(input.title, 120, "Title") };
    if (!await confirm("Correct Brain memory", { before: { title: old.title, text: old.text }, after: { title: next.title, text: next.text } })) throw new CompanionError("User declined. Do not retry this action.");
    signal?.throwIfAborted(); this.store.requireStorage();
    const current = this.store.data.notes.find(n => n.id === old.id);
    if (!current || digest(JSON.stringify(current)) !== input.revision) throw new CompanionError("Memory changed while awaiting approval. Search Brain again.");
    // Change the existing record in place, preserving pins, tags, source
    // ownership and Awareness provenance used when forgetting source data.
    const saved = this.store.change(d => {
      const note = d.notes.find(n => n.id === old.id);
      note.text = next.text; note.title = next.title; note.updatedAt = Date.now(); return note;
    });
    return { updated: true, memory: this.memoryResult(saved) };
  }
  taskResult(task) {
    const goal = this.store.data.goals.find(g => g.id === task.goalId);
    return { id: task.id, revision: digest(JSON.stringify(task)), title: task.title, status: task.status, due: task.due,
      goalId: task.goalId, goalTitle: goal?.title || null, detail: task.detail.slice(0, 600), truncated: task.detail.length > 600, updatedAt: task.updatedAt };
  }
  tasks(input) {
    this.store.requireStorage();
    const status = input.status || "open";
    if (!["open", "all", "todo", "doing", "done"].includes(status)) throw new CompanionError("Choose open, all, todo, doing or done tasks.");
    const words = tokens(String(input.query || ""));
    const matches = this.store.data.brain.tasks.filter(t => (status === "all" || (status === "open" ? t.status !== "done" : t.status === status)) &&
      (!input.goalId || t.goalId === input.goalId) && words.every(w => tokens(t.title + " " + t.detail).includes(w)))
      .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || b.updatedAt - a.updatedAt);
    return { tasks: matches.slice(0, 20).map(t => this.taskResult(t)), total: matches.length, truncated: matches.length > 20,
      localDate: new Date().toLocaleString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      notice: "Personal Brain tasks only. A task or due date does not schedule a reminder, run a workflow or perform an external action." };
  }
  async changeTask(input, confirm, signal) {
    this.store.requireStorage(); signal?.throwIfAborted();
    if (!["create", "update"].includes(input.operation)) throw new CompanionError("Choose create or update.");
    const old = input.operation === "update" ? this.store.data.brain.tasks.find(t => t.id === input.id) : null;
    if (input.operation === "update" && (!old || input.revision !== digest(JSON.stringify(old)))) throw new CompanionError("Task changed or its revision is missing. List Brain tasks again before updating it.");
    if (input.operation === "create" && input.id) throw new CompanionError("Use update to change an existing task.");
    const changes = input.changes;
    if (!changes || typeof changes !== "object" || Array.isArray(changes) || !Object.keys(changes).length || Object.keys(changes).some(k => !["title", "detail", "status", "due", "goalId"].includes(k))) throw new CompanionError("Provide task changes: title, detail, status, due or goalId.");
    const next = { ...(old || { title: "", detail: "", status: "todo", due: "", goalId: "" }), ...copy(changes) };
    next.title = text(next.title, 200, "Task");
    if (typeof next.detail !== "string" || next.detail.length > 3000) throw new CompanionError("Task detail must be text, up to 3000 characters.");
    if (!["todo", "doing", "done"].includes(next.status)) throw new CompanionError("Task status must be todo, doing or done.");
    if (typeof next.due !== "string" || next.due && (!/^\d{4}-\d{2}-\d{2}$/.test(next.due) || !Number.isFinite(Date.parse(next.due)) || new Date(next.due).toISOString().slice(0, 10) !== next.due)) throw new CompanionError("Use a real YYYY-MM-DD due date, or an empty string to clear it.");
    const goal = this.store.data.goals.find(g => g.id === next.goalId);
    if (typeof next.goalId !== "string" || next.goalId && !goal) throw new CompanionError("Read Brain goals for an exact goal ID, or use an empty string for no goal.");
    const goalSnapshot = goal ? JSON.stringify(goal) : null;
    const preview = task => ({ title: task.title, detail: task.detail, status: task.status, due: task.due || "No due date", goal: this.store.data.goals.find(g => g.id === task.goalId)?.title || "No goal" });
    if (!await confirm(old ? "Update Brain task" : "Create Brain task", { ...(old ? { before: preview(old) } : {}), after: preview(next), note: "This changes your personal task board only. No reminder or workflow is scheduled and no connected-app action runs." })) throw new CompanionError("User declined. Do not retry this action.");
    signal?.throwIfAborted(); this.store.requireStorage();
    if (old && digest(JSON.stringify(this.store.data.brain.tasks.find(t => t.id === old.id) || null)) !== input.revision) throw new CompanionError("Task changed while awaiting approval. List Brain tasks again.");
    if (goal && JSON.stringify(this.store.data.goals.find(g => g.id === goal.id)) !== goalSnapshot) throw new CompanionError("Goal changed while awaiting approval. Read Brain goals again.");
    return { [old ? "updated" : "created"]: true, task: this.taskResult(this.task(next)) };
  }
  index() {
    this.store.requireStorage(); const d = this.store.data;
    if (this.cache?.data === d) return this.cache.value;
    const topics = new Map(), sources = new Map(), nodes = [], edges = [], noteMeta = {};
    for (const n of d.notes) {
      const tags = topicsFor(n), source = n.sourceId || "personal";
      if (!sources.has(source)) sources.set(source, { id: source, name: n.source || "Your notes", noteIds: [], excerpts: [] });
      const src = sources.get(source); src.noteIds.push(n.id); if (src.excerpts.length < 4) src.excerpts.push(extract(n));
      for (const t of tags) { if (!topics.has(t)) topics.set(t, { id: keyFor(t), name: t, noteIds: [], sourceIds: new Set() }); const topic = topics.get(t); topic.noteIds.push(n.id); topic.sourceIds.add(source); }
      const age = Math.max(0, (Date.now() - n.updatedAt) / 86400000);
      noteMeta[n.id] = { topics: tags, importance: Math.min(100, 20 + (n.pinned ? 40 : 0) + Math.min(20, tags.length * 4) + Math.max(0, 20 - age)), excerpt: extract(n) };
    }
    const ordered = [...topics.values()].sort((a, b) => b.noteIds.length - a.noteIds.length || a.name.localeCompare(b.name)).slice(0, 120).map(t => ({ ...t, sourceIds: [...t.sourceIds] }));
    for (const s of [...sources.values()].slice(0, 30)) nodes.push({ id: "source:" + s.id, kind: "source", label: s.name, count: s.noteIds.length });
    for (const t of ordered.slice(0, 30)) { nodes.push({ id: "topic:" + t.id, kind: "topic", label: t.name, count: t.noteIds.length }); for (const s of t.sourceIds) if (nodes.some(n => n.id === "source:" + s)) edges.push({ from: "source:" + s, to: "topic:" + t.id }); }
    const days = Array.from({ length: 28 }, (_, i) => { const day = new Date(Date.now() - (27 - i) * 86400000).toISOString().slice(0, 10); return { day, count: d.notes.filter(n => new Date(n.updatedAt).toISOString().slice(0, 10) === day).length }; });
    const value = { sources: [...sources.values()], topics: ordered, nodes, edges, noteMeta, days,
      metrics: { notes: d.notes.length, sources: d.sources.length, topics: topics.size, characters: d.notes.reduce((n, s) => n + s.text.length, 0), latest: Math.max(0, ...d.notes.map(n => n.updatedAt)), changes: d.brain.changes.filter(c => c.at > d.brain.readAt).length } };
    this.cache = { data: d, value }; return value;
  }
  search(input) {
    const query = String(input.query || "").trim().toLowerCase(), ix = this.index();
    const topic = ix.topics.find(t => t.id === input.topicId);
    return this.store.search(query, 100, n => (!input.sourceId || (n.sourceId || "personal") === input.sourceId) && (!topic || topic.noteIds.includes(n.id)) && (!input.since || n.updatedAt >= Number(input.since))).map(n => ({ ...n, ...ix.noteMeta[n.id] }));
  }
  task(input) {
    return this.store.change(d => {
      const old = input.id ? d.brain.tasks.find(t => t.id === input.id) : null;
      if (input.id && !old) throw new CompanionError("Task no longer exists.");
      if (!old && d.brain.tasks.length >= 300) throw new CompanionError("Archive older tasks before adding more.");
      const task = { id: old?.id || id(), title: text(input.title, 200, "Task"), detail: String(input.detail || "").slice(0, 3000), status: ["todo", "doing", "done"].includes(input.status) ? input.status : "todo", goalId: d.goals.some(g => g.id === input.goalId) ? input.goalId : "", due: /^\d{4}-\d{2}-\d{2}$/.test(input.due || "") ? input.due : "", createdAt: old?.createdAt || Date.now(), updatedAt: Date.now(), insightId: old?.insightId || null };
      if (old) d.brain.tasks[d.brain.tasks.indexOf(old)] = task; else d.brain.tasks.unshift(task); return task;
    });
  }
  checkpoint(name) {
    return this.store.change(d => { const c = { id: id(), name: text(name || "Reviewed Brain", 100), at: Date.now(), notes: d.notes.length, sources: d.sources.length, fingerprint: digest(JSON.stringify(d.notes.map(n => [n.id, n.text]))) }; d.brain.checkpoints.unshift(c); d.brain.checkpoints = d.brain.checkpoints.slice(0, 30); d.brain.readAt = c.at; return c; });
  }
  review(input) {
    const insight = this.store.data.brain.insights.find(i => i.id === input.id);
    if (!insight || insight.status !== "pending") throw new CompanionError("This insight has already been reviewed.");
    return this.store.change(d => {
      const i = d.brain.insights.find(i => i.id === input.id);
      if (input.decision === "dismiss") { i.status = "dismissed"; i.reviewedAt = Date.now(); return i; }
      if (!["remember", "task"].includes(input.decision)) throw new CompanionError("Choose remember, task or dismiss.");
      if (input.decision === "remember") {
        if (d.notes.length >= 3000) throw new CompanionError("Brain is full.");
        const n = { id: id(), title: i.title, text: i.text, category: "notes", tags: ["awareness"], pinned: false, source: "Awareness · reviewed", createdAt: Date.now(), updatedAt: Date.now(), insightId: i.id };
        d.notes.push(n); i.savedId = n.id;
      } else {
        if (d.brain.tasks.length >= 300) throw new CompanionError("Archive older tasks first.");
        const t = { id: id(), title: i.title, detail: i.text, status: "todo", goalId: "", due: "", createdAt: Date.now(), updatedAt: Date.now(), insightId: i.id }; d.brain.tasks.unshift(t); i.savedId = t.id;
      }
      i.status = input.decision === "remember" ? "remembered" : "task"; i.reviewedAt = Date.now(); return i;
    });
  }
  exportVault(folder) {
    this.store.requireStorage();
    // Each export is a fresh folder. Never overwrite the user's hand-edited vault.
    const target = path.join(fs.realpathSync(folder), "KAI-Brain-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + id().slice(0, 6));
    fs.mkdirSync(target, { mode: 0o700 }); fs.mkdirSync(path.join(target, "Memories")); fs.mkdirSync(path.join(target, "Topics")); fs.mkdirSync(path.join(target, "Sources"));
    const write = (name, value) => fs.writeFileSync(path.join(target, name), value, { flag: "wx", mode: 0o600 });
    const noteLink = n => `[[Memories/${keyFor(n)}]]`;
    for (const n of this.store.data.notes) write("Memories/" + keyFor(n.id) + ".md", `# ${n.title}\n\nSource: ${n.source || "You"}\nUpdated: ${new Date(n.updatedAt).toISOString()}\n\n${n.text}\n`);
    const ix = this.index();
    for (const t of ix.topics) write("Topics/" + t.id + ".md", `# ${t.name}\n\n` + t.noteIds.map(n => "- " + noteLink(n)).join("\n"));
    for (const s of ix.sources) write("Sources/" + keyFor(s.id) + ".md", `# ${s.name}\n\n` + s.noteIds.map(n => "- " + noteLink(n)).join("\n"));
    write("KAI Brain.md", `# Your KAI Brain\n\nExported ${new Date().toISOString()}. This export is plain Markdown.\n\n## Sources\n\n` + ix.sources.map(s => `- [[Sources/${keyFor(s.id)}|${s.name.replace(/[\]|]/g, "")}]]`).join("\n") + "\n\n## Topics\n\n" + ix.topics.map(t => `- [[Topics/${t.id}|${t.name.replace(/[\]|]/g, "")}]]`).join("\n") + "\n\n## Goals\n\n" + this.store.data.goals.map(g => `- [${g.status === "done" ? "x" : " "}] ${g.title}: ${g.detail}`).join("\n"));
    write("Tasks.md", "# Tasks\n\n" + this.store.data.brain.tasks.map(t => `- [${t.status === "done" ? "x" : " "}] ${t.title}\n  ${t.detail}`).join("\n"));
    write("manifest.json", JSON.stringify({ version: 1, exportedAt: Date.now(), memories: this.store.data.notes.length, sources: ix.sources.length }));
    return { folder: target, notes: this.store.data.notes.length };
  }
}
module.exports = { CompanionBrain, topicsFor, extract, digest };
