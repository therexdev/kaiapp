"use strict";
// Run against the reviewed backend checkout. All HTTP stays on loopback and
// all blockchain observations/signatures use deterministic fixture wallets.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http"), crypto = require("node:crypto");
const { createRequire } = require("node:module"), { EventEmitter } = require("node:events"), { Signer } = require("koilib");
const BACKEND = process.env.KAI_WALLET_BACKEND;
const options = { skip: !BACKEND, timeout: 60000 };
const P = require("../lib/koin-network/job-protocol"), PD = require("../lib/koin-network/provider-device-protocol");
const { AccountService } = require("../lib/account"), { CreditService } = require("../../electron/credit-service"), { ProviderDevice } = require("../../electron/provider-device");
const Prices = require("./helpers/purchase-price-fixture"), USD = require("../lib/koin-network/purchase-quote");
const origin = "https://credits.integration.invalid", schedulerUrl = origin + "/scheduler";
const nativeFetch = globalThis.fetch;
function cleanupStack(t) {
  const stack = [];
  // Node runs after hooks in registration order. Compose one hook so the
  // funding helper's directory removal runs after every SQLite/socket close,
  // including when setup or an earlier disposer fails on Windows.
  t.after(async () => {
    const errors = [];
    for (const dispose of stack.reverse()) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Wallet integration cleanup failed");
  });
  return dispose => stack.push(dispose);
}
function protectedStorage() {
  const key = crypto.randomBytes(32);
  return { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: value => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, c.update(value, "utf8"), c.final(), c.getAuthTag()]); },
    decryptString: bytes => { const c = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); c.setAuthTag(bytes.subarray(-16)); return Buffer.concat([c.update(bytes.subarray(12, -16)), c.final()]).toString(); } };
}
function desktopWallet(signer) {
  let unlocked = true, hashes = 0;
  return { address: signer.getAddress(), get signer() { if (!unlocked) throw Error("Wallet locked"); return signer; },
    status: () => ({ address: signer.getAddress(), exists: true, unlocked }),
    lock: () => { unlocked = false; }, unlock: () => { unlocked = true; },
    signHash: async value => { if (!unlocked) throw Error("Wallet locked"); hashes++; return Buffer.from(await signer.signHash(value)).toString("base64"); },
    hashes: () => hashes };
}
async function fixture(t, { sessionOnly = false, freeAllowance = "1000000", multiModel = false, qualificationCases = 1, irreversiblePurchase = true, quoteTtlMs = USD.MAX_QUOTE_MS } = {}) {
  const cleanup = cleanupStack(t);
  const backend = createRequire(path.join(path.resolve(BACKEND), "package.json"));
  const f = require("./helpers/koin-funding-recovery-fixture").fixture({ after: cleanup }, { usd: true, mainnet: true });
  f.state.now = Date.now();
  const dir = path.join(f.dir, "integration"); fs.mkdirSync(dir);
  let offset = 0; const clock = () => Date.now() + offset;
  const tariff = { model: "koinos-smart", version: 1, modelHash: P.hash("model"), tokenizerHash: P.hash("tokenizer"), templateHash: P.hash("template"),
    inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "1000000", maxOutputTokens: 64, contextTokens: 4096, maxLatencyMs: 30000 };
  const tariffs = [tariff, ...(multiModel ? ["koinos-fast", "koinos-balanced", "llama-3.1-8b"].map(model => ({ ...tariff, model, modelHash: P.hash(model) })) : [])];
  const encode = value => [...Buffer.from(value)], render = JSON.stringify;
  const meter = new (backend("./lib/koin-network/metering").Meter)(tariffs.map(tariff => ({ tariff, adapter: { ...tariff, encode, render, input: value => encode(render(value)).length, output: value => encode(value).length } })));
  const config = { schema: 1, mode: "mainnet-pilot", deployment: f.d, schedulerUrl, policyHash: meter.policyHash, version: 1, model: tariff.model, maxOutput: 64,
    pricingPolicyHash: Prices.pricingPolicyHash, maxRcPerTransaction: "10000000", maxRcPerDay: "500000000", limits: { amount: "10000000000", perJob: "1000000", maxJobs: 10, durationMs: 3600000 } };
  const target = require("../../electron/provider-device").target(config);
  const accounts = backend("./lib/accounts").createAccounts({ stateDir: dir, siteOrigin: origin });
  cleanup(() => accounts.service.db.close());
  accounts.service.configureWalletCredits({ target, schedulerUrl, clock });
  const chain = new (backend("./lib/koin-network/chain").KoinChain)(f.d, f.provider);
  let runtime;
  const networkOverview = () => {
    if (!multiModel) return { observedAt: clock(), validUntil: clock() + 15000, models: [{ id: tariff.model, available: true, providers: 1, freeEligible: true }] };
    // The controlled chain remains serving during real preparation timers;
    // sample before the overview so its timestamp can never be in the future.
    runtime.lastServing = clock();
    return backend("./lib/koin-network/network-overview").networkOverview(runtime);
  };
  const deviceOptions = { directory: path.join(dir, "provider-devices"), schedulerUrl, target, deployment: f.d, clock,
    catalog: () => backend("./lib/koin-network/model-catalog").modelCatalog({ meter, target, networkOverview, clock }),
    status: (address, deviceId) => {
      if (multiModel) runtime.lastServing = clock();
      return { mode: config.mode, mainnetPaymentsEnabled: config.mode === "mainnet-pilot", observedAt: clock(),
        providers: multiModel ? [backend("./lib/koin-network/provider-readiness").providerReadiness(runtime, address, undefined, deviceId)] : [] };
    } };
  let devices = new (backend("./lib/koin-network/provider-devices").ProviderDevices)(deviceOptions);
  cleanup(() => devices.close());
  const scheduler = new (backend("./lib/scheduler").Scheduler)({ dataDir: path.join(dir, "scheduler"), accounts: accounts.service, providerDevices: devices,
    operatorSecret: "a".repeat(64), priceSources: [], bootstrapPoolSat: "0", workerProofEnforce: true,
    ...(multiModel ? { koinShadow: { audience: schedulerUrl, clock, providerDevices: devices } } : {}),
    koinPrepaid: { client: chain, target, meter, clock, providerDevices: devices, encryptionKey: Buffer.alloc(32, 53), publicAccounts: true, waitMs: 30000,
      freePolicy: { version: 1, accountDaily: freeAllowance, networkDaily: "10000000", originDaily: "10000000", accountConcurrent: 4, eligibleModels: tariffs.map(t => t.model) },
      networkOverview, qualify: (...args) => multiModel ? runtime.qualified(...args) : true, accept: () => true,
      purchaseQuote: (owner, amount, denomination) => { assert.equal(denomination, "USD"); return Prices.issue({ deployment: f.d, signer: Signer.fromSeed("funding-recovery-verifier"), account: owner, amount: USD.nativeForDollars(amount, "25000000"), usdPerKoin: "25000000", version: 1, now: clock(), ttlMs: quoteTtlMs }); } } });
  cleanup(() => scheduler.close());
  const hosts = new (backend("./lib/koin-network/test-hosts").TestHosts)(path.join(dir, "hosts"), f.d.chainId);
  cleanup(() => hosts.close());
  runtime = { accounts: accounts.service, scheduler, hosts, config: multiModel ? { ...config, models: tariffs.map(tariff => ({ tariff })), freePolicy: { eligibleModels: tariffs.map(t => t.model) } } : config,
    prepaid: true, clock, claims: { accountStatus: () => [] } };
  if (multiModel) {
    Object.setPrototypeOf(runtime, backend("./lib/koin-network/test-runtime").TestRuntime.prototype);
    Object.assign(runtime, { target, meter, providerDevices: devices, reviewedQualifications: () => [], lastServing: clock(), cycle: { days: () => [] } });
    // Deliberately tiny fixture policies: exercise real signed qualification,
    // never claim production inference quality or replace the deployed suite.
    runtime.qualifier = new (backend("./lib/koin-network/provider-qualification-set").ProviderQualificationSet)({
      file: path.join(dir, "qualification.json"), target, meter, clock, providerDevices: devices, preparePresence: worker => devices.presence(worker),
      policies: tariffs.map(t => ({ schema: 1, model: t.model, modelHash: t.modelHash, modelWeight: "100", coverageBps: 10000,
        reviewedEvidenceHash: P.hash("integration-only:" + t.model), minPass: qualificationCases, maxLatencyMs: 30000, renewBeforeMs: 60000, retryMs: 300000,
        cases: Array.from({ length: qualificationCases }, (_, i) => ({ id: "fixture-answer-" + i, messages: [{ role: "user", content: "Fixture benchmark " + i }], maxOutput: 16, expected: [t.model === "koinos-balanced" ? "No" : "Yes"] })) })) });
    scheduler.providerQualification = runtime.qualifier;
  }
  const authApp = backend("./lib/credit-account-web").createCreditAccountWeb(accounts.router);
  const handler = backend("./test-server").createHandler({ runtime, config, secret: "a".repeat(64), authApp });
  let inferenceCalls = 0;
  const server = http.createServer(async (req, res) => {
    if (["/tokenize", "/completion"].includes(req.url)) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/tokenize") res.end(JSON.stringify({ tokens: encode(body.content) }));
      else { inferenceCalls++; assert.ok(Array.isArray(body.prompt)); res.end(JSON.stringify({ content: "Yes" })); }
      return;
    }
    return handler(req, res);
  });
  cleanup(async () => { server.closeAllConnections(); if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const base = "http://127.0.0.1:" + server.address().port;
  const fetchImpl = (url, init) => { const u = new URL(url); assert.ok([origin, base].includes(u.origin), "fixture forbids public network egress"); return nativeFetch(base + u.pathname + u.search, init); };
  const rpcCalls = []; let transactionSigns = 0;
  f.provider.getAccountRc = async () => "10000000000";
  f.provider.call = async (method, args) => {
    assert.equal(method, "chain.submit_transaction"); rpcCalls.push(args.broadcast);
    const receipt = { id: args.transaction.id, payer: f.signer.getAddress(), rc_used: "1000", reverted: false };
    if (args.broadcast) {
      const op = args.transaction.operations[1].call_contract;
      const decoded = await f.client.serializer.deserialize(op.args, "koin.Request");
      f.request.args = { account: decoded.account, amount: decoded.amount, purchase_quote: USD.quote(decoded.purchase_quote), price_signature: decoded.price_signature };
      f.state.now = clock(); await f.include(args.transaction, { irreversible: irreversiblePurchase });
    }
    return { receipt };
  };
  const originalSign = f.signer.signTransaction.bind(f.signer);
  f.signer.signTransaction = async value => { transactionSigns++; return originalSign(value); };
  const wallet = desktopWallet(f.signer), storage = sessionOnly ? { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text", encryptString() { throw Error("Plaintext persistence forbidden"); } } : protectedStorage(), settings = { get: (key, fallback) => key === "network.privacyMode" ? "local-first" : fallback };
  const buyerDir = path.join(dir, "buyer"); fs.mkdirSync(buyerDir);
  const accountOptions = { dataDir: buyerDir, settings, wallet, safeStorage: storage, accountOrigin: origin, fetchImpl };
  const account = new AccountService(accountOptions), approvals = [];
  const approval = { response: 1 };
  const dialog = { showMessageBox: async (_window, detail) => { approvals.push(detail); await approval.wait; return { response: approval.responses?.length ? approval.responses.shift() : approval.response }; } };
  const serviceOptions = { dataDir: buyerDir, account, storage, service: { schema: 1, state: "ready", config }, fetchImpl, dialog };
  const service = new CreditService(serviceOptions); service.purchases.clientFactory = () => f.client;
  cleanup(() => service.purchases.stop()); cleanup(() => service.sessionStore?.dispose());
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: new EventEmitter() });
  const providerWallet = desktopWallet(Signer.fromSeed("wallet-first-provider")), providerStorage = protectedStorage();
  const core = { account: { wallet: providerWallet, safeStorage: providerStorage }, settings, gateway: { network: { status: () => ({ privacyMode: "local-first" }) } },
    models: { catalog: { aliases: Object.fromEntries(tariffs.map(t => [t.model, { package: t.model }])), packages: Object.fromEntries(tariffs.map(t => [t.model, { sha256: t.modelHash }])) } } };
  const providerService = { service: serviceOptions.service, dataDir: path.join(dir, "provider"), fetchImpl };
  const providerDevice = new ProviderDevice({ service: providerService, core, dialog, clock });
  cleanup(() => providerDevice.dispose());
  const wire = require("../lib/koin-network/payment-network").protocol(target);
  const request = async (route, body, token) => {
    const response = await fetchImpl(origin + route, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  async function register(context) {
    const body = { address: context.config.owner, ts: clock(), fingerprint: "1".repeat(16), models: [tariff.model], capabilities: { ramGb: 32, [wire.capability]: 1, koinMeteredStreaming: 1 } };
    body.signature = context.signer.register(body);
    const result = await request("/scheduler/worker/register", body); assert.equal(result.status, 200, JSON.stringify(result.body));
    return { token: result.body.token, body };
  }
  let activeWorker;
  cleanup(() => { globalThis.fetch = nativeFetch; });
  cleanup(() => activeWorker?.stop());
  async function startWorker(context) {
    const { Worker } = require("../lib/worker");
    const previous = globalThis.fetch; globalThis.fetch = fetchImpl;
    const acquisitions = [], selected = multiModel ? tariffs.slice(0, 3) : tariffs;
    const workerRuntime = { activeAlias: tariff.model, status: () => ({ activeAlias: workerRuntime.activeAlias, runtime: { kind: "llamacpp", running: true } }),
      acquireFor: async model => { assert.ok(selected.some(t => t.model === model)); acquisitions.push(model); workerRuntime.activeAlias = model; return { endpoint: base, release() {} }; } };
    const models = { ...core.models, aliases: () => tariffs.map(t => ({ alias: t.model, status: "ready", minRamGb: 1 })), packageStatus: () => ({ status: "ready" }) };
    const events = [];
    activeWorker = new Worker({ schedulerUrl, providerSigner: context.signer, runtime: workerRuntime, hardware: { ramBytes: 32e9 }, models,
      modelPins: Object.fromEntries(selected.map(t => [t.model, t.modelHash])), fundedOnly: true, qualificationTarget: target, koinMainnetPilotJobs: true, koinMainnetTarget: target, idlePollMs: 5000, onEvent: event => events.push(event) });
    await activeWorker.start();
    return { worker: activeWorker, events, runtime: workerRuntime, acquisitions, async stop() { await activeWorker.stop(); globalThis.fetch = previous; } };
  }
  return { ...f, dir, backend, account, accountOptions, approvals, approval, service, serviceOptions, providerDevice, providerService, providerWallet, core, window, target, wire,
    config, tariff, tariffs, runtime, networkOverview, scheduler, request, register, wallet, storage, clock, rpcCalls, transactionSigns: () => transactionSigns,
    startWorker, cleanup, inferenceCalls: () => inferenceCalls,
    get devices() { return devices; }, restartDevices() { devices.close(); devices = new (backend("./lib/koin-network/provider-devices").ProviderDevices)(deviceOptions); scheduler.providerDevices = devices; scheduler.koinPrepaid.ledger.providerDevices = devices; }, advance: ms => { offset += ms; } };
}

async function assignedReply(f, context, worker, input, { wrongDevice } = {}) {
  let finished;
  const signal = AbortSignal.timeout(15000), pending = f.service.run("chat-completion", { ...input, stream: false }, signal).then(value => (finished = { value }), error => (finished = { error }));
  let job;
  for (let tries = 0; tries < 100; tries++) {
    const response = await f.request("/scheduler/worker/next-job?token=" + encodeURIComponent(worker.token));
    if (response.body?.job) { job = response.body.job; break; }
    if (finished?.error) throw finished.error;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(job, "real scheduler must assign the authenticated device a prepaid job");
  if (wrongDevice) {
    wrongDevice.signer.assign(job);
    const wrong = await f.request("/scheduler" + f.wire.prefix + "result?token=" + encodeURIComponent(worker.token), { jobId: job.id, output: "No", signature: wrongDevice.signer.result(job, "No") });
    assert.equal(wrong.status, 400); assert.match(wrong.body.error, /assigned device/);
    // Rejecting a result safely cancels the allocation; nothing is charged.
    const ended = await pending; assert.ok(ended.error); return { job, wrong };
  }
  context.signer.assign(job);
  const output = "Yes", proof = context.signer.result(job, output);
  const sent = await f.request("/scheduler" + f.wire.prefix + "result?token=" + encodeURIComponent(worker.token), { jobId: job.id, output, signature: proof });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const completed = await pending; if (completed.error) throw completed.error;
  assert.equal(completed.value.choices[0].message.content, output);
  assert.ok(completed.value.koin.receipt.signature.startsWith("pd1."));
  return { job, proof, answer: completed.value };
}

test("real HTTP wallet-only enrollment, free balance, purchase finality and locked-wallet assigned replies work together", options, async t => {
  const f = await fixture(t), signal = AbortSignal.timeout(45000);
  assert.equal((await f.service.walletInfo(signal)).connected, false);
  const connected = await f.service.connectWallet(f.window, {}, signal);
  assert.equal(connected.state, "connected"); assert.equal(f.account._tokenRecord().scope, "wallet-credits");
  const before = await f.service.run("credit-status", undefined, signal);
  assert.equal(before.credits.free.state, "available"); assert.equal(before.credits.free.available, "1000000"); assert.equal(before.credits.purchased.available, "0");
  f.approval.response = 0;
  const cancelledQuote = await f.service.run("purchase-preview", { usd: "1" }, signal);
  assert.equal((await f.service.run("purchase-approve", cancelledQuote.quote.id, signal, f.window)).state, "cancelled");
  assert.equal(f.transactionSigns(), 0); assert.deepEqual(f.rpcCalls, []);
  assert.equal((await f.service.run("credit-status", undefined, signal)).credits.purchased.available, "0");
  f.approval.response = 1;
  const quote = await f.service.run("purchase-preview", { usd: "1" }, signal);
  const purchase = await f.service.run("purchase-approve", quote.quote.id, signal, f.window);
  assert.ok(purchase.purchase?.txId); assert.equal(f.transactionSigns(), 1); assert.deepEqual(f.rpcCalls, [false, true]);
  assert.equal(f.approvals.filter(a => a.title === "Buy AI credits").length, 2);
  const paid = await f.service.run("credit-status", undefined, signal);
  assert.equal(paid.credits.purchased.available, "100000000");
  assert.equal(paid.purchases.filter(p => p.state === "confirmed").length, 1);
  assert.equal((await f.providerDevice.authorize(f.window, {}, signal)).state, "authorized");
  const context = await f.providerDevice.context(signal), signedWhileUnlocked = f.providerWallet.hashes();
  f.providerWallet.lock(); f.wallet.lock();
  assert.equal(f.providerWallet.status().unlocked, false); assert.equal(f.wallet.status().unlocked, false);
  const running = await f.startWorker(context);
  const answer = await f.service.run("chat-completion", { model: "koinos-network:" + f.tariff.model, messages: [{ role: "user", content: "Ready?" }], max_tokens: 16, stream: false }, signal);
  assert.equal(answer.choices[0].message.content, "Yes"); assert.ok(answer.koin.receipt.signature.startsWith("pd1."));
  for (let n = 0; n < 100 && !running.worker.stats.mainnetPilotJobsDone; n++) await new Promise(resolve => setTimeout(resolve, 10));
  await running.stop();
  assert.equal(running.worker.stats.mainnetPilotJobsDone, 1, JSON.stringify(running.events));
  assert.equal(f.inferenceCalls(), 1, "actual Worker ran the pinned-tokenizer local inference protocol");
  assert.equal(f.providerWallet.hashes(), signedWhileUnlocked, "assigned work never reaches the locked wallet signer");
  assert.equal(f.transactionSigns(), 1, "chat does not sign a wallet transaction");
  const after = await f.service.run("credit-status", undefined, signal);
  assert.ok(BigInt(after.credits.free.available) < BigInt(before.credits.free.available));
  assert.equal(after.credits.purchased.available, paid.credits.purchased.available, "free credits are used first");
  assert.equal(after.usage.length, 1); assert.equal(after.usage[0].purchased, "0");
  assert.equal(answer.koin.receipt.provider, f.providerWallet.address);
  const restartedAccount = new AccountService(f.accountOptions);
  assert.equal((await restartedAccount.creditAuthorization(f.config.schedulerUrl, signal)).accountId, connected.accountId, "protected wallet credit access survives desktop restart while locked");
  const restartedDevice = new ProviderDevice({ service: f.providerService, core: f.core, dialog: { showMessageBox: () => { throw Error("No new approval expected"); } }, clock: f.clock });
  f.cleanup(() => restartedDevice.dispose());
  assert.equal((await restartedDevice.context(signal)).signer.address, f.providerWallet.address);
});

test("an included purchase outlives its quote, survives restart and credits once without cancellation or another signature", options, async t => {
  const f = await fixture(t, { irreversiblePurchase: false, quoteTtlMs: 60000 }), signal = AbortSignal.timeout(45000), progress = [];
  f.service.purchases.clock = f.clock; f.service.purchases.quotes.clock = f.clock;
  f.service.purchases.progress = value => progress.push(value);
  await f.service.connectWallet(f.window, {}, signal);
  const preview = await f.service.run("purchase-preview", { usd: "1" }, signal);
  const bought = await f.service.run("purchase-approve", preview.quote.id, signal, f.window);
  assert.equal(bought.state, "pending"); assert.ok(bought.purchase.txId);
  const reviewedCount = f.approvals.length;
  assert.equal(f.approvals.filter(a => a.title === "Buy AI credits").length, 1);
  assert.equal(f.transactionSigns(), 1); assert.deepEqual(f.rpcCalls, [false, true]);
  assert.equal((await f.service.run("credit-status", undefined, signal)).credits.purchased.available, "0", "reversible inclusion cannot spend credits");

  // The payment was included before its 60-second quote expired. Time spent
  // waiting for LIB must never turn that successful inclusion into a refund,
  // a cancellation approval or another signed purchase.
  f.advance(61000); f.state.now = f.clock(); f.state.height++;
  await f.service.run("purchase-sync", undefined, signal);
  const included = (await f.service.purchaseInfo(signal)).localPurchase;
  assert.equal(included.quoteExpired, true);
  assert.equal(included.confirmation.state, "included");
  assert.equal(included.confirmation.txId, bought.purchase.txId);
  assert.equal(included.recovery, null);
  assert.match(included.detail, /included in a block/i);
  assert.doesNotMatch(included.detail, /zero-transfer|use Continue payment/i);
  const retry = await f.service.run("purchase-retry", undefined, signal, f.window);
  assert.equal(retry.state, "pending");
  assert.equal(f.approvals.length, reviewedCount, "included payment must not open a cancellation or second purchase approval");
  assert.equal(f.transactionSigns(), 1); assert.deepEqual(f.rpcCalls, [false, true]);
  assert.ok(progress.some(p => p.stage === "awaiting-confirmation" && p.blockHeight && p.irreversibleHeight), "progress exposes verified inclusion while waiting for LIB");

  f.service.purchases.stop();
  const resumed = new CreditService({ ...f.serviceOptions, purchaseProgress: value => progress.push(value) });
  resumed.purchases.clientFactory = () => f.client;
  resumed.purchases.clock = f.clock; resumed.purchases.quotes.clock = f.clock;
  f.cleanup(() => resumed.purchases.stop()); f.cleanup(() => resumed.sessionStore?.dispose());
  await resumed.run("purchase-sync", undefined, signal);
  assert.equal((await resumed.purchaseInfo(signal)).localPurchase.confirmation.state, "included", "restart reobserves the saved exact envelope");
  f.state.lib = f.state.height;
  await resumed.run("purchase-sync", undefined, signal);
  await resumed.run("purchase-sync", undefined, signal);
  const paid = await resumed.run("credit-status", undefined, signal);
  assert.equal(paid.credits.purchased.available, "100000000");
  assert.equal(paid.purchases.filter(p => p.state === "confirmed").length, 1);
  assert.equal((await resumed.purchaseInfo(signal)).localPurchase, null);
  assert.ok(progress.some(p => p.stage === "complete" && p.outcome === "credited" && p.txId === bought.purchase.txId));
  assert.equal(f.approvals.length, reviewedCount); assert.equal(f.transactionSigns(), 1);
  assert.deepEqual(f.rpcCalls, [false, true], "confirmation and restart never broadcast another envelope");
});

test("retry after restart recovers an already-confirmed expired quote without cancelling or buying twice", options, async t => {
  const f = await fixture(t, { quoteTtlMs: 60000 }), signal = AbortSignal.timeout(45000);
  f.service.purchases.clock = f.clock; f.service.purchases.quotes.clock = f.clock;
  await f.service.connectWallet(f.window, {}, signal);
  const preview = await f.service.run("purchase-preview", { usd: "1" }, signal);
  const bought = await f.service.run("purchase-approve", preview.quote.id, signal, f.window);
  const reviewedCount = f.approvals.length;
  assert.equal((await f.service.run("credit-status", undefined, signal)).credits.purchased.available, "100000000");
  assert.ok((await f.service.purchaseInfo(signal)).localPurchase, "desktop saved payment still awaits its own finality reconciliation");
  f.advance(61000); f.state.now = f.clock(); f.state.height++; f.state.lib = f.state.height;
  f.service.purchases.stop();
  const resumed = new CreditService(f.serviceOptions);
  resumed.purchases.clientFactory = () => f.client;
  resumed.purchases.clock = f.clock; resumed.purchases.quotes.clock = f.clock;
  f.cleanup(() => resumed.purchases.stop()); f.cleanup(() => resumed.sessionStore?.dispose());
  const pending = (await resumed.purchaseInfo(signal)).localPurchase;
  assert.equal(pending.quoteExpired, true); assert.equal(pending.txId, bought.purchase.txId);
  assert.doesNotMatch(pending.detail, /zero-transfer cancellation|expired before submission/i);
  const recovered = await resumed.run("purchase-retry", undefined, signal, f.window);
  assert.equal(recovered.state, "complete");
  assert.equal(recovered.purchase.state, "funded");
  assert.equal((await resumed.purchaseInfo(signal)).localPurchase, null);
  const paid = await resumed.run("credit-status", undefined, signal);
  assert.equal(paid.credits.purchased.available, "100000000");
  assert.equal(paid.purchases.filter(p => p.state === "confirmed").length, 1);
  assert.equal(f.approvals.length, reviewedCount); assert.equal(f.transactionSigns(), 1);
  assert.deepEqual(f.rpcCalls, [false, true]);
});

const BUY_CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
test("the real Buy button crosses registered desktop IPC, native review and HTTP purchase confirmation", {
  ...options, skip: !BACKEND || !fs.existsSync(BUY_CHROMIUM), timeout: 90000,
}, async t => {
  const f = await fixture(t), signal = AbortSignal.timeout(75000);
  assert.equal(f.account._token(), null);
  assert.equal(f.wallet.status().unlocked, true);
  const { CreditPurchases } = require("../../electron/credit-purchases");
  const context = CreditService.prototype.context, open = CreditPurchases.prototype.open;
  const preparePurchase = CreditService.prototype.preparePurchase;
  // Keep the production IPC/controller intact. Only its injected deployment,
  // read-only chain and OS review are the existing isolated fixture boundary.
  t.mock.method(CreditService.prototype, "context", function (s, auth) { return context.call(f.service, s, auth); });
  t.mock.method(CreditService.prototype, "preparePurchase", function (window, s) { return preparePurchase.call(f.service, window, s); });
  t.mock.method(CreditPurchases.prototype, "open", function (...args) {
    this.clientFactory = () => f.client; this.fetchImpl = f.service.fetchImpl;
    return open.apply(this, args);
  });
  const desktop = await require("../server").createCore({ dataDir: path.join(f.dir, "browser-core"), port: 0, onEvent() {} });
  f.cleanup(() => desktop.stop());
  const appOrigin = "http://127.0.0.1:" + await desktop.start();
  f.window.webContents.mainFrame = { url: appOrigin + "/" };
  let handler;
  const registration = require("../../electron/koin-test-ipc").registerTestPaymentIPC({
    dataDir: f.service.dataDir, core: { account: f.account, gateway: { network: { trackShadowRequest: () => () => {} } } },
    dialog: f.service.dialog, isTest: true, origin: appOrigin, getMainWindow: () => f.window,
    ipcMain: { handle: (_name, fn) => { handler = fn; } },
  });
  f.cleanup(() => registration.dispose());
  const browser = await require("playwright-core").chromium.launch({ executablePath: BUY_CHROMIUM, args: ["--no-sandbox"] });
  f.cleanup(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } }), calls = [], errors = [], progress = [];
  f.window.webContents.send = (channel, value) => {
    assert.equal(channel, "koin:purchase-progress"); progress.push(value);
    void page.evaluate(value => window.fixturePurchaseProgress?.(value), value).catch(error => errors.push(error.message));
  };
  let delayPreview = false, previewArrived, releasePreview, failSummary = false;
  page.on("pageerror", error => errors.push(error.message));
  const event = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame };
  await page.exposeBinding("fixtureDesktopIPC", async (_source, action, input) => {
    calls.push(action);
    if (["purchase-connect", "purchase-info", "purchase-preview", "purchase-approve", "purchase-stop", "credit-purchase-retry", "credit-status"].includes(action)) {
      const reply = await handler(event, action, input);
      if (action === "purchase-preview" && delayPreview) {
        const release = new Promise(resolve => { releasePreview = resolve; });
        previewArrived(); await release;
      }
      return reply;
    }
    // Unrelated startup panes do not make public network requests in this test.
    if (action === "purchase-capabilities") return { purchasePricePreview: false };
    if (action === "status") return { enabled: true, configured: false, mode: "test-deployment" };
    if (action === "chat-info") return { configured: true, enabled: true, product: "prepaid-usd-v1", activation: "ready", models: [] };
    if (action.startsWith("provider-public-")) return { state: "unavailable", detail: "Separate provider fixture" };
    throw Error("This read is not needed by the isolated purchase: " + action);
  });
  await page.addInitScript(() => {
    localStorage.setItem("kai-interface-language", "en");
    const listeners = new Set();
    window.fixturePurchaseProgress = value => { for (const listener of listeners) listener(value); };
    window.kaiKoinTestBridge = { onProgress: () => () => {},
      onPurchaseProgress: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      run: (action, input) => window.fixtureDesktopIPC(action, input) };
  });
  await page.route("**/core/koinos/rpc", route => route.request().postDataJSON().channel === "wallet:summary"
    ? route.fulfill(failSummary ? { status: 503, json: { ok: false, error: "Background balance temporarily unavailable" } }
      : { json: { ok: true, data: { address: f.wallet.address, network: "mainnet", tokenSymbol: "KOIN", koin: "100", usd: 25 } } })
    : route.continue());
  await page.route("**/core/earn", route => route.fulfill({ json: { wallet: f.wallet.status(), worker: { running: false } } }));
  await page.goto(appOrigin);
  await page.locator('.product-sidebar-credits [data-product-view="buy-credits"]').click();
  await page.waitForFunction(() => !document.getElementById("product-quote-refresh").disabled);
  assert.equal(calls.includes("purchase-connect"), false, "page opening does not connect or sign");
  f.approval.response = 0;
  await page.locator("#product-quote-refresh").click();
  await page.waitForFunction(() => /connection cancelled/i.test(document.getElementById("product-quote-state").textContent));
  assert.equal(f.account._token(), null); assert.equal(f.wallet.hashes(), 0);
  assert.equal(calls.includes("purchase-preview"), false); assert.equal(calls.includes("purchase-approve"), false);
  assert.equal(f.transactionSigns(), 0); assert.deepEqual(f.rpcCalls, []);
  assert.equal(await page.locator("#view-buy-credits").isVisible(), true);
  f.approval.responses = [1, 0];
  await page.locator("#product-quote-refresh").click();
  await page.waitForFunction(() => document.getElementById("product-quote-state").textContent.includes("Payment cancelled"));
  assert.equal(f.account._tokenRecord().scope, "wallet-credits");
  assert.equal(f.wallet.hashes(), 1, "connection acceptance signs only the domain-bound connection challenge");
  assert.equal(await page.locator("#view-buy-credits").isVisible(), true);
  assert.equal(await page.locator("#view-settings").isVisible(), false);
  assert.equal(f.approvals.filter(a => a.title === "Buy AI credits").length, 1);
  assert.equal(f.transactionSigns(), 0); assert.deepEqual(f.rpcCalls, []);
  f.approval.response = 1; delayPreview = true;
  let releaseApproval;
  f.approval.wait = new Promise(resolve => { releaseApproval = resolve; });
  const quoted = new Promise(resolve => { previewArrived = resolve; });
  await page.locator("#product-quote-refresh").click();
  await quoted;
  failSummary = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForFunction(() => document.getElementById("product-purchase-detail").textContent.includes("Background balance temporarily unavailable"));
  assert.equal(await page.locator("#product-quote-refresh").textContent(), "Getting current price…");
  failSummary = false; releasePreview();
  await page.waitForFunction(() => document.getElementById("product-payment-progress").dataset.stage === "wallet-approval");
  assert.equal(await page.locator("#product-payment-progress").getAttribute("aria-busy"), "true");
  assert.equal(await page.locator("#product-payment-progress").isVisible(), true);
  assert.equal(await page.locator(".product-payment-spinner").isVisible(), true);
  assert.match(await page.locator("#product-payment-progress-label").textContent(), /wallet/i);
  assert.equal(f.transactionSigns(), 0, "wallet progress is visible before any signing");
  releaseApproval();
  await page.waitForFunction(() => document.getElementById("product-payment-progress-label").textContent === "Credits added");
  assert.equal(f.approvals.filter(a => a.title === "Buy AI credits").length, 2);
  assert.equal(calls.filter(a => a === "purchase-connect").length, 3);
  assert.equal(f.approvals.filter(a => a.title === "Connect wallet to network credits").length, 2, "the accepted durable connection is reused for the next Buy");
  assert.equal(f.wallet.hashes(), 1, "a connected purchase does not sign another connection proof");
  assert.equal(calls.filter(a => a === "purchase-preview").length, 2);
  assert.equal(calls.filter(a => a === "purchase-approve").length, 2);
  assert.equal(f.transactionSigns(), 1); assert.deepEqual(f.rpcCalls, [false, true]);
  const completed = progress.find(p => p.stage === "complete" && p.outcome === "credited");
  assert.ok(completed, "registered desktop IPC delivers the actual backend-confirmed result");
  const phases = progress.filter(p => p.operationId === completed.operationId).map(p => p.stage);
  for (const stage of ["getting-price", "checking-network", "wallet-approval", "rechecking-payment", "signing", "checking-mana", "submitting", "updating-credits", "complete"])
    assert.ok(phases.includes(stage), "real purchase emits " + stage);
  assert.ok(phases.indexOf("wallet-approval") < phases.indexOf("signing"));
  assert.ok(phases.indexOf("signing") < phases.indexOf("submitting"));
  assert.equal(await page.locator("#product-payment-progress").getAttribute("aria-busy"), "false");
  const paid = await f.service.run("credit-status", undefined, signal);
  assert.equal(paid.credits.purchased.available, "100000000");
  assert.equal(paid.purchases.filter(p => p.state === "confirmed").length, 1);
  await page.waitForFunction(() => document.getElementById("product-quote-refresh").textContent === "Buy credits" && !document.getElementById("product-quote-refresh").disabled);
  const previous = f.account._tokenRecord();
  f.account._saveToken(previous.token, { ...previous, expiresAt: Date.now() - 1 });
  delayPreview = false;
  f.approval.responses = [1, 0];
  await page.locator("#product-quote-refresh").click();
  await page.waitForFunction(() => document.getElementById("product-quote-state").textContent.includes("Payment cancelled") || document.getElementById("product-quote-state").getAttribute("role") === "alert");
  assert.match(await page.locator("#product-quote-state").textContent(), /Payment cancelled/);
  assert.equal(f.approvals.filter(a => a.title === "Connect wallet to network credits").length, 3, "expired wallet access renews inside the next purchase");
  assert.equal(f.wallet.hashes(), 2);
  assert.equal(f.account._tokenRecord().accountId, previous.accountId, "renewal retains the purchased-credit account");
  assert.equal((await f.service.run("credit-status", undefined, signal)).credits.purchased.available, "100000000");
  assert.equal(f.transactionSigns(), 1); assert.deepEqual(f.rpcCalls, [false, true]);
  assert.deepEqual(errors, []);
});

