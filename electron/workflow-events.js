"use strict";
const { CompanionError, copy } = require("./companion-store");
const crypto = require("crypto");
const hash = s => crypto.createHash("sha256").update(s).digest("hex").slice(0, 24);
class WorkflowEvents {
  constructor({ composio, workflows, store }) { Object.assign(this, { composio, workflows, store }); this.controller = new AbortController(); this.busy = false; this.next = 0; }
  async relay(action, input, signal) {
    const ctx = this.composio.context(), origin = this.composio.account?.origin(), token = this.composio.account?._token();
    if (!origin || !token) throw new CompanionError("Sign in to KAI to receive live events through your account server. App-change watches can run without the event relay.");
    const url = new URL(origin); if (url.protocol !== "https:") throw new CompanionError("Live event delivery needs a public HTTPS account server.");
    return this.composio.guarded(async s => {
      const r = await this.composio.fetch(origin + "/connections/events/" + action, { method: "POST", redirect: "error", signal: s, headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(input) });
      if (r.status === 404) throw new CompanionError("Update your KAI server to enable live event delivery. App-change watches already work with existing connections.");
      let body = ""; for await (const chunk of r.body || []) { body += Buffer.from(chunk).toString("utf8"); if (body.length > 1000000) throw new CompanionError("Event response is too large."); }
      let p; try { p = JSON.parse(body); } catch { throw new CompanionError("The event server returned an unreadable response."); }
      if (!r.ok || !p.ok) throw new CompanionError(p.error || "The event server could not complete this operation.");
      const current = this.composio.context(); if (current.binding !== ctx.binding || current.project !== ctx.project || this.composio.account?._token() !== token) throw new CompanionError("Connection settings changed during event setup.");
      return p.result;
    }, signal);
  }
  async types(connectionId, signal) {
    const c = this.composio.store.data.connections.find(c => c.id === connectionId); if (!c || c.provider !== "composio" || !this.composio.current(c)) throw new CompanionError("Choose a connected Composio account.");
    const items = [], cursors = new Set(); let cursor = "";
    for (let page = 0; page < 10; page++) {
      const result = await this.composio.guarded(s => this.composio.call("triggerTypes", { toolkit: c.toolkit, cursor }, s), signal);
      items.push(...result.items); if (!result.nextCursor || cursors.has(result.nextCursor)) break;
      cursor = result.nextCursor; cursors.add(cursor);
    }
    return { items: [...new Map(items.map(t => [t.slug, t])).values()] };
  }
  async setup(config, signal) {
    const c = this.store.data.connections.find(c => c.id === config.connectionId);
    if (!c?.enabled || c.provider !== "composio" || !c.allowSync || !this.composio.current(c)) throw new CompanionError("Choose a connected app with Brain and workflow reads enabled.");
    const ctx = this.composio.context(); let relay;
    if (ctx.mode === "managed") relay = await this.relay("managedSetup", {}, signal);
    else {
      relay = await this.relay("register", { project: ctx.project, userId: ctx.userId }, signal);
      if (!relay.configured) {
        const subscription = await this.composio.guarded(s => this.composio.call("webhookSetup", { url: relay.webhookUrl }, s), signal);
        relay = await this.relay("register", { project: ctx.project, userId: ctx.userId, signingSecret: subscription.secret }, signal);
      }
    }
    const result = await this.composio.guarded(s => this.composio.call("triggerUpsert", { id: c.accountId, triggerSlug: config.triggerSlug, config: config.triggerConfig || {} }, s), signal);
    if (!this.composio.current(c)) throw new CompanionError("The app account changed during event setup.");
    this.store.change(d => { d.workflowState ||= {}; const old = d.workflowState.eventRelay; d.workflowState.eventRelay = { channel: relay.channel, project: ctx.project, binding: ctx.binding, mode: ctx.mode, after: old?.channel === relay.channel && old?.binding === ctx.binding ? old.after : 0 }; });
    return { ...config, triggerId: result.triggerId, eventBinding: ctx.binding, eventProject: ctx.project };
  }
  async prepareWorkflow(input, signal) {
    const trigger = input.graph?.nodes.find(n => n.type === "trigger"); if (!input.enabled || trigger?.config.kind !== "app_event") return input;
    const report = this.workflows.validate(input); if (report.errors.length) throw new CompanionError(report.errors[0].message);
    const result = copy(input); result.graph.nodes.find(n => n.type === "trigger").config = await this.setup(trigger.config, signal); return result;
  }
  async tick(now = Date.now()) {
    if (this.busy || now < this.next || this.store.locked || !this.store.available()) return;
    const relay = this.store.data.workflowState?.eventRelay; if (!relay) return;
    let ctx; try { ctx = this.composio.context(); } catch { return; }
    if (ctx.binding !== relay.binding || ctx.project !== relay.project) return;
    if (!this.store.data.workflows.some(w => w.enabled && w.graph?.nodes.some(n => n.type === "trigger" && n.config.kind === "app_event"))) return;
    this.busy = true; this.next = now + 15000;
    try {
      const result = await this.relay("poll", { channel: relay.channel, after: relay.after || 0 }, this.controller.signal);
      this.store.change(d => {
        const s = d.workflowState, seen = new Set((s.events || []).map(e => e.id));
        s.events = (s.events || []).filter(e => e.at > now - 86400000 && e.binding === ctx.binding && !(e.targets || []).every(id => e.handled.includes(id) || !d.workflows.some(w => w.id === id && w.enabled)));
        let cursor = relay.after || 0;
        for (const e of result.items || []) {
          if (seen.has(e.id)) { cursor = Math.max(cursor, e.sequence); continue; }
          const connection = d.connections.find(c => c.accountId === e.accountId && c.provider === "composio" && this.composio.current(c));
          if (connection?.enabled && connection.allowSync) {
            if (s.events.length >= 100) break;
            const targets = d.workflows.filter(w => w.enabled && !w.draft && w.graph?.nodes.some(n => n.type === "trigger" && n.config.kind === "app_event" && n.config.triggerId === e.triggerId && n.config.connectionId === connection.id && n.config.eventBinding === ctx.binding)).map(w => w.id);
            if (targets.length) s.events.push({ ...e, targets, binding: ctx.binding, connectionId: connection.id, handled: [] });
          }
          cursor = Math.max(cursor, e.sequence);
        }
        s.eventRelay.after = cursor; s.eventRelay.error = null; s.eventRelay.checkedAt = now;
      });
      for (const event of [...this.store.data.workflowState.events]) for (const w of this.store.data.workflows.filter(w => w.enabled && !w.draft)) {
        const c = w.graph?.nodes.find(n => n.type === "trigger")?.config;
        if (!event.targets?.includes(w.id) || c?.kind !== "app_event" || c.eventBinding !== ctx.binding || c.triggerId !== event.triggerId || c.connectionId !== event.connectionId || event.handled.includes(w.id)) continue;
        if (this.store.data.runs.some(r => r.workflowId === w.id && ["running", "waiting", "interrupted"].includes(r.status))) continue;
        if (this.store.data.runs.filter(r => r.trigger === "app event" && r.startedAt > now - 3600000).length >= 30) break;
        try {
          // Run creation and its receipt marker share one encrypted checkpoint.
          if (!this.store.data.runs.some(r => r.workflowId === w.id && r.eventId === event.id)) { this.workflows.begin(w.id, event.payload, "app event", { eventId: event.id }); }
          
        } catch (e) { this.store.change(d => { d.workflowState.eventRelay.error = e instanceof CompanionError ? e.message : "Event is queued until a workflow slot is free."; }); }
      }
    } catch (e) { this.store.change(d => { d.workflowState.eventRelay.error = e instanceof CompanionError ? e.message : "Live event delivery paused."; }); }
    finally { this.busy = false; }
  }
  stop() { this.controller.abort(); }
}
module.exports = { WorkflowEvents };
