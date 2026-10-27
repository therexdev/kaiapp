"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), http = require("node:http"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { EventEmitter } = require("node:events");
const { publicSnapshot, readPublicNetworkOverview } = require("../lib/network-overview");
const sample = () => ({ ok: true, workersOnline: 2, queueDepth: 3, pendingJobs: 1,
  models: [{ model: "koinos-fast", providers: 2 }], workers: [
    { address: "1first…1234", models: ["koinos-fast"], busy: false, lastSeenSecs: 1 },
    { address: "1other…5678", models: ["koinos-fast"], busy: true, lastSeenSecs: 12 },
  ] });

test("public overview keeps reported presence separate from unknown credit qualification and receipt totals", () => {
  const overview = publicSnapshot(sample(), 1000);
  assert.equal(overview.providersOnline, 2); assert.equal(overview.readyProviders, null);
  assert.equal(overview.waitingRequests, 3); assert.equal(overview.activeJobs, 1);
  assert.equal(overview.completedToday, null); assert.equal(overview.activityAvailable, false);
  assert.equal(overview.models[0].freeEligible, null); assert.equal(overview.models[0].selectable, false);
  assert.equal(overview.providers[1].state, "busy"); assert.equal(overview.validUntil, 16000);
  const zero = { ok: true, workersOnline: 0, queueDepth: 0, pendingJobs: 0, models: [], workers: [] };
  assert.equal(publicSnapshot(zero, 1000).providersOnline, 0);
  for (const mutate of [s => delete s.queueDepth, s => s.workersOnline = "2", s => s.workers[0].busy = "yes", s => s.models.push(s.models[0])]) {
    const bad = sample(); mutate(bad); assert.throws(() => publicSnapshot(bad, 1000), /could not be verified/);
  }
});

test("public reader sends no account credentials and blocks Local-Only, redirects, oversized and malformed responses", async () => {
  let mode = "local-only", hits = 0, response = () => Response.json(sample());
  const network = { status: () => ({ privacyMode: mode, schedulerUrl: "https://configured.example/scheduler" }) };
  const read = () => readPublicNetworkOverview({ network, fetchImpl: async (url, options) => {
    hits++; assert.equal(url, "https://configured.example/scheduler/network/status");
    assert.equal(options.method, "GET"); assert.equal(options.body, undefined); assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { accept: "application/json" }); return response();
  } });
  await assert.rejects(read(), /Local-Only/); assert.equal(hits, 0);
  mode = "local-first"; assert.equal((await read()).providersOnline, 2);
  for (const bad of [() => new Response("<html>failure</html>"), () => new Response("{}", { headers: { "content-length": "3000000" } }), () => new Response("", { status: 302 })]) {
    response = bad; await assert.rejects(read(), /could not be verified|service is unavailable/);
  }
});

