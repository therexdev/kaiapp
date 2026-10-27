"use strict";
// Cross-repository integration uses the actual reviewed backend, HTTP and
// SQLite. It never contacts a public network, wallet, or model endpoint.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { createRequire } = require("node:module"), { Signer } = require("koilib");
const { DeviceFreeAccount } = require("../lib/device-free-account"), { pin } = require("../lib/wallet-credit-account");
const { SessionFreeChat, SessionFreeChatStore } = require("../../electron/session-free-chat");
const P = require("../lib/koin-network/job-protocol"), F = require("../lib/koin-network/funded-protocol");
const BACKEND = process.env.KAI_WALLET_BACKEND;
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";

async function serviceFixture(t) {
  const cleanup = [], backend = createRequire(path.join(path.resolve(BACKEND), "package.json"));
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  const f = backend("./scripts/helpers/koin-prepaid-fixture").fixture({ after: close => cleanup.push(close) });
  const origin = "https://credits.integration.invalid", schedulerUrl = origin + "/scheduler", address = name => Signer.fromSeed("device-free-integration:" + name).address;
  const deployment = { schema: 1, network: "mainnet", product: "prepaid-usd-v1", chainId: f.target.chainId, decimals: 8,
    rpc: ["https://fixture.invalid"], token: backend("./lib/koin-network/payment-network").MAINNET_TOKEN, tokenHash: "0x1220" + P.hash("token"),
    credits: f.target.credits, creditsHash: f.target.creditsHash, rewards: address("rewards"), rewardsHash: "0x1220" + P.hash("rewards"),
    admin: address("admin"), verifier: address("verifier"), mining: address("mining"), operations: address("operations"), masterNode: backend("./lib/koin-network/product").MASTER_NODE };
  const config = { schema: 1, mode: "mainnet-pilot", deployment, schedulerUrl, policyHash: f.meter.policyHash, model: "fixture", version: 1, maxOutput: 16,
    maxRcPerTransaction: "10000000", maxRcPerDay: "500000000", limits: { amount: "10000000000", perJob: "1000", maxJobs: 10, durationMs: 3600000 } };
  const expected = pin(config, origin), auth = backend("./lib/accounts").createAccounts({ stateDir: path.join(f.dir, "accounts"), siteOrigin: origin });
  cleanup.push(() => auth.service.db.close()); auth.service.configureWalletCredits({ target: expected.target, schedulerUrl, clock: f.options.clock });
  const chain = new (backend("./lib/koin-network/chain").KoinChain)(deployment, {}), networkOverview = () => ({ observedAt: f.options.clock(), validUntil: f.options.clock() + 15000,
    models: [{ id: "fixture", available: true, providers: 1, freeEligible: true }] });
  const routerOptions = { ...f.options, dataDir: path.join(f.dir, "credits"), target: expected.target, client: chain, accounts: auth.service, publicAccounts: true, networkOverview,
    freePolicy: { version: 1, accountDaily: "1000", networkDaily: "2000", originDaily: "1500", accountConcurrent: 1, eligibleModels: ["fixture"] },
    qualify: () => true, accept: ({ output }) => !!output.trim(), purchaseQuote: async () => { throw Error("Free access must never create a purchase quote"); } };
  let router = backend("./lib/koin-network/prepaid-router").createPrepaidRouter(routerOptions); cleanup.push(() => router.close());
  const express = backend("express"), app = express(); app.use(express.json({ limit: "32kb" })); app.use(auth.router);
  const worker = { address: f.provider, proof: "signed", models: ["fixture"], capabilities: { koinMainnetPilotJobs: 1, koinMeteredStreaming: 1 } };
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/auth/") || req.url.startsWith("/account")) return app(req, res);
    req.url = req.url.replace(/^\/scheduler/, "");
    if (req.url === "/consume/chat/completions") {
      const chunks = []; for await (const part of req) chunks.push(part);
      return router.work.chat(req, res, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    }
    if (await router.handle(req, res, request => new URL(request.url, "http://x").searchParams.get("token") === "fixture-worker" ? worker : null)) return;
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = "http://127.0.0.1:" + server.address().port, nativeFetch = fetch;
  const fetchImpl = (url, init) => { const u = new URL(url); assert.equal(u.origin, origin, "all requests must use the packaged service pin"); return nativeFetch(base + u.pathname + u.search, init); };
  const clientDir = path.join(f.dir, "desktop"), settings = { get: () => "local-first" };
  return { f, cleanup, backend, origin, schedulerUrl, config, expected, auth, worker, fetchImpl, clientDir, settings, get router() { return router; },
    restart() { router.close(); router = backend("./lib/koin-network/prepaid-router").createPrepaidRouter(routerOptions); } };
}

test("automatic desktop free access completes a signed reply with the real backend and resumes the same grant after restart", { skip: !BACKEND, timeout: 30000 }, async t => {
  const s = await serviceFixture(t), { f, cleanup, config, expected, schedulerUrl, auth, worker, fetchImpl, clientDir, settings } = s;
  let client, sessionStore, chat, authorization;
  function openDesktop() {
    client = new DeviceFreeAccount({ dataDir: clientDir, config, settings, fetchImpl, clock: f.options.clock }); cleanup.push(() => client.dispose());
    sessionStore = new SessionFreeChatStore(); cleanup.push(() => sessionStore.dispose());
  }
  function openChat() {
    chat = new SessionFreeChat({ file: path.join(clientDir, "free-chat.json"), config: { ...config, owner: authorization.owner }, sessionStore, fetchImpl, clock: f.options.clock,
      access: { authorize: (scheduler, signal) => { signal?.throwIfAborted(); return client.assertCreditAuthorization(authorization, scheduler); } } });
  }
  openDesktop(); authorization = await client.creditAuthorization(schedulerUrl); openChat();
  const firstId = authorization.accountId, firstToken = authorization.sessionToken, identityBytes = fs.readFileSync(client.file);
  const status = await chat.status(); assert.equal(status.credits.free.available, "1000"); assert.equal(status.balance.purchased, "0");
  assert.equal(s.router.ledger.db.prepare("SELECT COUNT(*) AS n FROM free_grants").get().n, 1);
  const prompt = "private fresh-install question", output = "private answer", body = { model: "koinos-network:fixture", messages: [{ role: "user", content: prompt }], max_tokens: 16, stream: false };
  const waiting = chat.chat(null, body, AbortSignal.timeout(10000)); waiting.catch(() => {});
  let job; for (let n = 0; n < 100 && !job; n++) { job = await s.router.work.next(worker); if (!job) await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(job, "fresh-install free chat reached the actual worker queue");
  const signature = Buffer.from(await f.worker.signHash(F.fundedResultHash(expected.target, job, output))).toString("base64");
  const result = await fetchImpl(schedulerUrl + "/koin/funded/mainnet-pilot/result?token=fixture-worker", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: job.id, output, signature }) });
  assert.equal(result.status, 200, JSON.stringify(await result.json())); const answer = await waiting; assert.equal(answer.choices[0].message.content, output);
  assert.equal(s.router.ledger.job(answer.id).funding.paidUsed, "0"); assert.equal(s.router.ledger.job(answer.id).funding.freeOnly, true);
  const used = await chat.status(); assert.ok(BigInt(used.credits.free.available) < 1000n);
  const saved = fs.readFileSync(chat.file, "utf8"); for (const secret of [prompt, output, firstToken]) assert.equal(saved.includes(secret), false);
  assert.equal(fs.readFileSync(client.file).includes(firstToken), false);
  for (const table of ["accounts", "wallets", "sessions", "spend_grants"]) assert.equal(auth.service.db.prepare("SELECT COUNT(*) AS n FROM " + table).get().n, 0);
  await assert.rejects(chat.call("quote-usd", { dollars: "1" }), /free|wallet|purchase|connect/i);
  client.dispose(); sessionStore.dispose(); s.restart();
  openDesktop(); authorization = await client.creditAuthorization(schedulerUrl); openChat();
  assert.equal(authorization.accountId, firstId); assert.notEqual(authorization.sessionToken, firstToken); assert.deepEqual(fs.readFileSync(client.file), identityBytes);
  assert.deepEqual((await chat.status()).credits.free, used.credits.free); assert.equal(s.router.ledger.db.prepare("SELECT COUNT(*) AS n FROM free_grants").get().n, 1);
  const recovered = await chat.chat(null, body, AbortSignal.timeout(10000)); assert.equal(recovered.id, answer.id); assert.equal(recovered.choices[0].message.content, output);
  assert.deepEqual((await chat.status()).credits.free, used.credits.free, "recovery does not spend the same grant twice"); assert.equal(s.router.ledger.jobs().length, 1);
});

