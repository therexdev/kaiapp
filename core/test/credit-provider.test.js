"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path"), os = require("os");
const { CreditProvider } = require("../../electron/credit-provider"), P = require("../lib/koin-network/job-protocol");
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-provider-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const owner = require("koilib").Signer.fromSeed("provider-setup-fixture").getAddress();
  const config = { owner, mode: "mainnet-pilot", schedulerUrl: "https://fixture.invalid/scheduler", policyHash: P.hash("policy"), model: "fixture",
    deployment: { chainId: require("../lib/koin-network/payment-network").MAINNET_CHAIN, credits: owner, creditsHash: "0x1220" + P.hash("contract") } };
  const tariffs = [{ model: "fixture", modelHash: P.hash("model") }];
  const c = { directory, config, auth: { sessionToken: "fixture-session" }, flow: { models: async () => ({ tariffs }) } };
  let installed = false, authorized = true, unlocked = true, started = 0, stopped = 0, downloads = 0, releases = 0, options;
  const core = { account: { wallet: { address: owner, status: () => ({ unlocked }) }, assertCreditAuthorization: () => { if (!authorized) throw Error("Account changed"); },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() } },
    models: { catalog: { aliases: { fixture: { package: "approved", minRamGb: 4 } }, packages: { approved: { sha256: P.hash("model"), sizeBytes: 1000 } } },
      quarantineOf: () => null, packageStatus: () => ({ status: installed ? "ready" : "absent" }), downloadProgress: () => null,
      ensurePackage: async () => { downloads++; installed = true; }, cancelDownload() {} },
    hardware: { ramBytes: 8e9 }, runtime: { acquireFor: async () => ({ release() { releases++; } }) }, gateway: { earn: { stop: async () => {} }, network: { trackShadowRequest: () => () => {} } } };
  const service = { account: core.account, dataDir: directory, context: async () => { if (!authorized) throw Error("Account changed"); return c; }, fetchImpl: async (_url, init) => Response.json({ mode: config.mode, owner, chainId: config.deployment.chainId, installation: JSON.parse(init.body).installation, granted: true }) };
  core.account = { ...core.account, assertCreditAuthorization() { throw Error("Legacy website authorization must not be used"); } };
  const args = { service, core, createWorker: o => { options = o; return { running: false, status: () => ({}), async start() { started++; this.running = true; }, async stop() { stopped++; this.running = false; } }; },
    readStatus: async () => ({ state: "qualifying", label: "CHECKING MODEL", detail: "Fixture checking" }) };
  const controller = new CreditProvider(args); t.after(() => controller.dispose());
  return { controller, args, core, c, tariffs, set installed(v) { installed = v; }, set authorized(v) { authorized = v; }, set unlocked(v) { unlocked = v; }, get counts() { return { started, stopped, downloads, releases }; }, get options() { return options; } };
}
test("guided setup requires explicit download, saves On for restart, renews on a pinned worker, and Off survives restart", async t => {
  const f = fixture(t), p = f.controller, signal = AbortSignal.timeout(5000);
  assert.equal((await p.info()).state, "download-required"); assert.equal(f.counts.downloads, 0);
  await assert.rejects(p.start(signal), /Download/); assert.equal(f.counts.downloads, 0);
  await p.download(signal); assert.equal(f.counts.downloads, 1); assert.equal((await p.info()).state, "ready");
  await p.start(signal); assert.equal(f.counts.started, 1); assert.equal(f.options.fundedOnly, true); assert.ok(f.options.qualificationTarget);
  p.readStatus = async () => ({ model: "fixture", state: "qualifying", label: "CHECKING MODEL", detail: "Fixture checking" });
  assert.equal((await p.status()).state, "qualifying"); assert.equal(p.preference(f.c), true);
  await p.dispose(); const restarted = new CreditProvider(f.args); t.after(() => restarted.dispose()); await restarted.tick();
  assert.equal(f.counts.started, 2); await restarted.stop(); assert.equal(restarted.preference(f.c), false); await restarted.tick(); assert.equal(f.counts.started, 2);
  restarted.preference(f.c, true); await restarted.dispose();
  const beforeReconnect = new CreditProvider(f.args); t.after(() => beforeReconnect.dispose());
  assert.equal((await beforeReconnect.info()).enabled, true); await beforeReconnect.stop(); await beforeReconnect.tick();
  assert.equal(f.counts.started, 2, "Off before automatic reconnect clears the saved preference");
});
test("locked wallet, account changes and device mismatch never imply Online or start inference", async t => {
  const f = fixture(t), p = f.controller; f.installed = true; f.unlocked = false;
  assert.equal((await p.info()).state, "wallet-required"); await assert.rejects(p.start(AbortSignal.timeout(5000)), /Unlock/); assert.equal(f.counts.started, 0);
  f.unlocked = true; await p.start(AbortSignal.timeout(5000)); f.authorized = false; await p.tick(); assert.equal(p.worker.running, false); assert.equal(p.preference(f.c), true);
  f.authorized = true; f.core.hardware.ramBytes = 1e9; await p.tick(); assert.equal(p.worker.running, false); assert.equal((await p.info()).state, "unavailable");
});
test("current wallet requirements replace a stale connection error and a successful Off check clears it", async t => {
  const f = fixture(t), p = f.controller; f.installed = true; f.unlocked = false;
  p.error = 'Unexpected token "<", "<!DOCTYPE" is not valid JSON';
  let info = await p.info();
  assert.equal(info.state, "wallet-required");
  assert.match(info.detail, /Unlock.*Reward wallet/); assert.doesNotMatch(info.detail, /DOCTYPE/);
  f.unlocked = true;
  const owner = f.c.config.owner; f.c.config.owner = "account-not-linked";
  info = await p.info(); assert.equal(info.state, "wallet-required");
  assert.match(info.detail, /AI credit account.*link this computer/);
  await assert.rejects(p.start(AbortSignal.timeout(5000)), /link this computer/);
  f.c.config.owner = owner;
  info = await p.info(); assert.equal(info.state, "ready"); assert.match(info.detail, /Ready to connect/);
  assert.equal(p.error, ""); assert.equal(info.enabled, false); assert.equal(info.running, false);
  assert.equal(f.counts.started, 0); assert.equal(f.counts.downloads, 0);
  f.c.flow.models = async () => { throw Error("Catalog is unavailable"); };
  info = await p.info(); assert.equal(info.state, "unavailable"); assert.equal(info.detail, "Catalog is unavailable");
});
test("provider info forwards only bounded current-model diagnostics and removes them for changed identity or Off", async t => {
  const f = fixture(t), p = f.controller; f.installed = true; await p.start(AbortSignal.timeout(5000));
  const now = Date.now(), diagnostic = { model: "fixture", code: "tokenizer_mismatch", at: now };
  p.worker.status = () => ({ lastError: "private raw runtime error", modelDiagnostics: [{ ...diagnostic, message: "private prompt" },
    { model: "unselected", code: "inference_failed", at: now }, { model: "fixture", code: "secret-error", at: now }] });
  let info = await p.info(); assert.deepEqual(info.modelDiagnostics, [diagnostic]);
  assert.equal(JSON.stringify(info).includes("private"), false); assert.equal(info.running, true);
  const current = p.context; p.context = { ...current, auth: { sessionToken: "different-session" } };
  assert.deepEqual((await p.info()).modelDiagnostics, []); p.context = current;
  await p.stop(); info = await p.info(); assert.deepEqual(info.modelDiagnostics, []); assert.equal(info.enabled, false);
});
test("Stop during startup prevents a delayed runtime acquisition from turning sharing back on", async t => {
  const f = fixture(t); f.installed = true;
  let ready, release; const entered = new Promise(r => { ready = r; });
  f.core.runtime.acquireFor = async () => { ready(); await new Promise(r => { release = r; }); return { release() {} }; };
  const startup = f.controller.start(AbortSignal.timeout(5000)), rejected = assert.rejects(startup, /cancelled|abort/i);
  await entered; await f.controller.stop(); release(); await rejected;
  assert.equal(f.counts.started, 0); assert.equal(f.controller.preference(f.c), false);
});

