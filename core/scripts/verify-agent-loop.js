#!/usr/bin/env node
"use strict";

/*
 * End-to-end replay of the v0.27.3 field report (third-party koinos-ai-mcp,
 * 29 tools, koinos-balanced). Unit tests pin the helpers; this drives the
 * WHOLE renderer loop — real MCP subprocess, real tool registry, real
 * /core/tools routes — against a model that misbehaves the way small local
 * models actually do.
 *
 * The scripted model is deliberately not generous. It:
 *   · enforces the SAME context gate Core enforces, so an oversized tool
 *     menu fails here exactly as it fails in the app (that is the bug: every
 *     step 400s and the UI says "answering without tools");
 *   · reproduces names strictly as the prompt spelled them, and when a name
 *     carries a namespace it splits it into {"<namespace>": "<rest>"} — the
 *     verbatim shape from the report.
 *
 * Run:  node core/scripts/verify-agent-loop.js
 */

const http = require("http");
const path = require("path");

const { ToolRegistry } = require("../lib/tools");
const { McpManager } = require("../lib/mcp-manager");
const { JsonStore } = require("../lib/store");
const { estimateMessageTokens } = require("../lib/gateway");
const KaiAgents = require(path.join(__dirname, "..", "..", "ui", "agents"));

const LOCAL_CTX = 4096;
const CTX_HEADROOM = 512; // matches gateway.js

const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!cond) process.exitCode = 1;
  return cond;
};

/* A real MCP server over stdio, shaped like the one in the report: a handful
 * of meaningful tools plus a long tail, every description spending most of
 * the 300-char budget on a confirm contract. */
const SERVER_SRC = `
const named = [
  ["network_overview", "Overview of the Koinos AI network: workers online, jobs completed, tokens per second."],
  ["network_status", "Live status for one worker or the whole network, including privacy mode and lease state."],
  ["network_models", "List the models the network currently advertises with their context class and price."],
];
const tools = named.concat(Array.from({ length: 26 }, (_, i) => ["extra_tool_" + i, "Capability number " + i + " exposed by this server."]))
  .map(([name, d]) => ({
    name,
    description: d + " Read-only; never mutates scheduler state. Call this before any write tool so the confirm prompt can quote live numbers back to the user rather than stale ones, and so the audit log records the value that was shown.",
    inputSchema: { type: "object", properties: {
      target: { type: "string", description: "which worker id or scope to report on, or 'all'" },
      verbose: { type: "boolean", description: "include the full per-worker breakdown rather than totals" },
      since: { type: "string", description: "ISO 8601 timestamp lower bound for the window" },
    } },
  }));
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  if (m.method === "initialize") reply({ protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: "koinos-ai-mcp", version: "1" } });
  else if (m.method === "tools/list") reply({ tools });
  else if (m.method === "tools/call") reply({ content: [{ type: "text", text: "LIVE " + m.params.name + ": 7 workers online, 1042 jobs, 31.4 tok/s" }] });
});
`;

/** A small local model, simulated honestly. */
function makeScriptedModel(trace) {
  const used = new Set();
  return async function askModelOnce(messages) {
    // 1. The gate Core really applies. An oversized menu dies right here.
    const est = estimateMessageTokens(messages);
    if (est > LOCAL_CTX - CTX_HEADROOM) {
      throw new Error(`Prompt is ~${est} tokens — larger than the local model's ${LOCAL_CTX}-token context`);
    }
    trace.push({ tokens: est });

    // 2. Read the menu it was actually given.
    const listed = [...String(messages[0].content).matchAll(/^- (.+?): /gm)].map((m) => m[1]);
    const pick = listed.find((n) => !used.has(n));
    if (!pick || used.size >= 3) return '{"answer": true}';
    used.add(pick);

    // 3. Say the name — the only way this model knows how. A namespaced name
    //    gets split at the first colon: the namespace becomes the KEY.
    const colon = pick.indexOf(":");
    if (colon !== -1) return JSON.stringify({ [pick.slice(0, colon)]: pick.slice(colon + 1), args: {} });
    return JSON.stringify({ tool: pick, args: {} });
  };
}

