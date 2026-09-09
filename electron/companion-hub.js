"use strict";
const fs = require("fs"), path = require("path");
const { CompanionStore, CompanionError, id, text, copy } = require("./companion-store");
const { CompanionConnections, TEMPLATES } = require("./companion-connections");
const { CompanionWorkflows, TYPES } = require("./companion-workflows");
const { trustedFrame } = require("./mascot");

class CompanionHub {
  constructor({ dataDir, safeStorage, privacyMode, models, runLocal, fetchImpl, canUseModel, legacyMemory, account, openExternal, chats, lookup }) {
    this.store = new CompanionStore({ dataDir, safeStorage }); this.models = models; this.canUseModel = canUseModel; this.legacyMemory = legacyMemory;
    this.connections = new CompanionConnections({ store: this.store, privacyMode, fetchImpl });
    const { CompanionComposio } = require("./companion-composio");
    this.composio = new CompanionComposio({ store: this.store, privacyMode, account, fetchImpl, openExternal });
    this.connections.composio = this.composio;
    this.workflows = new CompanionWorkflows({ store: this.store, connections: this.connections, runLocal, models });
    const { CompanionBrain } = require("./companion-brain"), { CompanionSources } = require("./companion-sources"), { CompanionAwareness } = require("./companion-awareness");
    this.brain = new CompanionBrain({ store: this.store });
    this.sources = new CompanionSources({ store: this.store, chats, privacyMode, fetchImpl, lookup });
    this.awareness = new CompanionAwareness({ store: this.store, models, runLocal, workflows: this.workflows });
    this.syncing = new Set(); this.sourceControllers = new Map(); this.timer = null;
  }
  status() {
    const s = this.store;
    if (s.locked || !s.available()) return { locked: true, available: s.available() };
    const { connections, composio, ...data } = s.data;
    return { ...copy(data), brainIndex: this.brain.index(), awarenessRunning: this.awareness.active?.id || null, available: true, locked: false, composio: this.composio.status(), connections: this.connections.list(), templates: copy(TEMPLATES), models: this.models().filter(m => m.status === "ready"), stepTypes: TYPES, syncing: [...this.syncing] };
  }
  source(input) {
    const request = this.connections.prepare(input.connectionId, input.operationId, input.variables || {});
    if (request.method !== "GET") throw new CompanionError("Brain sources must use a GET operation.");
    const c = this.store.data.connections.find(c => c.id === input.connectionId);
    if (input.autoSync && !c.allowSync) throw new CompanionError("Enable background reads on this connection before enabling auto-sync.");
    return this.store.change(d => {
      if (d.sources.length >= 100) throw new CompanionError("Maximum 100 sources.");
      const s = { id: id(), kind: "connection", name: text(input.name, 100, "Source name"), connectionId: c.id, operationId: request.operationId,
        variables: copy(input.variables || {}), autoSync: input.autoSync === true, lastSync: null, nextSync: Date.now() + 1200000, error: null };
      d.sources.push(s); return s;
    });
  }
  async sync(key, signal) {
    if (this.syncing.has(key)) throw new CompanionError("This source is already syncing.");
    if (this.syncing.size >= 2) throw new CompanionError("Two sources are already syncing. Try again when one finishes.");
    const s = copy(this.store.data.sources.find(s => s.id === key) || null);
    if (!s || s.kind === "file") throw new CompanionError("Re-import a file to update it.");
    const c = this.store.data.connections.find(c => c.id === s.connectionId);
    if (s.kind === "connection" && !c?.allowSync) throw new CompanionError("Enable background reads on this connection before syncing.");
    const controller = new AbortController(); signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.sourceControllers.set(key, controller); this.syncing.add(key);
    try {
      const result = s.kind === "connection" ? await this.connections.execute(this.connections.prepare(s.connectionId, s.operationId, s.variables), signal) : await this.sources.read(s, signal);
      signal?.throwIfAborted(); if (!this.store.data.sources.some(x => x.id === key)) return;
      return this.store.ingest(key, result);
    } catch (e) {
      this.store.change(d => { const source = d.sources.find(x => x.id === key); if (source) { source.error = e instanceof CompanionError ? e.message : "Sync stopped."; d.syncs.unshift({ sourceId: key, name: source.name, at: Date.now(), status: "failed", error: source.error }); d.syncs = d.syncs.slice(0, 100); } });
      throw e;
    } finally {
      this.syncing.delete(key); this.sourceControllers.delete(key);
      this.store.change(d => { const source = d.sources.find(x => x.id === key); if (source) source.nextSync = Date.now() + (source.intervalMinutes || 20) * 60000; });
    }
  }
  importText(name, content) {
    text(content, 200000, "File content");
    const source = this.store.change(d => {
      const existing = d.sources.find(s => s.kind === "file" && s.name === name);
      if (existing) return existing;
      if (d.sources.length >= 100) throw new CompanionError("Maximum 100 sources.");
      const s = { id: id(), kind: "file", name: text(name, 100, "File name"), autoSync: false, lastSync: null }; d.sources.push(s); return s;
    });
    return this.store.ingest(source.id, content);
  }
  toolList(model) {
    if (!this.canUseModel(model) || this.store.locked || !this.store.available()) return [];
    const tools = [
      { name: "brain_search", description: "Search private Brain notes, people, projects, preferences, and imported sources.", params: { query: "what to find" } },
      { name: "brain_remember", description: "Ask the user to approve a fact for persistent Brain memory.", params: { text: "fact to remember", title: "short title", category: "notes | preferences | people | projects" } },
      { name: "brain_goals", description: "Read the user's active goals from Brain.", params: {} },
      { name: "workflow_propose", description: "Save a disabled workflow draft for the user to review in Workflows. Cannot run or enable it.", params: { name: "workflow name", model: "installed local model alias", steps: "array of {type,label,text}; types brain_search,prompt,approval,remember,output; use {{input}} and {{previous}}" } },
    ];
    for (const c of this.connections.list().filter(c => c.enabled && c.allowAgent)) for (const o of c.operations) tools.push({
      name: "connection_" + c.id.replace(/-/g, "") + "_" + o.id, description: `${c.name}: ${o.name}. ${o.method} ${o.path}. KAI asks for approval before each call.`, params: c.provider === "composio" ? { variables: o.schema } : { variables: "JSON object for path placeholders", body: "JSON request body for writes" },
    });
    return tools.map(t => ({ ...t, egress: false, sensitive: false, privateCompanion: true, label: t.name }));
  }
  async tool(name, args, model, confirm, signal) {
    if (!this.toolList(model).some(t => t.name === name)) throw new CompanionError("This private tool is unavailable for the selected model.");
    if (name === "brain_search") return this.store.search(String(args.query || ""), 6).map(n => ({ title: n.title, text: n.text.slice(0, 1500), source: n.source }));
    if (name === "brain_goals") return this.store.data.goals.filter(g => g.status === "active");
    if (name === "brain_remember") {
      const note = { title: String(args.title || "Remembered with KAI").slice(0, 120), text: text(args.text, 12000), category: args.category, source: "agent" };
      if (!await confirm("Remember in Brain", note)) throw new CompanionError("User declined. Do not retry this action.");
      signal?.throwIfAborted(); return this.store.note(note);
    }
    if (name === "workflow_propose") {
      const w = this.workflows.save({ name: args.name, model: args.model, steps: args.steps, schedule: { kind: "manual" } }, { draft: true });
      return { id: w.id, message: "Draft saved in Workflows. The user must review and save it before it can run." };
    }
    for (const c of this.store.data.connections) for (const o of c.operations) if (name === "connection_" + c.id.replace(/-/g, "") + "_" + o.id) {
      const request = this.connections.prepare(c.id, o.id, args.variables || {}, args.body);
      if (!await confirm(request.name, request)) throw new CompanionError("User declined. Do not retry this action.");
      signal?.throwIfAborted(); return (await this.connections.execute(request, signal)).slice(0, 12000);
    }
    throw new CompanionError("Unknown companion tool.");
  }
  start() {
    if (this.store.data.connections.some(c => c.provider === "composio")) this.composio.refresh().catch(() => {});
    this.workflows.start(); this.awareness.start(); this.timer = setInterval(() => {
      if (this.store.locked || !this.store.available()) return;
      for (const s of this.store.data.sources) if (s.autoSync && s.nextSync <= Date.now() && !this.syncing.has(s.id)) this.sync(s.id).catch(() => {});
    }, 30000); this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); for (const c of this.sourceControllers.values()) c.abort(); this.awareness.stop(); this.workflows.stop(); this.connections.cancel(); this.composio.cancel(); }
}