test("locked-wallet Worker qualifies shared models, serves either on demand and counts only loaded reward capacity", { ...options, timeout: 180000 }, async t => {
  const f = await fixture(t, { multiModel: true }), signal = AbortSignal.timeout(165000);
  await f.service.connectWallet(f.window, {}, signal);
  await f.providerDevice.authorize(f.window, {}, signal);
  const context = await f.providerDevice.context(signal), signedWhileUnlocked = f.providerWallet.hashes();
  f.providerWallet.lock(); f.wallet.lock();
  const running = await f.startWorker(context), address = f.providerWallet.address;
  async function until(check, message) {
    // Exercise the real serving intervals and signed preparation timestamps;
    // a fake future clock would invalidate the actual desktop worker proofs.
    const end = Date.now() + 120000;
    while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), message + ": " + JSON.stringify(running.events));
  }
  await until(() => ["koinos-smart", "koinos-fast"].every(model => f.runtime.qualifier.status(address, model)?.state === "qualified") &&
    f.runtime.qualifier.status(address, "koinos-balanced")?.state === "failed", "actual signed model qualifications must finish");
  const registered = [...f.scheduler.workers.values()].find(w => w.address === address);
  assert.equal(registered.capabilities.koinModelOnDemand, 1, "on-demand capability is covered by real device registration");
  assert.deepEqual([...registered.models].sort(), ["koinos-balanced", "koinos-fast", "koinos-smart"]);
  assert.equal(f.runtime.qualifier.status(address, "llama-3.1-8b"), null, "installed but unselected models never receive benchmarks");
  assert.equal(f.runtime.qualifications().length, 2, "failed answers do not create qualification");
  assert.ok(running.events.some(e => e.type === "worker:model-warming" && e.model === "koinos-fast"), "cold preparation precedes the signed timed benchmark");
  for (const engine of f.runtime.qualifier.engines.values()) for (const record of Object.values(engine.state.records)) {
    assert.ok(record.evidence.results.every(result => result.signature.startsWith("pd1.")), "qualification retains actual scoped-device signature evidence");
  }
  const loaded = running.runtime.activeAlias, other = loaded === "koinos-smart" ? "koinos-fast" : "koinos-smart";
  assert.ok(["koinos-smart", "koinos-fast"].includes(loaded));
  const reportPresence = async () => {
    const prior = f.devices.presence(registered), wait = Math.max(0, (prior?.at || 0) + 10001 - Date.now());
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    await running.worker._koinPresence();
  };
  await reportPresence();
  await until(() => f.networkOverview().models.filter(m => m.available).length === 2, "both separately qualified models must be available");
  const readiness = f.backend("./lib/koin-network/provider-readiness").providerReadiness(f.runtime, address);
  assert.equal(readiness.models.find(m => m.model === other).onDemand, true);
  assert.equal(readiness.models.find(m => m.model === loaded).onDemand, false);
  const statusOptions = { config: context.config, access: context.access, approvedModels: f.tariffs.map(t => t.model), signal, clock: f.clock };
  const readStatus = require("../../electron/koin-provider-status").readProviderStatus;
  const observed = await readStatus(statusOptions);
  assert.deepEqual([...observed.readyModels].sort(), ["koinos-fast", "koinos-smart"]);
  const failed = observed.models.find(m => m.model === "koinos-balanced");
  assert.equal(failed.state, "qualification-failed");
  assert.deepEqual(failed.qualification, { state: "failed", passed: 0, completed: 1, total: 1,
    retryAt: f.runtime.qualifier.status(address, "koinos-balanced", registered).retryAt, required: 1,
    failure: { code: "quality", wrongAnswers: 1, deadlines: 0, unknown: 0 } }, "real signed HTTP status reaches the renderer boundary with actual bounded reasons");
  assert.equal(/outputHash|signedMaterial|signature|authorization|deviceId|prompt/.test(JSON.stringify(observed)), false, "private evidence and device credentials never enter renderer metadata");
  const legacy = await readStatus({ ...statusOptions, access: { ...context.access, readStatus: async nextSignal => {
    const value = await context.access.readStatus(nextSignal);
    for (const provider of value.providers) for (const row of [provider, ...(provider.models || [])]) {
      if (!row.qualification) continue;
      delete row.qualification.required; delete row.qualification.phase; delete row.qualification.failure;
    }
    return value;
  } } });
  const legacyFailed = legacy.models.find(m => m.model === "koinos-balanced");
  assert.equal(legacyFailed.state, "qualification-failed");
  assert.equal(legacyFailed.qualification.failure, undefined, "older servers do not invent a failure reason");
  assert.equal(legacyFailed.qualification.required, undefined, "older servers do not invent the required score");
  assert.deepEqual(legacy.readyModels, observed.readyModels, "optional diagnostics do not affect readiness");
  for (const id of ["koinos-balanced", "llama-3.1-8b"]) assert.equal(f.networkOverview().models.find(m => m.id === id).available, false);
  const rewardModels = () => Object.values(f.scheduler.koinShadow.ledger.state.qualifications).filter(q => q.expires > f.clock()).map(q => q.model);
  await f.runtime.collectRewards();
  assert.deepEqual(rewardModels(), [loaded], "advertising two ready models never creates two simultaneous reward slots");
  const beforeJobs = f.scheduler.koinPrepaid.ledger.jobs().length;
  for (const model of ["koinos-balanced", "llama-3.1-8b"]) {
    await assert.rejects(f.service.run("chat-completion", { model: "koinos-network:" + model, messages: [{ role: "user", content: "Must not dispatch" }], max_tokens: 16, stream: false }, signal));
  }
  assert.equal(f.scheduler.koinPrepaid.ledger.jobs().length, beforeJobs, "unqualified and excluded models cannot enqueue paid work");
  const acquired = running.acquisitions.length;
  const answer = await f.service.run("chat-completion", { model: "koinos-network:" + other, messages: [{ role: "user", content: "Switch to the other shared model" }], max_tokens: 16, stream: false }, signal);
  assert.equal(answer.choices[0].message.content, "Yes");
  assert.ok(answer.koin.receipt.signature.startsWith("pd1."));
  await until(() => running.worker.stats.mainnetPilotJobsDone === 1, "the actual Worker must finish the assigned model switch");
  assert.deepEqual(running.acquisitions.slice(acquired), [other]);
  assert.equal(running.runtime.activeAlias, other);
  await reportPresence();
  await f.runtime.collectRewards();
  assert.deepEqual(rewardModels(), [other], "model switch replaces, rather than multiplies, active reward capacity");
  assert.deepEqual(f.networkOverview().models.filter(m => m.available).map(m => m.id).sort(), ["koinos-fast", "koinos-smart"]);
  assert.equal(f.providerWallet.status().unlocked, false);
  assert.equal(f.providerWallet.hashes(), signedWhileUnlocked, "qualification and assigned work use only the non-spending device key");
  assert.equal(f.transactionSigns(), 0, "fixture uses actual free allowance and never signs a payment");
  await running.stop();
});

