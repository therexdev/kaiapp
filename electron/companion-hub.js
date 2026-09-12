"use strict";
const fs = require("fs"), path = require("path");
const { CompanionStore, CompanionError, id, text, copy } = require("./companion-store");
const { CompanionConnections, TEMPLATES } = require("./companion-connections");
const { CompanionWorkflows, TYPES } = require("./companion-workflows");
const { trustedFrame } = require("./mascot");

class CompanionHub {
  constructor({ dataDir, safeStorage, privacyMode, models, runLocal, fetchImpl, canUseModel, legacyMemory, account, openExternal, chats, lookup, legacyTasks }) {
    this.store = new CompanionStore({ dataDir, safeStorage }); this.models = models; this.canUseModel = canUseModel; this.legacyMemory = legacyMemory;
    this.memoryMigrationError = null;
    try { this.store.migrateLegacy(legacyMemory); } catch (error) { this.memoryMigrationError = "Earlier memories could not be moved to Brain. Free storage or unlock your OS keychain and restart KAI. " + error.message; }
    this.connections = new CompanionConnections({ store: this.store, privacyMode, fetchImpl });
    const { CompanionComposio } = require("./companion-composio");
    this.composio = new CompanionComposio({ store: this.store, privacyMode, account, fetchImpl, openExternal });
    this.connections.composio = this.composio;
    this.workflows = new CompanionWorkflows({ store: this.store, connections: this.connections, runLocal, models, privacyMode, fetchImpl, lookup, chats, legacyTasks });
    this.workflowEvents = new (require("./workflow-events").WorkflowEvents)({ composio: this.composio, workflows: this.workflows, store: this.store });
    this.workflowAssistant = new (require("./workflow-assistant").WorkflowAssistant)(this.workflows);
    const { CompanionBrain } = require("./companion-brain"), { CompanionSources } = require("./companion-sources"), { CompanionAwareness } = require("./companion-awareness");
    this.brain = new CompanionBrain({ store: this.store });
    this.sources = new CompanionSources({ store: this.store, chats, privacyMode, fetchImpl, lookup });
    this.awareness = new CompanionAwareness({ store: this.store, models, runLocal, workflows: this.workflows });
    this.actions = new (require("./conversation-actions").ConversationActions)({ hub: this, privacyMode, fetchImpl, lookup });
    this.agentNetwork = new (require("../core/lib/agent-network/network").AgentNetwork)({ store: new (require("../core/lib/agent-network/store").Store)(path.join(dataDir, "agent-network.json"), safeStorage), models, runLocal, privacyMode });
    this.agentNetwork.start();
    this.syncing = new Set(); this.sourceControllers = new Map(); this.timer = null;
  }
  status() {
    const s = this.store;
    if (s.locked || !s.available()) return { locked: true, available: s.available() };
    const { connections, composio, ...data } = s.data;
    return { ...copy(data), memoryMigrationError: this.memoryMigrationError, brainIndex: this.brain.index(), awarenessRunning: this.awareness.active?.id || null, available: true, locked: false, composio: this.composio.status(), connections: this.connections.list(), templates: copy(TEMPLATES), models: this.models().filter(m => m.status === "ready"), stepTypes: TYPES, syncing: [...this.syncing] };
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
    const tools = [...this.actions.tools(),
      { name: "brain_search", description: "Search private Brain notes, people, projects, preferences, and imported sources.", params: { query: "what to find" } },
      { name: "brain_remember", description: "Ask the user to approve a fact for persistent Brain memory.", params: { text: "fact to remember", title: "short title", category: "notes | preferences | people | projects" } },
      { name: "brain_forget", description: "Forget one personal Brain memory by its exact ID after user approval. Search Brain first. Imported source text must be managed in Brain Sources.", params: { id: "memory ID from brain_search" } },
      { name: "brain_goals", description: "Read the user's active goals from Brain.", params: {} },
      { name: "workflow_propose", description: "Save a disabled workflow draft for the user to review in Workflows. Cannot run or enable it.", params: { name: "workflow name", model: "installed local model alias", graph: "optional v2 canvas {version:2,nodes:[{id,type,label,position,config}],edges:[{id,from,to,port,input}]}; prefer workflow builder Copilot for complex graphs", steps: "array of {type,label,text}; types brain_search,prompt,approval,remember,output; use {{input}} and {{previous}}" } },
    ];
    for (const c of this.connections.list().filter(c => c.enabled && c.allowAgent)) for (const o of c.operations) tools.push({
      name: "connection_" + c.id.replace(/-/g, "") + "_" + o.id, description: `${c.name}: ${o.name}. ${o.method} ${o.path}. KAI asks for approval before each call.`, params: c.provider === "composio" ? { variables: o.schema } : { variables: "JSON object for path placeholders", body: "JSON request body for writes" },
    });
    return tools.map(t => ({ ...t, egress: false, sensitive: false, privateCompanion: true, label: t.name }));
  }
  async tool(name, args, model, confirm, signal, session) {
    if (!this.toolList(model).some(t => t.name === name)) throw new CompanionError("This private tool is unavailable for the selected model.");
    if (this.actions.tools().some(t => t.name === name)) return this.actions.tool(session?.owner, session?.id, name, args, model, confirm, signal);
    if (name === "brain_search") return this.store.search(String(args.query || ""), 6).map(n => ({ id: n.id, title: n.title, text: n.text.slice(0, 1500), source: n.source, imported: !!n.sourceId }));
    if (name === "brain_goals") return this.store.data.goals.filter(g => g.status === "active");
    if (name === "brain_forget") {
      const note = this.store.data.notes.find(n => n.id === args.id && !n.sourceId);
      if (!note) throw new CompanionError("Search Brain for an exact personal memory first. Manage imported material in Brain Sources.");
      if (!await confirm("Forget Brain memory", { title: note.title, text: note.text })) throw new CompanionError("User declined. Do not retry this action.");
      signal?.throwIfAborted();
      const current = this.store.data.notes.find(n => n.id === note.id);
      if (!current || current.updatedAt !== note.updatedAt || current.text !== note.text) throw new CompanionError("Memory changed while awaiting approval. Search Brain again.");
      this.awareness.cancel();
      this.store.remove("notes", note.id);
      return { forgotten: true, id: note.id };
    }
    if (name === "brain_remember") {
      const note = { title: String(args.title || "Remembered with KAI").slice(0, 120), text: text(args.text, 12000), category: args.category, source: "agent" };
      if (!await confirm("Remember in Brain", note, { key: "brain:remember", label: "Save memories to Brain from chat and KAI" })) throw new CompanionError("User declined. Do not retry this action.");
      signal?.throwIfAborted(); return this.store.note(note);
    }
    if (name === "workflow_propose") {
      const w = this.workflows.save({ name: args.name, model: args.model, steps: args.steps, ...(args.graph ? { graph: args.graph } : {}), enabled: false, schedule: { kind: "manual" } }, { draft: true });
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
    this.workflows.migrateTasks(); this.workflows.start(); this.awareness.start(); this.timer = setInterval(() => {
      if (this.store.locked || !this.store.available()) return;
      void this.workflowEvents.tick().catch(() => {});
      void this.workflowAssistant.tick().catch(() => {});
      for (const s of this.store.data.sources) if (s.autoSync && s.nextSync <= Date.now() && !this.syncing.has(s.id)) this.sync(s.id).catch(() => {});
    }, 30000); this.timer.unref?.();
  }
  stop() {
    this.agentNetwork?.stop(); this.actions.stop(); clearInterval(this.timer); for (const c of this.sourceControllers.values()) c.abort(); this.awareness.stop(); this.workflowEvents.stop(); this.workflowAssistant.stop(); this.workflows.stop(); this.connections.cancel(); this.composio.cancel(); }
}

function registerCompanionIPC({ ipcMain, service, origin, getMainWindow, getMascotWindow, dialog }) {
  const handles = [], jobs = new Map(), sessions = new Map(); let approvalPending = false;
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
      // Hiding/minimizing the companion stops its microphone and speech in the
      // renderer, but an already-approved text/action job may finish in the
      // background. Destruction, navigation and explicit Cancel still abort.
      jobs.set(key, { controller, sender }); sender.on("destroyed", stop); sender.on("render-process-gone", stop); sender.on("did-start-navigation", navigate);
      const confirm = async (name, details, permission = null) => {
        controller.signal.throwIfAborted(); if (approvalPending || !window.isVisible()) return false;
        const grantKey = permission && typeof permission.key === "string" && /^[a-z0-9:_-]{1,500}$/i.test(permission.key) ? permission.key : null;
        const grantLabel = grantKey && typeof permission.label === "string" ? permission.label.trim().slice(0, 180) : null;
        if (grantKey && service.store.data.settings?.approvalGrants?.some(g => g.key === grantKey)) return true;
        const detail = JSON.stringify(details, null, 2); if (detail.length > 20000) throw new CompanionError("This action is too large to review.");
        approvalPending = true;
        try {
          const buttons = grantKey && grantLabel ? ["Cancel", "Allow once", "Always allow this action"] : ["Cancel", "Allow once"];
          const suffix = grantKey && grantLabel
            ? "\n\nAllow once, or always allow this action for this account? You can revoke an always-allow grant in Connections → Connection settings."
            : "\n\nAllow this exact action once?";
          const { response } = await dialog.showMessageBox(window, { type: "question", title: "KAI · Review action", message: name, detail: detail + suffix, buttons, defaultId: 0, cancelId: 0, noLink: true });
          const active = !controller.signal.aborted && !!windowFor(event, management) && window.isVisible();
          if (!active || (response !== 1 && !(response === 2 && grantKey && grantLabel))) return false;
          if (response === 2 && grantKey && grantLabel) service.store.change(d => {
            d.settings ||= { recall: true }; d.settings.approvalGrants ||= [];
            d.settings.approvalGrants = [{ key: grantKey, label: grantLabel, at: Date.now() }, ...d.settings.approvalGrants.filter(g => g.key !== grantKey)].slice(0, 200);
          });
          return true;
        } finally { approvalPending = false; }
      };
      try { return { ok: true, result: await fn({ event, window, signal: controller.signal, confirm }, ...args) }; }
      catch (e) { return { ok: false, error: e instanceof CompanionError ? e.message : e.name === "AbortError" ? "Operation stopped." : "The companion operation failed. Check the saved settings and try again." }; }
      finally { jobs.delete(key); sender.removeListener("destroyed", stop); sender.removeListener("render-process-gone", stop); sender.removeListener("did-start-navigation", navigate); }
    });
  }
  handle("companion:context", false, (_ctx, model, query) => {
    const eligible = service.canUseModel(model) && service.store.available() && !service.store.locked;
    // null is an eligibility-only check during planning; do not run and
    // discard a full Brain search on every intermediate model completion.
    return { eligible, context: eligible && query !== null ? service.store.context(String(query || "")) : "" };
  });
  handle("companion:tools", false, (_ctx, model) => service.toolList(model));
  handle("companion:tool", false, (ctx, name, args, model, sessionId) => service.tool(name, args || {}, model, ctx.confirm, ctx.signal, { owner: ctx.event.sender.id, id: sessionId }));
  handle("companion:activity", false, (_ctx, model, conversationId) => {
    if (!service.canUseModel(model)) throw new CompanionError("Choose a local or private desktop model.");
    service.store.requireStorage();
    return (service.store.data.conversations || []).filter(t => t.conversationId === conversationId).slice(0, 10).map(t => service.actions.view(t.id));
  });
  handle("companion:session", false, (ctx, operation, input = {}) => {
    const owner = ctx.event.sender.id;
    if (operation === "begin") {
      sessions.get(owner)?.();
      const sender = ctx.event.sender, window = ctx.window;
      const stop = () => { service.actions.stop(owner); cleanup(); };
      const navigate = (_e, _url, _inPlace, main) => { if (main) stop(); };
      const cleanup = () => { sender.removeListener("destroyed", stop); sender.removeListener("render-process-gone", stop); sender.removeListener("did-start-navigation", navigate); sessions.delete(owner); };
      const result = service.actions.begin(owner, input.model, input);
      sender.on("destroyed", stop); sender.on("render-process-gone", stop); sender.on("did-start-navigation", navigate); sessions.set(owner, cleanup);
      return result;
    }
    if (operation === "finish") { const result = service.actions.finish(owner, input.id, input.cancel === true); sessions.get(owner)?.(); return result; }
    service.actions.authorize(owner, input.id, input.model);
    if (operation === "status") return service.actions.view(input.id);
    throw new CompanionError("Unknown conversation operation.");
  });
  handle("companion:cancel", false, ctx => { service.actions.stop(ctx.event.sender.id); for (const job of jobs.values()) if (job.sender === ctx.event.sender) job.controller.abort(); return true; });
  handle("companion:manage", true, async (ctx, action, input = {}) => {
    if (action === "status") return service.status();
    service.store.requireStorage();
    switch (action) {
      case "agentNetworkStatus": return service.agentNetwork.status();
      case "agentNetworkSettings": {
        if (input.enabled && !await ctx.confirm("Enable Agent Network", { relays: input.endpoints || [], scope: "Separate private service identity. Hosted jobs use only their reviewed workflow and local model. Publishing makes the service card public. No paid transactions are enabled." })) throw new CompanionError("Agent Network stays off.");
        return service.agentNetwork.settings(input);
      }
      case "agentNetworkSave": {
        const definition = input.workflowId ? service.store.data.workflows.find(w => w.id === input.workflowId && !w.draft) : input.definition;
        if (input.workflowId && !definition) throw new CompanionError("Review and save the workflow first.");
        return service.agentNetwork.save({ ...input, ...(definition ? { definition } : {}) });
      }
      case "agentNetworkAccepting": {
        const agent = service.agentNetwork.store.data.agents.find(a => a.id === input.id);
        if (input.enabled && !await ctx.confirm("Accept service jobs on this desktop", { agent: agent?.card.payload.name, limits: agent?.card.payload.limits, scope: "Untrusted callers may submit selected input. This service has no access to your Brain, accounts, wallet, or desktop. Local model and machine resources are used while KAI is open." })) throw new CompanionError("Host stays paused.");
        return service.agentNetwork.accepting(input.id, input.enabled);
      }
      case "agentNetworkPublish": {
        const agent = service.agentNetwork.store.data.agents.find(a => a.id === input.id);
        if (!await ctx.confirm("Publish this agent service", agent?.card.payload || {})) throw new CompanionError("Publication cancelled.");
        return service.agentNetwork.publish(input.id);
      }
      case "agentNetworkRetire": return service.agentNetwork.retire(input.id);
      case "agentNetworkDiscover": return service.agentNetwork.discover(input.query || "");
      case "agentNetworkImport": return service.agentNetwork.importCard(require("../core/lib/agent-network/protocol").parse(input.text, 200000));
      case "agentNetworkQuote": {
        const card = service.agentNetwork.store.data.cards.find(c => c.payload.agent_id === input.id) || service.agentNetwork.store.data.agents.find(a => a.id === input.id)?.card;
        if (!card) throw new CompanionError("Choose a saved service card.");
        return service.agentNetwork.quote(card, input.input);
      }
      case "agentNetworkSubmit": {
        const job = service.agentNetwork.store.data.jobs.find(j => j.id === input.id && j.role === "buyer");
        if (!await ctx.confirm("Send this input to the agent host", { service: job?.name, input: job?.input, quote: job?.quote?.payload, privacy: "The selected operator can read and process this input. No KAI payment is made for this free service." })) throw new CompanionError("Input was not sent.");
        return service.agentNetwork.submit(input.id);
      }
      case "agentNetworkJob": {
        if (input.action === "remove" && !await ctx.confirm("Remove this finished local job", { id: input.id, role: input.role, detail: "Its input and result will be deleted from this installation. Save any result you need first." })) throw new CompanionError("Job kept.");
        return service.agentNetwork.jobAction(input.id, input.action, input.role);
      }
      case "agentNetworkRefresh": await service.agentNetwork.tick(); return service.agentNetwork.status();
      case "conversationReview": {
        const t = service.store.data.conversations?.find(t => t.id === input.turnId), a = t?.actions.find(a => a.id === input.id);
        if (!a || a.status !== "uncertain") throw new CompanionError("Choose an uncertain action.");
        if (!await ctx.confirm("Acknowledge the inspected outcome", { action: a.name, receiptId: a.id, note: "Only continue if you inspected the provider for this action. This records your review; it does not verify success or run the action again." })) throw new CompanionError("Receipt kept uncertain.");
        return service.actions.patch(t.id, a.id, { status: "reviewed", message: "User inspected the destination. Outcome is user-reviewed, not automatically verified." });
      }
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
      case "approvalGrantRemove": return service.store.change(d => {
        const key = typeof input.key === "string" ? input.key : "";
        d.settings.approvalGrants = (d.settings.approvalGrants || []).filter(g => g.key !== key);
      });

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
        const c = service.store.data.connections.find(c => c.id === input.connectionId);
        if (request.method !== "GET" && !await ctx.confirm(request.name, request, { key: `connected:${c.id}:${request.operationId}:${c.revision}`, label: `${c.name} · ${request.name}` })) throw new CompanionError("User declined. The request did not run.");
        return service.connections.execute(request, ctx.signal);
      }
      case "source": return service.source(input);
      case "sync": return service.sync(input.id, ctx.signal);
      case "sourceToggle": return service.store.change(d => { const s = d.sources.find(s => s.id === input.id); if (!s || s.kind === "file") throw new CompanionError("Source unavailable."); if (s.kind === "connection" && input.enabled && !d.connections.find(c => c.id === s.connectionId)?.allowSync) throw new CompanionError("Enable background reads for this connection first."); s.autoSync = input.enabled === true; s.nextSync = Date.now() + (s.intervalMinutes || 20) * 60000; });
      case "workflow": return service.workflows.save(await service.workflowEvents.prepareWorkflow(input, ctx.signal));
      case "workflowValidate": return service.workflows.validate(input);
      case "workflowAssist": return service.workflowAssistant.ask(input, ctx.signal);
      case "workflowDiscoverySettings": return service.workflowAssistant.configure(input);
      case "workflowDiscover": return service.workflowAssistant.ask(input, ctx.signal, true);
      case "workflowDismiss": return service.store.change(d => { if (d.workflowState) { const s = (d.workflowState.suggestions || []).find(s => s.id === input.id); if (s) d.workflowState.dismissed = [...(d.workflowState.dismissed || []), s.name.toLowerCase()].slice(-50); d.workflowState.suggestions = (d.workflowState.suggestions || []).filter(s => s.id !== input.id); } });
      case "workflowDraft": return service.workflows.save(input, { draft: true });
      case "workflowEventTypes": return service.workflowEvents.types(input.connectionId, ctx.signal);
      case "workflowEnabled": {
        const w = service.store.data.workflows.find(w => w.id === input.id);
        if (input.enabled && w?.graph?.nodes.some(n => n.type === "trigger" && n.config.kind === "app_event")) return service.workflows.save(await service.workflowEvents.prepareWorkflow({ ...w, enabled: true }, ctx.signal));
        return service.workflows.setEnabled(input.id, input.enabled);
      }
      case "workflowPreview": return service.workflows.begin(input.id, input.input, "preview", { dryRun: true });
      case "workflowReject": return service.workflows.decide(input.id, "rejected");
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
        if (fs.statSync(result.filePaths[0]).size > 160000) throw new CompanionError("Workflow file is too large.");
        const spec = require("../ui/workflow-model").importDocument(JSON.parse(fs.readFileSync(result.filePaths[0], "utf8"))); delete spec.id; return service.workflows.save(spec, { draft: true });
      }
      default: throw new CompanionError("Unknown companion action.");
    }
  });
  return { dispose() { for (const clean of [...sessions.values()]) clean(); service.stop(); for (const job of jobs.values()) job.controller.abort(); for (const h of handles) ipcMain.removeHandler(h); } };
}
module.exports = { CompanionHub, registerCompanionIPC };
