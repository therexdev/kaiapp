/* KAI's portable workflow document. Shared by the private runner and canvas. */
(function (root, factory) {
  const api = factory(); if (typeof module === "object" && module.exports) module.exports = api; else root.KaiWorkflowModel = api;
})(typeof window === "object" ? window : globalThis, function () {
  "use strict";
  const clone = x => JSON.parse(JSON.stringify(x));
  const catalog = [
    ["trigger", "Trigger", "Start", "Start manually, on a schedule, or when a source changes.", "⚡"],
    ["agent", "Agent", "Actions", "Ask a local model to reason, write, or use selected read tools.", "✦"],
    ["tool_call", "App action", "Actions", "Run an action from a connected app or custom API.", "↗"],
    ["http_request", "HTTP request", "Actions", "Fetch a public endpoint or use a saved API connection.", "◎"],
    ["code", "Code", "Actions", "Transform data with isolated JavaScript.", "{}"],
    ["sub_workflow", "Sub-workflow", "Actions", "Run another saved workflow and return its result.", "▧"],
    ["memory", "Brain memory", "Actions", "Search, read, remember, or forget selected Brain notes.", "♧"],
    ["approval", "Human review", "Actions", "Pause for a decision and follow the approved or rejected path.", "✓"],
    ["condition", "Condition", "Logic", "Route each item to a true or false branch.", "⑂"],
    ["switch", "Switch", "Logic", "Route items to named cases or a fallback.", "⋔"],
    ["merge", "Merge", "Logic", "Wait for branches and append, zip, or join their items.", "⋈"],
    ["split_out", "Split out", "Logic", "Turn a list into individual items.", "⋮"],
    ["transform", "Transform", "Logic", "Map fields with expressions using upstream data.", "◇"],
    ["output_parser", "Output parser", "Logic", "Parse JSON, text, or CSV and validate required fields.", "≡"],
    ["dedup", "Deduplicate", "Logic", "Skip items already seen in this workflow.", "⊜"],
    ["loop", "Loop", "Logic", "Repeat a connected body a limited number of times.", "↻"],
    ["output", "Result", "Finish", "Keep a result in run history or a new conversation.", "▤"],
  ].map(([type, name, group, description, icon]) => ({ type, name, group, description, icon }));
  const types = catalog.map(x => x.type), meta = type => catalog.find(x => x.type === type);
  function defaults(type) {
    return clone({ trigger: { kind: "manual", schedule: { kind: "daily", hour: 9, minute: 0, day: 1 }, inputFields: [] }, agent: { prompt: "Summarize this input and suggest next steps:\n{{previous}}", profile: "assistant", model: "", execution: "once", maxTurns: 3, tools: [] }, tool_call: { connectionId: "", operationId: "", variables: {}, body: {}, execution: "per_item" }, http_request: { method: "GET", url: "https://api.example.com/data", headers: {}, body: {}, execution: "per_item" }, code: { language: "javascript", source: "return items;" }, sub_workflow: { workflowId: "", execution: "once" }, memory: { operation: "search", query: "{{input}}", limit: 8 }, approval: { text: "Review this result:\n{{previous}}" }, condition: { expression: "=Boolean(item.text)", operator: "truthy", value: "" }, switch: { expression: "=item.status", cases: ["ready", "pending"] }, merge: { mode: "append", key: "id" }, split_out: { field: "=item.json", keepFields: false }, transform: { set: { summary: "=item.text" }, keepFields: true }, output_parser: { format: "json", field: "=item.text", required: "" }, dedup: { key: "=item.id", scope: "workflow" }, loop: { maxIterations: 3, condition: "", onExceeded: "continue" }, output: { text: "{{previous}}", saveChat: false } }[type] || {});
  }
  const node = (type, id, position, config = {}, label) => ({ id, type, label: label || meta(type)?.name || type, config: { ...defaults(type), ...config }, position: position || { x: 80, y: 80 } });
  const edge = (from, to, port = "main", input = "main") => ({ id: [from, port, to, input].join(":"), from, to, port, input });
  function ports(n) { return [...new Set(n.type === "condition" ? ["true", "false", "error"] : n.type === "switch" ? [...(n.config.cases || []).map(String), "default", "error"] : n.type === "loop" ? ["body", "done", "error"] : n.type === "approval" ? ["approved", "rejected", "error"] : ["main", "error"])]; }
  function fromLegacy(w) {
    if (w.graph) return clone(w);
    const nodes = [node("trigger", "start", { x: 80, y: 80 }, { kind: w.schedule?.kind !== "manual" ? "schedule" : "manual", schedule: w.schedule || { kind: "manual" } })], edges = [];
    (w.steps || []).forEach((s, i) => {
      const type = { prompt: "agent", connection: "tool_call", brain_search: "memory", remember: "memory" }[s.type] || s.type;
      const config = s.type === "prompt" ? { prompt: s.text, model: w.model } : s.type === "brain_search" ? { operation: "search", query: s.text || "{{input}}", legacyText: true } : s.type === "remember" ? { operation: "remember", title: s.label, value: s.text } : s.type === "condition" ? { expression: "=item.text", operator: "contains", value: s.text } : s.type === "connection" ? { ...s } : { text: s.text };
      const n = node(type, "step" + (i + 1), { x: 80, y: 80 + (i + 1) * 150 }, config, s.label); nodes.push(n);
      edges.push(edge(nodes[i].id, n.id, nodes[i].type === "condition" ? "true" : nodes[i].type === "approval" ? "approved" : "main"));
    });
    return { ...clone(w), graph: { version: 2, nodes, edges } };
  }
  // Exchange behavior, not source code: explicitly translate the documented OpenHuman wire format.
  function importDocument(raw) {
    const w = clone(raw.flow || raw), g = w.graph || (w.nodes ? w : null);
    if (!g) return fromLegacy(w);
    if (g.nodes?.some(n => n.kind)) {
      const nodes = g.nodes.map((n, i) => {
        const c = { ...(n.config || {}) }, type = n.kind;
        if (type === "trigger") { c.kind = c.trigger_kind || "manual"; if (typeof c.schedule === "string") c.schedule = { kind: "cron", expression: c.schedule }; }
        for (const [a, b] of [["workflow_id", "workflowId"], ["max_iterations", "maxIterations"], ["on_exceeded", "onExceeded"], ["on_error", "onError"], ["connection_ref", "connectionId"]]) if (c[a] !== undefined) c[b] = c[a];
        if (type === "agent") c.profile = c.agent_ref || "assistant";
        if (type === "tool_call") { c.operationId = c.slug || ""; c.variables = c.args || {}; }
        if (type === "condition" && c.field && !c.expression) c.expression = "=item[" + JSON.stringify(c.field) + "]";
        return node(type, n.id, n.position || { x: 80, y: 80 + i * 150 }, c, n.name);
      });
      return { name: w.name || g.name || "Imported workflow", description: w.description || "", enabled: false, graph: { version: 2, nodes, edges: (g.edges || []).map(e => edge(e.from_node, e.to_node, e.from_port || "main", e.to_port || "main")) } };
    }
    return { ...w, graph: g, enabled: false };
  }
  function validateGraph(g) {
    const errors = [], warnings = [], error = (message, nodeId) => errors.push({ message, nodeId });
    if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return { errors: [{ message: "Add a workflow graph." }], warnings };
    if (!g.nodes.length || g.nodes.length > 60 || g.edges.length > 160) error("Use 1–60 nodes and at most 160 connections.");
    const ids = new Set(); for (const n of g.nodes) { if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(n.id) || ids.has(n.id)) error("Nodes need unique letter-led IDs.", n.id); ids.add(n.id); if (!types.includes(n.type)) error("Unsupported node: " + n.type, n.id); if (!n.config || typeof n.config !== "object" || Array.isArray(n.config)) error("Node settings must be an object.", n.id); }
    const triggers = g.nodes.filter(n => n.type === "trigger"); if (triggers.length !== 1) error("Add exactly one trigger.");
    const seen = new Set(); for (const e of g.edges) { const from = g.nodes.find(n => n.id === e.from); if (!from || !ids.has(e.to)) error("A connection points to a missing node."); else if (!ports(from).includes(e.port || "main")) error("Unknown output port: " + e.port, e.from); const key = [e.from, e.to, e.port, e.input].join(":"); if (seen.has(key)) error("Remove the duplicate connection.", e.from); seen.add(key); if (e.to === triggers[0]?.id) error("A trigger cannot have incoming connections.", e.to); }
    const reached = new Set(), walk = id => { if (reached.has(id)) return; reached.add(id); g.edges.filter(e => e.from === id).forEach(e => walk(e.to)); }; if (triggers[0]) walk(triggers[0].id);
    g.nodes.filter(n => !reached.has(n.id)).forEach(n => error("Connect this node to the trigger.", n.id));
    // Every cycle must pass through a bounded loop head. Removing loop heads must leave a DAG.
    const loops = new Set(g.nodes.filter(n => n.type === "loop").map(n => n.id)), visiting = new Set(), done = new Set();
    const cycle = id => { if (loops.has(id) || done.has(id)) return; if (visiting.has(id)) { error("Close cycles through a Loop node with a finite limit.", id); return; } visiting.add(id); g.edges.filter(e => e.from === id).forEach(e => cycle(e.to)); visiting.delete(id); done.add(id); }; g.nodes.forEach(n => cycle(n.id));
    for (const n of g.nodes) {
      const c = n.config || {};
      if (n.type === "loop" && (!Number.isInteger(c.maxIterations) || c.maxIterations < 1 || c.maxIterations > 50)) error("Choose a loop limit from 1 to 50.", n.id);
      if (n.type === "sub_workflow" && !c.workflowId) error("Choose a saved sub-workflow.", n.id);
      if (n.type === "tool_call" && (!c.connectionId || !c.operationId)) error("Choose a connected app and action.", n.id);
      if (n.type === "agent" && !c.prompt?.trim()) error("Tell this agent what to do.", n.id);
      if (n.type === "http_request" && !c.connectionId && !/^https:\/\//.test(c.url || "")) error("Use a public HTTPS endpoint or a saved API connection.", n.id);
      if (n.type === "code" && c.language !== "javascript") error("KAI Code nodes use isolated JavaScript; translate this script before enabling it.", n.id);
      if (n.type === "trigger" && !["manual", "schedule", "app_change", "source_change", "app_event"].includes(c.kind)) error("Choose a supported trigger. Raw webhook listeners are not enabled.", n.id);
      if (n.type === "trigger" && ["app_change", "source_change"].includes(c.kind) && !(c.sourceId || c.connectionId && c.operationId)) error("Select the source or read action to watch.", n.id);
      if (n.type === "trigger" && c.kind === "app_event" && !(c.connectionId && c.triggerSlug)) error("Select the app account and event type.", n.id);
      if (n.type === "switch" && (!Array.isArray(c.cases) || c.cases.length > 12 || c.cases.some(p => !/^[a-zA-Z0-9_-]{1,40}$/.test(p) || ["default", "error"].includes(p)))) error("Use up to 12 unique case names (letters, numbers, dashes).", n.id);
      if (n.type === "condition" && !g.edges.some(e => e.from === n.id && e.port === "false")) warnings.push({ nodeId: n.id, message: "Unmatched items stop here; connect False to handle them." });
    }
    return { errors, warnings };
  }
  function template(key, model = "", connection) {
    const trigger = node("trigger", "start", { x: 90, y: 60 }), nodes = [trigger], edges = [];
    const add = (type, config, label) => { const n = node(type, "n" + nodes.length, { x: 90, y: 60 + nodes.length * 155 }, config, label); edges.push(edge(nodes.at(-1).id, n.id, nodes.at(-1).type === "approval" ? "approved" : "main")); nodes.push(n); return n; };
    const ask = (prompt, label) => add("agent", { prompt, model }, label);
    let name;
    if (["briefing", "review", "digest"].includes(key)) { name = { briefing: "Project briefing", review: "Weekly goal review", digest: "Daily digest to an app" }[key]; add("memory", { operation: "search", query: "{{input}}" }, "Gather context"); ask("Summarize these notes and identify useful next steps. Cite note titles.\n{{previous}}", "Write a briefing"); if (key === "review") add("memory", { operation: "remember", title: "Reviewed next steps", value: "{{previous}}" }, "Remember next steps"); if (key === "digest") { trigger.config.kind = "schedule"; add("tool_call", { connectionId: connection?.id || "", operationId: "", variables: {}, body: {} }, "Send the reviewed digest"); } }
    else if (["api", "scrape"].includes(key)) { name = key === "api" ? "Fetch and parse an API" : "Scheduled source to Brain"; add("http_request", { url: "https://api.example.com/data" }, "Call the API"); add("output_parser", { field: "=item.text", format: "json" }, "Parse the response"); if (key === "scrape") { trigger.config.kind = "schedule"; ask("Summarize this source:\n{{previous}}", "Summarize source"); add("memory", { operation: "remember", title: "Source summary", value: "{{previous}}" }, "Save to Brain"); } }
    else if (key === "event") { name = "App change to conditional action"; trigger.config = { ...trigger.config, kind: "app_change", connectionId: connection?.id || "", operationId: connection?.operations?.find(o => o.method === "GET")?.id || "", variables: {}, intervalMinutes: 5 }; ask("Classify this change and return JSON with a boolean relevant field and a short summary.\n{{previous}}", "Triage the change"); add("output_parser", { format: "json", field: "=item.text" }); add("condition", { expression: "=item.relevant" }, "Is it relevant?"); const out = node("output", "result", { x: 90, y: 680 }, { text: "{{previous}}" }, "Keep relevant result"); edges.push(edge(nodes.at(-1).id, out.id, "true")); nodes.push(out); }
    else if (key === "research") { name = "Plan and write a research brief"; add("memory", { operation: "search", query: "{{input}}" }, "Gather research"); ask("Plan a concise research brief from these sources:\n{{previous}}", "Plan the brief"); ask("Write the brief from this plan. Clearly mark unknowns.\n{{previous}}", "Draft the brief"); }
    else if (key === "loop") { name = "Review and refine"; ask("Draft a short answer to {{input}}", "First draft"); const loop = add("loop", { maxIterations: 2, onExceeded: "continue" }, "Refine twice"), refine = node("agent", "refine", { x: 420, y: 390 }, { model, prompt: "Improve this draft, keeping it concise:\n{{previous}}" }, "Refine draft"); nodes.push(refine); edges.push(edge(loop.id, refine.id, "body"), edge(refine.id, loop.id)); const out = node("output", "result", { x: 90, y: 560 }); nodes.push(out); edges.push(edge(loop.id, out.id, "done")); }
    else { name = "Ask KAI"; ask("{{input}}", "Ask the agent"); }
    if (!nodes.some(n => n.type === "output") && nodes.at(-1).type !== "memory") add("output", { text: "{{previous}}" }, "Keep the result");
    return { name, model, enabled: false, description: "", graph: { version: 2, nodes, edges } };
  }
  const templates = [["briefing", "Project briefing", "Search your Brain and prepare a useful briefing."], ["review", "Weekly goal review", "Review context and remember approved next steps."], ["digest", "Daily digest to an app", "Summarize context on a schedule and send it to a connection."], ["scrape", "Scheduled source to Brain", "Read a source, summarize it, and remember the reviewed result."], ["event", "App change to conditional action", "Watch a read action, triage changes, and follow a branch."], ["api", "Fetch and parse an API", "Read structured data and use it in later steps."], ["ask", "Ask KAI", "A simple manual prompt with a saved result."], ["research", "Plan and write a research brief", "Use separate agents and models to plan and draft."], ["loop", "Review and refine", "Improve a draft through a bounded feedback loop."]];
  return { catalog, types, meta, defaults, node, edge, ports, fromLegacy, importDocument, validateGraph, template, templates, clone };
});