async function main() {
  const registry = new ToolRegistry({ privacyMode: () => "network" });
  const settings = new JsonStore(path.join(require("os").tmpdir(), `kai-agentcheck-${Date.now()}.json`), {});
  const mgr = new McpManager({ settings, registry, onEvent: () => {} });

  const srv = mgr.addServer({ name: "Koinos AI MCP", transport: "stdio", command: [process.execPath, "-e", SERVER_SRC] });
  const tools = await mgr.connect(srv.id);
  mgr.setServerFlags(srv.id, { trusted: true }); // user has vouched for it
  ok("MCP server connected with a realistic tool count", tools.length >= 29, `${tools.length} tools`);

  // The two /core routes the renderer talks to (gateway.js keeps them a dumb
  // pipe; the registry is where policy lives, so this is a faithful stand-in).
  const api = http.createServer(async (req, res) => {
    const send = (code, obj) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));
    if (req.url === "/core/tools") return send(200, { ok: true, tools: registry.list() });
    let body = "";
    for await (const c of req) body += c;
    const b = JSON.parse(body || "{}");
    try {
      send(200, { ok: true, result: await registry.call(b.name, b.args || {}, { confirmed: Boolean(b.confirmed) }) });
    } catch (e) {
      send(e.needsConfirmation ? 428 : 400, { ok: false, error: String(e.message), ...(e.needsConfirmation ? { needsConfirmation: true } : {}) });
    }
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${api.address().port}`;
  const realFetch = global.fetch;
  global.fetch = (p, o) => realFetch(typeof p === "string" && p.startsWith("/") ? base + p : p, o);

  const trace = [];
  const statuses = [];
  const rt = KaiAgents.makeRuntime({
    askModelOnce: makeScriptedModel(trace),
    setStatus: (t) => statuses.push(t),
    confirmTool: () => Promise.resolve(true),
  });

  const question = "how is the koinos network doing right now?";
  let phase = null;
  let failure = null;
  try {
    phase = await rt.runAgent(question, "koinos-balanced");
  } catch (e) {
    failure = e.message;
  }

  ok("the loop survived its own tool menu", !failure, failure || "no context refusal");
  ok("every step stayed inside the local context", trace.length > 0 && trace.every((t) => t.tokens < LOCAL_CTX - CTX_HEADROOM), `peak ~${Math.max(0, ...trace.map((t) => t.tokens))} tokens`);
  ok("tools actually ran", Boolean(phase), phase ? phase.trace : "runAgent returned nothing — this is the reported bug");
  if (phase) {
    ok("three tool calls, not a silent fallback", /3 tool calls/.test(phase.trace), phase.trace);
    ok("the answer is grounded in live server data", /1042 jobs/.test(phase.context), phase.context.split("\n").find((l) => l.includes("LIVE")) || "");
    ok("the trace names tools the way a human reads them", !phase.trace.includes(`mcp:${srv.id}:`), phase.trace);
  }
  ok("the user was told the menu was subset", statuses.some((s) => /of \d+ tools/.test(s)), statuses.find((s) => /of \d+ tools/.test(s)) || "(no subset notice)");

  /* The naming half, pinned against this server's REAL generated id rather
   * than a synthetic one — and checked independently of the context bug, so
   * raising n_ctx some day cannot quietly un-fix it. */
  const registryNames = registry.list().map((t) => t.name);
  const menu = KaiAgents.buildAgentSystem(registry.list(), { question, allNames: registryNames });
  ok("no namespaced name ever reaches the model", !menu.includes(`mcp:${srv.id}:`), `id was ${srv.id}`);
  const fieldOutput = JSON.stringify({ mcp: `${srv.id}:network_status`, args: {} });
  const parsed = KaiAgents.parseAgentAction(fieldOutput, registryNames);
  ok("the field model's verbatim output resolves to a real tool", parsed && parsed.tool === `mcp:${srv.id}:network_status`, fieldOutput);
  ok("a tool that does not exist is still refused", KaiAgents.parseAgentAction(JSON.stringify({ mcp: `${srv.id}:drop_everything` }), registryNames) === null);

  global.fetch = realFetch;
  mgr.closeAll();
  api.close();
  console.log(process.exitCode ? "\nAGENT LOOP CHECK FAILED" : "\nAGENT LOOP CHECK PASSED");
}

main().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});
