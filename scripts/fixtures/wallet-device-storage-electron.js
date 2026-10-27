"use strict";
// Only loaded by verify-wallet-device-storage.js in its disposable package.
// Approvals and responses are explicit fixtures. Native safeStorage, wallet
// locking, credential classes and signed proof validation are production code.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { app, safeStorage } = require("electron");
const config = JSON.parse(fs.readFileSync(process.env.KAI_NATIVE_WALLET_CONFIG, "utf8")), phase = process.env.KAI_NATIVE_WALLET_PHASE;
const report = value => { const file = path.join(config.root, phase + ".json"); fs.writeFileSync(file + ".tmp", JSON.stringify(value)); fs.renameSync(file + ".tmp", file); };
const fail = error => { report({ error: String(error.stack || error) }); app.exit(1); };
const load = file => require(path.join(config.sourceRoot, file));
app.setPath("appData", config.profile);
load("core/lib/release-channel.js").configureDesktop(app, load("core/lib/release-channel.js").channelConfig("test"));
if (!app.requestSingleInstanceLock()) fail(Error("Isolated fixture profile was already in use"));
else app.whenReady().then(async () => {
  assert.equal(process.platform, "win32"); assert.equal(safeStorage.isEncryptionAvailable(), true);
  assert.equal(load("core/lib/protected-storage.js").isProtectedStorage(safeStorage), true);
  const dataDir = path.join(app.getPath("userData"), "native-credential-fixture"), walletDir = path.join(dataDir, "wallet");
  const { WalletService } = load("core/lib/wallet.js"), { AccountService } = load("core/lib/account.js"), { ProviderDevice, target } = load("electron/provider-device.js"), { CreditProvider } = load("electron/credit-provider.js");
  const P = load("core/lib/koin-network/provider-device-protocol.js"), W = load("core/lib/wallet-credit-account.js");
  const wallet = new WalletService(walletDir), serviceManifest = structuredClone(load("core/lib/koin-network/credit-service.json"));
  serviceManifest.config.schedulerUrl = "https://native-fixture.invalid/scheduler";
  const serviceConfig = serviceManifest.config, origin = "https://native-fixture.invalid", token = "wc_" + "n".repeat(43), accountId = "native-protected-wallet-fixture";
  let walletSignCalls = 0, controlledApprovals = 0, challenge, enrolled, walletSecret;
  const originalSign = wallet.signHash.bind(wallet);
  wallet.signHash = async hash => { walletSignCalls++; return originalSign(hash); };
  if (phase === "enroll") {
    assert.equal(wallet.exists(), false); wallet.create({ password: "IsolatedNativeFixtureOnly-9271" });
    walletSecret = wallet.signer.getPrivateKey("hex");
  } else if (phase !== "restart") throw Error("Unknown native fixture phase");
  const savedPublic = path.join(config.root, "service-public.json");
  let publicState = phase === "restart" ? JSON.parse(fs.readFileSync(savedPublic, "utf8")) : {};
  const accountValue = () => ({ id: accountId, scope: "wallet-credits", freeOnly: false, wallets: [{ address: wallet.address }] });
  // No actual request is permitted: the only transport is this fixture callback.
  globalThis.fetch = async () => { throw Error("Native credential fixture must never access the network"); };
  const fetchImpl = async (url, options = {}) => {
    const route = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null;
    assert.equal(new URL(url).origin, origin);
    if (route === "/auth/wallet-credit/capabilities") return Response.json({ ok: true, capabilities: { walletCredits: 1, freeOnlySessions: 1, scope: "wallet-credits", ...W.pin(serviceConfig, origin), challengeTtlMs: 300000, sessionTtlMs: 2592000000 } });
    if (route === "/auth/wallet-credit/challenge") {
      const at = Date.now(); challenge = { schema: 1, purpose: "wallet-credit-session", ...W.pin(serviceConfig, origin), address: body.address, deviceId: body.deviceId, freeOnly: body.freeOnly,
        nonce: P.hash("native-wallet-challenge").toString("hex"), issuedAt: at, expiresAt: at + 300000, sessionExpiresAt: at + 2592000000 };
      return Response.json({ ok: true, challenge });
    }
    if (route === "/auth/wallet-credit/verify") {
      assert.equal(body.challengeId, challenge.nonce);
      load("core/lib/koin-network/job-protocol.js").signatureMatches(W.challengeHash(challenge), body.signature, wallet.address);
      publicState.sessionExpiresAt = challenge.sessionExpiresAt;
      return Response.json({ ok: true, token, scope: "wallet-credits", freeOnly: false, expiresAt: challenge.sessionExpiresAt, account: accountValue() });
    }
    if (route === "/auth/session") {
      assert.ok(options.headers.authorization === "Bearer " + token, "The native stored credit session must survive restart");
      return Response.json({ ok: true, scope: "wallet-credits", freeOnly: false, account: accountValue() });
    }
    if (route === "/scheduler/koin/provider/device/capabilities") return Response.json({ ok: true, capabilities: { walletFirstEarning: 1, delegatedProvider: 1 }, schedulerUrl: serviceConfig.schedulerUrl, target: target(serviceConfig) });
    if (route === "/scheduler/koin/provider/device/challenge") {
      const at = Date.now(); return Response.json({ ok: true, authorization: { schema: 1, purpose: "provider", schedulerUrl: serviceConfig.schedulerUrl, target: target(serviceConfig), wallet: body.wallet,
        deviceId: body.deviceId, publicKey: body.publicKey, challenge: P.hash("native-provider-challenge").toString("hex"), issuedAt: at, challengeExpiresAt: at + 300000, expiresAt: at + 2592000000, actions: [...P.ACTIONS] } });
    }
    if (route === "/scheduler/koin/provider/device/enroll") {
      const proof = "pd1." + Buffer.from(JSON.stringify(body)).toString("base64url"), checked = P.verifyAction(proof, "register", P.authorizationHash(body.authorization), { wallet: wallet.address, schedulerUrl: serviceConfig.schedulerUrl, target: target(serviceConfig) });
      enrolled = checked.authorizationId; return Response.json({ ok: true, authorizationId: enrolled, deviceId: checked.deviceId, wallet: checked.wallet });
    }
    throw Error("Unexpected native fixture route: " + route);
  };
  const settings = { get: (_key, fallback) => _key === "network.privacyMode" ? "network" : fallback };
  const account = new AccountService({ dataDir, settings, wallet, safeStorage, accountOrigin: origin, fetchImpl });
  const core = { account, settings, gateway: { network: { status: () => ({ privacyMode: "network" }) } }, models: { catalog: { aliases: {}, packages: {} } } };
  const service = { dataDir, service: serviceManifest, fetchImpl }, device = new ProviderDevice({ service, core,
    dialog: { showMessageBox: async () => { if (phase !== "enroll") throw Error("Restart must not request new authority"); controlledApprovals++; return { response: 1 }; } } });
  const signal = AbortSignal.timeout(20000);
  if (phase === "enroll") {
    const connected = await account.connectWallet(serviceConfig, { review: async () => { controlledApprovals++; return true; } }, signal);
    assert.equal(connected.state, "connected"); assert.equal((await device.authorize(null, {}, signal)).state, "authorized");
  } else {
    assert.equal(wallet.status().unlocked, false); assert.equal(wallet._signer, null);
  }
  const c = await device.context(signal), record = account._tokenRecord();
  assert.equal(record.encrypted, true); assert.equal(record.sessionOnly, false); assert.ok(record.token === token, "Wallet-credit session restored from native storage");
  const providerBytes = fs.readFileSync(path.join(c.directory, "authorization.enc")), accountBytes = fs.readFileSync(account.file);
  assert.equal(accountBytes.subarray(0, 4).toString(), "ENC1"); assert.equal(accountBytes.includes(Buffer.from(token)), false);
  assert.equal(providerBytes.includes(Buffer.from(c.record.privateKey)), false);
  assert.equal(c.signer.signHash, undefined); assert.equal(c.signer.signTransaction, undefined);
  if (walletSecret) {
    assert.equal(JSON.stringify(c.record).includes(walletSecret), false, "Device record must not cache the spending wallet key");
    for (const file of [wallet.keystorePath, account.file, path.join(c.directory, "authorization.enc")]) assert.equal(fs.readFileSync(file).includes(Buffer.from(walletSecret)), false);
    walletSecret = null;
  }
  let workers = 0;
  const provider = new CreditProvider({ service, core, device, createWorker: () => { workers++; throw Error("Saved Off must not start a worker"); } });
  if (phase === "enroll") { provider.preference(c, false); publicState.address = wallet.address; publicState.authorizationId = enrolled; fs.writeFileSync(savedPublic, JSON.stringify(publicState)); }
  assert.equal(provider.preference(c), false);
  wallet.lock(); assert.equal(wallet.status().unlocked, false); assert.equal(wallet._signer, null); assert.equal(fs.existsSync(wallet._sessionPath()), false);
  const beforeLockAttempt = walletSignCalls; await assert.rejects(wallet.signHash(Buffer.alloc(32)), /locked/); walletSignCalls = beforeLockAttempt;
  const auth = await account.creditAuthorization(serviceConfig.schedulerUrl, signal); assert.equal(auth.owner, wallet.address); assert.equal(auth.accountId, accountId);
  const reportValue = { schema: 1, session: "a".repeat(32), sequence: phase === "enroll" ? 1 : 2, at: Date.now(), model: "", modelHash: "", ready: false };
  const signature = c.signer.presence(reportValue), proof = P.verifyAction(signature, "presence", load("core/lib/koin-network/presence.js").presenceHash(wallet.address, serviceConfig.schedulerUrl, reportValue), { wallet: wallet.address, schedulerUrl: serviceConfig.schedulerUrl, target: target(serviceConfig) });
  await provider.tick(); assert.equal(workers, 0); assert.equal(provider.preference(c), false);
  assert.equal(walletSignCalls, phase === "enroll" ? 2 : 0);
  const result = { phase, packaged: config.packaged, profile: app.getPath("userData"), address: wallet.address, authorizationId: proof.authorizationId, deviceId: proof.deviceId,
    walletLocked: !wallet.status().unlocked, walletSignerAbsent: wallet._signer === null, walletSigningRejected: true, protectedStorage: true, offPreserved: true,
    accountRestored: true, scopedProofVerified: true, walletSignCalls, controlledApprovals };
  await provider.dispose(); report(result); app.quit();
}).catch(fail);
