"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path"), os = require("os");
const { CreditProvider } = require("../../electron/credit-provider"), P = require("../lib/koin-network/job-protocol");
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-provider-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const owner = require("koilib").Signer.fromSeed("provider-setup-fixture").getAddress();
  const config = { owner, mode: "mainnet-pilot", schedulerUrl: "https://fixture.invalid/scheduler", policyHash: P.hash("policy"), model: "fixture",
    deployment: { chainId: require("../lib/koin-network/payment-network").MAINNET_CHAIN, credits: owner, creditsHash: "0x1220" + P.hash("contract") } };
  const c = { directory, config, auth: { sessionToken: "fixture-session" } };
  let installed = false, authorized = true, unlocked = true, started = 0, stopped = 0, downloads = 0, releases = 0, options;
  const core = { account: { wallet: { address: owner, status: () => ({ unlocked }) }, assertCreditAuthorization: () => { if (!authorized) throw Error("Account changed"); },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() } },
    models: { catalog: { aliases: { fixture: { package: "approved", minRamGb: 4 } }, packages: { approved: { sha256: P.hash("model"), sizeBytes: 1000 } } },
      quarantineOf: () => null, packageStatus: () => ({ status: installed ? "ready" : "absent" }), downloadProgress: () => null,
      ensurePackage: async () => { downloads++; installed = true; }, cancelDownload() {} },
    hardware: { ramBytes: 8e9 }, runtime: { acquireFor: async () => ({ release() { releases++; } }) }, gateway: { earn: { stop: async () => {} }, network: { trackShadowRequest: () => () => {} } } };
  const service = { dataDir: directory, context: async () => { if (!authorized) throw Error("Account changed"); return c; }, fetchImpl: async (_url, init) => Response.json({ mode: config.mode, owner, chainId: config.deployment.chainId, installation: JSON.parse(init.body).installation, granted: true }) };
  const args = { service, core, createWorker: o => { options = o; return { running: false, status: () => ({}), async start() { started++; this.running = true; }, async stop() { stopped++; this.running = false; } }; },
    readStatus: async () => ({ state: "qualifying", label: "CHECKING MODEL", detail: "Fixture checking" }) };
  const controller = new CreditProvider(args); t.after(() => controller.dispose());
  return { controller, args, core, c, set installed(v) { installed = v; }, set authorized(v) { authorized = v; }, set unlocked(v) { unlocked = v; }, get counts() { return { started, stopped, downloads, releases }; }, get options() { return options; } };
}
test("guided setup requires explicit download, saves On for restart, renews on a pinned worker, and Off survives restart", async t => {
  const f = fixture(t), p = f.controller, signal = AbortSignal.timeout(5000);
  assert.equal((await p.info()).state, "download-required"); assert.equal(f.counts.downloads, 0);
  await assert.rejects(p.start(signal), /Download/); assert.equal(f.counts.downloads, 0);
  await p.download(signal); assert.equal(f.counts.downloads, 1); assert.equal((await p.info()).state, "ready");
  await p.start(signal); assert.equal(f.counts.started, 1); assert.equal(f.options.fundedOnly, true); assert.ok(f.options.qualificationTarget);
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