test("fresh Pi desktop shows free credits automatically and sends a real IPC network chat without a wallet or keyring", { skip: !BACKEND || !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const s = await serviceFixture(t), { EventEmitter } = require("node:events");
  require("../../electron/desktop-first-run").initializeDesktopProfile(s.clientDir);
  const core = await require("../server").createCore({ dataDir: s.clientDir, creditAccountOrigin: s.origin, port: 0, onEvent() {} }); s.cleanup.push(() => core.stop());
  assert.equal(core.gateway.network.status().privacyMode, "local-first"); assert.equal(core.account.wallet.status().exists, false);
  let keyringCalls = 0;
  const basicStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text",
    encryptString() { keyringCalls++; throw Error("Plaintext encryption must never be used"); }, decryptString() { keyringCalls++; throw Error("No OS keyring in this Pi fixture"); } };
  core.account.safeStorage = basicStorage; core.creditAccount.safeStorage = core.account.wallet.creditStorage(basicStorage, s.origin);
  const appOrigin = "http://127.0.0.1:" + await core.start(), nativeFetch = fetch;
  t.mock.method(globalThis, "fetch", (url, init) => new URL(url).origin === s.origin ? s.fetchImpl(url, init)
    : new URL(url).origin === appOrigin ? nativeFetch(url, init) : Promise.reject(Error("Public egress blocked in desktop fixture: " + new URL(url).origin)));
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: new EventEmitter() });
  window.webContents.mainFrame = { url: appOrigin + "/" };
  let handler, reviews = 0;
  const manifestFile = require.resolve("../lib/koin-network/credit-service.json"), savedManifest = require(manifestFile);
  require.cache[manifestFile].exports = { schema: 1, state: "ready", config: s.config };
  let registration;
  try {
    registration = require("../../electron/koin-test-ipc").registerTestPaymentIPC({ dataDir: s.clientDir, core, origin: appOrigin, isTest: true, getMainWindow: () => window,
      dialog: { showMessageBox: async () => { reviews++; throw Error("Fresh free access must not prompt for wallet approval"); } }, ipcMain: { handle: (_name, fn) => { handler = fn; } } });
  } finally { require.cache[manifestFile].exports = savedManifest; }
  s.cleanup.push(() => registration.dispose());
  const browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] }); s.cleanup.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } }), calls = [], errors = [];
  page.on("pageerror", error => errors.push(error.message));
  window.webContents.send = (channel, value) => { if (channel === "koin:chat-progress") void page.evaluate(value => window.fixtureChatProgress?.(value), value).catch(() => {}); };
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  await page.exposeBinding("fixtureDesktopIPC", async (_source, action, input) => {
    calls.push(action);
    if (action === "purchase-capabilities") return { purchasePricePreview: false };
    if (action.startsWith("provider-public-")) return { state: "unavailable", detail: "Provider management is separate from buyer startup" };
    return handler(event, action, input);
  });
  await page.addInitScript(() => {
    localStorage.setItem("kai-interface-language", "en");
    const listeners = new Set(); window.fixtureChatProgress = value => { for (const listener of listeners) listener(value); };
    window.kaiKoinTestBridge = { onProgress: fn => { listeners.add(fn); return () => listeners.delete(fn); }, onPurchaseProgress: () => () => {}, run: (action, input) => window.fixtureDesktopIPC(action, input) };
  });
  await page.goto(appOrigin);
  await page.waitForFunction(() => document.querySelector('.product-sidebar-credits [data-credit-breakdown]').textContent.includes("0.01 free"));
  assert.equal(await page.locator('.product-sidebar-credits [data-credit-total]').textContent(), "0.01");
  assert.equal(await page.locator("#status-text").textContent(), "Local model not installed");
  assert.equal(core.creditAccount._token(), null); assert.equal(core.account.wallet.status().exists, false); assert.equal(reviews, 0); assert.equal(keyringCalls, 0);
  await page.locator('.product-sidebar-credits [data-product-view="credits"]').click();
  await page.waitForFunction(() => document.getElementById("product-wallet-access-detail").textContent.includes("Free-credit access is ready"));
  assert.equal(await page.locator("#product-wallet-access").isVisible(), false, "verified free access uses the balance card without another setup panel");
  assert.equal(await page.locator('#product-wallet-access [data-product-action="signin"]').isVisible(), false);
  assert.equal(await page.locator("#product-wallet-access-session").isVisible(), false);
  assert.doesNotMatch(await page.locator("#product-wallet-access").innerText(), /keyring|Secret Service|unlock|create an account/i);
  const screenshot = async name => { if (process.env.KAI_PRODUCT_QA_DIR) { fs.mkdirSync(process.env.KAI_PRODUCT_QA_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.KAI_PRODUCT_QA_DIR, name), animations: "disabled" }); } };
  await screenshot("kai-229-free-credits.png");
  await page.locator('#nav [data-view="chat"]').click();
  await page.waitForFunction(() => [...document.getElementById("src-pick").options].some(o => o.value === "network" && !o.disabled));
  await page.selectOption("#src-pick", "network");
  await page.waitForFunction(() => document.getElementById("model-pick").value === "koinos-network:fixture");
  const assertReadyChat = async () => assert.doesNotMatch(await page.locator("#view-chat").innerText(), /Connect your network account|temporary connection|create an account|sign in|keyring|Secret Service/i);
  await assertReadyChat();
  await page.fill("#input", "Use the automatic free credits"); await page.locator("#btn-send").click();
  let job; for (let n = 0; n < 300 && !job; n++) { job = await s.router.work.next(s.worker); if (!job) await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(job, JSON.stringify({ messages: await page.locator("#messages").innerText(), calls, errors, network: await page.evaluate(() => window.KaiNetwork.info) }));
  const output = "Free reply", signature = Buffer.from(await s.f.worker.signHash(F.fundedResultHash(s.expected.target, job, output))).toString("base64");
  const result = await s.fetchImpl(s.schedulerUrl + "/koin/funded/mainnet-pilot/result?token=fixture-worker", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: job.id, output, signature }) });
  assert.equal(result.status, 200, JSON.stringify(await result.json()));
  await page.waitForFunction(() => document.getElementById("messages").textContent.includes("Free reply") && !document.getElementById("btn-send").disabled);
  await assertReadyChat(); assert.equal(await page.locator("#network-recover").isVisible(), false, "a successfully saved and acknowledged answer needs no recovery action");
  assert.ok(calls.includes("chat-ack"));
  await page.evaluate(() => window.dispatchEvent(new Event("kai-network-account-changed")));
  await page.evaluate(() => window.KaiNetwork.refresh()); await assertReadyChat();
  assert.equal(s.router.ledger.job(job.id).funding.paidUsed, "0"); assert.equal(calls.includes("wallet-connect"), false); assert.equal(reviews, 0);
  await screenshot("kai-229-free-network-chat.png");
  const preserved = Buffer.from("ENC1existing-unreadable-paid-identity"); fs.writeFileSync(core.creditAccount.file, preserved);
  await page.evaluate(() => window.KaiCredits.refresh());
  assert.match(await page.locator('.product-sidebar-credits [data-credit-breakdown]').textContent(), /purchased balance not connected/);
  assert.doesNotMatch(await page.locator('.product-sidebar-credits [data-credit-breakdown]').textContent(), /0 purchased/);
  assert.deepEqual(fs.readFileSync(core.creditAccount.file), preserved); assert.equal(core.creditAccount._memorySession, null);
  await page.locator('.product-sidebar-credits [data-product-view="buy-credits"]').click();
  await page.waitForFunction(() => document.getElementById("product-quote-refresh").textContent === "Set up wallet" && !document.getElementById("product-quote-refresh").disabled);
  await page.locator("#product-quote-refresh").click(); await page.locator("#view-payment-wallet").waitFor({ state: "visible" });
  assert.equal(calls.includes("purchase-preview"), false); assert.equal(calls.includes("purchase-approve"), false);
  core.account.wallet.create({ password: "fixture wallet password" }); core.account.wallet.lock();
  await page.locator('.product-sidebar-credits [data-product-view="buy-credits"]').click();
  await page.waitForFunction(() => document.getElementById("product-quote-refresh").textContent === "Buy credits" && !document.getElementById("product-quote-refresh").disabled);
  await page.locator("#product-quote-refresh").click(); await page.locator("#product-purchase-unlock-pass").waitFor({ state: "visible" });
  await screenshot("kai-229-buy-wallet-unlock.png");
  await page.locator("#product-purchase-unlock-cancel").click();
  assert.equal(calls.includes("purchase-preview"), false); assert.equal(core.account.wallet.status().unlocked, false);
  assert.deepEqual(fs.readFileSync(core.creditAccount.file), preserved); assert.equal(keyringCalls, 0); assert.equal(reviews, 0); assert.deepEqual(errors, []);
});

