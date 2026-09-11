"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { ToolRegistry } = require("../lib/tools");
const { registerAppTools, appRequest, ACTIONS } = require("../lib/app-tools");
const { Gateway } = require("../lib/gateway");
const { run } = require("../../ui/mascot-tools");
const { messagesFor } = require("../../ui/mascot-client");
const navigation = require("../../ui/app-navigation");
const { createToolApproval } = require("../../electron/tool-approval");

function fixture() {
  let mode = "local-first";
  const calls = [], registry = new ToolRegistry({ privacyMode: () => mode });
  const responses = {
    "/core/earn": { ok: true, wallet: { address: "test-address" }, worker: { running: true, jobsDone: 9 }, earnings: { kai: "42.75", pendingKai: "1.25" }, password: "MUST_NOT_LEAK" },
    "/core/models": { aliases: [{ alias: "installed", status: "ready", package: "pkg1" }, { alias: "downloadable", status: "missing", package: "pkg2", sizeBytes: 2000000000 }], runtime: { activeAlias: "installed" } },
  };
  registerAppTools(registry, { privacyMode: () => mode, request: async (path, method, body, context) => {
    calls.push({ path, method, body, context });
    if (path === "/core/koinos/rpc") {
      if (body.channel === "chain:balances") return { ok: true, data: { address: "test-address", koin: "123456789", formatted: { koin: "1.23456789", vhp: "2", mana: "3" } } };
      if (body.channel === "dashboard:summary") return { data: { node: { isRunning: true }, balances: { koin: "123456789", vhp: "200000000", mana: "300000000" }, stats: { available: true, windows: { last24h: "125000000", daysTracked: 2 } } } };
    }
    return responses[path] || { ok: true, started: true };
  } });
  return { registry, calls, responses, setMode: value => { mode = value; } };
}

test("App tools read real control-plane shapes, preserve money units and never expose wallet credentials", async () => {
  const f = fixture();
  const earnings = JSON.parse(await f.registry.call("app_read", { subject: "earnings" }));
  assert.equal(earnings.data.earnings.kai, "42.75"); assert.equal(earnings.data.earnings.pendingKai, "1.25");
  assert.match(earnings.data.units, /open earning epoch/); assert.ok(!JSON.stringify(earnings).includes("MUST_NOT_LEAK"));
  const wallet = JSON.parse(await f.registry.call("app_read", { subject: "wallet" }));
  assert.equal(wallet.data.balances.koin, "1.23456789");
  const node = JSON.parse(await f.registry.call("app_read", { subject: "node" }));
  assert.equal(node.data.rewards.windows.last24h, "1.25"); assert.equal(node.data.rewards.windows.daysTracked, 2);
  const models = JSON.parse(await f.registry.call("app_read", { subject: "models" }));
  assert.deepEqual(models.data.models.map(x => x.status), ["ready", "missing"]);
  f.responses["/core/earn"].earnings = { error: "Balance temporarily unavailable" };
  assert.match(await f.registry.call("app_read", { subject: "earnings" }), /temporarily unavailable/);
});

test("Every app mutation requires confirmation, rejects arbitrary paths/channels and keeps network privacy", async () => {
  const f = fixture();
  for (const action of Object.keys(ACTIONS)) await assert.rejects(f.registry.call("app_action", { action, args: {} }), e => e.needsConfirmation);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.registry.call("app_action", { action: "wallet:revealWif", args: {} }, { confirmed: true }), /Unknown app action/);
  await assert.rejects(f.registry.call("app_action", { action: "start_node", args: { produce: false, channel: "wallet:remove" } }, { confirmed: true }), /Unsupported argument/);
  await assert.rejects(f.registry.call("app_read", { subject: "chats", id: "../earn/wallet/reveal" }), /valid item id/);
  await assert.rejects(f.registry.call("app_action", { action: "remove_model", args: { id: ".." } }, { confirmed: true }), /valid item id/);
  f.setMode("local-only");
  for (const subject of ["earnings", "wallet", "node", "network", "crypto", "account"]) await assert.rejects(f.registry.call("app_read", { subject }), /Local-Only/);
  await assert.rejects(f.registry.call("app_action", { action: "download_model", args: { alias: "downloadable" } }, { confirmed: true }), /Local-Only/);
  assert.equal(f.calls.length, 0);
  await f.registry.call("app_read", { subject: "models" });
  assert.equal(f.calls.length, 1);
  f.setMode("local-first");
  const out = JSON.parse(await f.registry.call("app_action", { action: "download_model", args: { alias: "downloadable" } }, { confirmed: true }));
  assert.match(out.note, /not completed/); assert.equal(f.calls.at(-1).path, "/core/models/ensure");
});

