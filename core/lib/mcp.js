"use strict";

const { spawn } = require("child_process");

/*
 * Minimal Model Context Protocol client (§8 expansion). Two transports:
 *
 *   http:  Streamable HTTP — POST JSON-RPC to one URL; the server answers
 *          with JSON or a one-shot SSE stream; Mcp-Session-Id is echoed once
 *          the server assigns it.
 *   stdio: spawn a local command; one JSON-RPC message per line each way.
 *
 * Scope is deliberately tools-only (initialize → tools/list → tools/call).
 * Resources/prompts/sampling can layer on later; tools are what makes the
 * 10k-server ecosystem useful from chat.
 *
 * Privacy contract (enforced by the ToolRegistry, decided here): an http
 * server is egress by definition. A stdio server is a LOCAL process, but we
 * cannot audit what that process does — so it is egress:true as well unless
 * the user explicitly marked it "local-only safe" when adding it. Honest
 * beats convenient.
 */

const PROTOCOL_VERSION = "2025-03-26";
const RPC_TIMEOUT_MS = 30000;

class McpConnection {
  constructor(config, onEvent) {
    this.config = config; // {id, name, transport: "http"|"stdio", url?, command?, args?, localSafe?}
    this.onEvent = onEvent || (() => {});
    this.tools = [];
    this.serverInfo = null;
    this._nextId = 1;
    this._child = null;
    this._pending = new Map(); // id -> {resolve, reject, timer} (stdio)
    this._sessionId = null; // http
    this._buf = "";
  }

  // ---- transport: http (Streamable HTTP) ----
  async _httpRpc(method, params, { notification = false } = {}) {
    const body = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
    if (!notification) body.id = this._nextId++;
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this._sessionId ? { "mcp-session-id": this._sessionId } : {}),
    };
    const resp = await fetch(this.config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const sid = resp.headers.get("mcp-session-id");
    if (sid) this._sessionId = sid;
    if (notification) return null; // 202 expected, body irrelevant
    if (!resp.ok) throw new Error(`MCP server answered HTTP ${resp.status}`);
    const ctype = String(resp.headers.get("content-type") || "");
    let msg;
    if (ctype.includes("text/event-stream")) {
      // One-shot SSE: read until the event carrying our response id.
      const text = await resp.text();
      for (const chunk of text.split("\n\n")) {
        const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!data) continue;
        try {
          const j = JSON.parse(data);
          if (j.id === body.id) { msg = j; break; }
        } catch { /* keep scanning */ }
      }
      if (!msg) throw new Error("MCP server SSE stream ended without a response");
    } else {
      msg = await resp.json();
    }
    if (msg.error) throw new Error(`MCP error: ${msg.error.message || JSON.stringify(msg.error)}`);
    return msg.result;
  }

  // ---- transport: stdio (newline-delimited JSON-RPC) ----
  _stdioStart() {
    const [cmd, ...baseArgs] = Array.isArray(this.config.command) ? this.config.command : String(this.config.command).split(" ");
    this._child = spawn(cmd, [...baseArgs, ...(this.config.args || [])], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this._child.stdout.on("data", (d) => {
      this._buf += d.toString();
      let idx;
      while ((idx = this._buf.indexOf("\n")) >= 0) {
        const line = this._buf.slice(0, idx).trim();
        this._buf = this._buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const p = this._pending.get(msg.id);
          if (p) {
            this._pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(`MCP error: ${msg.error.message || JSON.stringify(msg.error)}`));
            else p.resolve(msg.result);
          }
          // notifications (tools/list_changed etc.) are ignored in v1
        } catch { /* partial/noise line */ }
      }
    });
    this._child.stderr.on("data", () => {}); // servers log freely; not our problem
    this._child.on("exit", (code) => {
      for (const [, p] of this._pending) p.reject(new Error(`MCP server exited (${code})`));
      this._pending.clear();
      this._child = null;
      this.onEvent({ type: "mcp:exited", server: this.config.name, code });
    });
    this._child.on("error", (e) => {
      for (const [, p] of this._pending) p.reject(new Error(`MCP server failed to start: ${e.message}`));
      this._pending.clear();
    });
  }

  _stdioRpc(method, params, { notification = false } = {}) {
    if (!this._child) throw new Error("MCP server not running");
    const body = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
    if (notification) {
      this._child.stdin.write(JSON.stringify(body) + "\n");
      return Promise.resolve(null);
    }
    body.id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(body.id);
        reject(new Error(`MCP call timed out: ${method}`));
      }, RPC_TIMEOUT_MS);
      this._pending.set(body.id, { resolve, reject, timer });
      this._child.stdin.write(JSON.stringify(body) + "\n");
    });
  }

  _rpc(method, params, opts) {
    return this.config.transport === "stdio" ? this._stdioRpc(method, params, opts) : this._httpRpc(method, params, opts);
  }

  async connect() {
    if (this.config.transport === "stdio") this._stdioStart();
    const init = await this._rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "koinos-ai", version: "1.0" },
    });
    this.serverInfo = init?.serverInfo || null;
    await this._rpc("notifications/initialized", undefined, { notification: true });
    const listed = await this._rpc("tools/list", {});
    this.tools = (listed?.tools || []).map((t) => ({
      name: t.name,
      description: String(t.description || "").slice(0, 300),
      inputSchema: t.inputSchema || {},
    }));
    return this.tools;
  }

  async callTool(name, args) {
    const r = await this._rpc("tools/call", { name, arguments: args || {} });
    // Result content is a list of typed parts; flatten the text ones.
    const parts = (r?.content || []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
    if (r?.isError) throw new Error(parts || "tool reported an error");
    return parts || "(empty result)";
  }

  close() {
    if (this._child) {
      try { this._child.kill(); } catch { /* gone */ }
      this._child = null;
    }
  }
}

module.exports = { McpConnection, PROTOCOL_VERSION };
