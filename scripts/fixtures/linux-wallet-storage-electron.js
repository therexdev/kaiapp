"use strict";
// Disposable Linux native fixture. Only approval/service transport is simulated;
// Electron safeStorage, wallet locking and scoped device signatures are real.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { app, safeStorage } = require("electron");
const config = JSON.parse(fs.readFileSync(process.env.KAI_LINUX_WALLET_CONFIG, "utf8")), { phase, basic } = config;
const load = file => require(path.join(config.sourceRoot, file));
const report = value => { const file = path.join(config.root, phase + ".json"); fs.writeFileSync(file + ".tmp", JSON.stringify(value), { mode: 0o600 }); fs.renameSync(file + ".tmp", file); };
const fail = error => { report({ error: String(error.stack || error) }); app.exit(1); };
async function verifyWalletVault(backend) {
  const enrolling = phase === "vault-enroll", dataDir = path.join(app.getPath("userData"), "native-core-vault");
  const origin = "https://linux-vault-fixture.invalid", password = "NativeVaultPasswordFixtureOnly-9271";
  const savedPublic = path.join(config.root, "vault-public.json"), publicState = enrolling ? {} : JSON.parse(fs.readFileSync(savedPublic, "utf8"));
  const blockedRequests = [];
  globalThis.fetch = async url => { const target = new URL(url); blockedRequests.push(target.origin + target.pathname); throw Error("Native vault fixture must never access the network"); };
  const sessionSecret = load("electron/wallet-session-secret.js").machineSecret(dataDir, safeStorage);
  assert.equal(sessionSecret, null);
  const core = await load("core/server.js").createCore({ dataDir, port: 0, sessionSecret, creditAccountOrigin: origin, onEvent() {} });
  let service, device, provider;
  try {
    core.settings.set("network.privacyMode", "local-first");
    core.settings.set("earn.schedulerUrl", origin + "/scheduler");
    const account = core.creditAccount, wallet = account.wallet;
    assert.equal(core.account.wallet, wallet); assert.equal(core.account.safeStorage, safeStorage);
    assert.notEqual(account.safeStorage, safeStorage); assert.equal(typeof account.safeStorage.forPurpose, "function");
    const protectedStorage = load("core/lib/protected-storage.js");
    assert.equal(protectedStorage.isProtectedStorage(account.safeStorage), false);
    assert.equal(wallet.status().unlocked, false); assert.equal(wallet._signer, null);
    if (enrolling) assert.equal(wallet.exists(), false, "automatic free access begins without a wallet");
    else assert.equal(wallet.address, publicState.address);
    const serviceManifest = structuredClone(load("core/lib/koin-network/credit-service.json"));
    serviceManifest.config.schedulerUrl = origin + "/scheduler";
    const serviceConfig = serviceManifest.config, P = load("core/lib/koin-network/provider-device-protocol.js");
    const W = load("core/lib/wallet-credit-account.js"), Free = load("core/lib/device-free-account.js");
    const { ProviderDevice, target } = load("electron/provider-device.js");
    const expected = W.pin(serviceConfig, origin), token = "wc_" + "v".repeat(43), accountId = "native-wallet-vault-paid-account";
    let walletChallenge, freeChallenge, walletSignCalls = 0, controlledApprovals = 0, passwordUnlocks = 0;
    const originalSign = wallet.signHash.bind(wallet);
    wallet.signHash = async hash => { walletSignCalls++; return originalSign(hash); };
    const accountValue = () => ({ id: accountId, scope: "wallet-credits", freeOnly: false, wallets: [{ address: wallet.address }] });
    const fetchImpl = async (url, options = {}) => {
      assert.equal(new URL(url).origin, origin);
      const route = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null;
      if (route === "/scheduler/balance") return Response.json({ ok: true, kai: "0", pendingReceipts: 0 });
      if (route === "/auth/device-free/capabilities") return Response.json({ ok: true, capabilities: { deviceFreeCredits: 1, scope: "device-free", freeOnly: true,
        algorithm: "Ed25519", ...expected, challengeTtlMs: 300000, sessionTtlMs: 86400000 } });
      if (route === "/auth/device-free/challenge") {
        assert.deepEqual(Object.keys(body), ["publicKey"]);
        const at = Date.now(); freeChallenge = { schema: 1, purpose: "device-free-session", ...expected, publicKey: body.publicKey,
          nonce: crypto.randomBytes(32).toString("hex"), issuedAt: at, expiresAt: at + 300000, sessionExpiresAt: at + 86400000 };
        return Response.json({ ok: true, challenge: freeChallenge });
      }
      if (route === "/auth/device-free/verify") {
        assert.deepEqual(Object.keys(body).sort(), ["challengeId", "signature"]); assert.equal(body.challengeId, freeChallenge.nonce);
        assert.equal(crypto.verify(null, Free.challengeHash(freeChallenge), crypto.createPublicKey({ key: Buffer.from(freeChallenge.publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(body.signature, "base64")), true);
        return Response.json({ ok: true, token: "df_" + crypto.randomBytes(32).toString("base64url"), scope: "device-free", freeOnly: true, expiresAt: freeChallenge.sessionExpiresAt,
          account: { id: Free.accountId(expected, freeChallenge.publicKey), scope: "device-free", freeOnly: true, wallets: [], expiresAt: freeChallenge.sessionExpiresAt } });
      }
      if (route === "/auth/wallet-credit/capabilities") return Response.json({ ok: true, capabilities: { walletCredits: 1, freeOnlySessions: 1, scope: "wallet-credits",
        ...expected, challengeTtlMs: 300000, sessionTtlMs: 2592000000 } });
      if (route === "/auth/wallet-credit/challenge") {
        assert.equal(enrolling, true); assert.equal(body.freeOnly, false);
        const at = Date.now(); walletChallenge = { schema: 1, purpose: "wallet-credit-session", ...expected, address: body.address, deviceId: body.deviceId, freeOnly: false,
          nonce: crypto.randomBytes(32).toString("hex"), issuedAt: at, expiresAt: at + 300000, sessionExpiresAt: at + 2592000000 };
        return Response.json({ ok: true, challenge: walletChallenge });
      }
      if (route === "/auth/wallet-credit/verify") {
        assert.equal(body.challengeId, walletChallenge.nonce);
        load("core/lib/koin-network/job-protocol.js").signatureMatches(W.challengeHash(walletChallenge), body.signature, wallet.address);
        return Response.json({ ok: true, token, scope: "wallet-credits", freeOnly: false, expiresAt: walletChallenge.sessionExpiresAt, account: accountValue() });
      }
      if (route === "/auth/session") {
        assert.equal(options.headers.authorization, "Bearer " + token);
        return Response.json({ ok: true, scope: "wallet-credits", freeOnly: false, account: accountValue() });
      }
      if (route === "/scheduler/koin/provider/device/capabilities") return Response.json({ ok: true, capabilities: { walletFirstEarning: 1, delegatedProvider: 1 }, schedulerUrl: serviceConfig.schedulerUrl, target: target(serviceConfig) });
      if (route === "/scheduler/koin/provider/device/challenge") {
        assert.equal(enrolling, true); const at = Date.now();
        return Response.json({ ok: true, authorization: { schema: 1, purpose: "provider", schedulerUrl: serviceConfig.schedulerUrl, target: target(serviceConfig), wallet: body.wallet,
          deviceId: body.deviceId, publicKey: body.publicKey, challenge: crypto.randomBytes(32).toString("hex"), issuedAt: at, challengeExpiresAt: at + 300000, expiresAt: at + 2592000000, actions: [...P.ACTIONS] } });
      }
      if (route === "/scheduler/koin/provider/device/enroll") {
        assert.equal(enrolling, true);
        const proof = "pd1." + Buffer.from(JSON.stringify(body)).toString("base64url"), checked = P.verifyAction(proof, "register", P.authorizationHash(body.authorization),
          { wallet: wallet.address, schedulerUrl: serviceConfig.schedulerUrl, target: target(serviceConfig) });
        return Response.json({ ok: true, authorizationId: checked.authorizationId, deviceId: checked.deviceId, wallet: checked.wallet });
      }
      throw Error("Unexpected native vault fixture route: " + route);
    };
    // Core's shutdown status reads only this synthetic balance; all other
    // transports must use their explicit controlled fetch implementation.
    globalThis.fetch = async (url, options) => {
      const target = new URL(url);
      if (target.origin === origin && target.pathname === "/scheduler/balance") return fetchImpl(url, options);
      blockedRequests.push(target.origin + target.pathname); throw Error("Native vault fixture must never access the network");
    };
    account.fetchImpl = fetchImpl;
    service = new (load("electron/credit-service.js").CreditService)({ dataDir, account, storage: account.safeStorage, service: serviceManifest, fetchImpl });
    const signal = AbortSignal.timeout(30000), previousAccount = enrolling ? null : fs.readFileSync(account.file);
    const guest = await service.context(signal);
    assert.equal(guest.auth.deviceFree, true); assert.equal(guest.auth.freeOnly, true); assert.equal(guest.auth.localWallet, null);
    assert.equal(wallet.status().unlocked, false); assert.equal(walletSignCalls, 0); assert.equal(controlledApprovals, 0);
    await assert.rejects(service.run("purchase-preview", {}, signal), { code: "wallet-connection-required" });
    const freeBytes = fs.readFileSync(service.deviceFree.file), freeIdentityHash = crypto.createHash("sha256").update(freeBytes).digest("hex");
    assert.equal(freeBytes.includes(guest.auth.sessionToken), false);
    assert.equal(fs.statSync(service.deviceFree.file).mode & 0o777, 0o600);
    if (enrolling) { publicState.freeAccountId = guest.auth.accountId; publicState.freeIdentityHash = freeIdentityHash; }
    else {
      assert.equal(guest.auth.accountId, publicState.freeAccountId); assert.equal(freeIdentityHash, publicState.freeIdentityHash);
      assert.deepEqual(fs.readFileSync(account.file), previousAccount, "free access cannot replace the locked paid credential");
    }
    device = new ProviderDevice({ service, core, dialog: { showMessageBox: async () => {
      assert.equal(enrolling, true, "restart cannot request new provider authority"); controlledApprovals++; return { response: 1 };
    } } });
    if (enrolling) {
      wallet.create({ password });
      assert.equal((await account.connectWallet(serviceConfig, { review: async value => {
        assert.equal(value.sessionOnly, false); controlledApprovals++; return true;
      } }, signal)).state, "connected");
      assert.equal((await device.authorize(null, {}, signal)).state, "authorized");
    } else {
      assert.equal(account._token(), null);
      await assert.rejects(device.context(signal), { code: "secure-storage-required" });
      assert.throws(() => wallet.unlock("IncorrectFixturePassword"), /Incorrect password/);
      assert.equal(account._token(), null); assert.equal(wallet.status().unlocked, false);
      wallet.unlock(password); passwordUnlocks++;
    }
    assert.equal(protectedStorage.storageState(account.safeStorage).protection, "wallet-session");
    const paid = await service.context(signal), c = await device.context(signal), record = account._tokenRecord();
    assert.equal(paid.auth.scope, "wallet-credits"); assert.equal(paid.auth.sessionOnly, undefined);
    assert.equal(paid.auth.accountId, accountId); assert.equal(record.token, token); assert.equal(record.encrypted, true); assert.equal(record.freeOnly, false);
    const accountBytes = fs.readFileSync(account.file), providerFile = path.join(c.directory, "authorization.enc"), providerBytes = fs.readFileSync(providerFile);
    assert.equal(accountBytes.subarray(0, 8).toString(), "ENC1WCV1"); assert.equal(providerBytes.subarray(0, 4).toString(), "WCV1");
    assert.equal(accountBytes.includes(token), false); assert.equal(providerBytes.includes(c.record.privateKey), false);
    const chatFile = path.join(dataDir, "native-chat.enc"), chatText = "synthetic native private chat";
    if (enrolling) fs.writeFileSync(chatFile, service.storage.encryptString(chatText), { mode: 0o600 });
    assert.equal(service.storage.decryptString(fs.readFileSync(chatFile)), chatText);
    assert.equal(fs.readFileSync(chatFile).includes(chatText), false);
    const installation = load("electron/credit-purchase-access.js").installation({ dataDir, directory: paid.directory, config: paid.config, storage: account.safeStorage.forPurpose("purchase-installation") });
    const installationHash = crypto.createHash("sha256").update(installation).digest("hex");
    if (enrolling) publicState.installationHash = installationHash;
    else { assert.equal(installationHash, publicState.installationHash); assert.deepEqual(accountBytes, previousAccount); }
    for (const file of [account.file, providerFile, chatFile, path.join(paid.directory, "purchase-installation.enc")]) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.readFileSync(file).includes(wallet.signer.getPrivateKey("hex")), false);
    }
    let workers = 0;
    provider = new (load("electron/credit-provider.js").CreditProvider)({ service, core, device, createWorker: () => { workers++; throw Error("Saved Off must not start a worker"); } });
    if (enrolling) { provider.preference(c, false); publicState.address = wallet.address; fs.writeFileSync(savedPublic, JSON.stringify(publicState), { mode: 0o600 }); }
    assert.equal(provider.preference(c), false);
    wallet.lock(); assert.equal(wallet.status().unlocked, false); assert.equal(wallet._signer, null);
    assert.equal(account._token(), token); assert.equal((await account.creditAuthorization(serviceConfig.schedulerUrl, signal)).accountId, accountId);
    const beforeSign = walletSignCalls;
    await assert.rejects(wallet.signHash(Buffer.alloc(32)), /locked/); walletSignCalls = beforeSign;
    assert.throws(() => wallet.signer, /locked/); assert.throws(() => wallet.signerFor(""), /password/);
    assert.throws(() => device.proof(c, "transfer", Buffer.alloc(32)), /action/i);
    const presence = { schema: 1, session: "b".repeat(32), sequence: enrolling ? 1 : 2, at: Date.now(), model: "", modelHash: "", ready: false };
    const proof = P.verifyAction(c.signer.presence(presence), "presence", load("core/lib/koin-network/presence.js").presenceHash(wallet.address, serviceConfig.schedulerUrl, presence),
      { wallet: wallet.address, schedulerUrl: serviceConfig.schedulerUrl, target: target(serviceConfig) });
    await provider.tick(); assert.equal(workers, 0); assert.equal(provider.preference(c), false);
    assert.equal(walletSignCalls, enrolling ? 2 : 0); assert.equal(controlledApprovals, enrolling ? 2 : 0);
    assert.equal(load("electron/wallet-session-secret.js").machineSecret(dataDir, safeStorage), null);
    assert.equal(fs.existsSync(path.join(dataDir, "machine-secret.bin")), false); assert.equal(fs.existsSync(wallet._sessionPath()), false);
    const result = { phase, arch: process.arch, backend, address: wallet.address, deviceId: proof.deviceId, authorizationId: proof.authorizationId,
      walletLocked: true, walletSignerAbsent: true, realCoreWiring: true, walletVaultEncrypted: true, freeAccessBeforeWalletUnlock: true,
      freeAccountId: guest.auth.accountId, freeIdentityHash, paidCredentialsRestored: true, chatCredentialsRestored: true, purchaseInstallationRestored: true,
      scopedProofVerified: true, offPreserved: true, financialSigningBlocked: true, noWalletResumeFiles: true, walletSignCalls, controlledApprovals, passwordUnlocks };
    await provider.dispose(); provider = null; service.dispose(); service = null; await core.stop();
    assert.equal(protectedStorage.isProtectedStorage(account.safeStorage), false); assert.equal(account._token(), null);
    assert.deepEqual(fs.readFileSync(account.file), accountBytes); assert.deepEqual(fs.readFileSync(providerFile), providerBytes);
    assert.deepEqual(blockedRequests, []);
    report({ ...result, shutdownClearsVault: true });
  } finally { await provider?.dispose(); service?.dispose(); await core.stop(); }
}
app.setPath("appData", config.profile);
const release = load("core/lib/release-channel.js"); release.configureDesktop(app, release.channelConfig("test"));
// The basic-only runner creates a fresh private profile and awaits each child
// exit. It also runs on headless hosts that cannot create Electron's Unix
// singleton socket; singleton behavior remains covered by the relaunch suite.
if (!config.basicOnly && !app.requestSingleInstanceLock()) fail(Error("Disposable profile was already in use"));
else app.whenReady().then(async () => {
  assert.equal(process.platform, "linux");
  safeStorage.isEncryptionAvailable();
  const backend = safeStorage.getSelectedStorageBackend();
  assert.equal(backend, basic ? "basic_text" : "gnome_libsecret");
  assert.equal(load("core/lib/protected-storage.js").isProtectedStorage(safeStorage), !basic);
  if (phase.startsWith("vault")) { await verifyWalletVault(backend); app.quit(); return; }
  const dataDir = path.join(app.getPath("userData"), "native-credential-fixture"), walletDir = path.join(dataDir, "wallet");
  const { WalletService } = load("core/lib/wallet.js"), { AccountService } = load("core/lib/account.js"), { ProviderDevice, target } = load("electron/provider-device.js"), { CreditProvider } = load("electron/credit-provider.js");
  const P = load("core/lib/koin-network/provider-device-protocol.js"), W = load("core/lib/wallet-credit-account.js");
  const wallet = new WalletService(walletDir), serviceManifest = structuredClone(load("core/lib/koin-network/credit-service.json"));
  serviceManifest.config.schedulerUrl = "https://linux-fixture.invalid/scheduler";
  const serviceConfig = serviceManifest.config, origin = "https://linux-fixture.invalid", token = "wc_" + "l".repeat(43), accountId = "linux-native-wallet-fixture";
  let walletSignCalls = 0, controlledApprovals = 0, challenge, enrolled, walletSecret;
  const originalSign = wallet.signHash.bind(wallet);
  wallet.signHash = async hash => { walletSignCalls++; return originalSign(hash); };
  const enrolling = phase === "enroll" || phase === "temporary";
  if (enrolling) { assert.equal(wallet.exists(), false); wallet.create({ password: "DisposableLinuxFixtureOnly-9271" }); walletSecret = wallet.signer.getPrivateKey("hex"); }
  else { assert.equal(wallet.status().unlocked, false); assert.equal(wallet._signer, null); }
  const savedPublic = path.join(config.root, basic ? "temporary-public.json" : "protected-public.json");
  const publicState = enrolling ? {} : JSON.parse(fs.readFileSync(savedPublic, "utf8"));
  const accountValue = () => ({ id: accountId, scope: "wallet-credits", freeOnly: basic, wallets: [{ address: wallet.address }] });
  globalThis.fetch = async () => { throw Error("Native fixture must never access the network"); };
  const fetchImpl = async (url, options = {}) => {
    const route = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null;
    assert.equal(new URL(url).origin, origin);
    if (route === "/auth/wallet-credit/capabilities") return Response.json({ ok: true, capabilities: { walletCredits: 1, freeOnlySessions: 1, scope: "wallet-credits", ...W.pin(serviceConfig, origin), challengeTtlMs: 300000, sessionTtlMs: 2592000000 } });
    if (route === "/auth/wallet-credit/challenge") {
      const at = Date.now(); assert.equal(body.freeOnly, basic);
      challenge = { schema: 1, purpose: "wallet-credit-session", ...W.pin(serviceConfig, origin), address: body.address, deviceId: body.deviceId, freeOnly: body.freeOnly,
        nonce: P.hash("linux-wallet-challenge").toString("hex"), issuedAt: at, expiresAt: at + 300000, sessionExpiresAt: at + 2592000000 };
      return Response.json({ ok: true, challenge });
    }
    if (route === "/auth/wallet-credit/verify") {
      assert.equal(body.challengeId, challenge.nonce);
      load("core/lib/koin-network/job-protocol.js").signatureMatches(W.challengeHash(challenge), body.signature, wallet.address);
      return Response.json({ ok: true, token, scope: "wallet-credits", freeOnly: basic, expiresAt: challenge.sessionExpiresAt, account: accountValue() });
    }
    if (route === "/auth/session") { assert.equal(options.headers.authorization, "Bearer " + token); return Response.json({ ok: true, scope: "wallet-credits", freeOnly: basic, account: accountValue() }); }
    if (route === "/scheduler/koin/provider/device/capabilities") return Response.json({ ok: true, capabilities: { walletFirstEarning: 1, delegatedProvider: 1 }, schedulerUrl: serviceConfig.schedulerUrl, target: target(serviceConfig) });
    if (route === "/scheduler/koin/provider/device/challenge") {
      const at = Date.now(); return Response.json({ ok: true, authorization: { schema: 1, purpose: "provider", schedulerUrl: serviceConfig.schedulerUrl, target: target(serviceConfig), wallet: body.wallet,
        deviceId: body.deviceId, publicKey: body.publicKey, challenge: P.hash("linux-provider-challenge").toString("hex"), issuedAt: at, challengeExpiresAt: at + 300000, expiresAt: at + 2592000000, actions: [...P.ACTIONS] } });
    }
    if (route === "/scheduler/koin/provider/device/enroll") {
      const proof = "pd1." + Buffer.from(JSON.stringify(body)).toString("base64url"), checked = P.verifyAction(proof, "register", P.authorizationHash(body.authorization), { wallet: wallet.address, schedulerUrl: serviceConfig.schedulerUrl, target: target(serviceConfig) });
      enrolled = checked.authorizationId; return Response.json({ ok: true, authorizationId: enrolled, deviceId: checked.deviceId, wallet: checked.wallet });
    }
    throw Error("Unexpected native fixture route: " + route);
  };
  const settings = { get: (key, fallback) => key === "network.privacyMode" ? "network" : fallback };
  const account = new AccountService({ dataDir, settings, wallet, safeStorage, accountOrigin: origin, fetchImpl });
  const core = { account, settings, gateway: { network: { status: () => ({ privacyMode: "network" }) } }, models: { catalog: { aliases: {}, packages: {} } } };
  const service = { dataDir, service: serviceManifest, fetchImpl }, device = new ProviderDevice({ service, core,
    dialog: { showMessageBox: async (...args) => { assert.equal(enrolling, true); assert.equal(args.at(-1).defaultId, 0); if (basic) assert.match(args.at(-1).detail, /Session only/); controlledApprovals++; return { response: 1 }; } } });
  const signal = AbortSignal.timeout(20000), identity = device.identity();
  const secretFiles = () => [account.file, path.join(identity.directory, "authorization.enc")];
  if (phase === "temporary-restart") {
    assert.equal(account._token(), null); assert.equal(device.describe().deviceAuthorized, false);
    assert.ok(secretFiles().every(file => !fs.existsSync(file)));
    await assert.rejects(device.context(signal), { code: "authorization-required" });
    assert.equal(wallet.address, publicState.address); assert.equal(walletSignCalls, 0); assert.equal(controlledApprovals, 0);
    device.dispose(); report({ phase, arch: process.arch, backend, address: wallet.address, walletLocked: true, walletSignerAbsent: true, sessionGone: true, noSecretFiles: true, walletSignCalls, controlledApprovals }); app.quit(); return;
  }
  if (enrolling) {
    if (basic) {
      await assert.rejects(account.connectWallet(serviceConfig, { review: async () => { throw Error("Persistent approval must not be offered"); } }, signal), { code: "secure-storage-required" });
      await assert.rejects(device.authorize(null, {}, signal), { code: "secure-storage-required" });
      assert.equal(walletSignCalls, 0); assert.equal(controlledApprovals, 0);
    }
    const connected = await account.connectWallet(serviceConfig, { sessionOnly: basic, review: async value => { assert.equal(value.sessionOnly, basic); controlledApprovals++; return true; } }, signal);
    assert.equal(connected.state, "connected"); assert.equal(connected.sessionOnly, basic);
    assert.equal((await device.authorize(null, { sessionOnly: basic }, signal)).state, "authorized");
  }
  const c = await device.context(signal), record = account._tokenRecord();
  assert.equal(record.sessionOnly, basic); assert.equal(record.freeOnly, basic); assert.equal(record.token, token);
  if (basic) assert.ok(secretFiles().every(file => !fs.existsSync(file)));
  else {
    assert.equal(record.encrypted, true);
    const providerBytes = fs.readFileSync(path.join(c.directory, "authorization.enc")), accountBytes = fs.readFileSync(account.file);
    assert.equal(accountBytes.subarray(0, 4).toString(), "ENC1"); assert.equal(accountBytes.includes(Buffer.from(token)), false);
    assert.equal(providerBytes.includes(Buffer.from(c.record.privateKey)), false);
    for (const file of secretFiles()) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(c.signer.signHash, undefined); assert.equal(c.signer.signTransaction, undefined);
  if (walletSecret) {
    assert.equal(JSON.stringify(c.record).includes(walletSecret), false);
    for (const file of [wallet.keystorePath, ...secretFiles()].filter(file => fs.existsSync(file))) assert.equal(fs.readFileSync(file).includes(Buffer.from(walletSecret)), false);
    walletSecret = null;
  }
  let workers = 0;
  const provider = new CreditProvider({ service, core, device, createWorker: () => { workers++; throw Error("Saved Off must not start a worker"); } });
  if (enrolling) { provider.preference(c, false); publicState.address = wallet.address; publicState.authorizationId = enrolled; fs.writeFileSync(savedPublic, JSON.stringify(publicState), { mode: 0o600 }); }
  assert.equal(provider.preference(c), false);
  wallet.lock(); assert.equal(wallet.status().unlocked, false); assert.equal(wallet._signer, null); assert.equal(fs.existsSync(wallet._sessionPath()), false);
  const beforeLockAttempt = walletSignCalls; await assert.rejects(wallet.signHash(Buffer.alloc(32)), /locked/); walletSignCalls = beforeLockAttempt;
  const auth = await account.creditAuthorization(serviceConfig.schedulerUrl, signal); assert.equal(auth.owner, wallet.address); assert.equal(auth.accountId, accountId); assert.equal(Boolean(auth.sessionOnly), basic);
  const reportValue = { schema: 1, session: "a".repeat(32), sequence: enrolling ? 1 : 2, at: Date.now(), model: "", modelHash: "", ready: false };
  const signature = c.signer.presence(reportValue), proof = P.verifyAction(signature, "presence", load("core/lib/koin-network/presence.js").presenceHash(wallet.address, serviceConfig.schedulerUrl, reportValue), { wallet: wallet.address, schedulerUrl: serviceConfig.schedulerUrl, target: target(serviceConfig) });
  await provider.tick(); assert.equal(workers, 0); assert.equal(provider.preference(c), false);
  assert.equal(walletSignCalls, enrolling ? 2 : 0);
  await provider.dispose();
  report({ phase, arch: process.arch, backend, address: wallet.address, authorizationId: proof.authorizationId, deviceId: proof.deviceId, walletLocked: true, walletSignerAbsent: true,
    accountRestored: true, scopedProofVerified: true, offPreserved: true, freeOnly: basic, persistentRefused: basic, noSecretFiles: basic, walletSignCalls, controlledApprovals });
  app.quit();
}).catch(fail);
