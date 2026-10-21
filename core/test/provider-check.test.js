"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), { EventEmitter } = require("node:events");
const { LocalProviderCheck, MAX_REPORT, MAX_RESPONSE, validatePack } = require("../../electron/provider-check");
const { registerProviderCheckIPC } = require("../../electron/provider-check-ipc");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "private-provider-check-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "approved.gguf"), bytes = Buffer.from("Fixture model bytes, not actual model quality"); fs.writeFileSync(file, bytes);
  const pack = structuredClone(require("../provider-check/candidates.json"));
  const m = pack.models.find(x => x.model === "koinos-fast"); pack.models = [m]; m.model = "fixture-public"; m.package = "fixture-public@1"; m.modelHash = hash(bytes);
  const tokenMap = new Map(); let index = 0;
  for (const v of m.vectors) { const ids = [++index, 7]; v.count = ids.length; v.idsHash = hash(JSON.stringify(ids)); tokenMap.set(v.text, ids); }
  for (const c of m.cases) { const ids = [++index, 9]; c.inputTokens = ids.length; c.inputIdsHash = hash(JSON.stringify(ids)); tokenMap.set(c.prompt, ids); }
  const state = { activeAlias: m.model, loading: false, runtime: { kind: "llamacpp", running: true, pid: 123, endpoint: "http://127.0.0.1:12345", model: file } };
  const counts = { acquired: 0, released: 0, requests: [], stopped: 0 }, progress = [];
  const core = { hardware: { platform: "fixture", arch: "x64", cpu: { model: "Fixture CPU", cores: 4 }, ramBytes: 8e9,
      gpus: [{ vendor: "fixture", name: "Fixture GPU", serial: "PRIVATE_SERIAL" }], serial: "PRIVATE_SERIAL", hostname: "PRIVATE_HOST" },
    account: { wallet: { address: "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK", privateKey: "PRIVATE_KEY", sign: () => { throw Error("must not sign"); } }, token: "PRIVATE_TOKEN", chatHistory: "PRIVATE_CHAT" },
    models: { catalog: { aliases: { [m.model]: { label: "Fixture public", package: m.package } }, packages: { [m.package]: { sha256: m.modelHash } } },
      packagePath: () => file, quarantineOf: () => null, ensurePackage: () => { throw Error("must not download"); } },
    runtime: { status: () => structuredClone(state), busy: () => false,
      acquireCurrent: alias => { assert.equal(alias, m.model); counts.acquired++; return { endpoint: state.runtime.endpoint, release: () => { counts.released++; } }; },
      ensure: () => { throw Error("must not load a model"); }, stop: () => { counts.stopped++; throw Error("must not stop other work"); } } };
  let response = async (route, body) => route === "/tokenize" ? Response.json({ tokens: tokenMap.get(body.content) }) :
    Response.json({ content: m.cases.find(c => c.prompt === body.prompt).expected[0], stop: true, stopped_limit: false, stopped_eos: true });
  const fetchImpl = async (url, init) => { const u = new URL(url), body = JSON.parse(init.body); assert.equal(u.origin, "http://127.0.0.1:12345"); assert.equal(init.redirect, "error");
    assert.deepEqual(Object.keys(init.headers), ["content-type"]); counts.requests.push({ route: u.pathname, body }); return response(u.pathname, body, init); };
  const check = new LocalProviderCheck({ core, appVersion: "fixture-test", pack, fetchImpl, onProgress: value => progress.push(value) }); t.after(() => check.dispose());
  return { dir, file, core, state, pack, m, check, counts, progress, fetchImpl, set response(fn) { response = fn; } };
}
async function complete(check) { check.start(); await check.task; return check.status(); }
test("one local check verifies current bytes and runtime tokens, measures all12 cases, and exports no private account data", async t => {
  const f = fixture(t), status = await complete(f.check), report = JSON.parse(f.check.reportText());
  assert.equal(status.state, "complete"); assert.equal(status.passed, 12); assert.equal(status.completed, status.total); assert.equal(status.reportAvailable, true);
  assert.equal(report.status, "candidate-not-approved"); assert.equal(report.signed, false); assert.equal(report.providerEligibilityCreated, false); assert.equal(report.networkReady, false);
  assert.equal(report.modelFile.sha256, f.m.modelHash); assert.equal(report.runtime.identity, "managed-process-observed"); assert.equal(report.runtime.stable, true);
  assert.equal(report.calibration.vectors.length, f.m.vectors.length); assert.equal(report.calibration.complete, true); assert.equal(report.measurement.results.length, 12);
  assert.equal(f.counts.acquired, 1); assert.equal(f.counts.released, 1); assert.equal(f.counts.stopped, 0);
  assert.equal(f.counts.requests.filter(x => x.route === "/completion").length, 12);
  for (const request of f.counts.requests.filter(x => x.route === "/completion")) {
    assert.equal(request.body.stream, false); assert.equal(request.body.cache_prompt, false); assert.equal(request.body.temperature, 0);
    assert.ok(f.m.cases.some(c => c.prompt === request.body.prompt));
  }
  for (const secret of ["PRIVATE_KEY", "PRIVATE_TOKEN", "PRIVATE_CHAT", "PRIVATE_HOST", "PRIVATE_SERIAL", f.dir, "http://127.0.0.1", f.m.cases[0].messages[0].content]) assert.equal(f.check.reportText().includes(secret), false, secret);
  assert.ok(Buffer.byteLength(f.check.reportText()) < MAX_REPORT); assert.equal(f.progress.at(-1).reportAvailable, true);
});
test("private, unavailable, busy or unsupported runtimes never start inference, downloads or payment actions", async t => {
  for (const [mutate, code] of [
    [f => { f.state.runtime = null; }, "model_not_running"],
    [f => { f.state.activeAlias = null; }, "model_identity_unavailable"],
    [f => { f.core.models.catalog.aliases[f.m.model].custom = true; }, "model_not_approved"],
    [f => { f.core.models.catalog.aliases[f.m.model].dev = true; }, "model_not_approved"],
    [f => { f.pack.models = []; }, "model_not_prepared"],
    [f => { f.core.runtime.busy = () => true; }, "model_busy"],
    [f => { f.state.runtime.kind = "ollama"; }, "runtime_unsupported"]
  ]) {
    const f = fixture(t); mutate(f); assert.equal((await complete(f.check)).state, "unavailable");
    assert.equal(JSON.parse(f.check.reportText()).outcome.code, code); assert.equal(f.counts.acquired, 0); assert.equal(f.counts.requests.length, 0);
  }
});
test("installed models and a stopped engine remain distinct in the report without exposing private model names or errors", async t => {
  const f = fixture(t);
  for (let i = 2; i <= 4; i++) {
    const m = { ...f.m, model: `fixture-${i}`, package: `fixture-${i}@1` };
    f.pack.models.push(m); f.core.models.catalog.aliases[m.model] = { package: m.package }; f.core.models.catalog.packages[m.package] = { sha256: m.modelHash };
  }
  f.core.models.aliases = () => [...f.pack.models.map(m => ({ alias: m.model, status: "ready" })), { alias: "PRIVATE_IMPORTED_MODEL", status: "ready", custom: true }];
  f.state.activeAlias = null; f.state.runtime = null;
  const status = await complete(f.check), report = JSON.parse(f.check.reportText());
  assert.equal(report.outcome.code, "model_not_running");
  assert.deepEqual(report.localState.current, { loading: false, activeModel: null, running: false, engine: null, lastLoadFailed: false, installedApprovedModels: 4 });
  assert.match(status.detail, /4 approved local models are installed/);
  assert.equal(f.check.reportText().includes("PRIVATE_IMPORTED_MODEL"), false);
  assert.equal(f.counts.requests.length, 0); assert.equal(f.counts.acquired, 0);
});
test("an already-started local load is observed before checking, with no new load, download or request retry", async t => {
  const f = fixture(t), ready = structuredClone(f.state);
  f.state.loading = true; f.state.activeAlias = null; f.state.runtime = null;
  f.check.start();
  assert.equal(f.check.status().stage, "Waiting for local model"); assert.equal(f.counts.acquired, 0); assert.equal(f.counts.requests.length, 0);
  Object.assign(f.state, ready);
  await f.check.task;
  const report = JSON.parse(f.check.reportText());
  assert.equal(report.outcome.state, "complete"); assert.equal(report.localState.waitedForLoad, true);
  assert.equal(report.localState.initial.loading, true); assert.equal(report.localState.initial.running, false);
  assert.equal(report.localState.current.loading, false); assert.equal(report.localState.current.running, true);
  assert.equal(f.counts.acquired, 1); assert.equal(f.counts.released, 1);
  assert.equal(f.counts.requests.filter(x => x.route === "/completion").length, 12);
});
test("waiting for an existing load can be cancelled without stopping it and a failed load is reported honestly", async t => {
  const f = fixture(t); f.state.loading = true; f.state.activeAlias = null; f.state.runtime = null;
  f.check.start(); f.check.cancel(); await f.check.task;
  assert.equal(JSON.parse(f.check.reportText()).outcome.code, "cancelled");
  assert.equal(f.state.loading, true); assert.equal(f.counts.stopped, 0); assert.equal(f.counts.acquired, 0); assert.equal(f.counts.requests.length, 0);
  const g = fixture(t); g.state.loading = true; g.state.activeAlias = null; g.state.runtime = null;
  g.check.start(); g.state.loading = false; g.state.lastLoadError = { message: "PRIVATE_LOCAL_PATH_OR_ENGINE_ERROR" }; await g.check.task;
  const report = JSON.parse(g.check.reportText());
  assert.equal(report.outcome.code, "model_load_failed"); assert.equal(report.localState.current.lastLoadFailed, true);
  assert.equal(g.check.reportText().includes("PRIVATE_LOCAL_PATH_OR_ENGINE_ERROR"), false);
  assert.equal(g.counts.requests.length, 0); assert.equal(g.counts.acquired, 0); assert.equal(g.counts.stopped, 0);
});
test("wrong current model bytes and mismatched runtime token IDs stop before quality inference", async t => {
  const f = fixture(t); fs.writeFileSync(f.file, "not the approved bytes"); await complete(f.check);
  assert.equal(JSON.parse(f.check.reportText()).outcome.code, "model_hash_mismatch"); assert.equal(f.counts.requests.length, 0); assert.equal(f.counts.released, 1);
  const g = fixture(t); g.response = async () => Response.json({ tokens: [999, 999] }); await complete(g.check);
  const report = JSON.parse(g.check.reportText()); assert.equal(report.outcome.code, "tokenizer_mismatch"); assert.equal(report.calibration.vectors[0].passed, false);
  assert.equal(report.runtime.stable, null, "an incomplete tokenizer check is not evidence of runtime instability");
  assert.equal(report.measurement.results.length, 0); assert.equal(g.counts.requests.length, 1); assert.equal(g.counts.released, 1);
});
test("process and public wallet changes invalidate a run without stopping the runtime or retrying", async t => {
  for (const kind of ["pid", "wallet"]) {
    const f = fixture(t); f.response = async () => { if (kind === "pid") f.state.runtime.pid++; else f.core.account.wallet.address = null; return Response.json({ tokens: [] }); };
    await complete(f.check); const report = JSON.parse(f.check.reportText());
    assert.equal(report.outcome.code, kind === "pid" ? "runtime_changed" : "wallet_changed"); assert.equal(report.runtime.stable, kind === "pid" ? false : null);
    assert.equal(f.counts.requests.length, 1); assert.equal(f.counts.released, 1); assert.equal(f.counts.stopped, 0);
  }
});
test("cancellation aborts only the active local request, releases its hold and retains partial evidence", async t => {
  const f = fixture(t); let entered; const ready = new Promise(resolve => { entered = resolve; });
  f.response = async (_route, _body, init) => { entered(); return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Error("PRIVATE_ENGINE_ERROR")), { once: true })); };
  f.check.start(); await ready; f.check.cancel(); await f.check.task;
  const report = JSON.parse(f.check.reportText()); assert.equal(report.outcome.code, "cancelled"); assert.equal(f.check.status().reportAvailable, true);
  assert.equal(f.counts.requests.length, 1); assert.equal(f.counts.released, 1); assert.equal(f.counts.stopped, 0); assert.equal(f.check.reportText().includes("PRIVATE_ENGINE_ERROR"), false);
});
test("wrong and token-limited answers remain measured failures without granting eligibility", async t => {
  const f = fixture(t); let completed = 0;
  f.response = async (route, body) => {
    if (route === "/tokenize") { const item = [...f.m.vectors.map(v => ({ text: v.text, idsHash: v.idsHash })), ...f.m.cases.map(c => ({ text: c.prompt, idsHash: c.inputIdsHash }))].find(x => x.text === body.content);
      for (let i = 1; i <= 100; i++) for (const end of [7, 9]) if (hash(JSON.stringify([i, end])) === item.idsHash) return Response.json({ tokens: [i, end] }); }
    const c = f.m.cases[completed++]; return Response.json({ content: completed === 1 ? "wrong" : c.expected[0], stop: true, stopped_limit: completed === 2 });
  };
  const status = await complete(f.check); assert.equal(status.state, "complete"); assert.equal(status.passed, 10); assert.equal(JSON.parse(f.check.reportText()).providerEligibilityCreated, false);
});
test("expected text with a nonterminal or missing completion marker never passes as a completed answer", async t => {
  for (const ending of [{ stop: false }, {}]) {
    const f = fixture(t); let index = 0;
    f.response = async route => route === "/tokenize" ? Response.json({ tokens: [++index, index <= f.m.vectors.length ? 7 : 9] }) : Response.json({ content: f.m.cases[0].expected[0], ...ending });
    await complete(f.check); const report = JSON.parse(f.check.reportText());
    assert.equal(report.outcome.code, "runtime_response_invalid"); assert.equal(report.measurement.complete, false); assert.equal(report.measurement.results[0].passed, false);
    assert.equal(f.counts.requests.filter(x => x.route === "/completion").length, 1);
  }
});
test("oversized engine responses and escaped-output report growth produce bounded incomplete reports", async t => {
  const f = fixture(t); f.response = async () => new Response("x".repeat(MAX_RESPONSE + 1)); await complete(f.check);
  assert.equal(JSON.parse(f.check.reportText()).outcome.code, "runtime_response_invalid"); assert.equal(f.counts.requests.length, 1);
  const g = fixture(t); let index = 0;
  g.response = async route => route === "/tokenize" ? Response.json({ tokens: [++index, index <= g.m.vectors.length ? 7 : 9] }) : Response.json({ content: "\u0000".repeat(65536), stop: true });
  await complete(g.check); const report = JSON.parse(g.check.reportText());
  assert.equal(report.outcome.code, "report_too_large"); assert.equal(report.resultsOmitted, true); assert.ok(Buffer.byteLength(g.check.reportText()) < MAX_REPORT);
});
test("pack validation accepts the committed15 candidates and rejects changed prompt commitments and oversized definitions", () => {
  const pack = require("../provider-check/candidates.json"); assert.equal(validatePack(pack).models.length, 15);
  const altered = structuredClone(pack); altered.models[0].cases[0].prompt += "changed"; assert.throws(() => validatePack(altered), /pack_unavailable/);
  assert.throws(() => validatePack({ ...pack, padding: "x".repeat(2000001) }), /pack_unavailable/);
});
function windowFixture() {
  const w = new EventEmitter(); w.isDestroyed = () => false; w.webContents = new EventEmitter(); w.webContents.mainFrame = { url: "http://127.0.0.1:41100/" }; w.webContents.send = () => {}; return w;
}
test("real provider-check IPC rejects other windows/frames and caller data, then copies and privately saves one local report", async t => {
  const f = fixture(t), w = windowFixture(), handlers = new Map(), output = path.join(f.dir, "report.json"); let copied = "", dialogCalls = 0;
  const ipc = registerProviderCheckIPC({ ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) }, core: f.core,
    getMainWindow: () => w, origin: "http://127.0.0.1:41100", appVersion: "fixture-test", channel: "test", downloadsDirectory: f.dir,
    clipboard: { writeText: text => { copied = text; } }, dialog: { showSaveDialog: async () => { dialogCalls++; return { filePath: output }; } },
    createCheck: args => new LocalProviderCheck({ ...args, pack: f.pack, fetchImpl: f.fetchImpl }) }); t.after(() => ipc.dispose());
  const invoke = handlers.get("provider:local-check"), event = { sender: w.webContents, senderFrame: w.webContents.mainFrame };
  await assert.rejects(invoke({ sender: {}, senderFrame: event.senderFrame }, "start"), /denied/);
  await assert.rejects(invoke({ sender: w.webContents, senderFrame: { url: event.senderFrame.url } }, "start"), /denied/);
  const original = w.webContents.mainFrame.url; w.webContents.mainFrame.url = "http://127.0.0.1:41100/mascot.html";
  await assert.rejects(invoke(event, "start"), /denied/); w.webContents.mainFrame.url = original;
  await assert.rejects(invoke(event, "start", { endpoint: "http://example.com" }), /Unknown/);
  await invoke(event, "start"); await ipc.check.task; assert.equal((await invoke(event, "status")).state, "complete");
  await invoke(event, "copy"); assert.equal(JSON.parse(copied).signed, false); assert.equal(copied.includes("PRIVATE_TOKEN"), false);
  await invoke(event, "save"); assert.equal(fs.readFileSync(output, "utf8"), copied); assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  await assert.rejects(invoke(event, "save"), /new filename/); assert.equal(fs.readFileSync(output, "utf8"), copied); assert.equal(dialogCalls, 2);
  w.webContents.emit("did-start-navigation"); assert.equal(ipc.check.controller.signal.aborted, true);
});
test("native save revalidates the main window after the dialog and cannot export after navigation", async t => {
  const f = fixture(t), w = windowFixture(), handlers = new Map(), output = path.join(f.dir, "must-not-exist.json");
  const ipc = registerProviderCheckIPC({ ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: () => {} }, core: f.core, getMainWindow: () => w,
    origin: "http://127.0.0.1:41100", appVersion: "fixture", downloadsDirectory: f.dir, clipboard: { writeText() {} },
    dialog: { showSaveDialog: async () => { w.webContents.mainFrame.url = "https://untrusted.invalid"; return { filePath: output }; } },
    createCheck: options => new LocalProviderCheck({ ...options, pack: f.pack, fetchImpl: f.fetchImpl }) }); t.after(() => ipc.dispose());
  const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame }, invoke = handlers.get("provider:local-check");
  await invoke(event, "start"); await ipc.check.task; await assert.rejects(invoke(event, "save"), /denied/); assert.equal(fs.existsSync(output), false);
});
test("current-runtime leases never ensure or switch a model and release the normal drain counter", () => {
  const { RuntimeManager } = require("../lib/runtime-manager"), r = new RuntimeManager({ models: { resolveAlias: () => ({}) } });
  r.activeAlias = "known"; r.runtime = { endpoint: "http://127.0.0.1:1", status: () => ({ running: true }) };
  r.ensure = () => { throw Error("must not ensure"); };
  const hold = r.acquireCurrent("known"); assert.equal(r.busy(), true); assert.equal(r._inflight, 1);
  assert.throws(() => r.acquireCurrent("different"), /changed/); hold.release(); hold.release(); assert.equal(r._inflight, 0);
  r._loading = {}; assert.throws(() => r.acquireCurrent("known"), /changed/);
});