test("public earnings use the selected account without unlocking or changing old reward records", async t => {
  const f = fixture(t); f.unlocked = false;
  let value = { mode: "mainnet-pilot", mainnetPaymentsEnabled: true, observedAt: Date.now(), lastCycleCheck: null,
    payouts: [{ account: f.c.config.owner, epoch: "20742", state: "needs_review", availability: "10000000", work: "0" },
      { account: "another-account", epoch: "20743", state: "paid", availability: "999", work: "1" }] };
  f.args.service.fetchImpl = async () => Response.json(value);
  const result = await f.controller.earnings();
  assert.deepEqual(result.payouts, [{ epoch: "20742", state: "needs_review", availability: "10000000", work: "0" }]);
  assert.equal(result.lastCycleCheck, null); assert.equal(f.counts.started, 0);
  value = { ...value, observedAt: Date.now() - 31000 };
  await assert.rejects(f.controller.earnings(), /stale/);
  value = { ...value, observedAt: Date.now(), payouts: [{ ...value.payouts[0], epoch: 20742 }] };
  await assert.rejects(f.controller.earnings(), /verified/);
  f.authorized = false; await assert.rejects(f.controller.earnings(), /Account changed/);
});

test("provider startup uses an installed approved model when the configured default is absent", async t => {
  const f = fixture(t), modelHash = P.hash("large model");
  f.tariffs.push({ model: "large", modelHash });
  f.core.models.catalog.aliases.large = { package: "large-package", minRamGb: 4 };
  f.core.models.catalog.packages["large-package"] = { sha256: modelHash, sizeBytes: 2000 };
  f.core.models.packageStatus = name => ({ status: name === "large-package" ? "ready" : "absent" });
  let prepared; f.core.runtime.acquireFor = async model => { prepared = model; return { release() {} }; };
  const info = await f.controller.info(); assert.equal(info.state, "ready"); assert.equal(info.model.id, "large");
  await f.controller.start(AbortSignal.timeout(5000)); assert.equal(prepared, "large"); assert.equal(f.counts.downloads, 0);
  assert.deepEqual(f.c.providerModels, ["fixture", "large"]);
});
test("provider setup preserves the active approved model and rejects changed, private or unsuitable packages", async t => {
  const f = fixture(t), modelHash = P.hash("large model"); f.installed = true;
  f.tariffs.push({ model: "large", modelHash });
  f.core.models.catalog.aliases.large = { package: "large-package", minRamGb: 4 };
  f.core.models.catalog.packages["large-package"] = { sha256: modelHash, sizeBytes: 2000 };
  f.core.runtime.status = () => ({ activeAlias: "large" });
  assert.equal((await f.controller.info()).model.id, "large");
  f.core.models.catalog.packages["large-package"].sha256 = P.hash("replacement");
  assert.equal((await f.controller.info()).model.id, "fixture");
  f.core.models.catalog.packages["large-package"].sha256 = modelHash;
  f.core.models.catalog.aliases.large.custom = true;
  assert.equal((await f.controller.info()).model.id, "fixture");
  f.core.models.catalog.aliases.large.custom = false; f.core.models.catalog.aliases.large.dev = true;
  assert.equal((await f.controller.info()).model.id, "fixture");
  f.core.models.catalog.aliases.large.dev = false; f.core.models.catalog.aliases.large.minRamGb = 99;
  assert.equal((await f.controller.info()).model.id, "fixture");
  f.tariffs.splice(0, 1); assert.equal((await f.controller.info()).state, "unavailable");
  assert.equal(f.counts.downloads, 0); assert.equal(f.counts.started, 0);
});
test("Stop during a catalog read cannot re-enable the saved provider preference", async t => {
  const f = fixture(t); f.installed = true;
  let entered, release; const reading = new Promise(resolve => { entered = resolve; });
  f.c.flow.models = async () => { entered(); await new Promise(resolve => { release = resolve; }); return { tariffs: f.tariffs }; };
  const pending = f.controller.start(AbortSignal.timeout(5000)), rejected = assert.rejects(pending, /cancelled|abort/i);
  await reading; await f.controller.stop(); release(); await rejected;
  assert.equal(f.controller.preference(f.c), false); assert.equal(f.counts.started, 0);
});

