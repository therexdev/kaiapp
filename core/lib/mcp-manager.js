"use strict";

const { McpConnection } = require("./mcp");

/*
 * MCP server lifecycle + the user-facing niceties. Design goal: adding a
 * tool server must be ONE decision, not a config file. Three add paths:
 *
 *   1. Curated catalog — one click. Each entry is something we verified
 *      speaks MCP and states plainly what it needs (nothing / an API key /
 *      a local runtime like Node).
 *   2. Paste a URL — any Streamable-HTTP MCP server.
 *   3. Paste a command — any stdio server (advanced; shown with a plain
 *      warning that it runs a program on this machine).
 *
 * Every server tool lands in the unified registry as mcp:<server>:<tool>,
 * sensitive by default (ask before use) until the user flips "trusted" on
 * that server. Nothing auto-connects at boot until the user has connected
 * it successfully once (autoConnect flips on then — surprise processes at
 * startup are not user friendly).
 */

// Small, honest catalog: entries we can stand behind. requires:"node" means
// npx must exist on the machine; the UI says so up front instead of failing.
const CATALOG = [
  {
    id: "fetch",
    name: "Web fetch (reference)",
    description: "Fetch and read any web page as clean text — the MCP reference fetch server.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
    requires: "node",
  },
  {
    id: "filesystem",
    name: "File access (pick folders)",
    description: "Read and write files in folders YOU choose — the MCP reference filesystem server.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    argsPrompt: { label: "Folder the tools may access", appendAsArg: true },
    requires: "node",
  },
  {
    id: "memory-graph",
    name: "Knowledge graph memory",
    description: "A structured knowledge-graph memory — the MCP reference memory server.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    requires: "node",
  },
];

class McpManager {
  constructor({ settings, registry, onEvent }) {
    this.settings = settings; // JsonStore
    this.registry = registry;
    this.onEvent = onEvent || (() => {});
    this._conns = new Map(); // id -> McpConnection
  }

  servers() {
    return (this.settings.get("mcp.servers") || []).map((s) => ({
      ...s,
      connected: this._conns.has(s.id),
      tools: this._conns.get(s.id)?.tools || [],
    }));
  }

  _saveServers(list) {
    this.settings.set("mcp.servers", list);
  }

  addServer({ name, transport, url, command, args, localSafe = false }) {
    const list = this.settings.get("mcp.servers") || [];
    const id = `srv${Date.now().toString(36)}`;
    const entry = {
      id,
      name: String(name || "").slice(0, 60) || "Tool server",
      transport: transport === "stdio" ? "stdio" : "http",
      ...(url ? { url: String(url) } : {}),
      // A command may arrive as argv array (catalog) or a typed string; a
      // String() of an array would comma-join it into garbage.
      ...(command ? { command: Array.isArray(command) ? command.map(String) : String(command) } : {}),
      ...(args?.length ? { args: args.map(String) } : {}),
      localSafe: Boolean(localSafe), // user vouched a stdio server never egresses
      trusted: false, // trusted = tools run without per-call confirmation
      autoConnect: false,
    };
    if (entry.transport === "http" && !entry.url) throw new Error("An http tool server needs a URL");
    if (entry.transport === "stdio" && !entry.command) throw new Error("A local tool server needs a command");
    list.push(entry);
    this._saveServers(list);
    return entry;
  }

  removeServer(id) {
    this.disconnect(id);
    this._saveServers((this.settings.get("mcp.servers") || []).filter((s) => s.id !== id));
  }

  setServerFlags(id, { trusted, autoConnect, localSafe }) {
    const list = this.settings.get("mcp.servers") || [];
    const s = list.find((x) => x.id === id);
    if (!s) throw new Error("no such tool server");
    if (trusted !== undefined) s.trusted = Boolean(trusted);
    if (autoConnect !== undefined) s.autoConnect = Boolean(autoConnect);
    if (localSafe !== undefined) s.localSafe = Boolean(localSafe);
    this._saveServers(list);
    if (this._conns.has(id)) this._registerTools(s, this._conns.get(id)); // re-register with new policy
    return s;
  }

  async connect(id) {
    const s = (this.settings.get("mcp.servers") || []).find((x) => x.id === id);
    if (!s) throw new Error("no such tool server");
    if (this._conns.has(id)) return this._conns.get(id).tools;
    const conn = new McpConnection(s, this.onEvent);
    const tools = await conn.connect().catch((e) => {
      conn.close();
      throw e;
    });
    this._conns.set(id, conn);
    this._registerTools(s, conn);
    // First successful connect earns auto-reconnect on next boot.
    if (!s.autoConnect) this.setServerFlags(id, { autoConnect: true });
    this.onEvent({ type: "mcp:connected", server: s.name, tools: tools.length });
    return tools;
  }

  disconnect(id) {
    const conn = this._conns.get(id);
    if (!conn) return;
    conn.close();
    this._conns.delete(id);
    this.registry.unregister(`mcp:${id}`);
  }

  _registerTools(s, conn) {
    this.registry.unregister(`mcp:${s.id}`);
    for (const t of conn.tools) {
      this.registry.register({
        name: `mcp:${s.id}:${t.name}`,
        description: `[${s.name}] ${t.description || t.name}`,
        params: Object.fromEntries(
          Object.entries(t.inputSchema?.properties || {}).map(([k, v]) => [k, String(v?.description || v?.type || "value").slice(0, 120)])
        ),
        // http = egress, always. stdio = local process we can't audit; only
        // the user's explicit "local-only safe" vouch clears the flag.
        egress: s.transport === "http" ? true : !s.localSafe,
        sensitive: !s.trusted,
        handler: (args) => conn.callTool(t.name, args),
      });
    }
  }

  /** Reconnect servers the user has used before. Fire-and-forget at boot. */
  async autoConnect() {
    for (const s of this.settings.get("mcp.servers") || []) {
      if (s.autoConnect) {
        await this.connect(s.id).catch((e) => this.onEvent({ type: "mcp:autoconnect-failed", server: s.name, message: String(e.message) }));
      }
    }
  }

  closeAll() {
    for (const id of [...this._conns.keys()]) this.disconnect(id);
  }
}

module.exports = { McpManager, CATALOG };
