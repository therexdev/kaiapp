"use strict";
const { CompanionError, id, text, copy } = require("./companion-store");
const TEMPLATES = [
  { id: "github", name: "GitHub", baseUrl: "https://api.github.com", auth: "bearer", headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, operations: [
    { id: "profile", name: "Read my profile", method: "GET", path: "/user" },
    { id: "repos", name: "List my repositories", method: "GET", path: "/user/repos?per_page=30&sort=updated" },
    { id: "issues", name: "Read repository issues", method: "GET", path: "/repos/{owner}/{repo}/issues?state=open&per_page=30" },
    { id: "create_issue", name: "Create an issue", method: "POST", path: "/repos/{owner}/{repo}/issues" } ] },
  { id: "notion", name: "Notion", baseUrl: "https://api.notion.com", auth: "bearer", headers: { "Notion-Version": "2022-06-28" }, operations: [
    { id: "profile", name: "Check integration", method: "GET", path: "/v1/users/me" },
    { id: "page", name: "Read page content", method: "GET", path: "/v1/blocks/{page_id}/children?page_size=100" },
    { id: "append", name: "Append page blocks", method: "PATCH", path: "/v1/blocks/{page_id}/children" } ] },
  { id: "slack", name: "Slack", baseUrl: "https://slack.com", auth: "bearer", headers: {}, operations: [
    { id: "profile", name: "Check token", method: "GET", path: "/api/auth.test" },
    { id: "history", name: "Read channel messages", method: "GET", path: "/api/conversations.history?channel={channel}&limit=30" },
    { id: "send", name: "Send a message", method: "POST", path: "/api/chat.postMessage" } ] },
  { id: "homeassistant", name: "Home Assistant", baseUrl: "http://127.0.0.1:8123", auth: "bearer", headers: {}, operations: [
    { id: "profile", name: "Check server", method: "GET", path: "/api/" },
    { id: "states", name: "Read device states", method: "GET", path: "/api/states" },
    { id: "service", name: "Call a device service", method: "POST", path: "/api/services/{domain}/{service}" } ] },
  { id: "custom", name: "Custom API", baseUrl: "https://api.example.com", auth: "bearer", headers: {}, operations: [{ id: "status", name: "Read status", method: "GET", path: "/status" }] },
];
function baseURL(raw) {
  let u; try { u = new URL(raw); } catch { throw new CompanionError("Enter a complete API base URL."); }
  if (u.username || u.password || u.search || u.hash || !["http:", "https:"].includes(u.protocol)) throw new CompanionError("Base URL must have no credentials, query or fragment.");
  if (u.protocol !== "https:" && !["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)) throw new CompanionError("Use HTTPS for remote APIs. HTTP is allowed only on this computer.");
  return u.href.replace(/\/$/, "");
}
function operations(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 30) throw new CompanionError("Add between 1 and 30 API operations.");
  const seen = new Set();
  return raw.map(o => {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(o.id) || seen.has(o.id)) throw new CompanionError("Operations need unique lowercase IDs."); seen.add(o.id);
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(o.method)) throw new CompanionError("Unsupported HTTP method.");
    const p = text(o.path, 2000, "Operation path");
    if (!p.startsWith("/") || p.startsWith("//") || /[\\\r\n#]/.test(p) || /(?:^|\/)\.\.?(?:\/|$|\?)/.test(p)) throw new CompanionError("Operation paths must stay inside the saved API base URL.");
    return { id: o.id, name: text(o.name || o.id, 100, "Operation name"), method: o.method, path: p };
  });
}
class CompanionConnections {
  constructor({ store, privacyMode, fetchImpl = fetch }) { this.store = store; this.privacyMode = privacyMode; this.fetch = fetchImpl; this.active = new Set(); }
  list() { return this.store.data.connections.filter(c => c.provider !== "composio" || this.composio?.current(c)).map(({ secret, binding, project, userId, ...c }) => ({ ...copy(c), configured: c.provider === "composio" ? c.status === "ACTIVE" : c.auth === "none" || !!secret })); }
  save(input) {
    const baseUrl = baseURL(input.baseUrl), ops = operations(input.operations);
    const headers = {};
    if (input.headers && (typeof input.headers !== "object" || Array.isArray(input.headers))) throw new CompanionError("Headers must be a JSON object.");
    for (const [k, v] of Object.entries(input.headers || {})) {
      if (!["accept", "notion-version", "x-github-api-version"].includes(k.toLowerCase()) || typeof v !== "string" || /[\r\n]/.test(v) || v.length > 200) throw new CompanionError("Only Accept and API-version headers are allowed here. Put credentials in the secret field.");
      headers[k] = v;
    }
    const auth = ["none", "bearer", "header"].includes(input.auth) ? input.auth : "bearer";
    const headerName = auth === "header" ? text(input.headerName, 60, "Secret header name") : "Authorization";
    if (!/^(?:authorization|x-[a-z0-9-]+|api-key|apikey)$/i.test(headerName)) throw new CompanionError("Use Authorization, api-key, apikey, or an X-… secret header.");
    const saved = this.store.change(d => {
      const old = input.id ? d.connections.find(c => c.id === input.id) : null;
      if (old?.provider === "composio") throw new CompanionError("Use this app's access settings to edit a Composio connection.");
      if (input.id && !old) throw new CompanionError("Connection no longer exists.");
      if (!old && d.connections.length >= 50) throw new CompanionError("Maximum 50 connections.");
      // Changing a destination never silently transfers the old credential.
      const secret = auth === "none" ? "" : input.secret || (old?.baseUrl === baseUrl && old.auth === auth && old.headerName === headerName ? old.secret : "");
      if (auth !== "none" && (typeof secret !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(secret))) throw new CompanionError("Enter an API token for this destination.");
      const c = { id: old?.id || id(), name: text(input.name, 80, "Connection name"), baseUrl, auth, headerName, secret, headers, operations: ops,
        enabled: input.enabled !== false, allowAgent: input.allowAgent === true, allowSync: input.allowSync === true, revision: (old?.revision || 0) + 1, lastCheck: null, status: "Not tested" };
      if (old) d.connections[d.connections.indexOf(old)] = c; else d.connections.push(c); return c.id;
    }); this.cancel(saved); return this.list().find(c => c.id === saved);
  }
  remove(key) { this.cancel(key); if (this.store.data.connections.find(c => c.id === key)?.provider === "composio") throw new CompanionError("Use Disconnect in Connected apps to remove this account."); this.store.change(d => { d.connections = d.connections.filter(c => c.id !== key); d.sources.forEach(s => { if (s.connectionId === key) { s.autoSync = false; s.error = "Connection removed"; } }); }); }
  prepare(connectionId, operationId, variables = {}, body = undefined) {
    this.store.requireStorage();
    const c = this.store.data.connections.find(c => c.id === connectionId);
    if (!c?.enabled) throw new CompanionError("Enable this connection first.");
    if (c.provider === "composio") return this.composio.prepare(c, operationId, variables, body);
    const op = c.operations.find(o => o.id === operationId); if (!op) throw new CompanionError("Choose a saved API operation.");
    if (!variables || typeof variables !== "object" || Array.isArray(variables)) throw new CompanionError("Variables must be a JSON object.");
    const p = op.path.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => {
      if (!["string", "number"].includes(typeof variables[k]) || String(variables[k]).length > 500 || /^(?:\.|\.\.)$/.test(String(variables[k]))) throw new CompanionError(`Enter a value for ${k}.`);
      return encodeURIComponent(String(variables[k]));
    });
    const base = new URL(c.baseUrl), url = new URL(c.baseUrl + p);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/")) throw new CompanionError("The operation escaped its saved base URL.");
    const payload = op.method === "GET" ? undefined : JSON.stringify(body ?? {});
    if (payload?.length > 16000) throw new CompanionError("Request body is too large to review (maximum 16,000 characters).");
    return { connectionId, revision: c.revision, operationId, name: c.name + " · " + op.name, method: op.method, url: url.href, ...(payload !== undefined ? { body: payload } : {}) };
  }
  async execute(request, signal) {
    if (request.provider === "composio") return this.composio.execute(request, signal);
    this.store.requireStorage();
    const c = this.store.data.connections.find(c => c.id === request.connectionId);
    if (!c?.enabled || c.revision !== request.revision) throw new CompanionError("Connection changed. Review and run the operation again.");
    if (this.privacyMode() === "local-only") throw new CompanionError("Local-Only blocks API connections. Change Privacy to Local-First to connect.");
    const controller = new AbortController(), job = { id: c.id, controller }; this.active.add(job);
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
    const timer = setInterval(() => { if (this.privacyMode() === "local-only") controller.abort(); }, 200); timer.unref?.();
    try {
      combined.throwIfAborted();
      const headers = { "Content-Type": "application/json", ...c.headers };
      if (c.auth !== "none") headers[c.headerName] = c.auth === "bearer" ? "Bearer " + c.secret : c.secret;
      const response = await this.fetch(request.url, { method: request.method, headers, body: request.body, signal: combined, redirect: "error" });
      if (!response.ok) throw new CompanionError(`API returned HTTP ${response.status}. Check the token, permissions, and operation path.`);
      if (Number(response.headers.get("content-length")) > 200000) throw new CompanionError("Response is too large. Narrow the request or use pagination.");
      let bytes = 0, result = ""; const decoder = new TextDecoder();
      for await (const chunk of response.body || []) { combined.throwIfAborted(); bytes += chunk.length; if (bytes > 200000) { controller.abort(); throw new CompanionError("Response is too large. Narrow the request or use pagination."); } result += decoder.decode(chunk, { stream: true }); }
      result += decoder.decode(); combined.throwIfAborted();
      if (c.secret) result = result.split(c.secret).join("[credential removed]");
      try { const j = JSON.parse(result); if (j.ok === false || (j.object === "error" && j.message)) throw new CompanionError("The API rejected this operation. Check the token scopes and request fields."); } catch (e) { if (e instanceof CompanionError) throw e; }
      this.store.change(d => { const saved = d.connections.find(x => x.id === c.id); if (saved?.revision === c.revision) { saved.lastCheck = Date.now(); saved.status = "Connected"; } });
      return result || "Operation completed (empty response).";
    } catch (e) {
      if (e instanceof CompanionError) throw e;
      if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
      throw new CompanionError(this.privacyMode() === "local-only" ? "Local-Only stopped this connection." : "The API request stopped or could not connect. Redirects are refused; use the final API URL.");
    } finally { clearInterval(timer); this.active.delete(job); }
  }
  cancel(key) { for (const job of this.active) if (!key || job.id === key) job.controller.abort(); }
}
module.exports = { CompanionConnections, TEMPLATES, baseURL, operations };
