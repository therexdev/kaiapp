"use strict";
// Cross-repository acceptance: actual desktop controllers, HTTP scheduler,
// SQLite ledger and signed receipts. Chain finality and model output are
// deliberately controlled fixtures; no public network or real wallet is used.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http"), { EventEmitter } = require("node:events");
const APP = path.resolve(__dirname, "..");
if (!process.argv[2] || process.argv.length > 4 || (process.argv[3] && process.argv[3] !== "--legacy-backend")) throw Error("Usage: node scripts/verify-credit-flow.js BACKEND_CHECKOUT [--legacy-backend]");
const BACK = path.resolve(process.argv[2]), LEGACY = process.argv[3] === "--legacy-backend";
if (!fs.existsSync(path.join(BACK, "lib/koin-network/prepaid-router.js"))) throw Error("The pinned backend checkout is required for credit-flow verification");
const { Signer } = require(APP + "/node_modules/koilib"), P = require(APP + "/core/lib/koin-network/job-protocol");
const { fixture } = require(APP + "/core/test/helpers/koin-funding-recovery-fixture"), Prices = require(APP + "/core/test/helpers/purchase-price-fixture");
const { CreditPurchases } = require(APP + "/electron/credit-purchases"), { PrepaidChat } = require(APP + "/electron/koin-prepaid-chat"), { CreditProvider } = require(APP + "/electron/credit-provider");
const { Meter } = require(BACK + "/lib/koin-network/metering"), { Scheduler } = require(BACK + "/lib/scheduler");
const storage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s).map(b => b ^ 42), decryptString: b => b.map(n => n ^ 42).toString() };
const json = (res, value) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
async function verifyFlow(t, { priority = false, legacy = false } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => { const parsed = new URL(url); assert.equal(parsed.hostname, "127.0.0.1", "acceptance must never contact a public network"); assert.equal(parsed.protocol, "http:"); return realFetch(url, init); };
  t.after(() => { globalThis.fetch = realFetch; });
  const cleanup = [], f = fixture({ after: fn => cleanup.push(fn) }, { mainnet: true, usd: true }); f.state.now = Date.now();
  let scheduler, provider, runtimeServer, nativeReviews = 0, signedPurchases = 0, inferenceCalls = 0, loaded = null;
  let priceReads = 0, quoteIssues = 0, displayedRate = "25000000", networkObservedAt = Date.now();
  let marketReads = 0;
  const pricingPolicyHash = legacy ? require(APP + "/core/lib/koin-network/purchase-market-estimate").PIN : Prices.pricingPolicyHash;
  const submissions = [], txs = new Map(), blocks = new Map(), actions = [], events = [], loads = [];
  const owner = f.signer.getAddress(), workerSigner = Signer.fromSeed("simple-flow-provider-fixture"), verifier = Signer.fromSeed("funding-recovery-verifier");
  const fallbackOwner = Signer.fromSeed("partial-paid-balance-fixture").getAddress();
  const wallets = { "buyer-session": owner, "provider-session": workerSigner.getAddress(), "fallback-session": fallbackOwner };
  const sign = f.signer.signTransaction.bind(f.signer); f.signer.signTransaction = async tx => { signedPurchases++; return sign(tx); };
  f.provider.getAccountRc = async () => "14938227003";
  f.provider.call = async (method, args) => { assert.equal(method, "chain.submit_transaction"); if (args.broadcast !== false) submissions.push(structuredClone(args.transaction)); return { receipt: { id: args.transaction.id, payer: owner, rc_used: "150000000", reverted: false } }; };
  const originalBlocks = f.provider.getBlocks;
  f.provider.getTransactionsById = async ids => ({ transactions: ids.flatMap(id => txs.has(id) ? [structuredClone(txs.get(id))] : []) });
  f.provider.getBlocks = async (height, count, head, opts) => opts.returnReceipt && blocks.has(Number(height)) ? [structuredClone(blocks.get(Number(height)))] : originalBlocks(height, count, head, opts);
  f.provider.getBlocksById = async ids => ({ block_items: [...blocks.values()].filter(b => ids.includes(b.block_id)).map(b => ({ block_id: b.block_id, block_height: b.block_height })) });
  const include = async (tx, irreversible) => {
    const decoded = await f.client.serializer.deserialize(tx.operations[1].call_contract.args, "koin.Request");
    f.request.args = { account: decoded.account, amount: decoded.amount, purchase_quote: decoded.purchase_quote, price_signature: decoded.price_signature };
    f.state.now = Date.now(); await f.include(tx, { irreversible });
    f.state.block.receipt.transaction_receipts[0].rc_used = "150000000";
    txs.set(tx.id, structuredClone(f.state.record)); blocks.set(f.state.height, structuredClone(f.state.block));
    f.state.nonce = submissions.length > 1 ? "KAM=" : "KAI=";
  };
  const model = "koinos-smart", hash = P.hash("controlled-smart-model");
  const tariff = { model, version: 1, modelHash: hash, tokenizerHash: P.hash("controlled-byte-tokenizer"), templateHash: P.hash("json-template"), inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "2000000", maxOutputTokens: 32, contextTokens: 4096, maxLatencyMs: 10000 };
  const encode = s => [...Buffer.from(s)], meter = new Meter([{ tariff, adapter: { ...tariff, render: JSON.stringify, encode, input: m => encode(JSON.stringify(m)).length, output: s => encode(s).length } }]);
  const server = http.createServer(async (req, res) => {
    try {
      req.url = req.url.replace(/^\/scheduler(?=\/)/, ""); actions.push(req.url.split("?")[0]);
      if (req.url === "/koin/test/lease") { let text = ""; for await (const part of req) text += part; const b = JSON.parse(text); return json(res, { granted: true, owner: b.creditWallet, installation: b.installation, mode: "mainnet-pilot", chainId: f.d.chainId }); }
      await scheduler.handle(req, res);
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/scheduler`;
  const target = { chainId: f.d.chainId, credits: f.d.credits, creditsHash: f.d.creditsHash, domain: require(APP + "/core/lib/koin-network/payment-mode").testDomain(f.d, base), policyHash: meter.policyHash };
  t.after(async () => { await provider?.dispose(); scheduler?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); if (runtimeServer) { runtimeServer.closeAllConnections(); await new Promise(r => runtimeServer.close(r)); } for (const fn of cleanup) await fn(); });
  const backendClient = new (require(BACK + "/lib/koin-network/chain").KoinChain)(f.d, f.provider);
  scheduler = new Scheduler({ priceSources: [], bootstrapPoolSat: "0", dataDir: path.join(f.dir, "backend"), accounts: { sessionAccount: token => wallets[token] ? { id: token } : null, accountView: a => ({ wallets: [{ address: wallets[a.id] }] }) }, koinPrepaid: {
    client: backendClient, target, meter, encryptionKey: Buffer.alloc(32, 42), publicAccounts: true, waitMs: 40000,
    clock: () => (networkObservedAt = Date.now()),
    ...((priority || legacy) ? { freePolicy: { version: 1, accountDaily: "1000", networkDaily: "10000", originDaily: "10000", accountConcurrent: 4, eligibleModels: [model] } } : {}), qualify: () => true, accept: ({ output }) => output === "PONG",
    networkOverview: () => ({ observedAt: networkObservedAt, validUntil: networkObservedAt + 15000, models: [{ id: model, available: !!provider?.worker?.running, providers: provider?.worker?.running ? 1 : 0, freeEligible: priority || legacy }] }),
    purchasePricePreview: () => { priceReads++; const now = Date.now(), { chainId, protocol, poolId } = require(APP + "/core/lib/koin-network/purchase-market").MARKET; return { schema: 1,
      market: { chainId, protocol, poolId }, referenceKind: "merchant-exchange-reference",
      usdPerKoinAtoms: displayedRate, marketObservedAt: now - 60000, expiresAt: now + 300000, windowSeconds: 1800,
      anchorHash: "0x" + P.hash("fixture-price-anchor"), pricingPolicyHash: Prices.pricingPolicyHash, referenceHash: P.hash("fixture-price-reference"),
      maxPurchaseUsdAtoms: "10000000000", maxPurchaseKoinAtoms: "100000000000" }; },
    purchaseQuote: (account, dollars, unit) => { quoteIssues++; assert.equal(unit, "USD"); return Prices.issue({ deployment: f.d, signer: verifier, account, amount: require(APP + "/core/lib/koin-network/purchase-quote").nativeForDollars(dollars, "25000000"), usdPerKoin: "25000000", pricingPolicyHash, version: 1, now: Date.now() }); }
  } });
  runtimeServer = http.createServer(async (req, res) => {
    let text = ""; for await (const part of req) text += part; const b = JSON.parse(text);
    if (req.url === "/tokenize") return json(res, { tokens: encode(b.content) });
    assert.equal(req.url, "/completion"); inferenceCalls++; assert.ok(Array.isArray(b.prompt));
    res.writeHead(200, { "content-type": "text/event-stream" }); res.end('data: {"content":"PONG","stop":true}\n\n');
  });
  await new Promise(r => runtimeServer.listen(0, "127.0.0.1", r));
  const config = { mode: "mainnet-pilot", deployment: f.d, owner, schedulerUrl: base, version: 1, pricingPolicyHash, policyHash: meter.policyHash, model, maxOutput: 16, maxRcPerTransaction: "100000000", maxRcPerDay: "500000000", limits: { amount: "10000000000", perJob: "1000000" } };
  const directory = path.join(f.dir, "buyer"); fs.mkdirSync(directory);
  const access = { authorize: () => ({ owner, sessionToken: "buyer-session" }) };
  const flowOptions = { file: path.join(directory, "chat.json"), config, access, storage, fetchImpl: fetch, progress: value => events.push(value) };
  let chat = new PrepaidChat(flowOptions), c = { config, directory, auth: { accountId: "buyer-session", sessionToken: "buyer-session" }, flow: chat };
  const account = { wallet: { address: owner, signer: f.signer }, assertCreditAuthorization() {} };
  const marketReader = { read: async nextSignal => { nextSignal?.throwIfAborted(); marketReads++; return {
    usdPerKoinAtoms: displayedRate, observedAt: Date.now() - 16 * 60000, expiresAt: Date.now() + 60000,
    anchorHash: "0x" + P.hash("controlled-independent-market"), referenceKind: "market-estimate", windowSeconds: 0, source: "uniswap-v4:vKOIN/USDT" }; } };
  const purchaseOptions = { dataDir: f.dir, account, storage, fetchImpl: fetch, marketReader, clientFactory: () => f.client, dialog: { showMessageBox: async (_window, review) => { nativeReviews++; assert.match(review.detail, /KOIN/); return { response: 1 }; } } };
  let buyer = new CreditPurchases(purchaseOptions);
  const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false, isVisible: () => true, isMinimized: () => false });
  const signal = AbortSignal.timeout(60000);
  const beforeDisplayFiles = fs.readdirSync(directory, { recursive: true }).sort();
  const modelPrices = require(APP + "/electron/credit-model-pricing").configuredModelPricing(config,
    { schema: 1, product: "prepaid-usd-v1", policyHash: meter.policyHash, tariffs: meter.tariffs() });
  assert.equal(modelPrices.policyHash, meter.policyHash);
  assert.deepEqual(modelPrices.models.map(({ model, inputCreditsPerMillion, outputCreditsPerMillion, inputUsdPerMillion, outputUsdPerMillion }) =>
    ({ model, inputCreditsPerMillion, outputCreditsPerMillion, inputUsdPerMillion, outputUsdPerMillion })),
    [{ model, inputCreditsPerMillion: "10", outputCreditsPerMillion: "20", inputUsdPerMillion: "0.01", outputUsdPerMillion: "0.02" }],
    "the configured model's exact rates are visible even before its provider starts");
  assert.equal(provider?.worker?.running, undefined);
  assert.equal(quoteIssues, 0); assert.equal(nativeReviews, 0); assert.equal(signedPurchases, 0);
  if (legacy) {
    const { capabilities } = await chat.call("capabilities", {}, signal);
    assert.notEqual(capabilities.creditPriority, true, "compatibility requires the old deployed service without paid-first support");
    assert.notEqual(capabilities.purchasePricePreview, true, "compatibility requires the old service without read-only price previews");
    assert.deepEqual(await buyer.estimateCapabilities(c, signal), { purchasePricePreview: true, purchasePriceSource: "market-estimate" });
    for (const [usd, koin] of [["1", "4"], ["5", "20"], ["1.23", "4.92"]]) {
      const shown = await buyer.estimate(c, { usd }, signal);
      assert.equal(shown.estimate.koin, koin); assert.equal(shown.estimate.id, undefined);
      assert.equal(shown.estimate.priceDetails.referenceKind, "market-estimate");
      assert.equal(shown.estimate.priceDetails.windowSeconds, 0, "spot display must not claim merchant TWAP validation");
    }
    displayedRate = "50000000";
    assert.equal((await buyer.estimate(c, { usd: "1" }, signal)).estimate.koin, "2", "display refresh uses the changed independent observation");
    assert.equal(marketReads, 4); assert.equal(priceReads, 0); assert.equal(quoteIssues, 0);
    assert.equal(nativeReviews, 0); assert.equal(signedPurchases, 0); assert.equal(submissions.length, 0);
    assert.equal(buyer.quotes.quotes.size, 0); assert.equal(buyer.quotes.intent, undefined);
    assert.deepEqual(fs.readdirSync(directory, { recursive: true }).sort(), beforeDisplayFiles, "display-only prices never create a payment journal or other buyer files");
  }
  if (priority) {
    for (const [usd, koin] of [["1", "4"], ["5", "20"], ["1.23", "4.92"], ["1", "4"]]) {
      const shown = await buyer.estimate(c, { usd }, signal);
      assert.equal(shown.estimate.koin, koin); assert.equal(shown.estimate.id, undefined);
    }
    displayedRate = "50000000";
    assert.equal((await buyer.estimate(c, { usd: "1" }, signal)).estimate.koin, "2", "periodic read follows changed price evidence");
    displayedRate = "25000000";
    assert.equal(priceReads, 5); assert.equal(quoteIssues, 0, "browsing never requests a signed purchase quote");
    assert.equal(nativeReviews, 0); assert.equal(signedPurchases, 0); assert.equal(submissions.length, 0);
    assert.equal(buyer.quotes.quotes.size, 0); assert.equal(buyer.quotes.intent, undefined, "display estimates cannot alter an approval intent");
  }
  const buy = async () => { const q = await buyer.preview(c, { usd: "1" }, signal); assert.equal(q.quote.koin, "4", "Buy reviews the exact signed merchant offer even when the market estimate differs"); const result = await buyer.run(c, window, "purchase-approve", q.quote.id, signal); assert.equal(result.state, "pending"); return submissions.at(-1); };
  const first = await buy(); assert.ok(first); assert.equal(first.header.rc_limit, "500000000"); assert.equal(nativeReviews, 1); assert.equal(signedPurchases, 1); assert.equal(submissions.length, 1);
  assert.equal(scheduler.koinPrepaid.ledger.balance(owner).purchased, "0");
  await include(first, false); await buyer.sync(c, signal); assert.equal(scheduler.koinPrepaid.ledger.balance(owner).purchased, "0", "reversible payment cannot create credits");
  f.state.lib = f.state.height; await buyer.sync(c, signal); await scheduler.koinPrepaid.purchases.tick();
  assert.equal(scheduler.koinPrepaid.ledger.balance(owner).purchased, "100000000");
  assert.equal(await buyer.status(c, signal), null);
  buyer = new CreditPurchases(purchaseOptions);
  const realCall = chat.call.bind(chat); let entered, holdRegistration = true;
  const enteredSync = new Promise(resolve => { entered = resolve; });
  chat.call = async (action, body, nextSignal, onCompletion) => {
    if (action === "purchase" && holdRegistration) { holdRegistration = false; entered(); await new Promise((resolve, reject) => { nextSignal.addEventListener("abort", () => reject(nextSignal.reason), { once: true }); }); }
    return realCall(action, body, nextSignal, onCompletion);
  };
  const background = buyer.sync(c, signal).catch(() => {}); await enteredSync;
  assert.equal(await buyer.status(c, signal), null, "read-only background confirmation must not appear as an open review");
  const second = await buy(); await background; assert.notEqual(second.id, first.id); assert.equal(second.header.rc_limit, "350000000", "second payment uses daily remainder after the actual irreversible cost"); assert.equal(nativeReviews, 2); assert.equal(signedPurchases, 2); assert.equal(submissions.length, 2);
  await include(second, true); await buyer.sync(c, signal); await scheduler.koinPrepaid.purchases.tick(); assert.equal(scheduler.koinPrepaid.ledger.balance(owner).purchased, "200000000");
  const providerDir = path.join(f.dir, "provider"); fs.mkdirSync(providerDir);
  const providerConfig = { ...config, owner: workerSigner.getAddress() }, providerAuth = { accountId: "provider-session", sessionToken: "provider-session" };
  const providerFlow = new PrepaidChat({ ...flowOptions, config: providerConfig, file: path.join(providerDir, "chat.json"), access: { authorize: () => ({ owner: workerSigner.getAddress(), sessionToken: "provider-session" }) } });
  const providerContext = { config: providerConfig, directory: providerDir, auth: providerAuth, flow: providerFlow };
  const providerAccount = { wallet: { address: workerSigner.getAddress(), status: () => ({ unlocked: true }), signHash: async h => Buffer.from(await workerSigner.signHash(h)).toString("base64") }, assertCreditAuthorization() {}, safeStorage: storage };
  const providerPurchases = new CreditPurchases({ dataDir: providerDir, account: providerAccount, fetchImpl: fetch,
    storage: { forPurpose: purpose => { assert.equal(purpose, "purchase-installation"); return storage; } } });
  const websiteAccount = { ...providerAccount, safeStorage: { isEncryptionAvailable: () => true,
    encryptString() { throw Error("Provider payments must not use website credential storage"); }, decryptString() { throw Error("Provider payments must not use website credential storage"); } } };
  const core = { account: websiteAccount, hardware: { ramBytes: 32e9 }, models: { catalog: { aliases: { [model]: { package: "controlled", minRamGb: 8 } }, packages: { controlled: { sha256: hash, sizeBytes: 1000 } } }, aliases: () => [{ alias: model, status: "ready", minRamGb: 8 }], quarantineOf: () => null, packageStatus: () => ({ status: "ready" }) },
    runtime: { status: () => ({ activeAlias: loaded, runtime: { kind: "llamacpp", running: !!loaded } }), acquireFor: async id => { loaded = id; loads.push(id); return { endpoint: `http://127.0.0.1:${runtimeServer.address().port}/`, release() {} }; } }, gateway: { earn: { stop: async () => {} }, network: { trackShadowRequest: () => () => {} } } };
  provider = new CreditProvider({ core, service: { account: providerAccount, purchases: providerPurchases, dataDir: providerDir, fetchImpl: fetch, context: async () => providerContext }, readStatus: async () => ({ state: "connecting", model }) });
  assert.equal(inferenceCalls, 0); await provider.start(signal); assert.equal(provider.worker.running, true); assert.equal(loaded, model); assert.equal(inferenceCalls, 0, "Earn starts before any chat");
  const body = { model: "koinos-network:" + model, messages: [{ role: "user", content: "Reply PONG" }], max_tokens: 16, ...(priority ? { paidFirst: true } : {}) };
  const answer = await chat.chat(window, body, signal); assert.equal(answer.choices[0].message.content, "PONG");
  assert.equal(inferenceCalls, 1); assert.equal(nativeReviews, 2); assert.equal(signedPurchases, 2, "Chat must not sign a wallet transaction");
  const spent = scheduler.koinPrepaid.ledger.balance(owner).spent; assert.equal(spent, legacy ? "0" : answer.koin.receipt.usage.amount);
  assert.ok(BigInt(answer.koin.receipt.usage.amount) > 0n); assert.equal(events.filter(v => v?.delta).map(v => v.delta).join(""), "PONG");
  chat = new PrepaidChat(flowOptions); const recovered = await chat.recover(window, signal); assert.equal(recovered.completion.id, answer.id);
  assert.equal(scheduler.koinPrepaid.ledger.balance(owner).spent, spent); assert.equal(inferenceCalls, 1); assert.equal(scheduler.koinPrepaid.ledger.purchases(owner).length, 2);
  const priorityResults = [];
  if (legacy) {
    const ledger = scheduler.koinPrepaid.ledger, job = ledger.job(answer.id);
    assert.equal(job.funding.paidFirst, undefined);
    assert.equal(job.funding.freeUsed, answer.koin.receipt.usage.amount);
    assert.equal(job.funding.paidUsed, "0");
    assert.equal(ledger.balance(owner).available, "200000000", "old service keeps purchased balance when free credits cover the request");
    await assert.rejects(chat.estimate({ ...body, paidFirst: true }, signal), /Paid-first is unavailable/);
    assert.equal(ledger.balance(owner).spent, "0"); assert.equal(inferenceCalls, 1);
    assert.equal(priceReads, 0); assert.equal(actions.includes("/koin/prepaid/purchase-price"), false, "unsupported display pricing must not be called");
    priorityResults.push({ preference: "legacy-free-first", paid: "0", free: job.funding.freeUsed, unsupportedPaidFirstBlocked: true });
  }
  if (priority) {
    const ledger = scheduler.koinPrepaid.ledger;
    const paidJob = ledger.job(answer.id);
    assert.equal(paidJob.funding.paidFirst, true);
    assert.equal(paidJob.funding.freeUsed, "0");
    assert.equal(paidJob.funding.paidUsed, spent);
    priorityResults.push({ preference: "paid-first", paid: paidJob.funding.paidUsed, free: paidJob.funding.freeUsed });
    const freeAnswer = await chat.chat(window, { ...body, paidFirst: false, messages: [{ role: "user", content: "Reply PONG with free credits first" }] }, signal);
    const freeJob = ledger.job(freeAnswer.id);
    assert.equal(freeJob.funding.paidFirst, undefined, "default priority preserves legacy durable shape");
    assert.equal(freeJob.funding.freeUsed, freeAnswer.koin.receipt.usage.amount);
    assert.equal(freeJob.funding.paidUsed, "0");
    assert.equal(ledger.balance(owner).spent, spent, "free-first must preserve purchased balance");
    priorityResults.push({ preference: "free-first", paid: freeJob.funding.paidUsed, free: freeJob.funding.freeUsed });
    // The fallback account has a deliberately small, server-verified fixture
    // purchase. This exercises a real ledger hold/split without changing a
    // balance directly or submitting a third real-wallet transaction.
    const fixturePurchase = "0x1220" + P.hash("partial-paid-fixture-purchase");
    ledger.confirmPurchase(fixturePurchase, { state: "finalized", txId: fixturePurchase, owner: fallbackOwner, amount: "20" }, P.hash("verified-account:fallback-session"));
    const fallbackOptions = { ...flowOptions, file: path.join(directory, "fallback-chat.json"), config: { ...config, owner: fallbackOwner },
      access: { authorize: () => ({ owner: fallbackOwner, sessionToken: "fallback-session" }) } };
    let fallbackChat = new PrepaidChat(fallbackOptions);
    const fallbackAnswer = await fallbackChat.chat(window, { ...body, paidFirst: true }, signal);
    const fallbackJob = ledger.job(fallbackAnswer.id);
    assert.equal(fallbackJob.funding.paidFirst, true);
    assert.equal(fallbackJob.funding.paidUsed, "20");
    assert.equal(fallbackJob.funding.freeUsed, String(BigInt(fallbackAnswer.koin.receipt.usage.amount) - 20n));
    assert.ok(BigInt(fallbackJob.funding.freeUsed) > 0n);
    assert.equal(ledger.balance(fallbackOwner).available, "0");
    const beforeRecovery = JSON.stringify(await fallbackChat.status());
    const completedCalls = inferenceCalls;
    fallbackChat = new PrepaidChat(fallbackOptions);
    const saved = await fallbackChat.recover(window, signal);
    assert.equal(saved.completion.id, fallbackAnswer.id);
    assert.equal(inferenceCalls, completedCalls, "saved fallback receipt never reruns provider inference");
    const afterRecovery = await fallbackChat.status(), before = JSON.parse(beforeRecovery);
    assert.deepEqual(afterRecovery.balance, before.balance);
    assert.deepEqual(afterRecovery.usage, before.usage);
    assert.equal(afterRecovery.credits.free.available, before.credits.free.available, "recovery never consumes free credits again");
    assert.equal(afterRecovery.credits.purchased.spent, "20", "recovery never consumes purchased credits again");
    assert.equal(nativeReviews, 2); assert.equal(signedPurchases, 2); assert.equal(submissions.length, 2);
    priorityResults.push({ preference: "paid-first-with-free-fallback", paid: fallbackJob.funding.paidUsed, free: fallbackJob.funding.freeUsed, recoveredWithoutDebit: true });
  }
  await provider.stop(); assert.equal(provider.worker.running, false);
  console.log(JSON.stringify({ acceptance: "passed", legacyBackend: legacy, priorityResults, readOnlyPriceEstimates: priceReads, readOnlyMarketEstimates: marketReads, signedPriceQuotes: quoteIssues, backgroundConfirmationYieldsToPurchase: true, actualRcPerPurchase: "150000000", reviewedRcLimits: submissions.map(tx => tx.header.rc_limit), signedPurchases, nativeReviews, broadcasts: submissions.length, creditsPurchasedAtoms: "200000000", chatChargeAtoms: answer.koin.receipt.usage.amount, purchasedChargeAtoms: spent, inferenceCalls, recoveredWithoutDebit: true, providerStartedBeforeChat: true, modelLoads: loads.length, actualModules: ["CreditPurchases", "FundingRecovery", "WalletNonceCoordinator", "PrepaidChat", "CreditProvider", "Worker", "Scheduler", "PrepaidLedger", "PrepaidPurchases"], controlledFixtures: ["chain blocks/finality", "exchange price", "model tokenizer/output", "qualification acceptance"] }));
}
if (LEGACY) test("old deployed backend keeps purchases, free-first signed replies and recovery working without new capabilities", { timeout: 65000 }, t => verifyFlow(t, { legacy: true }));
else {
  test("actual buyer purchase -> signed provider HTTP stream -> one debit/recovery, with background confirmation and two purchases", { timeout: 65000 }, t => verifyFlow(t));
  test("actual credit priority uses free first by default, pays first on request and falls back to free without duplicate recovery charges", { timeout: 65000 }, t => verifyFlow(t, { priority: true }));
}