function addSmart(f) {
  const modelHash = P.hash("smart-model");
  f.tariffs.push({ model: "smart", modelHash });
  f.core.models.catalog.aliases.smart = { package: "smart-package", minRamGb: 4 };
  f.core.models.catalog.packages["smart-package"] = { sha256: modelHash, sizeBytes: 2000 };
}
test("a cold provider recovers its qualified model, loads it without Chat and remembers it across restart", async t => {
  const f = fixture(t); f.installed = true; addSmart(f);
  f.core.runtime.status = () => ({ activeAlias: null });
  f.controller.readStatus = async () => ({ model: "fixture", state: "review-required", models: [{ model: "smart", state: "connecting" }] });
  fs.writeFileSync(path.join(f.c.directory, "provider-preference.json"), JSON.stringify({ schema: 1, enabled: true }));
  const loaded = []; f.core.runtime.acquireFor = async id => { loaded.push(id); return { release() {} }; };
  assert.equal((await f.controller.info()).model.id, "smart");
  assert.equal(f.counts.started, 0); assert.deepEqual(loaded, [], "setup reads do not start inference");
  f.controller.readStatus = async () => { throw Error("Status read temporarily unavailable after setup"); };
  await f.controller.tick(); assert.deepEqual(loaded, ["smart"]); assert.equal(f.counts.started, 1);
  assert.deepEqual(f.controller.savedPreference(f.c), { schema: 1, enabled: true, model: "smart" });
  await f.controller.dispose();
  const restarted = new CreditProvider({ ...f.args, readStatus: async () => { throw Error("Temporary status outage"); } });
  t.after(() => restarted.dispose()); await restarted.tick();
  assert.deepEqual(loaded, ["smart", "smart"]); assert.equal(f.counts.started, 2);
  await restarted.stop(); await restarted.tick();
  assert.equal(f.counts.started, 2); assert.equal(restarted.savedPreference(f.c).model, "smart");
});
test("Earn automatically uses installed approved capacity despite an absent or obsolete startup preference", async t => {
  const f = fixture(t); f.installed = true; addSmart(f);
  let installedSmart = false, prepared;
  f.core.models.packageStatus = id => ({ status: id === "smart-package" && !installedSmart ? "absent" : "ready" });
  f.core.runtime.status = () => ({ activeAlias: "fixture" });
  f.core.runtime.acquireFor = async id => { prepared = id; return { release() {} }; };
  await f.controller.selectModel("smart", AbortSignal.timeout(5000));
  assert.equal(f.controller.preference(f.c), false); assert.equal(prepared, undefined); assert.equal(f.counts.downloads, 0);
  let info = await f.controller.info();
  assert.equal(info.state, "ready"); assert.equal(info.model.id, "fixture"); assert.equal(info.automatic, true);
  assert.deepEqual(info.offeredModels, ["fixture"]);
  await assert.rejects(f.controller.selectModel({ model: "smart" }, AbortSignal.timeout(5000)), /Choose/);
  await assert.rejects(f.controller.selectModel("private-model", AbortSignal.timeout(5000)), /approved/);
  installedSmart = true; await f.controller.start(AbortSignal.timeout(5000)); assert.equal(prepared, "smart");
  await assert.rejects(f.controller.selectModel("fixture", AbortSignal.timeout(5000)), /Turn sharing off/);
  await f.controller.stop(); f.core.models.catalog.packages["smart-package"].sha256 = P.hash("unapproved-weights");
  info = await f.controller.info(); assert.equal(info.state, "ready"); assert.equal(info.model.id, "fixture");
  assert.deepEqual(info.models.map(m => m.id), ["fixture"]);
  await f.controller.start(AbortSignal.timeout(5000)); assert.equal(prepared, "fixture");
  await f.controller.stop();
  await f.controller.selectModel("fixture", AbortSignal.timeout(5000)); assert.equal((await f.controller.info()).model.id, "fixture");
});
test("one-click Earn overrides a stale saved startup model with network-qualified capacity and offers every supported installed pin", async t => {
  const f = fixture(t); f.installed = true; addSmart(f);
  f.controller.preference(f.c, false, "fixture");
  f.core.runtime.status = () => ({ activeAlias: "fixture" });
  f.controller.readStatus = async () => ({ model: "fixture", state: "review-required", models: [{ model: "smart", state: "preparing" }] });
  const loaded = []; f.core.runtime.acquireFor = async model => { loaded.push(model); return { release() {} }; };
  const info = await f.controller.info();
  assert.equal(info.model.id, "smart"); assert.equal(info.automatic, true); assert.deepEqual(info.offeredModels, ["fixture", "smart"]);
  assert.deepEqual(loaded, [], "reading setup never starts a chat or inference");
  await f.controller.start(AbortSignal.timeout(5000)); assert.deepEqual(loaded, ["smart"]);
  assert.deepEqual(f.options.modelPins, { fixture: P.hash("model"), smart: P.hash("smart-model") });
  assert.equal(f.counts.started, 1); assert.equal(f.counts.downloads, 0);
});
test("a new provider warms installed Smart before its first timed network check without selecting a model or sending Chat", async t => {
  const f = fixture(t); f.installed = true;
  const modelHash = P.hash("smart-default");
  f.tariffs.push({ model: "koinos-smart", modelHash });
  f.core.models.catalog.aliases["koinos-smart"] = { package: "smart-default", minRamGb: 8 };
  f.core.models.catalog.packages["smart-default"] = { sha256: modelHash, sizeBytes: 4000 };
  f.controller.readStatus = async () => ({ model: "fixture", state: "review-required", models: [{ model: "koinos-smart", state: "review-required" }] });
  f.controller.preference(f.c, false, "fixture");
  let loaded; f.core.runtime.acquireFor = async model => { loaded = model; return { release() {} }; };
  await f.controller.start(AbortSignal.timeout(5000));
  assert.equal(loaded, "koinos-smart"); assert.equal(f.options.idlePollMs, 5000);
  assert.equal(f.counts.started, 1); assert.equal(f.counts.downloads, 0);
  assert.deepEqual(Object.keys(f.options.modelPins), ["fixture", "koinos-smart"]);
});
test("provider setup and worker use the same RAM or VRAM capacity rule", async t => {
  const f = fixture(t); f.installed = true; addSmart(f);
  f.core.models.catalog.aliases.smart.minRamGb = 24;
  assert.deepEqual((await f.controller.info()).offeredModels, ["fixture"]);
  f.core.hardware.gpus = [{ vramMb: 32768 }];
  assert.deepEqual((await f.controller.info()).offeredModels, ["fixture", "smart"]);
});
test("Local-Only stops provider restart before account or catalog traffic and preserves the saved intent", async t => {
  const f = fixture(t); f.installed = true; f.controller.preference(f.c, true);
  f.core.gateway.network.status = () => ({ privacyMode: "local-only" });
  let requests = 0; f.args.service.context = async () => { requests++; return f.c; };
  const info = await f.controller.info(); assert.equal(info.state, "unavailable"); assert.match(info.detail, /Local-Only/);
  await assert.rejects(f.controller.start(AbortSignal.timeout(5000)), /Local-Only/);
  await f.controller.tick(); assert.equal(requests, 0); assert.equal(f.counts.started, 0); assert.equal(f.controller.preference(f.c), true);
});
test("Stop during provider model selection leaves the earlier choice and Off intact", async t => {
  const f = fixture(t); f.installed = true; addSmart(f);
  await f.controller.selectModel("fixture", AbortSignal.timeout(5000));
  let entered, release; const reading = new Promise(resolve => { entered = resolve; });
  f.c.flow.models = async () => { entered(); await new Promise(resolve => { release = resolve; }); return { tariffs: f.tariffs }; };
  const pending = f.controller.selectModel("smart", AbortSignal.timeout(5000)), rejected = assert.rejects(pending, /cancelled/);
  await reading; await f.controller.stop(); release(); await rejected;
  assert.equal(f.controller.savedPreference(f.c).model, "fixture"); assert.equal(f.controller.preference(f.c), false);
});