test("App adapters use the actual authenticated gateway routes and their model validation", async t => {
  const registry = new ToolRegistry({ privacyMode: () => "local-first" });
  let starts = 0;
  const gateway = new Gateway({ port: 0, tools: registry,
    network: { status: () => ({ privacyMode: "local-first" }) },
    models: { resolveAlias: alias => { if (alias !== "valid") throw new Error("Unknown model"); return {}; }, aliases: () => [], storageUsage: () => ({}), downloadProgress: () => null },
    runtime: { preflight: async () => {}, ensure: async () => { starts++; }, status: () => ({}) },
  });
  gateway.coreToken = "fixture-local-token";
  registerAppTools(registry, { request: appRequest(gateway), privacyMode: () => "local-first" });
  await gateway.listen(); t.after(() => gateway.close());
  await assert.rejects(registry.call("app_action", { action: "download_model", args: { alias: "invalid" } }, { confirmed: true }), /Unknown model/);
  assert.equal(starts, 0);
  await registry.call("app_action", { action: "download_model", args: { alias: "valid" } }, { confirmed: true });
  assert.equal(starts, 1);
});

function runtime(f, overrides = {}) {
  const plans = [], actions = [], confirmed = [], observations = [];
  const config = { question: "How much KAI have I earned?", history: [{ role: "user", content: "How much KAI have I earned?" }],
    json: async (path, options) => {
      if (path === "/core/tools") return { tools: f.registry.list() };
      const body = JSON.parse(options.body); actions.push(body);
      try { return { ok: true, result: await f.registry.call(body.name, body.args, { confirmed: body.confirmed, signal: options.signal }) }; }
      catch (e) { return { ok: false, error: e.message, needsConfirmation: e.needsConfirmation }; }
    },
    askModel: async messages => { plans.push(messages); return JSON.stringify({ answer: true }); },
    confirm: async (name, args) => { confirmed.push({ name, args }); return true; },
    onObservation: o => observations.push(o), ...overrides,
  };
  return { config, plans, actions, confirmed, observations };
}

test("Companion grounds earnings automatically, uses fresh tools for follow-ups and budgets the model context", async () => {
  const f = fixture(), r = runtime(f);
  const out = await run(r.config);
  assert.equal(r.actions[0].name, "app_read"); assert.equal(r.actions[0].args.subject, "earnings");
  assert.match(out.context, /42.75/);
  const messages = messagesFor(r.config.history, 4096, out.context);
  assert.ok(!messages[0].content.includes("42.75"), "tool data must not become system instructions");
  assert.ok(messages.some(m => m.role === "user" && m.content.includes("42.75")));
  assert.equal(messages.at(-1).content, r.config.question);
  assert.ok(messages.reduce((n, m) => n + m.content.length, 0) < 8300);
  const followup = runtime(f, { question: "What about pending?", history: [{ role: "user", content: "How much KAI have I earned?" }, { role: "assistant", content: "42.75 KAI" }, { role: "user", content: "What about pending?" }],
    askModel: async messages => { assert.match(messages[1].content, /42.75 KAI/); return JSON.stringify(followup.actions.length ? { answer: true } : { tool: "app_read", args: { subject: "earnings" } }); } });
  await run(followup.config); assert.equal(followup.actions.length, 1);
});