test("a privacy or configured-network change invalidates an in-flight public observation", async () => {
  for (const privacyChange of [false, true]) {
    let mode = "network", url = "https://first.example/scheduler", release, controller, released = false;
    const network = { status: () => ({ privacyMode: mode, schedulerUrl: url }), trackShadowRequest: value => { controller = value; return () => { released = true; }; } };
    const pending = readPublicNetworkOverview({ network, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
    if (privacyChange) { mode = "local-only"; controller.abort(); } else url = "https://second.example/scheduler";
    release(Response.json(sample()));
    await assert.rejects(pending, privacyChange ? /Local-Only/ : /settings changed/);
    assert.equal(released, true);
  }
});

test("native and browser overview read the configured public scheduler with inactive credits and an unresolved earlier account", { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-network-overview-")); let hits = 0;
  const scheduler = http.createServer((request, response) => {
    if (request.url !== "/scheduler/network/status") { response.writeHead(404).end(); return; }
    hits++; assert.equal(request.method, "GET"); assert.equal(request.headers.authorization, undefined);
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(sample()));
  });
  await new Promise(resolve => scheduler.listen(0, "127.0.0.1", resolve));
  const core = await require("../server").createCore({ dataDir: root, port: 0, onEvent() {} });
  let registration, liveRegistration;
  t.after(async () => { registration?.dispose(); liveRegistration?.dispose(); await core.stop(); scheduler.closeAllConnections?.(); await new Promise(resolve => scheduler.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  core.settings.set("earn.schedulerUrl", `http://127.0.0.1:${scheduler.address().port}/scheduler`);
  core.account.creditAuthorization = () => { throw Error("No account authorization is needed for public network status"); };
  const legacy = path.join(root, "koin-foundation-test"); fs.mkdirSync(legacy);
  const saved = Buffer.from("unresolved legacy journal must not be opened by network browsing");
  fs.writeFileSync(path.join(legacy, "deployment.json"), saved);
  const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false, isVisible: () => true, isMinimized: () => false });
  window.webContents.mainFrame = { url: "http://127.0.0.1:9000/" };
  let handle;
  const manifestPath = require.resolve("../lib/koin-network/credit-service.json"), original = require(manifestPath);
  try {
    require.cache[manifestPath].exports = { schema: 1, state: "unavailable", reason: "Activation pending in this fixture" };
  registration = require("../../electron/koin-test-ipc").registerTestPaymentIPC({ core, dataDir: root, isTest: true, dialog: {}, origin: "http://127.0.0.1:9000", getMainWindow: () => window, ipcMain: { handle: (_name, fn) => { handle = fn; } } });
  } finally { require.cache[manifestPath].exports = original; }
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  await assert.rejects(handle(event, "network-overview"), /Local-Only/); assert.equal(hits, 0);
  core.settings.set("network.privacyMode", "local-first");
  assert.equal((await handle(event, "network-overview")).network.providersOnline, 2);
  assert.equal((await handle(event, "purchase-info")).activation, "unavailable");
  const base = `http://127.0.0.1:${await core.start()}`;
  const response = await fetch(base + "/core/network/overview"); assert.equal(response.status, 200);
  assert.equal((await response.json()).network.models[0].id, "koinos-fast");
  const before = hits;
  await assert.rejects(handle(event, "network-overview", { url: "https://other.example" }), /takes no arguments/);
  await assert.rejects(handle({ ...event, senderFrame: { url: window.webContents.mainFrame.url } }, "network-overview"), /access denied/);
  assert.equal(hits, before); assert.deepEqual(fs.readFileSync(path.join(legacy, "deployment.json")), saved);
  let liveHandle;
  require.cache[manifestPath].exports = { schema: 1, state: "unavailable", reason: "Activation pending in this fixture" };
  try {
  liveRegistration = require("../../electron/koin-test-ipc").registerTestPaymentIPC({ core, dataDir: root, isTest: false, dialog: {}, origin: "http://127.0.0.1:9000", getMainWindow: () => window, ipcMain: { handle: (_name, fn) => { liveHandle = fn; } } });
  } finally { require.cache[manifestPath].exports = original; }
  assert.equal((await liveHandle(event, "network-overview")).network.providersOnline, 2);
  assert.equal((await liveHandle(event, "purchase-info")).enabled, false);
  assert.equal((await liveHandle(event, "purchase", "1")).enabled, false);
  const liveHits = hits;
  await assert.rejects(liveHandle(event, "network-overview", {}), /takes no arguments/);
  await assert.rejects(liveHandle({ ...event, senderFrame: { url: window.webContents.mainFrame.url } }, "network-overview"), /access denied/);
  assert.equal(hits, liveHits);
  core.gateway.network.configure({ privacyMode: "local-only" });
  assert.equal((await fetch(base + "/core/network/overview")).status, 503); assert.equal(hits, liveHits);
});

test("activated USD overview uses its exact authenticated service and never masks an outage with the public scheduler", async t => {
  const { fixture } = require("./helpers/koin-funding-recovery-fixture"), P = require("../lib/koin-network/job-protocol");
  const f = fixture(t, { mainnet: true, usd: true }), accountId = "overview-fixture-account";
  const auth = { accountId, owner: "account-" + P.hash(accountId), sessionToken: "fixture-private-session" };
  const config = { schema: 1, mode: "mainnet-pilot", deployment: f.d, schedulerUrl: "https://paid-network.example/scheduler", policyHash: P.hash("tariff"), version: 1,
    model: "paid-model", maxOutput: 32, maxRcPerTransaction: "1", maxRcPerDay: "2", limits: { amount: "10", perJob: "10", maxJobs: 10, durationMs: 60000 } };
  let publicReads = 0, paidReads = 0, signedIn = true, offline = false;
  const network = { observedAt: Date.now(), validUntil: Date.now() + 15000, state: "available", readyProviders: 1, waitingRequests: 0, completedToday: 7,
    models: [{ id: "paid-model", providers: 1, available: true, freeEligible: true }], providers: [], activity: [] };
  t.mock.method(global, "fetch", async (url, options) => {
    paidReads++; assert.equal(url, config.schedulerUrl + "/koin/prepaid/network");
    assert.equal(options.method, "POST"); assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), { sessionToken: auth.sessionToken, creditWallet: null });
    if (offline) throw Error("Paid network is offline");
    return Response.json({ ok: true, product: "prepaid-usd-v1", owner: auth.owner, mode: "mainnet-pilot", paymentsEnabled: true, network });
  });
  const core = { account: { creditAuthorization: async target => { assert.equal(target, config.schedulerUrl); if (!signedIn) throw Error("Sign in to the paid network"); return auth; }, assertCreditAuthorization: () => {}, safeStorage: {} },
    gateway: { network: { overview: () => { publicReads++; throw Error("Public scheduler must not replace paid network"); } } } };
  const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false, isVisible: () => true, isMinimized: () => false });
  window.webContents.mainFrame = { url: "http://127.0.0.1:9000/" };
  const manifestPath = require.resolve("../lib/koin-network/credit-service.json"), original = require(manifestPath);
  let handle, registration;
  try {
    require.cache[manifestPath].exports = { schema: 1, state: "ready", config };
    registration = require("../../electron/koin-test-ipc").registerTestPaymentIPC({ core, dataDir: f.dir, isTest: true, dialog: {}, origin: "http://127.0.0.1:9000", getMainWindow: () => window, ipcMain: { handle: (_name, fn) => { handle = fn; } } });
  } finally { require.cache[manifestPath].exports = original; }
  t.after(() => registration?.dispose());
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  assert.deepEqual((await handle(event, "network-overview")).network, network);
  offline = true; await assert.rejects(handle(event, "network-overview"), /Paid network is offline/);
  signedIn = false; await assert.rejects(handle(event, "network-overview"), /Sign in to the paid network/);
  assert.equal(paidReads, 2); assert.equal(publicReads, 0);
});
