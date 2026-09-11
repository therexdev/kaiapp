"use strict";
// Recalled values are anonymous test tokens, not personal facts or names.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const Agents = require("../../ui/agents"), Mascot = require("../../ui/mascot-tools");
const { MemoryStore } = require("../lib/memory");
const source = name => fs.readFileSync(path.join(__dirname, "../../ui", name), "utf8");

test("shared intent routing separates recall/chat from real tasks and preserves follow-ups", () => {
  const cases = [
    ["What is my daughters name?", "recall"], ["What’s my daughter’s name?", "recall"],
    ["Do you remember my dog's name?", "recall"], ["What is my current address?", "recall"],
    ["Search your memory for my daughter", "recall"], ["Remember that this is a synthetic test", "memory-write"],
    ["Hello KAI", "chat"], ["Tell me something interesting", "chat"], ["Explain photosynthesis", "chat"],
    ["I'm sad today", "chat"], ["Write a poem about tomorrow's weather", "chat"],
    ["How does Google Sheets work?", "chat"], ["How do I send a Slack message?", "chat"],
    ["Look up dentists in Omaha and put them in a Google sheet", "connected"],
    ["Create a document in Google Drive", "connected"], ["Send a message in Discord", "connected"],
    ["Run my workflow", "workflow"], ["Stop earning", "app"], ["How much KAI have I earned?", "app"],
    ["What is my wallet balance?", "app"], ["Weather tomorrow in Omaha?", "web"],
    ["Read https://example.com", "web"], ["Read my screen", "tools"], ["Play the movie on my screen", "tools"],
    ["Create a file in my workspace", "tools"], ["Turn off the microphone", "tools"],
    ["Find dentists in Omaha", "web"], ["Tell me about my files", "tools"],
  ];
  for (const [q, lane] of cases) assert.equal(Agents.routeTurn(q).lane, lane, q);
  assert.equal(Agents.routeTurn("What about pending?", { history: "user: How much KAI have I earned?\nassistant: 42.75 KAI" }).lane, "app");
  assert.equal(Agents.routeTurn("Yes, go ahead", { history: "user: Create a Google Sheet\nassistant: What title?" }).lane, "connected");
  assert.equal(Agents.routeTurn("What is my daughters name?", { mode: "agent", history: "Create a Google Sheet" }).lane, "recall");
});

test("both runtimes bypass catalog, planner, writes and web for personal recall", async () => {
  for (const question of ["What is my daughters name?", "What is my current address?", "Hello KAI"]) {
    let catalogs = 0, plans = 0, finish = 0;
    const json = async () => { catalogs++; throw new Error("must not run"); };
    json.finish = async () => finish++;
    const ask = async () => { plans++; throw new Error("must not run"); };
    const main = await Agents.makeRuntime({ json, askModelOnce: ask }).runAgent(question, "local");
    const mascot = await Mascot.run({ question, json, askModel: ask });
    assert.equal(catalogs, 0); assert.equal(plans, 0); assert.equal(finish, 2);
    assert.equal(main.citations.length + mascot.citations.length, 0);
    if (question.startsWith("What")) assert.match(main.context, /never guess/);
  }
});

test("memory matches possessive family queries, caches its lexical index and invalidates edits", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-recall-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new MemoryStore(dir), matching = store.add("This synthetic fixture contains the word daughter.");
  store.add("Unrelated synthetic fixture");
  for (const query of ["What is my daughters name?", "What is my daughter’s name?", "What is my daughter's name?"]) {
    assert.equal(store.search(query)[0].id, matching.id);
  }
  const index = store._index; store.search("daughter"); assert.equal(store._index, index);
  store.remove(matching.id); assert.equal(store._index, null); assert.deepEqual(store.search("daughter"), []);
  store.add("This fixture contains the possessive daughter's."); assert.equal(store.search("daughters").length, 1);
  store.clear(); assert.deepEqual(store.search("daughter"), []);
});