test("Companion shares web and connected tools, cites real URLs and asks for missing weather location", async () => {
  const f = fixture();
  f.registry.register({ name: "web_search", description: "Search the web", params: { query: "terms" }, egress: true, sensitive: false, handler: () => "Tomorrow in Paris: 22 C. https://weather.example/forecast" });
  const activities = [];
  const r = runtime(f, { question: "Weather tomorrow in Paris?", status: (label, detail) => activities.push({ label, detail }), askModel: async messages => {
    assert.match(messages[0].content, /ask for the city/); assert.match(messages[0].content, /Local date:/);
    return JSON.stringify(r.actions.length ? { answer: true } : { tool: "web_search", args: { query: "Paris tomorrow forecast" } });
  } });
  const out = await run(r.config); assert.equal(out.citations[0].url, "https://weather.example/forecast"); assert.match(out.context, /22 C/);
  assert.ok(activities.some(s => s.detail?.activity === "searching"));
  assert.equal(activities.at(-1).label, "");
  assert.equal(activities.at(-1).detail, undefined, "Finished tools clear the activity");
  f.setMode("local-only"); const offline = await run(runtime(f, { question: "Weather tomorrow?" }).config);
  assert.match(offline.context, /Web tools are disabled/); assert.match(offline.context, /never invent a forecast/);
});

test("Explicit connected requests discover enabled accounts and correct a small model's generic refusal", async () => {
  const calls = [], outputs = [
    JSON.stringify({ answer: true }),
    JSON.stringify({ tool: "connected_actions", args: { connectionId: "drive", query: "create folder" } }),
    JSON.stringify({ tool: "connected_describe", args: { connectionId: "drive", operationId: "create_folder" } }),
    JSON.stringify({ tool: "connected_call", args: { connectionId: "drive", operationId: "create_folder", arguments: { name: "Mike" } } }),
    JSON.stringify({ answer: true }),
  ];
  const tools = ["connected_find", "connected_actions", "connected_describe", "connected_call"].map(name => ({ name, description: name, params: {}, conversationAction: true }));
  const result = await run({ question: "Create a folder called Mike on my Google Drive", contextSize: 4096,
    json: async (path, options) => {
      if (path === "/core/tools") return { tools };
      const call = JSON.parse(options.body); calls.push(call);
      if (call.name === "connected_find") return { ok: true, result: JSON.stringify({ accounts: [{ id: "drive", name: "Google Drive", useInChat: true, selectedActions: 1, enabled: true }] }) };
      if (call.name === "connected_actions") return { ok: true, result: JSON.stringify([{ id: "create_folder", name: "Create folder", readOnly: false }]) };
      if (call.name === "connected_describe") return {
        ok: true,
        result: JSON.stringify({
          action: {
            id: "create_folder",
            schema: { properties: { name: { type: "string" } } },
          },
        }),
      };
      return { ok: true, result: JSON.stringify({ status: "returned", data: { id: "folder-1", name: "Mike" } }) };
    },
    askModel: async messages => { assert.match(messages[0].content, /attended access through the connected_/i); return outputs.shift(); },
  });
  assert.deepEqual(calls.map(c => c.name), ["connected_find", "connected_actions", "connected_describe", "connected_call"]);
  assert.match(result.context, /folder-1/);
});

