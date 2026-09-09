"use strict";
const crypto = require("crypto");
const { CompanionError, copy, id, text } = require("./companion-store");
const Model = require("../ui/workflow-model");
const V = require("./workflow-values"), { next } = require("./workflow-schedules");
const { assertPublicTarget } = require("../core/lib/websearch");
const WAIT = Symbol("waiting"), live = r => ["running", "waiting", "interrupted"].includes(r.status);
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function loopRegion(graph, loop) {
  const region = new Set(), visit = key => { if (key === loop.id || region.has(key)) return; region.add(key); graph.edges.filter(e => e.from === key).forEach(e => visit(e.to)); };
  graph.edges.filter(e => e.from === loop.id && e.port === "body").forEach(e => visit(e.to));
  if (!region.size || !graph.edges.some(e => region.has(e.from) && e.to === loop.id)) throw new CompanionError(loop.label + ": connect Body through steps and back to this Loop.");
  if (graph.edges.some(e => e.from === loop.id && e.port !== "body" && region.has(e.to))) throw new CompanionError(loop.label + ": Done must leave the loop body.");
  if (graph.edges.some(e => region.has(e.to) && !region.has(e.from) && e.from !== loop.id)) throw new CompanionError(loop.label + ": enter the body through the Loop node only.");
  return region;
}
function plan(graph) {
  const regions = Object.fromEntries(graph.nodes.filter(n => n.type === "loop").map(n => [n.id, [...loopRegion(graph, n)]]));
  const inside = new Set(Object.values(regions).flat()), nodes = graph.nodes.filter(n => !inside.has(n.id));
  return { nodes, edges: graph.edges.filter(e => !inside.has(e.from) && !inside.has(e.to) && e.port !== "body"), regions };
}
function normalize(input, draft = false) {
  const graph = copy(input.graph), report = Model.validateGraph(graph);
  const errors = draft ? report.errors.filter(e => /unique letter|Unsupported node|must be an object|1–60|Add a workflow graph/.test(e.message)) : report.errors;
  if (errors.length) throw new CompanionError(errors.map(e => e.message).slice(0, 4).join(" "));
  if (JSON.stringify(graph).length > 150000) throw new CompanionError("Workflow exceeds 150 KB.");
  for (const n of graph.nodes) {
    n.label = text(n.label || Model.meta(n.type).name, 100, "Node name");
    n.position = { x: Math.max(0, Math.min(6000, Number(n.position?.x) || 0)), y: Math.max(0, Math.min(12000, Number(n.position?.y) || 0)) };
    n.config.onError = ["stop", "continue", "route"].includes(n.config.onError) ? n.config.onError : "stop";
    n.config.retries = Math.max(0, Math.min(2, Number(n.config.retries) || 0));
    n.config.timeoutSeconds = Math.max(5, Math.min(180, Number(n.config.timeoutSeconds) || 120));
    if (n.type === "agent" && (n.config.model || input.model || "").match(/^(desktop:|koinos-network)/)) throw new CompanionError("Workflow reasoning requires an installed local model.");
    if (n.type === "memory" && !["search", "recall", "people", "goals", "remember", "forget"].includes(n.config.operation)) throw new CompanionError("Choose a supported Brain operation.");
    if (!draft && n.type === "http_request" && !n.config.connectionId) {
      let u; try { u = new URL(n.config.url); } catch { throw new CompanionError("Enter a public HTTPS URL."); }
      if (u.protocol !== "https:" || u.username || u.password || /[{}=]/.test(u.hostname)) throw new CompanionError("HTTP destinations must be fixed public HTTPS hosts without credentials.");
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(n.config.method)) throw new CompanionError("Choose a supported HTTP method.");
      for (const key of Object.keys(n.config.headers || {})) if (!["accept", "content-type"].includes(key.toLowerCase())) throw new CompanionError("Store authenticated headers in a Custom API connection.");
    }
  }
  if (!draft) plan(graph);
  const t = graph.nodes.find(n => n.type === "trigger"), schedule = t?.config.kind === "schedule" ? t.config.schedule : { kind: "manual" };
  if (!draft && t?.config.kind === "schedule") next(schedule);
  return { name: text(input.name, 100, "Workflow name"), description: String(input.description || "").slice(0, 1000), model: String(input.model || "").slice(0, 200), graph, schedule, steps: graph.nodes.filter(n => n.type !== "trigger").map(n => ({ type: n.type, label: n.label })) };
}
function createClass(Base) { return class GraphWorkflows extends Base {
  constructor(options) { super(options); Object.assign(this, { privacyMode: options.privacyMode || (() => "local-only"), fetch: options.fetchImpl || fetch, lookup: options.lookup, chats: options.chats, legacyTasks: options.legacyTasks }); this.polling = false; this.watchController = new AbortController(); }
  checkReferences(spec, { draft = false } = {}) {
    if (draft) return;
    for (const n of spec.graph.nodes) {
      const c = n.config;
      if (n.type === "agent") {
        const model = c.model || spec.model;
        if (!model || /^(desktop:|koinos-network)/.test(model) || !this.models().some(m => m.alias === model && m.status === "ready")) throw new CompanionError(n.label + ": choose an installed local model.");
        for (const tool of c.tools || []) { const connection = this.store.data.connections.find(x => x.id === tool.connectionId); if (!connection?.allowSync || !connection.operations.some(o => o.id === tool.operationId && o.method === "GET")) throw new CompanionError("Agent tools must be selected read actions with background reads enabled."); }
      }
      if (c.connectionId && !["trigger", "agent"].includes(n.type)) {
        const connection = this.connections.list().find(x => x.id === c.connectionId && x.enabled);
        if (!connection?.operations.some(o => o.id === c.operationId)) throw new CompanionError(n.label + ": reconnect the app and select its action.");
      }
      if (n.type === "sub_workflow") { const child = this.store.data.workflows.find(x => x.id === c.workflowId); if (!child || child.draft) throw new CompanionError(n.label + ": review and save the selected sub-workflow first."); }
      if (n.type === "trigger" && c.kind === "app_change") { const connection = this.connections.list().find(x => x.id === c.connectionId && x.enabled && x.allowSync); if (!connection?.operations.some(o => o.id === c.operationId && o.method === "GET")) throw new CompanionError("Choose a read action with background reads enabled for the app-change trigger."); }
      if (n.type === "trigger" && c.kind === "source_change" && !this.store.data.sources.some(s => s.id === c.sourceId)) throw new CompanionError("Choose an existing Brain source to watch.");
    }
  }
  validate(input) { try { const spec = normalize(input); this.checkReferences(spec); return { ...Model.validateGraph(spec.graph), nextRunAt: next(spec.schedule) }; } catch (e) { return { errors: [{ message: e.message }], warnings: [] }; } }
  save(input, { draft = false } = {}) {
    if (!input.graph) return super.save(input, { draft });
    const spec = normalize(input, draft); this.checkReferences(spec, { draft });
    if (spec.graph.nodes.some(n => n.type === "sub_workflow" && n.config.workflowId === input.id)) throw new CompanionError("A workflow cannot run itself.");
    return this.store.change(d => {
      const old = input.id ? d.workflows.find(w => w.id === input.id) : null;
      if (input.id && !old) throw new CompanionError("Workflow no longer exists.");
      if (old && d.runs.some(r => r.workflowId === old.id && live(r))) throw new CompanionError("Finish or cancel this workflow's pending run before editing.");
      if (!old && d.workflows.length >= 100) throw new CompanionError("Maximum 100 workflows.");
      const w = { ...spec, id: old?.id || id(), enabled: !draft && input.enabled === true, draft, revision: (old?.revision || 0) + 1, updatedAt: Date.now(), nextRunAt: !draft && input.enabled ? next(spec.schedule) : null, ...(old?.legacyTask ? { legacyTask: old.legacyTask } : {}) };
      if (old) d.workflows[d.workflows.indexOf(old)] = w; else d.workflows.push(w); return w;
    });
  }
  setEnabled(key, enabled) {
    const w = this.store.data.workflows.find(w => w.id === key); if (!w) throw new CompanionError("Workflow no longer exists."); if (enabled && w.draft) throw new CompanionError("Review and save the draft before enabling it.");
    if (enabled && w.graph) this.checkReferences(w);
    return this.store.change(d => { const saved = d.workflows.find(x => x.id === key); saved.enabled = enabled === true; saved.nextRunAt = saved.enabled ? next(saved.schedule) : null; return saved; });
  }
  snapshot(w, seen = [], out = {}) {
    if (seen.includes(w.id) || seen.length >= 4) throw new CompanionError("Sub-workflows cannot recurse and may nest at most four levels.");
    const spec = normalize(Model.fromLegacy(w)); this.checkReferences(spec); out[w.id] = { ...spec, id: w.id, revision: w.revision };
    for (const n of spec.graph.nodes.filter(n => n.type === "sub_workflow")) { const child = this.store.data.workflows.find(x => x.id === n.config.workflowId); if (!child || child.draft) throw new CompanionError("A sub-workflow is missing or still a draft."); this.snapshot(child, [...seen, w.id], out); }
    return out;
  }
  begin(key, input = "", trigger = "manual", options = {}) {
    const w = this.store.data.workflows.find(w => w.id === key); if (!w?.graph) return super.begin(key, input, trigger);
    this.store.requireStorage(); if (this.active.size >= 2) throw new CompanionError("Two workflows are already running.");
    if (w.draft) throw new CompanionError("Review and save this workflow before running it.");
    if (this.store.data.runs.some(r => r.workflowId === key && live(r))) throw new CompanionError("This workflow already has a running or paused run.");
    const snapshots = this.snapshot(w), runId = id(); let payload = input;
    if (typeof input === "string") { if (input.length > 32000) throw new CompanionError("Run input exceeds 32 KB."); try { payload = JSON.parse(input); } catch { /* literal prompt */ } }
    V.bounded(payload);
    const fields = w.graph.nodes.find(n => n.type === "trigger").config.inputFields || [];
    for (const field of fields) if (field.required && (payload?.[field.name] == null || payload[field.name] === "")) throw new CompanionError("Enter run input: " + field.name);
    this.store.change(d => {
      if (d.runs.filter(live).length >= 20) throw new CompanionError("Finish or cancel pending workflow runs first.");
      d.runs = d.runs.filter((r, i) => live(r) || i < 75);
      d.runs.unshift({ id: runId, workflowId: key, name: w.name, spec: copy(w), snapshots, trigger, input: payload, previous: V.string(payload), steps: [], index: 0, frames: {}, approvals: [], status: "running", startedAt: Date.now(), inFlight: null, pending: null, dryRun: options.dryRun === true });
      const saved = d.workflows.find(x => x.id === key); if (saved.enabled && trigger === "schedule") saved.nextRunAt = next(saved.schedule);
    }); this.launch(runId); return runId;
  }
  frame(key, frameId, graph, seeds, input, iteration = 0, model = "") {
    if (this.get(key).frames[frameId]) return;
    const p = plan(graph);
    this.patch(key, r => { if (Object.keys(r.frames).length >= 150) throw new CompanionError("Run reached the 150-frame limit."); r.frames[frameId] = { graph, seeds, input, iteration, model, states: Object.fromEntries(p.nodes.map(n => [n.id, { status: "pending", outputs: {}, cursor: 0, turns: [] }])), status: "running" }; });
  }
  state(key, frameId, nodeId) { return this.get(key).frames[frameId].states[nodeId]; }
  patchNode(key, frameId, nodeId, fn) { this.patch(key, r => fn(r.frames[frameId].states[nodeId], r)); }
  scope(key, frameId, values) {
    const f = this.get(key).frames[frameId]; return { input: f.input, item: values[0] || {}, items: values, iteration: f.iteration, nodes: Object.fromEntries(Object.entries(f.states).map(([id, s]) => [id, { ...(s.outputs.main?.[0] || Object.values(s.outputs).flat()[0] || {}), items: Object.values(s.outputs).flat() }])) };
  }
  async drive(key, signal, approved) {
    if (!this.get(key).spec.graph) return super.drive(key, signal, approved);
    if (approved) this.patch(key, r => { const a = r.approvals[0]; if (a) a.approved = true; r.status = "running"; });
    const run = this.get(key); this.frame(key, "root", run.spec.graph, [], run.input, 0, run.spec.model);
    const result = await this.driveFrame(key, "root", signal); signal.throwIfAborted();
    this.patch(key, r => { if (result === WAIT) { r.status = "waiting"; r.pending = r.approvals.find(a => !a.approved)?.detail || null; } else { r.status = "completed"; r.finishedAt = Date.now(); r.output = result; r.previous = result.map(v => v.text ?? V.string(v)).join("\n\n").slice(0, 16000); r.inFlight = null; r.pending = null; } });
  }
  async driveFrame(key, frameId, signal) {
    for (;;) {
      signal.throwIfAborted(); const f = copy(this.get(key).frames[frameId]), p = plan(f.graph);
      if (Object.values(f.states).every(s => ["completed", "skipped"].includes(s.status))) {
        const terminals = p.nodes.filter(n => !p.edges.some(e => e.from === n.id)), output = terminals.flatMap(n => Object.values(f.states[n.id].outputs).flat());
        this.patch(key, r => { r.frames[frameId].status = "completed"; }); return V.items(output);
      }
      const ready = p.nodes.filter(n => ["pending", "waiting"].includes(f.states[n.id].status) && p.edges.filter(e => e.to === n.id).every(e => ["completed", "skipped"].includes(f.states[e.from]?.status)));
      if (!ready.length) throw new CompanionError("The graph cannot progress. Check branch and loop connections.");
      let waiting = false;
      for (let start = 0; start < ready.length; start += 2) {
        const results = await Promise.allSettled(ready.slice(start, start + 2).map(async n => {
          const incoming = p.edges.filter(e => e.to === n.id), groups = {};
          for (const e of incoming) { const values = f.states[e.from].outputs[e.port || "main"] || []; (groups[e.input || "main"] ||= []).push(...values); }
          for (const seed of f.seeds.filter(s => s.to === n.id)) (groups[seed.input || "main"] ||= []).push(...seed.items);
          const values = n.type === "trigger" ? V.items(f.input) : Object.values(groups).flat();
          if (!values.length) { this.patchNode(key, frameId, n.id, s => { s.status = "skipped"; s.outputs = {}; }); return; }
          return this.executeNode(key, frameId, n, V.items(values), groups, signal);
        }));
        const failure = results.find(r => r.status === "rejected"); if (failure) throw failure.reason;
        waiting ||= results.some(r => r.value === WAIT);
      }
      if (waiting) return WAIT;
    }
  }
  async gate(key, token, detail, signal) {
    signal.throwIfAborted(); const existing = this.get(key).approvals.find(a => a.token === token), fingerprint = hash(detail);
    if (existing?.approved) { if (existing.fingerprint !== fingerprint) throw new CompanionError("The action changed while waiting. Cancel the run and review it again."); return true; }
    if (!existing) this.patch(key, r => { r.approvals.push({ token, detail, fingerprint, approved: false }); r.pending = r.approvals.find(a => !a.approved)?.detail; });
    return false;
  }
  logStart(key, token, frameId, n, values) {
    this.patch(key, r => { if (r.steps.length >= 500) throw new CompanionError("Run reached the 500-step limit."); r.steps.push({ token, nodeId: n.id, frameId, label: n.label, type: n.type, status: "running", input: copy(values), at: Date.now(), attempts: 1 }); r.inFlight = { tokens: r.steps.filter(s => s.status === "running").map(s => s.token) }; r.index = r.steps.length - 1; });
  }
  logFinish(key, token, output, status = "completed", error) {
    this.patch(key, r => { const step = r.steps.find(s => s.token === token && s.status === "running"); if (step) { step.status = status; step.output = V.string(output).slice(0, 32000); step.items = copy(output); step.finishedAt = Date.now(); step.durationMs = step.finishedAt - step.at; if (error) step.error = error; } const busy = r.steps.filter(s => s.status === "running"); r.inFlight = busy.length ? { tokens: busy.map(s => s.token) } : null; r.approvals = r.approvals.filter(a => a.token !== token); r.pending = r.approvals.find(a => !a.approved)?.detail || null; });
  }
  async executeNode(key, frameId, n, values, groups, signal) {
    const c = n.config, baseScope = this.scope(key, frameId, values);
    const perItem = ["agent", "tool_call", "http_request", "memory", "sub_workflow"].includes(n.type) && c.execution === "per_item";
    const batches = perItem ? values.map(v => [v]) : [values];
    for (let i = this.state(key, frameId, n.id).cursor; i < batches.length; i++) {
      signal.throwIfAborted(); const batch = batches[i], scope = { ...baseScope, item: batch[0], items: batch }, token = `${frameId}/${n.id}/${i}`;
      const run = this.get(key), prepared = run.dryRun ? { approval: false, sideEffect: false } : await this.prepareNode(key, n, scope, signal);
      if (prepared.approval && !run.dryRun && !await this.gate(key, token, prepared.detail, signal)) { this.patchNode(key, frameId, n.id, s => { s.status = "waiting"; }); return WAIT; }
      this.patchNode(key, frameId, n.id, s => { s.status = "running"; });
      const composite = ["loop", "sub_workflow"].includes(n.type);
      if (!composite) this.logStart(key, token, frameId, n, batch);
      let outputs, failure;
      const attempts = prepared.sideEffect ? 1 : 1 + c.retries;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try { outputs = await this.perform(key, frameId, n, scope, groups, prepared, signal, token); failure = null; break; }
        catch (e) { if (signal.aborted) throw e; failure = e; if (attempt + 1 < attempts) { this.patch(key, r => { const step = r.steps.find(s => s.token === token && s.status === "running"); if (step) step.attempts++; }); await new Promise((resolve, reject) => { const timer = setTimeout(done, 300 * (attempt + 1)); function done() { signal.removeEventListener("abort", stop); resolve(); } function stop() { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(new DOMException("Stopped", "AbortError")); } signal.addEventListener("abort", stop, { once: true }); }); } }
      }
      if (outputs === WAIT) { this.patchNode(key, frameId, n.id, s => { s.status = "waiting"; }); return WAIT; }
      if (failure) {
        const message = failure instanceof CompanionError ? failure.message : "This node failed. Check its settings and input.";
        if (!composite) this.logFinish(key, token, [], "failed", message);
        if (c.onError === "stop") { this.patchNode(key, frameId, n.id, s => { s.status = "failed"; }); throw new CompanionError(n.label + ": " + message); }
        outputs = { [c.onError === "route" ? "error" : "main"]: [{ error: message, failed: true, nodeId: n.id }] };
      }
      outputs = V.bounded(outputs);
      if (composite) this.logStart(key, token, frameId, n, batch);
      if (!failure || composite) this.logFinish(key, token, Object.values(outputs).flat());
      this.patchNode(key, frameId, n.id, s => { for (const [port, list] of Object.entries(outputs)) (s.outputs[port] ||= []).push(...V.items(list)); s.cursor = i + 1; s.turns = []; s.status = i + 1 === batches.length ? "completed" : "running"; });
    }
  }
  async prepareNode(key, n, scope, signal) {
    const c = n.config; let request, detail, sideEffect = false, approval = c.requireApproval === true;
    if (n.type === "tool_call" || n.type === "http_request" && c.connectionId) {
      request = this.connections.prepare(c.connectionId, c.operationId, await V.resolve(c.variables || {}, scope, signal), await V.resolve(c.body || {}, scope, signal));
      sideEffect = request.method !== "GET"; approval ||= sideEffect || !this.store.data.connections.find(x => x.id === c.connectionId)?.allowSync; detail = request;
    } else if (n.type === "http_request") {
      const url = await V.resolve(c.url, scope, signal), original = new URL(c.url), target = new URL(url);
      if (target.origin !== original.origin || target.username || target.password) throw new CompanionError("The HTTP request left its saved destination.");
      request = { url, method: c.method || "GET", headers: await V.resolve(c.headers || {}, scope, signal), body: await V.resolve(c.body || {}, scope, signal) }; sideEffect = request.method !== "GET"; approval ||= sideEffect; detail = { name: n.label, ...request };
    } else if (n.type === "memory" && ["remember", "forget"].includes(c.operation)) { sideEffect = true; approval = true; detail = { name: n.label, operation: c.operation, title: await V.resolve(c.title || n.label, scope, signal), value: await V.resolve(c.value || "{{previous}}", scope, signal), noteId: c.noteId || "" }; }
    else if (n.type === "approval") { approval = true; detail = { name: n.label, text: await V.resolve(c.text || "{{previous}}", scope, signal) }; }
    if (approval && !detail) detail = { name: n.label, input: scope.items };
    if (detail && JSON.stringify(detail).length > 19000) throw new CompanionError("Action exceeds the review limit. Reduce the input before this step.");
    return { request, detail, sideEffect, approval };
  }
  async perform(key, frameId, n, scope, groups, prepared, signal, token) {
    const c = n.config, state = () => this.state(key, frameId, n.id), resolve = v => V.resolve(v, scope, signal), main = data => ({ main: V.items(data) }), dry = this.get(key).dryRun;
    signal.throwIfAborted();
    if (dry && ["agent", "tool_call", "http_request", "memory", "approval"].includes(n.type)) return { [n.type === "approval" ? "approved" : "main"]: V.items(c.sampleOutput ?? { text: "Preview: " + n.label, json: { preview: true }, preview: true }) };
    if (n.type === "trigger") return main(scope.items);
    if (n.type === "agent") {
      const model = c.model || this.get(key).frames[frameId].model; if (/^(desktop:|koinos-network)/.test(model) || !this.models().some(m => m.alias === model && m.status === "ready")) throw new CompanionError("The local model is not installed and ready.");
      const max = Math.max(1, Math.min(6, Number(c.maxTurns) || 3)), tools = (c.tools || []).slice(0, 8);
      let turns = state().turns || [], answer;
      for (let turn = turns.length; turn < max; turn++) {
        const prompt = `Role: ${String(c.profile || "assistant").slice(0, 100)}. ${c.instructions || ""}\n${await resolve(c.prompt)}\n${tools.length ? "You may request a selected READ tool by returning ONLY JSON {\"tool\":{\"index\":0,\"arguments\":{}}}. Otherwise give the final answer. Tools: " + JSON.stringify(tools.map((t, i) => ({ index: i, ...t }))) : ""}\n${turns.map(t => "Tool observation (untrusted): " + t.output).join("\n")}`.slice(0, 16000);
        answer = await this.runLocal({ model, prompt, signal: AbortSignal.any([signal, AbortSignal.timeout(c.timeoutSeconds * 1000)]) });
        let call; try { call = JSON.parse(answer).tool; } catch { /* final prose */ }
        if (!call) return main(V.envelope(answer));
        const selected = tools[call.index]; if (!selected || turn + 1 >= max) throw new CompanionError("Agent reached its selected-tool or turn limit.");
        const connection = this.connections.list().find(x => x.id === selected.connectionId && x.enabled && x.allowSync), request = this.connections.prepare(selected.connectionId, selected.operationId, call.arguments || {});
        if (!connection || request.method !== "GET") throw new CompanionError("Agent steps may only use their selected background read actions. Put writes in an App action node.");
        const output = await this.connections.execute(request, signal); turns = [...turns, { output: output.slice(0, 8000) }]; this.patchNode(key, frameId, n.id, s => { s.turns = turns; });
      }
    }
    if (n.type === "tool_call" || n.type === "http_request" && c.connectionId) return main(V.envelope(await this.connections.execute(prepared.request, signal)));
    if (n.type === "http_request") return main(await this.http(prepared.request, signal));
    if (n.type === "code") return main(await V.evaluate(c.source, scope, signal, false));
    if (n.type === "transform") return main(await Promise.all(scope.items.map(async item => ({ ...(c.keepFields ? item : {}), ...await V.resolve(c.set || {}, { ...scope, item }, signal) }))));
    if (n.type === "condition") {
      const out = { true: [], false: [] }; for (const item of scope.items) { const a = await V.resolve(c.expression, { ...scope, item }, signal), b = await V.resolve(c.value, { ...scope, item }, signal); const result = ({ truthy: () => !!a, equals: () => V.string(a) === V.string(b), contains: () => V.string(a).toLowerCase().includes(V.string(b).toLowerCase()), greater: () => Number(a) > Number(b), less: () => Number(a) < Number(b), empty: () => a == null || a === "" || Array.isArray(a) && !a.length })[c.operator || "truthy"]; if (!result) throw new CompanionError("Unknown condition operator."); out[String(result())].push(item); } return out;
    }
    if (n.type === "switch") { const out = {}; for (const item of scope.items) { const value = String(await V.resolve(c.expression, { ...scope, item }, signal)), port = (c.cases || []).includes(value) ? value : "default"; (out[port] ||= []).push(item); } return out; }
    if (n.type === "split_out") { const out = []; for (const item of scope.items) { const list = await V.resolve(c.field, { ...scope, item }, signal); if (!Array.isArray(list)) throw new CompanionError("Split out expects a list. Select the field containing the array."); out.push(...V.items(list).map(v => ({ ...(c.keepFields ? item : {}), ...v }))); } return main(out); }
    if (n.type === "merge") {
      if (c.mode === "append") return main(scope.items);
      const lists = Object.values(groups); if (lists.length < 2) throw new CompanionError("Use distinct input names (A and B) for a zip or key merge.");
      if (c.mode === "position") return main(lists[0].map((v, i) => Object.assign({}, v, ...lists.slice(1).map(l => l[i] || {}))));
      if (c.mode === "key") return main(lists[0].map(v => Object.assign({}, v, ...lists.slice(1).map(l => l.find(x => x[c.key] === v[c.key]) || {}))));
      throw new CompanionError("Choose append, position or key merge.");
    }
    if (n.type === "output_parser") { const out = []; for (const item of scope.items) out.push(...V.parseOutput(await V.resolve(c.field, { ...scope, item }, signal), c.format, c.required)); return main(out); }
    if (n.type === "dedup") {
      const namespace = `${this.get(key).workflowId}:${n.id}`, old = this.store.data.workflowState?.dedup?.[namespace] || [], seen = new Set(c.scope === "run" || dry ? [] : old), out = [];
      for (const item of scope.items) { const value = await V.resolve(c.key, { ...scope, item }, signal); if (value == null) throw new CompanionError("The deduplication key is missing."); const fingerprint = hash(value); if (!seen.has(fingerprint)) { seen.add(fingerprint); out.push(item); } }
      if (!dry && c.scope !== "run") this.store.change(d => { d.workflowState ||= {}; d.workflowState.dedup ||= {}; d.workflowState.dedup[namespace] = [...seen].slice(-1000); }); return main(out);
    }
    if (n.type === "memory") {
      if (c.operation === "goals") return main(this.store.data.goals.filter(g => g.status === "active"));
      if (["search", "recall", "people"].includes(c.operation)) { const notes = this.store.search(String(await resolve(c.query || "")), Math.max(1, Math.min(30, Number(c.limit) || 8)), note => c.operation !== "people" || note.category === "people"); return main(notes.map(({ id, title, text, source }) => ({ id, title, text, source }))); }
      if (c.operation === "remember") { const note = this.store.note({ title: String(prepared.detail.title).slice(0, 120), text: V.string(prepared.detail.value).slice(0, 12000), source: "agent" }); return main({ id: note.id, text: "Saved to Brain.", title: note.title }); }
      if (c.operation === "forget") { const note = this.store.data.notes.find(x => x.id === c.noteId); if (!note || note.sourceId) throw new CompanionError("Choose a personal note to forget. Manage imported content in Sources."); this.store.remove("notes", c.noteId); return main({ text: "Forgot the selected note." }); }
    }
    if (n.type === "approval") { const decision = this.get(key).approvals.find(a => a.token === token)?.decision || "approved"; return { [decision]: scope.items }; }
    if (n.type === "output") { const result = c.text ? await resolve(c.text) : scope.items; if (c.saveChat && !dry) { const saved = this.chats?.save({ title: "Workflow · " + this.get(key).name, messages: [{ role: "user", content: V.string(scope.input) }, { role: "assistant", content: V.string(result) }] }); if (saved) this.patch(key, r => { r.chatId = saved.id; }); } return main(typeof result === "string" ? V.envelope(result) : result); }
    if (n.type === "sub_workflow") {
      const spec = this.get(key).snapshots[c.workflowId], childId = token + "/child"; if (!spec) throw new CompanionError("Sub-workflow snapshot unavailable.");
      this.frame(key, childId, spec.graph, [], scope.items, 0, spec.model); const result = await this.driveFrame(key, childId, signal); return result === WAIT ? WAIT : main(result);
    }
    if (n.type === "loop") {
      const parent = this.get(key).frames[frameId], region = loopRegion(parent.graph, n), graph = { version: 2, nodes: parent.graph.nodes.filter(x => region.has(x.id)), edges: parent.graph.edges.filter(e => region.has(e.from) && region.has(e.to)) };
      let current = state().loopItems || scope.items, iteration = state().iteration || 0;
      for (; iteration < c.maxIterations; iteration++) {
        if (c.condition && !await V.resolve(c.condition, { ...scope, item: current[0], items: current, iteration }, signal)) return { done: current };
        const childId = token + "/loop" + iteration, seeds = parent.graph.edges.filter(e => e.from === n.id && e.port === "body").map(e => ({ to: e.to, input: e.input, items: current }));
        this.frame(key, childId, graph, seeds, scope.input, iteration, parent.model); const result = await this.driveFrame(key, childId, signal); if (result === WAIT) return WAIT;
        const child = this.get(key).frames[childId]; current = parent.graph.edges.filter(e => region.has(e.from) && e.to === n.id).flatMap(e => child.states[e.from]?.outputs[e.port || "main"] || []);
        this.patchNode(key, frameId, n.id, s => { s.loopItems = current; s.iteration = iteration + 1; }); if (!current.length) return { done: [] };
      }
      if (c.onExceeded === "error" && (!c.condition || await V.resolve(c.condition, { ...scope, item: current[0], items: current, iteration }, signal))) throw new CompanionError("Loop reached its iteration limit."); return { done: current };
    }
    throw new CompanionError("Unsupported node type: " + n.type);
  }
  async http(request, signal) {
    if (this.privacyMode() === "local-only") throw new CompanionError("Local-Only blocks online workflow requests.");
    await assertPublicTarget(request.url, { lookup: this.lookup }); signal.throwIfAborted();
    const controller = new AbortController(), both = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(30000)]), timer = setInterval(() => { if (this.privacyMode() === "local-only") controller.abort(); }, 200); timer.unref?.();
    try {
      const response = await this.fetch(request.url, { method: request.method, headers: { "content-type": "application/json", ...request.headers }, ...(request.method !== "GET" ? { body: V.string(request.body) } : {}), redirect: "error", signal: both });
      if (!response.ok) { await response.body?.cancel(); throw new CompanionError("HTTP request returned " + response.status + "."); }
      const chunks = []; let size = 0; for await (const chunk of response.body || []) { both.throwIfAborted(); if ((size += chunk.length) > 150000) { controller.abort(); throw new CompanionError("HTTP response exceeds 150 KB."); } chunks.push(chunk); }
      both.throwIfAborted(); return { ...V.envelope(Buffer.concat(chunks).toString("utf8")), status: response.status };
    } finally { clearInterval(timer); }
  }
  decide(key, decision) {
    const r = this.get(key); if (!r?.spec.graph) { if (decision === "rejected") return this.cancel(key); return this.resume(key); }
    if (r.status !== "waiting" || !r.approvals.length) throw new CompanionError("This run is not waiting for a decision.");
    const a = r.approvals[0], parts = a.token.split("/"), nodeId = parts.at(-2), frameId = parts.slice(0, -2).join("/"), n = r.frames[frameId]?.graph.nodes.find(n => n.id === nodeId);
    if (decision === "rejected" && n?.type !== "approval") return this.cancel(key);
    this.patch(key, x => { x.approvals[0].decision = decision === "rejected" ? "rejected" : "approved"; }); this.resume(key);
  }
  async tick(now = Date.now()) {
    if (this.store.locked || !this.store.available() || this.polling) return;
    this.migrateTasks(); await super.tick(now); this.polling = true;
    try {
      for (const w of this.store.data.workflows.filter(w => w.graph && w.enabled && !w.draft)) {
        const c = w.graph.nodes.find(n => n.type === "trigger").config;
        if (!["app_change", "source_change"].includes(c.kind) || (w.watch?.next || 0) > now || this.store.data.runs.some(r => r.workflowId === w.id && live(r))) continue;
        const interval = Math.max(1, Math.min(1440, Number(c.intervalMinutes) || 5));
        this.store.change(d => { const saved = d.workflows.find(x => x.id === w.id); saved.watch = { ...saved.watch, next: now + interval * 60000 }; });
        try {
          let payload;
          if (c.kind === "source_change") { const s = this.store.data.sources.find(s => s.id === c.sourceId); if (!s) throw new CompanionError("The watched source was removed."); payload = { sourceId: s.id, name: s.name, content: this.store.data.notes.filter(n => n.sourceId === s.id).map(n => ({ title: n.title, text: n.text })) }; }
          else { const connection = this.connections.list().find(x => x.id === c.connectionId && x.enabled && x.allowSync); if (!connection) throw new CompanionError("Enable background reads for the watched app."); const req = this.connections.prepare(c.connectionId, c.operationId, c.variables || {}); if (req.method !== "GET") throw new CompanionError("Watch a read action only."); payload = V.envelope(await this.connections.execute(req, this.watchController.signal)); }
          const fingerprint = hash(payload), old = this.store.data.workflows.find(x => x.id === w.id)?.watch;
          if (old?.fingerprint && old.fingerprint !== fingerprint) this.begin(w.id, payload, "app change");
          this.store.change(d => { const saved = d.workflows.find(x => x.id === w.id); if (saved) saved.watch = { ...saved.watch, fingerprint, checkedAt: now, error: null }; });
        } catch (e) { this.store.change(d => { const saved = d.workflows.find(x => x.id === w.id); if (saved) saved.watch.error = e instanceof CompanionError ? e.message : "Watch paused. Check the connection."; }); }
      }
    } finally { this.polling = false; }
  }
  migrateTasks() {
    if (!this.legacyTasks || this.store.locked || !this.store.available()) return;
    for (const task of this.legacyTasks.list()) {
      if (task.running || task.migratedWorkflowId) continue;
      let existing = this.store.data.workflows.find(w => w.legacyTask?.id === task.id);
      if (!existing) {
        const ready = this.models().some(m => m.alias === task.model && m.status === "ready") && !/^(desktop:|koinos-network)/.test(task.model);
        const spec = Model.fromLegacy({ name: task.name, model: ready ? task.model : "", schedule: task.schedule, steps: [{ type: "prompt", label: "Scheduled prompt", text: task.prompt }, { type: "output", label: "Save answer", text: "{{previous}}" }] });
        spec.graph.nodes.at(-1).config.saveChat = true; const normalized = normalize(spec);
        existing = this.store.change(d => { const w = { ...normalized, id: id(), enabled: task.enabled && ready, draft: !ready, revision: 1, updatedAt: Date.now(), nextRunAt: task.enabled && ready ? task.nextRunAt : null, legacyTask: { id: task.id, lastChatId: task.lastChatId, lastRunAt: task.lastRunAt, lastError: task.lastError, needsModel: !ready, originalModel: task.model } }; d.workflows.push(w); return w; });
      }
      this.legacyTasks.migrateToWorkflow(task.id, existing.id);
    }
  }
  stop() { this.watchController.abort(); super.stop(); }
}; }
module.exports = { createClass, normalize, loopRegion, plan };