const selected = (...models) => ({ mode: "selected", models });
const shareAll = { mode: "all", models: [] };
function admissionRuntime(f) {
  const Runtime = require("../lib/runtime-manager").RuntimeManager;
  const runtime = new Runtime({ models: f.core.models });
  const loaded = []; runtime.acquireFor = async id => { loaded.push(id); return { release() {} }; };
  f.core.runtime = runtime; return { runtime, loaded };
}
test("explicit shared models persist separately from the warm hint and never warm excluded qualified Smart", async t => {
  const f = fixture(t); f.installed = true; addSmart(f);
  f.controller.readStatus = async () => ({ model: "smart", state: "online", models: [{ model: "fixture", state: "review-required" }] });
  assert.deepEqual((await f.controller.info()).selection, shareAll, "old preferences default to all");
  await f.controller.selectModels(selected("fixture"), AbortSignal.timeout(5000));
  const { loaded } = admissionRuntime(f);
  const info = await f.controller.info();
  assert.deepEqual(info.selection, selected("fixture")); assert.deepEqual(info.offeredModels, ["fixture"]);
  await f.controller.start(AbortSignal.timeout(5000));
  assert.deepEqual(loaded, ["fixture"]); assert.deepEqual(f.options.modelPins, { fixture: P.hash("model") });
  assert.equal(f.counts.downloads, 0);
  await f.controller.dispose();
  const restarted = new CreditProvider(f.args); t.after(() => restarted.dispose());
  await restarted.tick(); assert.deepEqual(f.options.modelPins, { fixture: P.hash("model") });
  assert.equal(restarted.preference(f.c), true); assert.deepEqual(restarted.selection(f.c), selected("fixture"));
});
test("shared model input rejects empty, repeated, malformed, private, changed and uninstalled choices without changing intent", async t => {
  const f = fixture(t); f.installed = true; addSmart(f);
  for (const input of [selected(), selected("fixture", "fixture"), selected("../private"), { ...shareAll, extra: true }, { mode: "all", models: ["fixture"] }, selected("private")])
    await assert.rejects(f.controller.selectModels(input, AbortSignal.timeout(5000)), /Choose/);
  f.core.models.catalog.aliases.smart.custom = true;
  await assert.rejects(f.controller.selectModels(selected("smart"), AbortSignal.timeout(5000)), /compatible installed/);
  f.core.models.catalog.aliases.smart.custom = false;
  f.core.models.catalog.packages["smart-package"].sha256 = P.hash("changed");
  await assert.rejects(f.controller.selectModels(selected("smart"), AbortSignal.timeout(5000)), /compatible installed/);
  f.core.models.catalog.packages["smart-package"].sha256 = P.hash("smart-model");
  f.core.models.packageStatus = id => ({ status: id === "smart-package" ? "absent" : "ready" });
  await assert.rejects(f.controller.selectModels(selected("smart"), AbortSignal.timeout(5000)), /compatible installed/);
  assert.deepEqual(f.controller.selection(f.c), shareAll); assert.equal(f.controller.preference(f.c), false);
  assert.equal(f.counts.started, 0); assert.equal(f.counts.downloads, 0);
});
test("changing models while earning waits through the existing work acknowledgment and restarts exactly one worker", async t => {
  const f = fixture(t); f.installed = true; addSmart(f);
  const { runtime, loaded } = admissionRuntime(f), signal = AbortSignal.timeout(5000);
  await f.controller.start(signal);
  const old = f.controller.worker, work = await runtime.acquireNetworkWork(signal);
  const applying = f.controller.selectModels(selected("smart"), signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.networkWorkPaused(), true); assert.equal(old.running, true);
  assert.equal(f.counts.stopped, 0); assert.equal(f.counts.started, 1); assert.deepEqual(f.controller.selection(f.c), shareAll);
  // This hold represents the entire poll -> inference -> signed result ACK,
  // so a completed inference alone does not admit a replacement worker.
  let nextPoll = false; const blocked = runtime.acquireNetworkWork(signal).then(lease => { nextPoll = true; lease.release(); });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(nextPoll, false);
  work.release(); await applying; await blocked;
  assert.equal(old.running, false); assert.equal(f.controller.worker.running, true);
  assert.equal(f.counts.stopped, 1); assert.equal(f.counts.started, 2);
  assert.deepEqual(f.options.modelPins, { smart: P.hash("smart-model") }); assert.equal(loaded.at(-1), "smart");
  assert.equal(f.controller.preference(f.c), true); assert.equal(runtime.networkWorkPaused(), false);
});
test("Stop during selection drain keeps the earlier selection and cannot restart after the work releases", async t => {
  const f = fixture(t); f.installed = true; addSmart(f);
  const { runtime } = admissionRuntime(f), signal = AbortSignal.timeout(5000);
  await f.controller.start(signal); const work = await runtime.acquireNetworkWork(signal);
  const applying = f.controller.selectModels(selected("smart"), signal), rejected = assert.rejects(applying, /abort|cancel/i);
  await new Promise(resolve => setImmediate(resolve)); await f.controller.stop(); work.release(); await rejected;
  assert.equal(f.controller.preference(f.c), false); assert.deepEqual(f.controller.selection(f.c), shareAll);
  assert.equal(f.counts.started, 1); assert.equal(runtime.networkWorkPaused(), false);
  await f.controller.tick(); assert.equal(f.counts.started, 1);
});
test("account authorization changing while draining cannot save selection or restart the previous account", async t => {
  const f = fixture(t); f.installed = true; addSmart(f);
  const { runtime } = admissionRuntime(f), signal = AbortSignal.timeout(5000);
  await f.controller.start(signal); const work = await runtime.acquireNetworkWork(signal);
  const applying = f.controller.selectModels(selected("smart"), signal), rejected = assert.rejects(applying, /Account changed/);
  await new Promise(resolve => setImmediate(resolve)); f.authorized = false; work.release(); await rejected;
  assert.deepEqual(f.controller.selection(f.c), shareAll); assert.equal(f.controller.worker.running, false);
  assert.equal(f.counts.started, 1); assert.equal(runtime.networkWorkPaused(), false);
});
test("all installed sharing incorporates a newly installed model, but an explicit subset does not", async t => {
  const f = fixture(t); f.installed = true; addSmart(f); admissionRuntime(f);
  let smartInstalled = false;
  f.core.models.packageStatus = id => ({ status: id === "smart-package" && !smartInstalled ? "absent" : "ready" });
  await f.controller.start(AbortSignal.timeout(5000)); assert.deepEqual(f.controller.registeredModelPins, { fixture: P.hash("model") });
  smartInstalled = true; await f.controller.tick(); assert.equal(f.counts.started, 2);
  assert.deepEqual(Object.keys(f.controller.registeredModelPins), ["fixture", "smart"]);
  await f.controller.selectModels(selected("fixture"), AbortSignal.timeout(5000));
  const before = f.counts.started; smartInstalled = false; await f.controller.tick(); smartInstalled = true; await f.controller.tick();
  assert.equal(f.counts.started, before); assert.deepEqual(Object.keys(f.controller.registeredModelPins), ["fixture"]);
});
test("removed selected models do not silently fall back to other installed models", async t => {
  const f = fixture(t); f.installed = true; addSmart(f); admissionRuntime(f);
  await f.controller.selectModels(selected("smart"), AbortSignal.timeout(5000)); await f.controller.start(AbortSignal.timeout(5000));
  f.core.models.packageStatus = id => ({ status: id === "smart-package" ? "absent" : "ready" });
  await f.controller.tick(); assert.equal(f.controller.worker.running, false); assert.equal(f.counts.started, 1);
  assert.equal(f.controller.preference(f.c), true); assert.deepEqual(f.controller.selection(f.c), selected("smart"));
  assert.deepEqual((await f.controller.info()).offeredModels, []);
});
test("provider status never uses unselected model Online evidence and diagnostics explain incompatible public models", async t => {
  const f = fixture(t); f.installed = true; addSmart(f);
  await f.controller.selectModels(selected("fixture"), AbortSignal.timeout(5000)); await f.controller.start(AbortSignal.timeout(5000));
  f.controller.readStatus = async options => {
    assert.deepEqual(options.approvedModels, ["fixture", "smart"]);
    return { model: "smart", state: "online", models: [{ model: "smart", state: "online" }, { model: "fixture", state: "qualifying", label: "CHECKING MODEL" }], readyModels: ["smart"] };
  };
  const status = await f.controller.status(); assert.equal(status.model, "fixture"); assert.equal(status.state, "qualifying");
  assert.deepEqual(status.readyModels, []); assert.deepEqual(status.models.map(m => m.model), ["fixture"]);
  f.core.models.catalog.aliases.smart.minRamGb = 64;
  const info = await f.controller.info(), smart = info.modelAvailability.find(m => m.id === "smart");
  assert.equal(smart.compatible, false); assert.match(smart.reason, /memory/);
});
test("a late catalog failure from a previous provider tick cannot stop a newly started worker", async t => {
  const f = fixture(t); f.installed = true; admissionRuntime(f);
  await f.controller.start(AbortSignal.timeout(5000));
  const original = f.c.flow.models; let release, entered;
  const reading = new Promise(resolve => { entered = resolve; });
  f.c.flow.models = async () => { entered(); return new Promise((_resolve, reject) => { release = () => reject(Error("Old catalog failed")); }); };
  const ticking = f.controller.tick(); await reading; await f.controller.stop();
  f.c.flow.models = original; await f.controller.start(AbortSignal.timeout(5000));
  const worker = f.controller.worker; release(); await ticking;
  assert.equal(worker.running, true); assert.equal(f.controller.worker, worker); assert.equal(f.controller.preference(f.c), true);
  assert.equal(f.controller.error, "");
});
test("shared model selection belongs to its account directory and does not carry into another account", async t => {
  const f = fixture(t); f.installed = true; addSmart(f);
  await f.controller.selectModels(selected("smart"), AbortSignal.timeout(5000));
  const directory = path.join(f.c.directory, "different-account"); fs.mkdirSync(directory);
  const other = { ...f.c, directory, auth: { sessionToken: "different-session" } };
  f.args.service.context = async () => other;
  assert.deepEqual((await f.controller.info()).selection, shareAll);
  await f.controller.selectModels(selected("fixture"), AbortSignal.timeout(5000));
  assert.deepEqual(f.controller.selection(other), selected("fixture")); assert.deepEqual(f.controller.selection(f.c), selected("smart"));
});
test("a status read begun before model selection cannot return old Online evidence while work drains", async t => {
  const f = fixture(t); f.installed = true; addSmart(f);
  const { runtime } = admissionRuntime(f), signal = AbortSignal.timeout(5000);
  await f.controller.start(signal); const work = await runtime.acquireNetworkWork(signal);
  let entered, release; const reading = new Promise(resolve => { entered = resolve; });
  const prior = f.controller.readStatus;
  f.controller.readStatus = async () => { entered(); await new Promise(resolve => { release = resolve; });
    return { model: "fixture", state: "online", label: "ONLINE", validUntil: Date.now() + 10000 }; };
  const status = f.controller.status(); await reading;
  const applying = f.controller.selectModels(selected("smart"), signal);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(runtime.networkWorkPaused(), true);
  release(); const result = await status;
  assert.equal(result.state, "checking"); assert.notEqual(result.label, "ONLINE");
  f.controller.readStatus = prior; work.release(); await applying;
  assert.equal(f.controller.worker.running, true); assert.deepEqual(f.controller.selection(f.c), selected("smart"));
});