test("real HTTP paid jobs interrupt between signed model checks and precede failed retries without changing qualification", options, async t => {
  // One shared controlled clock covers the actual desktop protocol validators,
  // scoped signatures, server journals and HTTP credit flow. No real time or
  // unverified qualification records are substituted into only one side.
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const f = await fixture(t, { multiModel: true, qualificationCases: 2 }), signal = AbortSignal.timeout(45000);
  await f.service.connectWallet(f.window, {}, signal);
  await f.providerDevice.authorize(f.window, {}, signal);
  const context = await f.providerDevice.context(signal), address = f.providerWallet.address, signed = f.providerWallet.hashes();
  f.providerWallet.lock(); f.wallet.lock();
  let token, sequence = 0;
  async function register() {
    const body = { address, ts: now, fingerprint: "1".repeat(16), models: ["koinos-smart", "koinos-balanced"],
      capabilities: { ramGb: 32, [f.wire.capability]: 1, koinMeteredStreaming: 1, koinQualification: 1, koinModelOnDemand: 1, preferredModel: "koinos-smart" } };
    body.signature = context.signer.register(body);
    const registered = await f.request("/scheduler/worker/register", body);
    assert.equal(registered.status, 200, JSON.stringify(registered.body)); token = registered.body.token;
  }
  async function presence(model) {
    const tariff = f.tariffs.find(t => t.model === model);
    const report = { schema: 1, session: "a".repeat(32), sequence: ++sequence, at: now, model, modelHash: tariff.modelHash, ready: true };
    const result = await f.request("/scheduler/koin/presence", { address, report, signature: context.signer.presence(report) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  const poll = () => f.request("/scheduler/worker/next-job?token=" + encodeURIComponent(token));
  async function answer(job, output = "Yes") {
    assert.equal(job.type, "koin-provider-qualification");
    context.signer.assign(job);
    const sent = await f.request("/scheduler/koin/provider/qualification/result?token=" + encodeURIComponent(token),
      { jobId: job.challenge.id, output, signature: context.signer.qualification(job, P.hash(output)) });
    assert.equal(sent.status, 200, JSON.stringify(sent.body)); assert.equal(sent.body.accepted, true);
  }
  async function queuePaid() {
    const before = f.scheduler.koinPrepaid.ledger.jobs().length; let completed;
    const pending = f.service.run("chat-completion", { model: "koinos-network:koinos-smart", messages: [{ role: "user", content: "Serve qualified Smart " + before }], max_tokens: 16, stream: false }, signal)
      .then(value => (completed = { value }), error => (completed = { error }));
    for (let n = 0; n < 500 && f.scheduler.koinPrepaid.ledger.jobs().length === before && !completed; n++) await new Promise(resolve => setTimeout(resolve, 10));
    if (completed?.error) throw completed.error;
    assert.equal(f.scheduler.koinPrepaid.ledger.jobs().length, before + 1, "a real prepaid ledger reservation must exist before polling");
    return { pending, async finish(job) {
      assert.equal(job.type, f.wire.jobType); assert.equal(job.model, "koinos-smart"); context.signer.assign(job);
      const sent = await f.request("/scheduler" + f.wire.prefix + "result?token=" + encodeURIComponent(token),
        { jobId: job.id, output: "Yes", signature: context.signer.result(job, "Yes") });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      const result = await pending; if (result.error) throw result.error;
      assert.equal(result.value.choices[0].message.content, "Yes"); assert.ok(result.value.koin.receipt.signature.startsWith("pd1."));
    } };
  }
  await register(); await presence("koinos-smart");
  await answer((await poll()).body.job); await answer((await poll()).body.job);
  assert.equal(f.runtime.qualifier.status(address, "koinos-smart").state, "qualified");
  assert.equal((await poll()).status, 204, "fresh qualified capacity gets a serving interval before another model check");
  now += 30001;
  const preparation = (await poll()).body.job;
  assert.equal(preparation.type, "koin-provider-prepare"); assert.equal(preparation.model, "koinos-balanced");
  await presence("koinos-balanced");
  const challenge = (await poll()).body.job;
  const paid = await queuePaid();
  assert.equal((await poll()).status, 204, "an issued signed challenge keeps its original assignment");
  await answer(challenge);
  const paidJob = (await poll()).body.job;
  assert.equal(f.runtime.qualifier.status(address, "koinos-balanced").completed, 1, "paid work is assigned before the next benchmark answer");
  now += 10001; await presence("koinos-smart"); await paid.finish(paidJob);
  const secondPreparation = (await poll()).body.job;
  assert.equal(secondPreparation.type, "koin-provider-prepare"); assert.equal(secondPreparation.model, "koinos-balanced");
  now += 10001; await presence("koinos-balanced"); await answer((await poll()).body.job);
  const failed = f.runtime.qualifier.status(address, "koinos-balanced");
  assert.equal(failed.state, "failed"); assert.deepEqual(failed.failure, { code: "quality", wrongAnswers: 2, deadlines: 0, unknown: 0 });
  const restore = (await poll()).body.job;
  assert.equal(restore.type, "koin-provider-prepare"); assert.equal(restore.model, "koinos-smart", "idle qualified capacity is restored without another buyer message");
  now += 10001; await presence("koinos-smart");
  assert.equal((await poll()).status, 204);
  now += 300001; await register(); await presence("koinos-smart");
  const retryPaid = await queuePaid(); await retryPaid.finish((await poll()).body.job);
  assert.equal(f.runtime.qualifier.status(address, "koinos-balanced").state, "failed", "a due failed retry does not preempt queued paid work");
  assert.deepEqual(f.runtime.qualifications().map(q => q.model), ["koinos-smart"], "a failed model never gains eligibility from local readiness or successful paid work elsewhere");
  assert.equal(f.providerWallet.hashes(), signed); assert.equal(f.transactionSigns(), 0);
});

test("temporary wallet access survives locking for free chat and cannot escalate into paid usage or account administration", options, async t => {
  const messages = [{ role: "user", content: "Temporary free message" }];
  const f = await fixture(t, { sessionOnly: true, freeAllowance: String(Buffer.byteLength(JSON.stringify(messages)) + 3) }), signal = AbortSignal.timeout(45000);
  f.approval.response = 0;
  assert.equal((await f.service.connectWallet(f.window, { sessionOnly: true }, signal)).state, "cancelled");
  assert.equal(f.wallet.hashes(), 0, "cancelled enrollment never signs");
  f.approval.response = 1;
  assert.equal((await f.service.connectWallet(f.window, { sessionOnly: true }, signal)).state, "connected");
  const authorization = await f.account.creditAuthorization(schedulerUrl, signal);
  assert.equal(authorization.sessionOnly, true);
  assert.equal((await f.service.purchaseInfo(signal)).activation, "secure-storage-required");
  await assert.rejects(f.service.run("purchase-preview", { usd: "1" }, signal), /free credits only/);
  const auth = { sessionToken: authorization.sessionToken, creditWallet: f.wallet.address };
  for (const [action, body] of [["quote-usd", { dollars: "1", intentId: P.hash("forbidden") }], ["purchase", { txId: "0x1220" + "1".repeat(64) }],
    ["estimate", { model: f.tariff.model, messages: [{ role: "user", content: "Spend paid balance" }], max_tokens: 16, paidFirst: true }],
    ["run-open", { runId: P.hash("forbidden-run"), model: f.tariff.model, mode: "agent", maxTotal: "1000", freeOnly: false }]]) {
    const rejected = await f.request("/scheduler/koin/prepaid/" + action, { ...auth, ...body });
    assert.equal(rejected.status, 400); assert.match(rejected.body.error, /free credits only/);
  }
  assert.equal((await f.request("/account/api", undefined, authorization.sessionToken)).status, 401);
  await f.providerDevice.authorize(f.window, {}, signal);
  const context = await f.providerDevice.context(signal), worker = await f.register(context);
  f.wallet.lock(); f.providerWallet.lock();
  await assignedReply(f, context, worker, { model: "koinos-network:" + f.tariff.model, messages, max_tokens: 3, paidFirst: true });
  const status = await f.service.run("credit-status", undefined, signal);
  assert.equal(status.usage.length, 1); assert.equal(status.usage[0].purchased, "0"); assert.equal(f.transactionSigns(), 0);
  assert.equal(status.credits.free.available, "0", "the actual service reports exhausted allowance without inventing free credits");
  await assert.rejects(f.service.run("chat-completion", { model: "koinos-network:" + f.tariff.model, messages: [{ role: "user", content: "Another message" }], max_tokens: 3, stream: false }, signal), /Free only/);
  assert.equal((await f.service.run("credit-status", undefined, signal)).usage.length, 1);
  const saved = (await f.service.context(signal)).flow.file;
  assert.ok(!fs.readFileSync(saved, "utf8").includes("Temporary free message"));
  await f.account.signOut();
  const revoked = await f.request("/scheduler/koin/prepaid/status", auth);
  assert.equal(revoked.status, 401);
  assert.equal(new AccountService(f.accountOptions)._token(), null, "temporary access cannot silently survive app restart");
});

test("delegated provider credentials cannot buy credits, administer accounts or substitute another assigned device", options, async t => {
  const f = await fixture(t), signal = AbortSignal.timeout(45000);
  await f.service.connectWallet(f.window, {}, signal); await f.providerDevice.authorize(f.window, {}, signal);
  const first = await f.providerDevice.context(signal), worker = await f.register(first);
  const authorization = first.record.authorization;
  for (const action of ["transfer", "purchase", "grant", "withdraw", "payout-address", "signHash"]) {
    assert.equal(first.signer[action], undefined);
    assert.throws(() => PD.actionHash(authorization, action, Buffer.alloc(32), f.clock()), /outside its authorization/);
  }
  const signature = first.signer.register({ address: first.config.owner, ts: f.clock(), fingerprint: "2".repeat(16), models: [f.tariff.model], capabilities: { [f.wire.capability]: 1 } });
  for (const token of [worker.token, signature, first.auth.sessionToken]) {
    const attempted = await f.request("/scheduler/koin/prepaid/quote-usd", { sessionToken: token, creditWallet: first.config.owner, dollars: "1", intentId: P.hash("malicious") });
    assert.equal(attempted.status, 401);
    assert.equal((await f.request("/account/api", undefined, token)).status, 401);
    assert.equal((await f.request("/account/wallets", { address: f.wallet.address }, token)).status, 401);
  }
  assert.equal(f.transactionSigns(), 0);
  const otherService = { ...f.providerService, dataDir: path.join(f.dir, "other-provider") };
  const other = new ProviderDevice({ service: otherService, core: f.core, dialog: { showMessageBox: async () => ({ response: 1 }) }, clock: f.clock });
  f.cleanup(() => other.dispose()); await other.authorize(f.window, {}, signal); const second = await other.context(signal);
  assert.notEqual(second.signer.deviceId, first.signer.deviceId);
  f.providerWallet.lock();
  await assignedReply(f, first, worker, { model: "koinos-network:" + f.tariff.model, messages: [{ role: "user", content: "Check device binding" }], max_tokens: 16 }, { wrongDevice: second });
  assert.equal((await f.service.run("credit-status", undefined, signal)).usage.length, 0);
  const proofId = PD.authorizationId(first.record.authorization), revocation = f.providerDevice.proof(first, "revoke", PD.hash("revoke:" + proofId));
  assert.equal((await f.request("/scheduler/koin/provider/device/revoke", { signature: revocation })).status, 200);
  f.restartDevices();
  assert.equal((await f.request("/scheduler/worker/heartbeat?token=" + worker.token, {})).status, 401);
  assert.equal(f.devices.active(PD.authorizationId(second.record.authorization)), true, "one revocation does not affect another device");
  f.advance(2592000001); f.restartDevices();
  assert.equal(f.devices.active(PD.authorizationId(second.record.authorization)), false, "expiry remains effective after server restart");
});
