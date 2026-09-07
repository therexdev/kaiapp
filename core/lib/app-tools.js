"use strict";

// Explicit adapters to the app's existing control plane. Models never supply
// an HTTP path or a node RPC channel. The original route remains responsible
// for privacy, validation, engine holds and service lifecycle rules.
const { formatAmount } = require("./koinos/format");
const pick = (value, names) => Object.fromEntries(names.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const decimal = value => /^-?\d+$/.test(String(value)) ? formatAmount(value) : null;
const id = value => {
  if (typeof value !== "string" || !value || value.length > 180 || /[\x00-\x1f/\\]/.test(value) || value === "." || value === "..") throw new Error("A valid item id is required. Read the list first.");
  return encodeURIComponent(value);
};
const fields = (args, allowed) => {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error(`Unsupported argument: ${key}`);
  return args;
};

const ACTIONS = Object.freeze({
  download_model: { description: "Download and load a catalog model. May use several GB and change the active local model; inspect Models first.", keys: ["alias"], route: "/core/models/ensure", egress: true },
  cancel_download: { description: "Cancel the current model/runtime download.", keys: [], route: "/core/models/download/cancel" },
  remove_model: { description: "Remove an installed model package; the app refuses an in-use model. Read Models for the exact package id.", keys: ["id"], route: a => "/core/models/installed/" + id(a.id), method: "DELETE" },
  start_earning: { description: "Start AI network earning using the existing wallet, scheduler and models.", keys: [], route: "/core/earn/start", egress: true },
  stop_earning: { description: "Stop AI network earning. This affects participation; does not stop the separate blockchain node.", keys: [], route: "/core/earn/stop" },
  set_privacy: { description: "Change privacyMode: local-only, local-first, or network. Local-first/network allow data to leave this computer; never change this silently to satisfy a web request.", keys: ["privacyMode"], route: "/core/network/config" },
  enable_node_view: { description: "Show or hide the Koinos Node app section (enabled boolean). Does not start or stop the node.", keys: ["enabled"], route: "/core/koinos/config" },
  start_node: { description: "Start the existing blockchain node (produce boolean). Uses Docker, network, disk and CPU.", keys: ["produce"], channel: "node:start", egress: true },
  stop_node: { description: "Stop the blockchain node. Stops its live contribution and block production.", keys: [], channel: "node:stop", egress: true },
  node_auto_recover: { description: "Set automatic recovery of the blockchain node (on boolean).", keys: ["on"], channel: "node:setAutoRecover", egress: true },
  save_document: { description: "Create an app document with title and content; supply an existing id only to replace that document.", keys: ["id", "title", "content"], route: "/core/docs" },
  delete_document: { description: "Delete an app document by id.", keys: ["id"], route: a => "/core/docs/" + id(a.id), method: "DELETE" },
  create_task: { description: "Create a scheduled AI prompt. name, prompt, model and schedule {kind: hourly/every6h/daily/weekly, hour: 0-23, day: 0-6}. Runs while app is open, using existing model routing/budgets.", keys: ["name", "prompt", "model", "schedule"], route: "/core/tasks" },
  update_task: { description: "Update a task by id; enabled, name, prompt, model, schedule are optional.", keys: ["id", "enabled", "name", "prompt", "model", "schedule"], route: a => "/core/tasks/" + id(a.id), method: "PATCH" },
  delete_task: { description: "Delete a scheduled task by id.", keys: ["id"], route: a => "/core/tasks/" + id(a.id), method: "DELETE" },
  delete_chat: { description: "Delete a saved chat by id. Read chats first; do not delete the current conversation.", keys: ["id"], route: a => "/core/chats/" + id(a.id), method: "DELETE" },
  developer_tools: { description: "Enable or disable Developer Tools (enabled boolean). Does not authorize their actions.", keys: ["enabled"], route: "/core/dev" },
  coding_tools: { description: "Enable or disable Koinos Code (enabled boolean). File/command approvals still happen in Koinos Code.", keys: ["enabled"], route: "/core/code-switch" },
});

const READS = Object.freeze({
  status: "App version, hardware and available modules",
  models: "Installed and installable models, aliases, package ids, download sizes, RAM needs, download progress and active engine",
  earnings: "KAI wallet balance, pending KAI and receipts for the open epoch, worker jobs and live contribution. No arbitrary historical KAI date range is available.",
  wallet: "KOIN, VHP and mana balances at the current wallet address; use earnings for KAI",
  node: "Blockchain node health, sync, production and KOIN rewards for 24h/7d/30d",
  rewards: "Automatic node reward-return configuration, pending returns and history",
  crypto: "ETH, USDT and vKOIN funding balances",
  settings: "Privacy mode, node-view and developer/coding feature switches",
  network: "Network capacity and availability",
  documents: "List app documents, or read one using id",
  chats: "List saved chats, or read one using id",
  tasks: "Scheduled prompts and their status",
  connections: "Connected tool servers and email/calendar connection status (no credentials)",
  account: "Account sign-in/link status (no credentials or sign-in codes)",
  voice: "Installed voice engines and available natural voices",
});

function registerAppTools(registry, { request, privacyMode }) {
  const localOnly = () => privacyMode() === "local-only";
  const external = () => { if (localOnly()) throw new Error("Privacy is Local-Only. Enable internet in the app's Privacy settings to read live network data."); };
  const rpc = async (channel, payload, context) => { external(); return (await request("/core/koinos/rpc", "POST", { channel, payload }, context)).data; };
  const get = (path, context) => request(path, "GET", undefined, context);
  registry.register({
    name: "app_capabilities", egress: false, sensitive: false,
    description: "Discover everything KAI can read or do in the app, including downloads, earning, node controls, documents, schedules and settings. Use this before app_action to get exact arguments.", params: { action: "optional exact action name to get its full details" },
    handler: ({ action } = {}) => ({ reads: Object.keys(READS), actions: Object.fromEntries(Object.entries(ACTIONS).filter(([name]) => !action || name === action).map(([name, a]) => [name, action ? { description: a.description, arguments: a.keys, available: !a.egress || !localOnly() } : a.keys])),
      instructions: "Every action needs approval. Call app_capabilities again with action for its full details before executing it.",
      ...(action ? { handoffs: "Wallet/financial/password/setup/host coding workflows use app_open and their existing forms." } : {
      handoffs: { wallet: "Use app_open koinos-wallet for send, create, restore, unlock, backup or remove wallet. Enter passwords/keys ONLY in the existing wallet form, never in chat.",
        funding: "Use app_open koinos-fund for buying, deposits, bridges and swaps; koinos-burn for burning and koinos-returns for automatic financial actions.",
        setup: "Use app_open koinos-node for Docker/WSL setup, quick sync and data moves.",
        tools: "Existing connected MCP, memory, email, calendar and workspace tools are available through the same registry and their own confirmations. Connect new services in Tools.",
        code: "Open code for project files, shell commands, GitHub and coding runs with existing approval cards.",
        api: "Open api for API keys and remote-access setup; settings for account sign-in and updates." } }) }),
  });
  registry.register({
    name: "app_read", egress: false, sensitive: false,
    description: "Read current app facts: wallet coin balance, KAI earnings, installed/installable models, node status/rewards, settings, network, documents, chats, tasks, connections, account, voice. Always read before answering app-state questions.",
    params: { subject: Object.keys(READS).join(" | "), id: "optional document/chat id", query: "optional model-name filter" },
    handler: async (args, context) => {
      const { subject, id: item, query } = fields(args, ["subject", "id", "query"]);
      if (!Object.hasOwn(READS, subject)) throw new Error("Unknown app subject. Use app_capabilities.");
      let data;
      if (subject === "status") data = pick(await get("/core/health", context), ["version", "channel", "productName", "hardware", "modules"]);
      if (subject === "models") {
        const j = await get("/core/models", context);
        const all = (j.aliases || []).filter(a => !query || JSON.stringify(a).toLowerCase().includes(String(query).toLowerCase()));
        data = { models: all.slice(0, 16), total: all.length, truncated: all.length > 16, next: "Use query to narrow a longer catalog", ...pick(j, ["runtime", "download", "ensure", "storage"]) };
      }
      if (subject === "earnings") {
        external(); // /core/earn may poll the scheduler, even when the worker is stopped.
        data = pick(await get("/core/earn", context), ["wallet", "worker", "guard", "earnings", "producerReport"]);
        data.units = "earnings.kai and pendingKai are KAI, not KOIN. Pending is the open earning epoch, not a guaranteed daily total. Never infer unavailable historical totals.";
      }
      if (subject === "wallet") {
        const j = await rpc("chain:balances", {}, context);
        data = { address: j.address, balances: j.formatted || null, error: j.error, units: "Formatted decimal KOIN, VHP and mana. For KAI use earnings." };
      }
      if (subject === "node") {
        const j = await rpc("dashboard:summary", {}, context);
        data = pick(j, ["network", "wallet", "node", "sync", "price", "returns"]);
        data.balances = j.balances?.error ? j.balances : j.balances ? { ...pick(j.balances, ["stale", "ageMs"]), ...Object.fromEntries(["koin", "vhp", "mana"].filter(k => j.balances[k] != null).map(k => [k, decimal(j.balances[k])])) } : null;
        data.rewards = { ...pick(j.stats, ["available", "error", "syncing"]), windows: j.stats?.windows ? Object.fromEntries(Object.entries(j.stats.windows).map(([k, v]) => [k, k === "daysTracked" ? v : decimal(v)])) : null };
        data.units = "Balances and reward windows are formatted decimal KOIN/VHP/mana. Node rewards are KOIN, not KAI. Preserve unavailable/stale/syncing indicators.";
      }
      if (subject === "rewards") data = { ...(await rpc("rewards:status", {}, context)), units: "Amount fields ending Sats use 1e8 units per KOIN; fields ending Koin are decimal KOIN." };
      if (subject === "crypto") data = await rpc("fund:cryptoBalances", {}, context);
      if (subject === "settings") {
        data = {};
        for (const [key, path] of Object.entries({ privacy: "/core/network", node: "/core/koinos", developer: "/core/dev", coding: "/core/code-switch" })) {
          const j = await get(path, context); data[key] = pick(j, ["privacyMode", "enabled", "chainReadsAllowed"]);
        }
      }
      if (subject === "network") { external(); data = await get("/core/network/status", context); }
      if (subject === "documents" || subject === "chats") data = await get("/core/" + (subject === "documents" ? "docs" : "chats") + (item ? "/" + id(item) : ""), context);
      if (subject === "tasks") data = await get("/core/tasks", context);
      if (subject === "connections") {
        const m = await get("/core/mcp", context);
        data = { servers: (m.servers || []).map(s => pick(s, ["id", "name", "connected", "tools", "error"])), email: pick(await get("/core/email", context), ["configured", "localOnly"]), calendar: pick(await get("/core/calendar", context), ["configured", "localOnly"]) };
      }
      if (subject === "account") { external(); data = pick(await get("/core/account", context), ["signedIn", "offline", "sessionRejected", "thisWalletLinked", "error"]); }
      if (subject === "voice") data = { input: await get("/core/voice", context), output: await get("/core/speech", context) };
      return { checkedAt: new Date().toISOString(), subject, data };
    },
  });
  registry.register({
    name: "app_action", egress: false, sensitive: true,
    description: "Change something within the app after explicit approval. First call app_capabilities for action names and arguments. Handles model downloads/removal, earning, node lifecycle, privacy, docs and scheduled tasks. Financial/password/setup workflows open their existing app screen instead.",
    params: { action: "exact action from app_capabilities", args: "object with the action's documented arguments" },
    handler: async (input, context) => {
      fields(input, ["action", "args"]);
      const a = Object.hasOwn(ACTIONS, input.action) && ACTIONS[input.action];
      if (!a) throw new Error("Unknown app action. Use app_capabilities or open the relevant app screen.");
      const args = fields(input.args || {}, a.keys);
      for (const k of ["enabled", "produce", "on"]) if (a.keys.includes(k) && typeof args[k] !== "boolean" && !(input.action === "update_task" && args[k] === undefined)) throw new Error(k + " must be true or false");
      if (a.egress) external();
      const result = a.channel ? await rpc(a.channel, args, context) : await request(typeof a.route === "function" ? a.route(args) : a.route, a.method || "POST", args, context);
      return { action: input.action, result, note: input.action === "download_model" ? "Download/load started, not completed. Read models to check progress." : "App action returned; use current status to verify long-running work." };
    },
  });
}

function appRequest(gateway) {
  return async (path, method, body, { signal } = {}) => {
    const r = await fetch(`http://${gateway.host === "::1" ? "[::1]" : "127.0.0.1"}:${gateway.port}${path}`, {
      method, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
      headers: { "content-type": "application/json", ...(gateway.coreToken ? { authorization: `Bearer ${gateway.coreToken}` } : {}) },
      ...(method !== "GET" && body ? { body: JSON.stringify(body) } : {}),
    });
    const j = await r.json();
    if (!r.ok || j.ok === false) throw new Error(j.error?.message || j.error || `App request failed (${r.status})`);
    return j;
  };
}
module.exports = { registerAppTools, appRequest, ACTIONS, READS };