function registerCompanionIPC({ ipcMain, service, origin, getMainWindow, getMascotWindow, dialog }) {
  const handles = [], jobs = new Map(); let approvalPending = false;
  const windowFor = (event, management = false) => {
    for (const [window, route] of [[getMainWindow(), "/"], ...(!management ? [[getMascotWindow(), "/mascot.html"]] : [])])
      if (trustedFrame(event, window, origin) && new URL(event.senderFrame.url).pathname === route) return window;
    return null;
  };
  function handle(channel, management, fn) {
    handles.push(channel); ipcMain.handle(channel, async (event, ...args) => {
      const window = windowFor(event, management); if (!window) throw new Error("Companion access denied.");
      const controller = new AbortController(), sender = event.sender;
      if (jobs.size >= 12) return { ok: false, error: "Finish the current companion operation first." };
      const key = id(), stop = () => controller.abort(), navigate = (_e, _url, _inPlace, main) => { if (main) stop(); };
      jobs.set(key, { controller, sender }); sender.on("destroyed", stop); sender.on("render-process-gone", stop); sender.on("did-start-navigation", navigate); window.on("hide", stop);
      const confirm = async (name, details) => {
        controller.signal.throwIfAborted(); if (approvalPending || !window.isVisible()) return false;
        const detail = JSON.stringify(details, null, 2); if (detail.length > 20000) throw new CompanionError("This action is too large to review.");
        approvalPending = true;
        try {
          const { response } = await dialog.showMessageBox(window, { type: "question", title: "KAI · Review action", message: name, detail: detail + "\n\nAllow this exact action once?", buttons: ["Cancel", "Allow once"], defaultId: 0, cancelId: 0, noLink: true });
          return response === 1 && !controller.signal.aborted && !!windowFor(event, management) && window.isVisible();
        } finally { approvalPending = false; }
      };
      try { return { ok: true, result: await fn({ event, window, signal: controller.signal, confirm }, ...args) }; }
      catch (e) { return { ok: false, error: e instanceof CompanionError ? e.message : e.name === "AbortError" ? "Operation stopped." : "The companion operation failed. Check the saved settings and try again." }; }
      finally { jobs.delete(key); sender.removeListener("destroyed", stop); sender.removeListener("render-process-gone", stop); sender.removeListener("did-start-navigation", navigate); window.removeListener("hide", stop); }
    });
  }
  handle("companion:context", false, (_ctx, model, query) => {
    const eligible = service.canUseModel(model) && service.store.available() && !service.store.locked;
    return { eligible, context: eligible ? service.store.context(String(query || "")) : "" };
  });
  handle("companion:tools", false, (_ctx, model) => service.toolList(model));
  handle("companion:tool", false, (ctx, name, args, model) => service.tool(name, args || {}, model, ctx.confirm, ctx.signal));
  handle("companion:cancel", false, ctx => { for (const job of jobs.values()) if (job.sender === ctx.event.sender) job.controller.abort(); return true; });
  handle("companion:manage", true, async (ctx, action, input = {}) => {
    if (action === "status") return service.status();
    service.store.requireStorage();
    switch (action) {
      case "composioSettings": return service.composio.save(input, ctx.signal);
      case "composioRefresh": return service.composio.refresh(ctx.signal);
      case "composioCatalog": return service.composio.catalog(input, ctx.signal);
      case "composioTools": return service.composio.tools(input, ctx.signal);
      case "composioConnect": return service.composio.connect(input.slug, ctx.signal);
      case "composioReopen": return service.composio.reopen(ctx.signal);
      case "composioPermissions": return service.composio.permissions(input, ctx.signal);
      case "composioDisconnect": {
        const connection = service.connections.list().find(c => c.id === input.id);
        if (!connection || !await ctx.confirm("Disconnect " + connection.name, { account: connection.name, app: connection.toolkit, effect: "Remove this Composio account connection and pause its Brain sources." })) throw new CompanionError("Connection kept.");
        return service.composio.disconnect(input.id, ctx.signal);
      }
      case "composioLogo": return service.composio.logo(input.slug, ctx.signal);
      case "note": return service.store.note(input);
      case "goal": return service.store.goal(input);
      case "remove": service.awareness.cancel(); if (input.kind === "sources") service.sourceControllers.get(input.id)?.abort(); return service.store.remove(input.kind, input.id);
      case "brainSearch": return service.brain.search(input);
      case "brainTask": return service.brain.task(input);
      case "removeBrainTask": return service.store.change(d => { d.brain.tasks = d.brain.tasks.filter(t => t.id !== input.id); });
      case "brainCheckpoint": return service.brain.checkpoint(input.name);
      case "brainClearHistory": return service.store.change(d => { d.brain.changes = []; d.brain.activity = []; d.brain.checkpoints = []; d.brain.readAt = Date.now(); });
      case "brainReview": {
        const insight = service.store.data.brain.insights.find(i => i.id === input.id);
        if (!insight) throw new CompanionError("Insight no longer exists.");
        if (input.decision !== "dismiss" && !await ctx.confirm(input.decision === "task" ? "Create a task" : "Remember this insight", { title: insight.title, text: insight.text })) throw new CompanionError("Insight kept for review.");
        return service.brain.review(input);
      }
      case "awarenessSettings": return service.awareness.settings(input);
      case "awarenessTask": return service.awareness.customTask(input);
      case "awarenessRun": { const job = service.awareness.enqueue(input.kind || "reflection", true); void service.awareness.tick().catch(() => {}); return job; }
      case "awarenessStop": return service.awareness.cancel(input.id);
      case "awarenessRetry": return service.awareness.retry(input.id);
      case "brainChats": return service.sources.chatList();
      case "brainSource": {
        let folder;
        if (input.kind === "folder") {
          const result = await dialog.showOpenDialog(ctx.window, { title: "Choose the text folder KAI may read", properties: ["openDirectory"] });
          ctx.signal.throwIfAborted(); if (result.canceled || !result.filePaths[0]) return null; folder = result.filePaths[0];
        }
        return service.sources.save(input, folder);
      }
      case "exportBrainVault": {
        const result = await dialog.showOpenDialog(ctx.window, { title: "Export a new plain Markdown Brain folder here", properties: ["openDirectory", "createDirectory"] });
        ctx.signal.throwIfAborted(); if (result.canceled || !result.filePaths[0]) return null;
        return service.brain.exportVault(result.filePaths[0]);
      }
      case "recall": return service.store.change(d => { d.settings.recall = input.enabled === true; });
      case "importLegacy": {
        const memories = service.legacyMemory?.list() || [];
        return service.importText("Previously remembered facts", memories.map(m => "- " + m.text).join("\n"));
      }
      case "import": {
        const result = await dialog.showOpenDialog(ctx.window, { title: "Add a source to KAI Brain", properties: ["openFile"], filters: [{ name: "Text and Markdown", extensions: ["txt", "md", "csv", "json"] }] });
        ctx.signal.throwIfAborted(); if (result.canceled || !result.filePaths[0]) return null;
        const file = result.filePaths[0]; if (fs.statSync(file).size > 200000) throw new CompanionError("Choose a text file smaller than 200 KB.");
        return service.importText(path.basename(file).slice(0, 100), fs.readFileSync(file, "utf8"));
      }
      case "exportBrain": {
        const result = await dialog.showSaveDialog(ctx.window, { title: "Export KAI Brain", defaultPath: "KAI-Brain.md", filters: [{ name: "Markdown", extensions: ["md"] }] });
        ctx.signal.throwIfAborted(); if (!result.canceled && result.filePath) fs.writeFileSync(result.filePath, service.store.markdown(), { mode: 0o600 }); return !result.canceled;
      }
      case "connection": return service.connections.save(input);
      case "removeConnection": return service.connections.remove(input.id);
      case "request": {
        const request = service.connections.prepare(input.connectionId, input.operationId, input.variables || {}, input.body);
        if (request.method !== "GET" && !await ctx.confirm(request.name, request)) throw new CompanionError("User declined. The request did not run.");
        return service.connections.execute(request, ctx.signal);
      }
      case "source": return service.source(input);
      case "sync": return service.sync(input.id, ctx.signal);
      case "sourceToggle": return service.store.change(d => { const s = d.sources.find(s => s.id === input.id); if (!s || s.kind === "file") throw new CompanionError("Source unavailable."); if (s.kind === "connection" && input.enabled && !d.connections.find(c => c.id === s.connectionId)?.allowSync) throw new CompanionError("Enable background reads for this connection first."); s.autoSync = input.enabled === true; s.nextSync = Date.now() + (s.intervalMinutes || 20) * 60000; });
      case "workflow": return service.workflows.save(input);
      case "removeWorkflow": return service.workflows.remove(input.id);
      case "run": return service.workflows.begin(input.id, input.input);
      case "cancelRun": return service.workflows.cancel(input.id);
      case "resume": {
        const run = service.workflows.get(input.id); if (!run) throw new CompanionError("Run no longer exists.");
        if (!await ctx.confirm("Resume " + run.name, run.pending || { nextStep: run.index + 1 })) throw new CompanionError("Run remains paused.");
        ctx.signal.throwIfAborted(); return service.workflows.resume(input.id);
      }
      case "exportWorkflow": {
        const w = service.store.data.workflows.find(w => w.id === input.id); if (!w) throw new CompanionError("Workflow no longer exists.");
        const result = await dialog.showSaveDialog(ctx.window, { title: "Export workflow", defaultPath: "KAI-Workflow.json", filters: [{ name: "Workflow", extensions: ["json"] }] });
        ctx.signal.throwIfAborted(); if (!result.canceled && result.filePath) { const { id: _id, ...spec } = w; fs.writeFileSync(result.filePath, JSON.stringify({ ...spec, enabled: false }, null, 2), { mode: 0o600 }); } return !result.canceled;
      }
      case "importWorkflow": {
        const result = await dialog.showOpenDialog(ctx.window, { properties: ["openFile"], filters: [{ name: "KAI workflow", extensions: ["json"] }] });
        ctx.signal.throwIfAborted(); if (result.canceled || !result.filePaths[0]) return null;
        if (fs.statSync(result.filePaths[0]).size > 100000) throw new CompanionError("Workflow file is too large.");
        const spec = JSON.parse(fs.readFileSync(result.filePaths[0], "utf8")); delete spec.id; return service.workflows.save(spec, { draft: true });
      }
      default: throw new CompanionError("Unknown companion action.");
    }
  });
  return { dispose() { service.stop(); for (const job of jobs.values()) job.controller.abort(); for (const h of handles) ipcMain.removeHandler(h); } };
}
module.exports = { CompanionHub, registerCompanionIPC };
