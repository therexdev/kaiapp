"use strict";
const { CompanionError, copy, id, text } = require("./companion-store");
const { computeNext } = require("../core/lib/tasks");
const TYPES = ["brain_search", "prompt", "connection", "condition", "approval", "remember", "output"];
function validate(input) {
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 20) throw new CompanionError("A workflow needs 1–20 steps.");
  const schedule = copy(input.schedule || { kind: "manual" });
  if (!["manual", "hourly", "every6h", "daily", "weekly"].includes(schedule.kind)) throw new CompanionError("Choose a supported schedule.");
  if (schedule.kind !== "manual") {
    if (!Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23) schedule.hour = 9;
    if (!Number.isInteger(schedule.day) || schedule.day < 0 || schedule.day > 6) schedule.day = 1;
  }
  const steps = input.steps.map((s, i) => {
    if (!TYPES.includes(s.type)) throw new CompanionError(`Unknown step type at step ${i + 1}.`);
    const step = { type: s.type, label: text(s.label || s.type.replace(/_/g, " "), 100, "Step label"), text: String(s.text || "").slice(0, 8000) };
    if (["prompt", "condition", "remember"].includes(s.type)) text(step.text, 8000, "Step text");
    if (s.type === "connection") {
      step.connectionId = text(s.connectionId, 100, "Connection"); step.operationId = text(s.operationId, 100, "Operation");
      step.variables = copy(s.variables || {}); step.body = copy(s.body ?? {});
      if (JSON.stringify(step).length > 18000) throw new CompanionError("Connection step is too large.");
    }
    return step;
  });
  const model = String(input.model || "").slice(0, 200);
  if (steps.some(s => s.type === "prompt") && (!model || model.startsWith("desktop:") || model.startsWith("koinos-network"))) throw new CompanionError("Choose an installed local model for workflow reasoning. Private provider keys are reserved for attended chat.");
  return { name: text(input.name, 100, "Workflow name"), description: String(input.description || "").slice(0, 1000), model, schedule, steps };
}
function fill(value, run) {
  if (typeof value === "string") return value.replace(/\{\{(input|previous)\}\}/g, (_, key) => key === "input" ? run.input : run.previous).slice(0, 16000);
  if (Array.isArray(value)) return value.map(v => fill(v, run));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, run)]));
  return value;
}
class CompanionWorkflows {
  constructor({ store, connections, runLocal, models }) {
    this.store = store; this.connections = connections; this.runLocal = runLocal; this.models = models; this.active = new Map(); this.timer = null;
    if (!store.locked && store.available() && store.data.runs.some(r => r.status === "running")) store.change(d => {
      for (const r of d.runs) if (r.status === "running") {
        r.status = "interrupted"; r.error = r.inFlight ? "KAI stopped during a step. Its result may be uncertain; inspect it before starting a new run." : "KAI restarted between steps. Resume when ready.";
      }
    });
  }
  save(input, { draft = false } = {}) {
    const spec = validate(input);
    if (spec.steps.some(s => s.type === "prompt") && !this.models().some(m => m.alias === spec.model && m.status === "ready")) throw new CompanionError("Install the selected workflow model first.");
    for (const s of spec.steps.filter(s => s.type === "connection")) if (!this.store.data.connections.some(c => c.id === s.connectionId && c.operations.some(o => o.id === s.operationId))) throw new CompanionError("A workflow step refers to a missing connection or operation.");
    return this.store.change(d => {
      const old = input.id ? d.workflows.find(w => w.id === input.id) : null;
      if (input.id && !old) throw new CompanionError("Workflow no longer exists.");
      if (!old && d.workflows.length >= 100) throw new CompanionError("Maximum 100 workflows.");
      if (old && d.runs.some(r => r.workflowId === old.id && ["running", "waiting", "interrupted"].includes(r.status))) throw new CompanionError("Finish or cancel this workflow's pending run before editing.");
      const w = { ...spec, id: old?.id || id(), enabled: !draft && input.enabled === true, draft, revision: (old?.revision || 0) + 1, updatedAt: Date.now(),
        nextRunAt: spec.schedule.kind === "manual" || draft || input.enabled !== true ? null : computeNext(spec.schedule).toISOString() };
      if (old) d.workflows[d.workflows.indexOf(old)] = w; else d.workflows.push(w); return w;
    });
  }
  remove(key) {
    if (this.store.data.runs.some(r => r.workflowId === key && ["running", "waiting", "interrupted"].includes(r.status))) throw new CompanionError("Cancel the pending run before deleting the workflow.");
    this.store.change(d => { d.workflows = d.workflows.filter(w => w.id !== key); d.runs = d.runs.filter(r => r.workflowId !== key); });
  }
  begin(key, input = "", trigger = "manual") {
    this.store.requireStorage();
    if (this.active.size >= 2) throw new CompanionError("Two workflows are already running. Try again when one finishes.");
    const w = this.store.data.workflows.find(w => w.id === key);
    if (!w || w.draft) throw new CompanionError("Review and save this workflow before running it.");
    if (this.store.data.runs.some(r => r.workflowId === key && ["running", "waiting", "interrupted"].includes(r.status))) throw new CompanionError("This workflow already has a running or paused run.");
    const runId = id();
    this.store.change(d => {
      if (d.runs.length >= 150) d.runs = d.runs.filter(r => ["running", "waiting", "interrupted"].includes(r.status) || d.runs.indexOf(r) < 100);
      d.runs.unshift({ id: runId, workflowId: key, name: w.name, spec: copy(w), trigger, input: String(input).slice(0, 8000), previous: String(input).slice(0, 8000), index: 0, steps: [], status: "running", startedAt: Date.now(), inFlight: null, pending: null });
      const saved = d.workflows.find(x => x.id === key); if (saved.enabled && saved.schedule.kind !== "manual") saved.nextRunAt = computeNext(saved.schedule).toISOString();
    }); this.launch(runId); return runId;
  }
  get(key) { return this.store.data.runs.find(r => r.id === key); }
  patch(key, fn) { this.store.change(d => { const r = d.runs.find(r => r.id === key); if (!r) throw new CompanionError("Run no longer exists."); fn(r); }); }
  launch(key, approved = false) {
    if (this.active.has(key)) throw new CompanionError("Run is already active.");
    if (this.active.size >= 2) throw new CompanionError("Two workflows are already running. Try again when one finishes.");
    const controller = new AbortController(); this.active.set(key, controller);
    this.drive(key, controller.signal, approved).catch(error => {
      if (this.get(key)?.status === "cancelled") return;
      this.patch(key, r => { r.status = "failed"; r.error = error instanceof CompanionError ? error.message : error.name === "AbortError" ? "Run stopped." : "Step failed. Check the local model or connection, then start a new run."; r.finishedAt = Date.now(); });
    }).finally(() => this.active.delete(key));
  }
  async drive(key, signal, approved) {
    for (;;) {
      signal.throwIfAborted(); const r = copy(this.get(key));
      if (r.index >= r.spec.steps.length) { this.patch(key, x => { x.status = "completed"; x.finishedAt = Date.now(); x.inFlight = null; }); return; }
      const s = r.spec.steps[r.index];
      let request;
      if (s.type === "connection") request = this.connections.prepare(s.connectionId, s.operationId, fill(s.variables, r), fill(s.body, r));
      const needsApproval = ["remember", "approval"].includes(s.type) || (request && (request.method !== "GET" || !this.store.data.connections.find(c => c.id === s.connectionId)?.allowSync));
      if (needsApproval && !approved) {
        this.patch(key, x => { x.status = "waiting"; x.pending = request || { name: s.label, text: fill(s.text, r) }; }); return;
      }
      if (approved && r.pending && request && JSON.stringify(request) !== JSON.stringify(r.pending)) throw new CompanionError("The connection changed while waiting. Cancel this run and review the workflow.");
      approved = false;
      // Persist the in-flight marker BEFORE a side effect. A crash never replays it.
      this.patch(key, x => { x.status = "running"; x.inFlight = { index: r.index, type: s.type, at: Date.now() }; x.pending = null; });
      let output = r.previous, stop = false;
      if (s.type === "brain_search") output = this.store.search(fill(s.text || "{{input}}", r), 8).map(n => `[${n.title}] ${n.text}`).join("\n\n").slice(0, 12000) || "No matching Brain notes.";
      if (s.type === "prompt") {
        if (!this.models().some(m => m.alias === r.spec.model && m.status === "ready")) throw new CompanionError("Workflow model is not installed and ready.");
        output = await this.runLocal({ model: r.spec.model, prompt: fill(s.text, r), signal });
      }
      if (s.type === "connection") output = await this.connections.execute(request, signal);
      if (s.type === "condition") { stop = !r.previous.toLowerCase().includes(fill(s.text, r).toLowerCase()); if (stop) output = "Condition did not match. Remaining steps skipped."; }
      if (s.type === "remember") { this.store.note({ title: s.label, text: fill(s.text, r).slice(0, 12000), source: "agent" }); output = "Saved to Brain."; }
      if (s.type === "output" && s.text) output = fill(s.text, r);
      signal.throwIfAborted();
      this.patch(key, x => {
        x.steps.push({ index: r.index, label: s.label, type: s.type, output: String(output).slice(0, 16000), at: Date.now(), status: stop ? "stopped by condition" : "completed" });
        x.previous = String(output).slice(0, 16000); x.index = stop ? x.spec.steps.length : x.index + 1; x.inFlight = null;
      });
    }
  }
  resume(key) {
    const r = this.get(key);
    if (!r || !["waiting", "interrupted"].includes(r.status)) throw new CompanionError("This run is not waiting.");
    if (r.inFlight) throw new CompanionError("An interrupted step has an uncertain result. Inspect it, cancel this run, and start a new one if needed.");
    this.launch(key, r.status === "waiting");
  }
  cancel(key) { if (!this.get(key)) throw new CompanionError("Run no longer exists."); this.active.get(key)?.abort(); this.patch(key, r => { r.status = "cancelled"; r.finishedAt = Date.now(); r.pending = null; }); }
  async tick(now = Date.now()) {
    if (this.store.locked || !this.store.available()) return;
    for (const w of this.store.data.workflows) if (w.enabled && w.nextRunAt && Date.parse(w.nextRunAt) <= now) {
      try { this.begin(w.id, "", "schedule"); } catch { /* A pending run suppresses catch-up storms. */ }
    }
  }
  start() { this.timer = setInterval(() => this.tick().catch(() => {}), 30000); this.timer.unref?.(); }
  stop() { clearInterval(this.timer); for (const c of this.active.values()) c.abort(); }
}
module.exports = { CompanionWorkflows: require("./workflow-engine").createClass(CompanionWorkflows), validate, fill, TYPES };
