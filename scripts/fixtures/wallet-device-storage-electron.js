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
async function verifyLongPathJournals() {
  // Use this Electron runtime's built-in SQLite and the packaged production
  // recovery classes. This is an unsigned isolated rehearsal, with no wallet
  // signer or broadcast transport. Ordinary persisted paths must stay intact.
  const { DatabaseSync } = require("node:sqlite"), { Transaction, Signer, utils } = load("node_modules/koilib");
  const { sqlitePath } = load("core/lib/sqlite-path.js"), { JournalSet } = load("core/lib/koin-network/journal-set.js");
  const { FundingRecovery } = load("electron/koin-funding-recovery.js"), { KoinChain } = load("core/lib/koin-network/chain.js");
  const { hash } = load("core/lib/koin-network/job-protocol.js");
  const shortFile = path.join(config.root, "sqlite-same-physical-file.sqlite");
  let db = new DatabaseSync(shortFile);
  try {
    if (phase === "enroll") { db.exec("CREATE TABLE fixture(value TEXT NOT NULL)"); db.prepare("INSERT INTO fixture VALUES(?)").run("native-same-file"); }
    assert.equal(db.prepare("SELECT value FROM fixture").get().value, "native-same-file");
  } finally { db.close(); }
  db = new DatabaseSync(sqlitePath(shortFile), { readOnly: true });
  try { assert.equal(db.prepare("SELECT value FROM fixture").get().value, "native-same-file"); }
  finally { db.close(); }
  let parent = path.join(config.root, "long-sqlite");
  while (parent.length < 340) parent = path.join(parent, "native-journal-" + "j".repeat(48));
  const directory = path.join(parent, "journals"), backupParent = path.join(parent, "external-backups"), backup = path.join(backupParent, "latest");
  fs.mkdirSync(backupParent, { recursive: true });
  const anchorFile = directory + ".recovery-anchor.sqlite", nonceFile = path.join(directory, "wallet-nonces.sqlite");
  assert.ok(anchorFile.length > 300); assert.ok(path.join(backup, "funding-recovery.sqlite").length > 300);
  const deployment = { schema: 1, network: "isolated", decimals: 8, rpc: ["http://127.0.0.1:1"],
    chainId: utils.encodeBase64url(Buffer.from("1220" + "6".repeat(64), "hex")) };
  for (const role of ["token", "credits", "rewards", "admin", "verifier", "mining", "operations"]) deployment[role] = Signer.fromSeed("native-storage-fixture-" + role).getAddress();
  for (const role of ["token", "credits", "rewards"]) deployment[role + "Hash"] = "0x1220" + "1".repeat(64);
  const client = new KoinChain(deployment, { getChainId: async () => deployment.chainId, getNextNonce: async () => "KAE=" });
  const options = { mode: "isolated-rehearsal", client, clock: () => 1000000, maxRcPerDay: "20000000" };
  const tx = new Transaction({ provider: client.provider, options: { payer: deployment.admin, rcLimit: "10000000" } });
  await tx.pushOperation({ call_contract: { contract_id: deployment.token, entry_point: 1, args: "" } });
  await tx.prepare({ chainId: deployment.chainId, nonce: "KAE=" });
  assert.ok(!tx.transaction.signatures?.length);
  const id = hash("native-long-path-unsigned-nonce"), savedFile = path.join(config.root, "journal-public.json");
  let journal, guard;
  const closeJournal = () => { if (journal) { const handle = journal; journal = null; handle.close(); } };
  const readAnchor = () => {
    const handle = new DatabaseSync(sqlitePath(anchorFile), { readOnly: true });
    try { return { ...handle.prepare("SELECT pair_id,directory,generation FROM anchor WHERE id=1").get() }; }
    finally { handle.close(); }
  };
  try {
    journal = new FundingRecovery(directory, options);
    assert.equal(journal.paymentsEnabled, false); assert.equal(journal.list().length, 0);
    if (phase === "enroll") {
      assert.equal((await journal.nonceCoordinator.reserve(id, "send", tx.transaction)).action, "sign_original");
    }
    assert.equal(journal.nonceCoordinator.status(id).state, "signing");
    assert.equal(journal.nonceCoordinator.status(id).txId, tx.transaction.id);
    assert.equal(journal.nonceCoordinator.envelope(id), null);
    assert.equal(journal.nonceCoordinator.pending(deployment.admin, "send").length, 1);
    await assert.rejects(journal.nonceCoordinator.reserve(hash("native-second-nonce"), "send", tx.transaction), /owns this wallet nonce/);
    closeJournal();
    // Supplying the namespace explicitly must reopen the same anchor and nonce,
    // without changing the directory identity stored by the application.
    journal = new FundingRecovery(sqlitePath(directory), options);
    assert.equal(journal.nonceCoordinator.status(id).txId, tx.transaction.id); closeJournal();
    const anchor = readAnchor(); assert.equal(anchor.directory, fs.realpathSync(directory));
    assert.equal(anchor.directory.startsWith("\\\\?\\"), false);
    guard = new JournalSet(directory, { maintenance: true });
    if (phase === "enroll") {
      const manifest = guard.snapshot(backup);
      assert.equal(manifest.pairId, anchor.pair_id); assert.equal(manifest.generation, anchor.generation);
      fs.writeFileSync(savedFile, JSON.stringify(anchor));
    } else {
      assert.deepEqual(anchor, JSON.parse(fs.readFileSync(savedFile, "utf8")));
      assert.equal(guard.restore(backup).restored, true);
      journal = new FundingRecovery(directory, options);
      assert.equal(journal.nonceCoordinator.status(id).txId, tx.transaction.id); closeJournal();
    }
    assert.equal(guard.inspect(backup).restorable, true); assert.deepEqual(readAnchor(), anchor);
    guard.close(); guard = null;
    if (phase === "restart") {
      db = new DatabaseSync(sqlitePath(nonceFile));
      try { db.exec("UPDATE recovery_generation SET generation=generation+1"); } finally { db.close(); }
      assert.throws(() => new FundingRecovery(directory, options), /generation mismatch/);
    }
    return { ordinaryNamespaceSameFile: true, namespaceDirectoryIdentity: true, unsignedNoncePreserved: true, backupVerified: true,
      restored: phase === "restart", generationTamperRejected: phase === "restart", anchorLength: anchorFile.length,
      backupLength: path.join(backup, "funding-recovery.sqlite").length, pairId: anchor.pair_id, generation: anchor.generation, txId: tx.transaction.id };
  } finally { try { closeJournal(); } finally { guard?.close(); } }
}
app.setPath("appData", config.profile);
load("core/lib/release-channel.js").configureDesktop(app, load("core/lib/release-channel.js").channelConfig("test"));
if (!app.requestSingleInstanceLock()) fail(Error("Isolated fixture profile was already in use"));
else app.whenReady().then(async () => {
  assert.equal(process.platform, "win32"); assert.equal(safeStorage.isEncryptionAvailable(), true);
  assert.equal(load("core/lib/protected-storage.js").isProtectedStorage(safeStorage), true);
  const sqlite = await verifyLongPathJournals();
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
    accountRestored: true, scopedProofVerified: true, walletSignCalls, controlledApprovals, sqlite };
  await provider.dispose(); report(result); app.quit();
}).catch(fail);