function clientFixture(overrides = {}) {
  const calls = [], bridge = {
    context: async (model, query) => { calls.push(["context", query]); return { ok: true, result: { eligible: model === "local", context: query === null ? "" : "SYNTHETIC_BRAIN_CONTEXT" } }; },
    tools: async () => ({ ok: true, result: [{ name: "connected_find", conversationAction: true }, { name: "brain_search" }] }),
    session: async (op, args) => { calls.push(["session", op]); return { ok: true, result: { id: args.id || "s1", actions: [] } }; },
    tool: async (name, args, model, id) => { calls.push(["tool", name, id]); return { ok: true, result: "fixture" }; },
    cancel: async () => { calls.push(["cancel"]); }, ...overrides,
  };
  const node = () => ({ value: "", classList: { add() {}, remove() {} }, append() {}, appendChild() {}, before() {}, remove() {}, addEventListener() {} });
  const nodes = new Map(), document = { createElement: node, getElementById: id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); } };
  const window = { kaiCompanionBridge: bridge };
  const fetch = async (url, init = {}) => {
    init.signal?.throwIfAborted(); calls.push(["fetch", url, init.body && JSON.parse(init.body)]);
    if (url.startsWith("/core/memory?")) return Response.json({ memories: [{ text: "SYNTHETIC_LEGACY_CONTEXT" }] });
    if (url === "/core/chat/completions") return new Response('data: {"choices":[{"delta":{"content":"Synthetic fixture response."}}]}\n\ndata: [DONE]\n\n');
    throw new Error("unexpected fetch " + url);
  };
  const env = vm.createContext({ window, document, fetch, DOMException, AbortController, Response, TextDecoder, URL, setInterval, clearInterval });
  vm.runInContext(source("companion-client.js"), env); vm.runInContext(source("desktop-providers.js"), env);
  return { env, window, calls, document, node };
}

test("final enrichment retrieves memory once; planning checks eligibility without retrieval", async () => {
  const f = clientFixture(), body = { model: "local", messages: [{ role: "user", content: "What is my daughters name?" }] };
  await f.window.KaiCompanionClient.enrich({ ...body, stream: false });
  assert.deepEqual(f.calls, [["context", null]]);
  const out = await f.window.KaiCompanionClient.enrich({ ...body, stream: true });
  assert.equal(f.calls.filter(c => c[0] === "fetch").length, 1); assert.equal(out.kai_private_desktop, true);
  assert.match(out.messages[0].content, /SYNTHETIC_BRAIN_CONTEXT/);
  assert.match(out.messages[0].content, /SYNTHETIC_LEGACY_CONTEXT/); assert.equal(body.messages.length, 1);
  f.calls.length = 0;
  const network = await f.window.KaiCompanionClient.enrich({ ...body, model: "koinos-network", stream: true });
  assert.equal(network.messages.length, 1); assert.equal(f.calls.filter(c => c[0] === "fetch").length, 0);
});

test("connected session is lazy, closes once and removes its cancellation listener", async () => {
  const f = clientFixture(), abort = new AbortController();
  const json = f.window.KaiCompanionClient.toolJSON("local", async () => ({ tools: [] }), abort.signal, { question: "Create a Sheet" });
  await json("/core/tools"); assert.equal(f.calls.length, 0, "catalog alone starts no session");
  await json("/core/tools/call", { body: JSON.stringify({ name: "brain_search", args: {} }) });
  assert.equal(f.calls.filter(c => c[0] === "session").length, 0);
  await json("/core/tools/call", { body: JSON.stringify({ name: "connected_find", args: {} }) });
  assert.equal(f.calls.filter(c => c[1] === "begin").length, 1);
  await json.finish(); await json.finish(); abort.abort();
  assert.equal(f.calls.filter(c => c[1] === "finish").length, 1); assert.equal(f.calls.filter(c => c[0] === "cancel").length, 0);
});

function mainHarness(overrides) {
  const f = clientFixture(overrides), app = source("app.js");
  const state = { history: [], chatting: false, attachment: null, webSearch: true, chatId: "recall-test" };
  f.document.getElementById("input").value = "What is my daughters name?";
  const bubbles = [];
  Object.assign(f.env, { state, KaiAgents: Agents, KaiProviders: f.window.KaiProviders,
    $: id => f.document.getElementById(id), composedChatModel: () => "local", getChatMode: () => "chat", personaText: () => "You are KAI",
    addMsg: (role, text) => { const b = f.node(); b.textContent = text; bubbles.push(b); return b; },
    mdToHtml: text => text, attachMsgActions() {}, saveCurrentChat() {}, toWire: messages => messages, performance,
  });
  vm.runInContext(app.slice(app.indexOf("async function send(replayText)"), app.indexOf("/** Parse an OpenAI SSE stream")), f.env);
  vm.runInContext(app.slice(app.indexOf("async function* sseDeltas(body)"), app.indexOf("async function* sseDeltas(body)") + functionLength(app.slice(app.indexOf("async function* sseDeltas(body)")))), f.env);
  return { ...f, state };
}