test("Explicit connected requests reject unrelated Brain routing and never invent completion", async () => {
  const calls = [], outputs = [
    JSON.stringify({ tool: "brain_goals", args: { operation: "list" } }),
    JSON.stringify({ tool: "connected_actions", args: { connectionId: "drive", query: "create folder" } }),
    JSON.stringify({ answer: true }),
    JSON.stringify({ answer: true }),
    JSON.stringify({ answer: true }),
    JSON.stringify({ answer: true }),
    JSON.stringify({ answer: true }),
  ];
  const tools = ["connected_find", "connected_actions", "connected_describe", "connected_call", "brain_goals"].map(name => ({ name, description: name, params: {}, conversationAction: true }));
  const result = await run({ question: "Make a folder on my Google Drive called Dentist", contextSize: 4096,
    json: async (path, options) => {
      if (path === "/core/tools") return { tools };
      const call = JSON.parse(options.body); calls.push(call);
      if (call.name === "connected_find") return { ok: true, result: JSON.stringify({ accounts: [{ id: "drive", name: "Google Drive", useInChat: true, selectedActions: 1, enabled: true }] }) };
      if (call.name === "connected_actions") return { ok: true, result: JSON.stringify([{ id: "create_folder", name: "Create folder", readOnly: false }]) };
      throw new Error("No unrelated tool should execute");
    },
    askModel: async messages => {
      assert.doesNotMatch(messages[0].content, /brain_goals/);
      return outputs.shift();
    },
  });
  assert.deepEqual(calls.map(c => c.name), ["connected_find", "connected_actions"]);
  assert.equal(result.connectedIncomplete, true);
  assert.match(result.context, /DID NOT RUN/);
  assert.doesNotMatch(result.trace.map(x => x.tool).join(" "), /brain_goals/);
});

test("Research then put results in a Google Sheet stays in the connected workflow", async () => {
  const question = "Can you look up some dentists in Omaha, Nebraska and put them in a Google sheet for me?";
  const calls = [], outputs = [
    JSON.stringify({ tool: "connected_research", args: { operation: "businesses", category: "dentists", location: "Omaha, Nebraska", limit: 12 } }),
    JSON.stringify({ tool: "connected_actions", args: { connectionId: "sheets", query: "create spreadsheet rows" } }),
    JSON.stringify({ tool: "connected_describe", args: { connectionId: "sheets", operationId: "create_sheet" } }),
    JSON.stringify({ tool: "connected_call", args: { connectionId: "sheets", operationId: "create_sheet", arguments: { title: "Omaha Dentists" } } }),
    JSON.stringify({ tool: "connected_describe", args: { connectionId: "sheets", operationId: "write_rows" } }),
    JSON.stringify({ tool: "connected_call", args: { connectionId: "sheets", operationId: "write_rows", arguments: { spreadsheet_id: "sheet-1", values: [["Name", "Address", "Phone", "Website", "Source"], ["Dundee Dental", "5002 Underwood Ave, Omaha, NE", "402-555-0100", "https://dundee.example", "OpenStreetMap"]] } } }),
    JSON.stringify({ answer: true }),
  ];
  const tools = ["connected_find", "connected_actions", "connected_describe", "connected_call", "connected_research", "brain_goals", "web_search"].map(name => ({ name, description: name, params: {}, conversationAction: name.startsWith("connected_") }));
  const result = await run({ question, contextSize: 4096,
    json: async (path, options) => {
      if (path === "/core/tools") return { tools };
      const call = JSON.parse(options.body); calls.push(call);
      if (call.name === "connected_find") return { ok: true, result: JSON.stringify({ accounts: [{ id: "sheets", name: "Google Sheets", useInChat: true, selectedActions: 1, enabled: true }] }) };
      if (call.name === "connected_research") return { ok: true, result: JSON.stringify({ columns: ["Name", "Address", "Phone", "Website", "Source"], rows: [{ name: "Dundee Dental", address: "5002 Underwood Ave, Omaha, NE", phone: "402-555-0100", website: "https://dundee.example", source: "OpenStreetMap" }] }) };
      if (call.name === "connected_actions") return { ok: true, result: JSON.stringify([{ id: "create_sheet", name: "Create spreadsheet", readOnly: false }, { id: "write_rows", name: "Write rows", readOnly: false }]) };
      if (call.name === "connected_describe") return { ok: true, result: JSON.stringify({ action: { id: call.args.operationId, schema: { type: "object" } } }) };
      return { ok: true, result: JSON.stringify({ status: "returned", data: call.args.operationId === "create_sheet" ? { id: "sheet-1", title: "Omaha Dentists" } : { updatedRows: 2 }, links: ["https://docs.google.com/spreadsheets/d/sheet-1"] }) };
    },
    askModel: async messages => {
      assert.match(messages[0].content, /use connected_research/i);
      assert.doesNotMatch(messages[0].content, /brain_goals|web_search:/i);
      return outputs.shift();
    },
  });
  assert.deepEqual(calls.map(c => c.name), ["connected_find", "connected_research", "connected_actions", "connected_describe", "connected_call", "connected_describe", "connected_call"]);
  assert.equal(result.connectedIncomplete, false);
  assert.match(result.context, /sheet-1/);
});