test("saved paid identity conflicts and outages never masquerade as successfully connected free access", { skip: !BACKEND }, async t => {
  const s = await serviceFixture(t), { CreditService } = require("../../electron/credit-service");
  let guestCalls = 0, currentError;
  const account = { settings: s.settings, file: path.join(s.f.dir, "existing-paid.cfg"), wallet: { address: s.f.owner, status: () => ({ address: s.f.owner, unlocked: false }) },
    creditAuthorization: async () => { throw currentError; } };
  fs.writeFileSync(account.file, "preserved-paid-connection");
  const service = new CreditService({ dataDir: s.clientDir, account, storage: null, service: { schema: 1, state: "ready", config: s.config }, fetchImpl: s.fetchImpl,
    deviceFreeAccount: { creditAuthorization: async () => { guestCalls++; throw Error("Unexpected guest fallback"); }, dispose() {} } });
  s.cleanup.push(() => service.dispose());
  for (const code of ["wallet-changed", "identity-unverified", "service-unavailable"]) {
    currentError = Object.assign(Error("Existing paid connection: " + code), { code });
    const info = await service.walletInfo(); assert.equal(info.freeAccess, undefined); assert.equal(info.connected, false); assert.match(info.detail, new RegExp(code));
    await assert.rejects(service.context(), error => error === currentError);
  }
  assert.equal(guestCalls, 0); assert.equal(fs.readFileSync(account.file, "utf8"), "preserved-paid-connection");
});