test("main Chat send with desktop connected and globe on performs one completion and no tool/web/session calls", async () => {
  const f = mainHarness(), { state } = f;
  await f.env.send();
  const requests = f.calls.filter(c => c[0] === "fetch");
  assert.equal(requests.length, 2); assert.ok(requests[0][1].startsWith("/core/memory?"));
  assert.equal(requests[1][1], "/core/chat/completions"); assert.equal(requests[1][2].stream, true);
  assert.match(JSON.stringify(requests[1][2].messages), /SYNTHETIC_BRAIN_CONTEXT/);
  assert.match(JSON.stringify(requests[1][2].messages), /SYNTHETIC_LEGACY_CONTEXT/);
  assert.equal(f.calls.filter(c => ["tool", "session"].includes(c[0])).length, 0);
  assert.equal(state.history.at(-1).content, "Synthetic fixture response."); assert.equal(state.chatting, false);
});

test("Stop during recall prevents final inference and still restores main Chat controls", async () => {
  const f = mainHarness({ context: async () => {
    f.state.abort.abort();
    return { ok: true, result: { eligible: true, context: "Private fact" } };
  } });
  await f.env.send();
  assert.equal(f.calls.filter(c => c[0] === "fetch").length, 0);
  assert.equal(f.state.chatting, false); assert.equal(f.state.abort, null);
  assert.equal(f.document.getElementById("btn-stop").hidden, true);
});

test("main Chat respects a disabled globe and does not claim a live lookup", async () => {
  const f = mainHarness(); f.state.webSearch = false;
  f.document.getElementById("input").value = "What is the weather tomorrow in Omaha?";
  await f.env.send();
  assert.equal(f.calls.filter(c => c[0] === "fetch" && /search|fetch$/.test(c[1])).length, 0);
  const body = f.calls.find(c => c[1] === "/core/chat/completions")[2];
  assert.match(JSON.stringify(body.messages), /web toggle is off/);
});

test("Stop during tool planning does not dispatch another tool and always finishes the session", async () => {
  const abort = new AbortController(); let calls = 0, finished = 0;
  const json = async url => { if (url === "/core/tools") return { tools: [{ name: "web_search" }] }; calls++; return { ok: true }; };
  json.finish = async () => finished++;
  const rt = Agents.makeRuntime({ json, signal: abort.signal, askModelOnce: async () => {
    abort.abort(); return '{"tool":"web_search","args":{"query":"private"}}';
  } });
  await assert.rejects(rt.runAgent("Search the web", "local"), e => e.name === "AbortError");
  assert.equal(calls, 0); assert.equal(finished, 1);
});

// This function is immediately followed by a top-level declaration/comment.
// Use the real parser from app.js, with no rewritten SSE logic in the test.
function functionLength(text) { const next = text.indexOf("\n}\n"); assert.ok(next >= 0); return next + 3; }

test("agent stops malformed output and repeated failures; unrequested memory writes cannot dispatch", async () => {
  for (const output of ["bad format", '{"tool":"memory_save","args":{"text":"invented"}}']) {
    let plans = 0, calls = 0;
    const json = async url => { if (url === "/core/tools") return { tools: [{ name: "web_search" }, { name: "memory_save" }] }; calls++; return { ok: true }; };
    await Agents.makeRuntime({ json, askModelOnce: async () => { plans++; return output; } }).runAgent("Search the web for Omaha", "local");
    assert.equal(plans, 2); assert.equal(calls, 0);
  }
  let plans = 0, calls = 0;
  const json = async url => { if (url === "/core/tools") return { tools: [{ name: "web_search" }] }; calls++; return { ok: false, error: "offline" }; };
  await Agents.makeRuntime({ json, askModelOnce: async () => JSON.stringify({ tool: "web_search", args: { query: "q" + ++plans } }) }).runAgent("Search the web for Omaha", "local");
  assert.equal(plans, 2); assert.equal(calls, 2);
  assert.equal(Agents.callKey("read", { a: 1, b: 2 }), Agents.callKey("read", { b: 2, a: 1 }));
});

test("bounded context keeps latest action status after long research results", () => {
  const text = Agents.observationContext([{ tool: "connected_research", args: {}, result: "x".repeat(9000) }, { tool: "connected_call", args: {}, result: '{"spreadsheetId":"real-id","status":"created; rows not written"}' }], 1600);
  assert.ok(text.length <= 1600); assert.match(text, /real-id/); assert.match(text, /rows not written/);
});