test("Ordinary requests do not inherit the connected planner's long loop", async () => {
  let plans = 0;
  const tools = [{ name: "connected_find", description: "connected_find", params: {}, conversationAction: true }, { name: "web_search", description: "web_search", params: {} }];
  await run({ question: "Tell me something interesting", contextSize: 4096,
    json: async path => path === "/core/tools" ? { tools } : { ok: true, result: "unused" },
    askModel: async () => { plans++; return JSON.stringify({ tool: "web_search", args: { query: "topic-" + plans } }); },
  });
  assert.equal(plans, 6);
});

test("Declined tools and cancelled approvals never mutate or retry, even with model-supplied confirmed", async () => {
  const f = fixture();
  const r = runtime(f, { question: "Stop earning", confirm: async () => false, askModel: async () => JSON.stringify({ tool: "app_action", args: { action: "stop_earning", args: {}, confirmed: true } }) });
  const out = await run(r.config);
  assert.equal(f.calls.length, 0); assert.equal(r.actions.length, 0); assert.match(out.context, /User declined/);
  const abort = new AbortController();
  const c = runtime(f, { question: "Stop earning", signal: abort.signal, confirm: async () => { abort.abort(); return true; }, askModel: async () => JSON.stringify({ tool: "app_action", args: { action: "stop_earning", args: {} } }) });
  await assert.rejects(run(c.config), e => e.name === "AbortError"); assert.equal(f.calls.length, 0);
});

test("Confirmed app actions execute once, keep pending receipts on interruption, and failed writes do not retry", async () => {
  const f = fixture(), r = runtime(f, { question: "Stop earning", askModel: async () => JSON.stringify({ tool: "app_action", args: { action: "stop_earning", args: {} } }) });
  await run(r.config); assert.equal(f.calls.length, 1); assert.equal(r.confirmed.length, 1);
  assert.equal(r.actions[0].confirmed, true); assert.match(r.observations[0].result, /Completion is unverified/);
  const abort = new AbortController(), c = runtime(f, { question: "Stop earning", signal: abort.signal,
    askModel: r.config.askModel, onObservation: o => { if (o.result.startsWith("Approved")) abort.abort(); } });
  await assert.rejects(run(c.config), e => e.name === "AbortError");
  assert.equal(f.calls.length, 1, "abort after approval but before submission must still prevent the write");
});

test("Native approvals show all arguments, default to Cancel and invalidate late clicks", async () => {
  let finish, shown;
  const approval = createToolApproval({ dialog: { showMessageBox: async (_window, spec) => { shown = spec; return new Promise(r => { finish = r; }); } } });
  const window = { isVisible: () => true, isDestroyed: () => false };
  const pending = approval.confirm(window, "app_action", { action: "stop_node", args: {} });
  assert.equal(shown.defaultId, 0); assert.match(shown.detail, /stop_node/);
  approval.cancel(); finish({ response: 1 }); assert.equal(await pending, false);
  await assert.rejects(approval.confirm(window, "app_action", { text: "x".repeat(21000) }), /too large/);
});

test("App navigation is limited to existing screens and recognizes direct natural requests", () => {
  assert.equal(navigation.request("Can you open up the application?"), "chat");
  assert.equal(navigation.request("Bring up the main application."), "chat");
  assert.equal(navigation.request("Open my wallet"), "koinos-wallet");
  assert.equal(navigation.valid("file:///secret"), false); assert.equal(navigation.valid("koinos-returns"), true);
  assert.equal(navigation.request('Explain "open the application"'), null);
});
