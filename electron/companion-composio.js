"use strict";
const crypto = require("crypto");
const { CompanionError, copy, id, text } = require("./companion-store");
const { ComposioClient, ComposioError, validateArgs, connectURL, slug } = require("../core/lib/composio-client");
const fingerprint = value => crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
class CompanionComposio {
  constructor({ store, privacyMode, account, fetchImpl = fetch, openExternal }) {
    Object.assign(this, { store, privacyMode, account, fetch: fetchImpl, openExternal }); this.active = new Set(); this.clients = new Map(); this.managed = null; this.logos = new Map(); this.pending = null; this.completed = null;
  }
  settings() { return this.store.data.composio || { mode: "managed", key: "", userId: "" }; }
  status() {
    const s = this.settings(), token = this.account?._token();
    const sessionExpired = !!(token && this.rejectedSession?.origin === this.account?.origin() && this.rejectedSession?.binding === fingerprint(token));
    return { mode: s.mode, personalConfigured: !!s.key, blocked: this.privacyMode() === "local-only", signedIn: !!token && !sessionExpired, sessionExpired,
      managedAvailable: this.managed?.available ?? null, completed: this.completed, pending: this.pending ? { toolkit: this.pending.toolkit, expiresAt: this.pending.expiresAt } : null };
  }
  context() {
    const s = this.settings();
    if (s.mode === "personal") {
      if (!s.key) throw new CompanionError("Add your Composio key in Connection settings first.");
      return { mode: s.mode, project: fingerprint(s.key), binding: fingerprint(s.key), userId: s.userId, key: s.key };
    }
    const origin = this.account?.origin(), token = this.account?._token();
    if (!origin || !token) throw new CompanionError("Sign in to your KAI account in Settings to use KAI-managed connections.");
    const u = new URL(origin); if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) throw new CompanionError("Managed connections require a secure account server.");
    return { mode: "managed", origin, token, project: origin + ":" + (this.managed?.generation || ""), binding: fingerprint(token) };
  }
  current(c) { try { const x = this.context(); return c.mode === x.mode && c.project === x.project && c.binding === x.binding; } catch { return false; } }
  async guarded(fn, signal) {
    this.store.requireStorage(); if (this.privacyMode() === "local-only") throw new CompanionError("Local-Only is on. Choose Local-First in Local API → Privacy to connect online apps.");
    if (this.active.size >= 6) throw new CompanionError("Please wait for the current connections to finish loading.");
    const controller = new AbortController(); this.active.add(controller);
    const both = AbortSignal.any([controller.signal, AbortSignal.timeout(45000), ...(signal ? [signal] : [])]);
    const timer = setInterval(() => { if (this.privacyMode() === "local-only") controller.abort(); }, 200); timer.unref?.();
    try { const result = await fn(both); both.throwIfAborted(); return result; }
    catch (e) { if (e instanceof CompanionError) throw e; if (e instanceof ComposioError) throw new CompanionError(e.message); if (both.aborted) throw new CompanionError("Connection request stopped."); throw new CompanionError("Could not reach the connection service. Check your internet connection and try again."); }
    finally { clearInterval(timer); this.active.delete(controller); }
  }
  async managedStatus(signal) {
    if (!this.account?.origin()) return this.managed = { available: false };
    const origin = this.account.origin(), u = new URL(origin);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) return this.managed = { available: false };
    const r = await this.fetch(origin + "/connections/status", { signal, redirect: "error" });
    if (r.status === 404) return this.managed = { available: false };
    if (!r.ok) throw new CompanionError("The KAI connection server is unavailable. Try again shortly.");
    const s = await r.json(); this.managed = { available: s.available === true && s.protocol === 1, generation: String(s.generation || "") }; return this.managed;
  }
  async call(action, input = {}, signal, ctx = this.context()) {
    if (ctx.mode === "managed") {
      if (!this.managed?.available) throw new CompanionError("KAI-managed connections are not enabled yet. You can use your own Composio key in Connection settings.");
      const r = await this.fetch(ctx.origin + "/connections/api/" + action, { method: "POST", redirect: "error", signal,
        headers: { "content-type": "application/json", authorization: "Bearer " + ctx.token }, body: JSON.stringify({ ...input, generation: this.managed.generation }) });
      let content = "", bytes = 0; const decoder = new TextDecoder();
      for await (const chunk of r.body || []) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw new CompanionError("The connection result is too large."); content += decoder.decode(chunk, { stream: true }); }
      content += decoder.decode(); signal?.throwIfAborted();
      let p; try { p = JSON.parse(content); } catch { throw new CompanionError("Update the KAI connection server before using this option."); }
      // The current server forwards Composio's HTTP status. Its own account
      // middleware also uses 401, so preserve the upstream key error separately.
      const keyRejected = r.status === 401 && p.error === "Composio rejected this key. Check your project API key.";
      if (r.status === 401 && !keyRejected) this.rejectedSession = { origin: ctx.origin, binding: ctx.binding };
      if (keyRejected) {
        this.rejectedSession = null;
        throw new CompanionError("The server's Composio key was rejected. Ask the server administrator to check COMPOSIO_API_KEY. Your KAI account sign-in is separate.");
      }
      if (!r.ok || !p.ok) throw new CompanionError(r.status === 401 ? "Your KAI sign-in has expired. Sign in again in Settings." : p.error || "Connection request failed.");
      this.rejectedSession = null; return p.result;
    }
    let client = this.clients.get(ctx.project); if (!client) { this.clients.clear(); client = new ComposioClient({ key: ctx.key, fetchImpl: this.fetch }); this.clients.set(ctx.project, client); }
    switch (action) {
      case "catalog": return client.catalog(input, signal);
      case "toolkit": return client.toolkit(input.slug, signal);
      case "tools": return client.tools(input, signal);
      case "tool": return client.tool(input.slug, input.version, signal);
      case "accounts": return { userId: ctx.userId, accounts: await client.accounts(ctx.userId, signal) };
      case "connect": return client.connect(input.slug, ctx.userId, signal);
      case "disconnect": return client.disconnect(input.id, ctx.userId, signal);
      case "execute": return client.execute(input, ctx.userId, signal);
      default: throw new CompanionError("Unknown Composio action.");
    }
  }
  async save(input, signal) {
    const old = this.settings(), mode = input.mode === "personal" ? "personal" : "managed", key = input.clearKey ? "" : input.key || old.key;
    if (key && !/^[\x21-\x7e]{8,4096}$/.test(key)) throw new CompanionError("Enter your Composio project API key.");
    if (mode === "personal" && !key) throw new CompanionError("Add your Composio key first.");
    if (input.key) await this.guarded(s => new ComposioClient({ key, fetchImpl: this.fetch }).catalog({}, s), signal);
    this.cancel(); this.pending = null; this.completed = null;
    this.store.change(d => { d.composio = { mode, key, userId: old.userId || "kai-desktop-" + id() }; });
    return this.status();
  }
  async refresh(signal) {
    return this.guarded(async s => {
      if (this.settings().mode === "managed") { await this.managedStatus(s); if (!this.managed.available || !this.account?._token()) return { status: this.status(), accounts: [] }; }
      else if (!this.settings().key) return { status: this.status(), accounts: [] };
      const ctx = this.context(), result = await this.call("accounts", {}, s, ctx);
      if (ctx.binding !== this.context().binding || ctx.project !== this.context().project) throw new CompanionError("Connection settings changed. Refresh again.");
      this.store.change(d => {
        for (const a of result.accounts) {
          const old = d.connections.find(c => c.provider === "composio" && c.accountId === a.id && c.mode === ctx.mode && c.project === ctx.project && c.userId === result.userId);
          if (old) { if (old.status !== a.status || old.binding !== ctx.binding || old.accountDisabled !== a.disabled) old.revision++; Object.assign(old, { status: a.status, binding: ctx.binding, accountDisabled: a.disabled }); }
          else if (d.connections.length < 100) d.connections.push({ id: id(), provider: "composio", mode: ctx.mode, project: ctx.project, binding: ctx.binding, userId: result.userId,
            accountId: a.id, toolkit: a.toolkit, name: a.name, status: a.status, accountDisabled: a.disabled, enabled: true, allowAgent: false, allowWrite: false, allowSync: false, operations: [], revision: 1 });
        }
        for (const c of d.connections.filter(c => c.provider === "composio" && c.mode === ctx.mode && c.project === ctx.project && c.userId === result.userId)) if (!result.accounts.some(a => a.id === c.accountId)) { if (c.status !== "DISCONNECTED") c.revision++; c.status = "DISCONNECTED"; c.allowSync = false; }
      });
      if (this.pending) {
        const a = result.accounts.find(a => a.status === "ACTIVE" && !a.disabled && a.toolkit === this.pending.toolkit && (this.pending.id ? a.id === this.pending.id : !this.pending.before.includes(a.id)));
        if (this.pending.binding !== ctx.binding || this.pending.project !== ctx.project || Date.now() > this.pending.expiresAt) this.pending = null;
        else if (a) { this.completed = { accountId: a.id, toolkit: a.toolkit }; this.pending = null; }
      }
      return { status: this.status(), accounts: result.accounts };
    }, signal);
  }
  catalog(input, signal) { return this.guarded(s => this.call("catalog", input, s), signal); }
  tools(input, signal) { return this.guarded(s => this.call("tools", input, s), signal); }
  async connect(key, signal) {
    return this.guarded(async s => {
      const ctx = this.context(); const before = (await this.call("accounts", {}, s, ctx)).accounts.map(a => a.id);
      const r = await this.call("connect", { slug: slug(key) }, s, ctx); s.throwIfAborted();
      if (ctx.binding !== this.context().binding || ctx.project !== this.context().project) throw new CompanionError("Connection settings changed. Start sign-in again.");
      this.completed = null;
      this.pending = { toolkit: key, id: r.id, url: connectURL(r.url), before, expiresAt: Math.min(Date.now() + 5 * 60000, Date.parse(r.expiresAt) || Infinity), binding: ctx.binding, project: ctx.project };
      await this.openExternal(this.pending.url); return { pending: true, toolkit: key };
    }, signal);
  }
  async reopen(signal) { return this.guarded(async () => { if (!this.pending || this.pending.expiresAt <= Date.now() || this.pending.binding !== this.context().binding || this.pending.project !== this.context().project) throw new CompanionError("This sign-in link expired. Connect the app again."); await this.openExternal(connectURL(this.pending.url)); }, signal); }
  async permissions(input, signal) {
    return this.guarded(async s => {
      const c = this.store.data.connections.find(c => c.id === input.id && c.provider === "composio");
      if (!c || !this.current(c) || c.status !== "ACTIVE") throw new CompanionError("Refresh or reconnect this account first.");
      const chosen = [...new Map((input.tools || []).map(t => { const value = typeof t === "string" ? { id: t } : t; return [slug(value.id), value]; })).values()]; if (chosen.length > 30) throw new CompanionError("Choose up to 30 actions for this account.");
      const operations = [], revision = c.revision;
      for (const ref of chosen) { const t = await this.call("tool", { slug: slug(ref.id), version: ref.version || "latest" }, s); if (t.toolkit !== c.toolkit) throw new CompanionError("Choose actions belonging to this app."); if (!t.readOnly && input.allowWrite !== true) throw new CompanionError("Enable reviewed actions to select actions that can make changes."); operations.push(t); }
      s.throwIfAborted(); if (!this.current(c) || this.store.data.connections.find(x => x.id === c.id)?.revision !== revision) throw new CompanionError("Connection settings changed. Refresh first.");
      this.store.change(d => { const saved = d.connections.find(x => x.id === c.id); Object.assign(saved, { name: text(input.name || c.name, 100, "Account name"), operations, allowAgent: input.allowAgent === true, allowSync: input.allowSync === true, allowWrite: input.allowWrite === true, revision: saved.revision + 1 }); });
      return true;
    }, signal);
  }
  prepare(c, operationId, variables, body) {
    if (!this.current(c) || c.status !== "ACTIVE" || c.accountDisabled) throw new CompanionError("Refresh or reconnect this account in Connections.");
    const op = c.operations.find(o => o.id === operationId); if (!op) throw new CompanionError("Select this action in the account's access settings first.");
    if (!op.readOnly && !c.allowWrite) throw new CompanionError("Reviewed actions are disabled for this account.");
    const values = validateArgs({ ...(variables || {}), ...(body || {}) }, op.schema);
    return { provider: "composio", connectionId: c.id, revision: c.revision, operationId, method: op.readOnly ? "GET" : "POST", name: c.name + " · " + op.name,
      url: "Composio / " + c.toolkit + " / " + op.id, accountId: c.accountId, version: op.version, arguments: values };
  }
  async execute(request, signal) {
    return this.guarded(async s => {
      const c = this.store.data.connections.find(x => x.id === request.connectionId);
      if (!c?.enabled || c.revision !== request.revision || !this.current(c)) throw new CompanionError("Connection changed. Review the action again.");
      const verified = this.prepare(c, request.operationId, request.arguments);
      if (JSON.stringify(verified) !== JSON.stringify(request)) throw new CompanionError("The action changed after review.");
      const result = await this.call("execute", { id: c.accountId, tool: request.operationId, version: request.version, arguments: request.arguments }, s);
      if (!this.current(c) || this.store.data.connections.find(x => x.id === c.id)?.revision !== request.revision) throw new CompanionError("Connection changed while the action was running. Its result was not collected.");
      return result;
    }, signal);
  }
  async disconnect(key, signal) {
    const c = this.store.data.connections.find(c => c.id === key && c.provider === "composio"); if (!c || !this.current(c)) throw new CompanionError("Select this account's connection mode before disconnecting.");
    await this.guarded(s => this.call("disconnect", { id: c.accountId }, s), signal);
    this.store.change(d => { d.connections = d.connections.filter(x => x.id !== key); for (const src of d.sources) if (src.connectionId === key) { src.autoSync = false; src.error = "Account disconnected"; } });
  }
  async logo(key, signal) {
    slug(key); if (this.logos.has(key)) return this.logos.get(key);
    return this.guarded(async s => {
      const r = await this.fetch("https://logos.composio.dev/api/" + key, { signal: s, redirect: "error" }); if (!r.ok) return null;
      const type = r.headers.get("content-type")?.split(";")[0]; if (!["image/svg+xml", "image/png", "image/webp", "image/jpeg"].includes(type)) return null;
      let bytes = 0; const chunks = []; for await (const chunk of r.body) { bytes += chunk.length; if (bytes > 100000) return null; chunks.push(chunk); }
      const result = "data:" + type + ";base64," + Buffer.concat(chunks).toString("base64"); if (this.logos.size < 500) this.logos.set(key, result); return result;
    }, signal);
  }
  cancel() { for (const c of this.active) c.abort(); }
}
module.exports = { CompanionComposio };
