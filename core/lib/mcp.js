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
const MAX_RPC_BYTES = 2 * 1024 * 1024;
/*
 * The FIRST connect to an npm-based server has to download the package
 * before the server process says a word, which on a cold machine routinely
 * outlasts a normal RPC timeout (Windows CI: initialize timed out at 30s
 * while npx was still installing). Connecting therefore gets its own, far
 * more patient budget; ordinary tool calls keep the short one so a wedged
 * server still fails fast.
 */
const CONNECT_TIMEOUT_MS = 240000;

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
  async _httpRpc(method, params, { notification = false, timeoutMs = RPC_TIMEOUT_MS } = {}) {
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
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    const sid = resp.headers.get("mcp-session-id");
    if (sid) this._sessionId = sid;
    if (notification) { await resp.body?.cancel(); return null; }
    if (!resp.ok) { await resp.body?.cancel(); throw new Error(`MCP server answered HTTP ${resp.status}`); }
    const ctype = String(resp.headers.get("content-type") || "");
    let msg;
    let buffered = "", bytes = 0; const decoder = new TextDecoder();
    if (ctype.includes("text/event-stream")) {
      // Servers may keep SSE open after the answer. Consume complete events
      // incrementally and release the stream as soon as our response arrives.
      const parseEvent = frame => {
        const data = frame.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).replace(/^ /, "")).join("\n");
        try { const value = JSON.parse(data); if (value.id === body.id) return value; } catch { /* notification/noise */ }
      };
      for await (const chunk of resp.body) {
        if ((bytes += chunk.length) > MAX_RPC_BYTES) throw new Error("MCP response exceeds 2 MB");
        buffered += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffered))) {
          const frame = buffered.slice(0, boundary.index); buffered = buffered.slice(boundary.index + boundary[0].length);
          msg = parseEvent(frame); if (msg) break;
        }
        if (msg) break;
      }
      if (!msg) msg = parseEvent(buffered + decoder.decode());
      if (!msg) throw new Error("MCP server SSE stream ended without a response");
    } else {
      for await (const chunk of resp.body) { if ((bytes += chunk.length) > MAX_RPC_BYTES) throw new Error("MCP response exceeds 2 MB"); buffered += decoder.decode(chunk, { stream: true }); }
      msg = JSON.parse(buffered + decoder.decode());
    }
    if (!msg || msg.id !== body.id) throw new Error("MCP response ID does not match the request");
    if (msg.error) throw new Error(`MCP error: ${msg.error.message || JSON.stringify(msg.error)}`);
    return msg.result;
  }

  // ---- transport: stdio (newline-delimited JSON-RPC) ----
  _stdioStart() {
    const [cmd, ...baseArgs] = Array.isArray(this.config.command) ? this.config.command : String(this.config.command).split(" ");
    this._child = spawn(cmd, [...baseArgs, ...(this.config.args || [])], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // config.env carries the resolved-Node PATH when the manager mapped an
      // npx server onto a real node binary. config.shell is only set for the
      // last-resort .cmd shim path (Windows refuses .cmd without a shell).
      env: this.config.env || process.env,
      ...(this.config.shell ? { shell: true } : {}),
    });
    const decoder = new (require("node:string_decoder").StringDecoder)("utf8");
    this._child.stdout.on("data", (d) => {
      this._buf += decoder.write(d);
      if (Buffer.byteLength(this._buf) > MAX_RPC_BYTES) {
        this._buf = "";
        for (const p of this._pending.values()) { clearTimeout(p.timer); p.reject(new Error("MCP response exceeds 2 MB")); }
        this._pending.clear(); this.close(); return;
      }
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
      for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error(`MCP server exited (${code})`)); }
      this._pending.clear();
      this._child = null;
      this.onEvent({ type: "mcp:exited", server: this.config.name, code });
    });
    this._child.on("error", (e) => {
      for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error(`MCP server failed to start: ${e.message}`)); }
      this._pending.clear();
    });
  }

  _stdioRpc(method, params, { notification = false, timeoutMs = RPC_TIMEOUT_MS } = {}) {
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
        reject(new Error(`MCP call timed out: ${method}${timeoutMs >= CONNECT_TIMEOUT_MS ? " (the tool server never started — if it downloads on first run, try again once it is cached)" : ""}`));
      }, timeoutMs);
      this._pending.set(body.id, { resolve, reject, timer });
      this._child.stdin.write(JSON.stringify(body) + "\n");
    });
  }

  _rpc(method, params, opts) {
    return this.config.transport === "stdio" ? this._stdioRpc(method, params, opts) : this._httpRpc(method, params, opts);
  }

  async connect() {
    if (this.config.transport === "stdio") this._stdioStart();
    const init = await this._rpc(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "koinos-ai", version: "1.0" } },
      { timeoutMs: CONNECT_TIMEOUT_MS } // first run downloads the package
    );
    this.serverInfo = init?.serverInfo || null;
    await this._rpc("notifications/initialized", undefined, { notification: true });
    const listed = await this._rpc("tools/list", {}, { timeoutMs: CONNECT_TIMEOUT_MS });
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

module.exports = { McpConnection, PROTOCOL_VERSION, RPC_TIMEOUT_MS, CONNECT_TIMEOUT_MS };
