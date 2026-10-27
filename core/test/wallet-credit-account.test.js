"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { Signer } = require("koilib"), { AccountService } = require("../lib/account"), Protocol = require("../lib/wallet-credit-account");
const { isProtectedStorage } = require("../lib/protected-storage");
const config = require("../lib/koin-network/credit-service.json").config;
function fixture(t, { basicText = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-wallet-credit-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const signer = Signer.fromSeed("wallet-credit-desktop-fixture"), state = { unlocked: true, privacy: "online", signed: 0, challenged: 0, verified: 0, revoked: 0, accountId: "existing-account", token: "wc_" + crypto.randomBytes(32).toString("base64url"), tamper: null, challenge: null };
  const wallet = { address: signer.getAddress(), status: () => ({ address: wallet.address, unlocked: state.unlocked }), signHash: async hash => { state.signed++; return Buffer.from(await signer.signHash(hash)).toString("base64"); } };
  const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => basicText ? "basic_text" : "gnome_libsecret", encryptString: value => Buffer.from(value).map(b => b ^ 72), decryptString: bytes => bytes.map(b => b ^ 72).toString() };
  const accountView = () => ({ id: state.accountId, scope: "wallet-credits", freeOnly: state.challenge?.freeOnly || false, wallets: [{ address: wallet.address }] });
  const options = { dataDir: dir, accountOrigin: new URL(config.schedulerUrl).origin, wallet, safeStorage: storage, settings: { get: () => state.privacy }, fetchImpl: async (url, init) => {
    assert.equal(new URL(url).origin, new URL(config.schedulerUrl).origin); assert.equal(init.redirect, "error");
    const route = new URL(url).pathname, body = init.body && JSON.parse(init.body);
    const pin = Protocol.pin(config, new URL(config.schedulerUrl).origin);
    if (route.endsWith("/capabilities")) return Response.json({ ok: true, capabilities: { walletCredits: 1, freeOnlySessions: 1, scope: "wallet-credits", ...pin, challengeTtlMs: 300000, sessionTtlMs: 2592000000 } });
    if (route.endsWith("/challenge")) {
      state.challenged++; const now = Date.now();
      state.challenge = { schema: 1, purpose: "wallet-credit-session", ...pin, ...body, nonce: "a".repeat(64), issuedAt: now, expiresAt: now + 300000, sessionExpiresAt: now + 2592000000 };
      state.tamper?.(state.challenge); return Response.json({ ok: true, challenge: state.challenge });
    }
    if (route.endsWith("/verify")) {
      state.verified++; assert.equal(body.challengeId, state.challenge.nonce);
      const c = state.challenge;
      const hash = crypto.createHash("sha256").update(JSON.stringify(["KAI-WALLET-CREDIT-SESSION-V1", 1, "wallet-credit-session", c.serviceOrigin, c.schedulerUrl, c.target.chainId, c.target.credits, c.target.creditsHash, c.target.domain, c.target.policyHash, c.address, c.deviceId, c.freeOnly, c.nonce, c.issuedAt, c.expiresAt, c.sessionExpiresAt])).digest();
      assert.equal(Signer.recoverAddress(hash, Buffer.from(body.signature, "base64")), wallet.address);
      return Response.json({ ok: true, token: state.token, account: accountView(), scope: "wallet-credits", freeOnly: c.freeOnly, expiresAt: c.sessionExpiresAt });
    }
    if (route === "/auth/session") {
      assert.equal(init.headers.authorization, "Bearer " + state.token);
      return Response.json({ ok: true, account: accountView(), scope: "wallet-credits", freeOnly: state.challenge.freeOnly, expiresAt: state.challenge.sessionExpiresAt });
    }
    if (route.endsWith("/logout")) { state.revoked++; return Response.json({ ok: true }); }
    throw Error("Unexpected route " + route);
  } };
  return { dir, state, wallet, storage, options, account: new AccountService(options) };
}
test("wallet proof creates protected credit access without traditional sign-in and survives wallet lock/restart", async t => {
  const f = fixture(t); let reviewed;
  const result = await f.account.connectWallet(config, { review: async v => { reviewed = v; return true; } });
  assert.equal(result.state, "connected"); assert.equal(reviewed.address, f.wallet.address); assert.equal(f.state.signed, 1);
  assert.equal(fs.readFileSync(f.account.file).subarray(0, 4).toString(), "ENC1"); assert.ok(!fs.readFileSync(f.account.file).includes(f.state.token));
  f.state.unlocked = false;
  const restarted = new AccountService(f.options), auth = await restarted.creditAuthorization(config.schedulerUrl);
  assert.equal(auth.accountId, "existing-account"); assert.equal(auth.owner, f.wallet.address); assert.equal(auth.scope, "wallet-credits");
  const status = await restarted.status(); assert.equal(status.signedIn, true); assert.equal(status.authScope, "wallet-credits"); assert.ok(!JSON.stringify(status).includes(f.state.token));
  await restarted.signOut(); assert.equal(f.state.revoked, 1); assert.equal(restarted._token(), null);
});
test("cancelled native review signs nothing and creates no credential", async t => {
  const f = fixture(t); assert.equal((await f.account.connectWallet(config, { review: async () => false })).state, "cancelled");
  assert.equal(f.state.signed, 0); assert.equal(f.state.challenged, 0); assert.equal(fs.existsSync(f.account.file), false);
});
for (const [name, tamper] of [
  ["wrong origin", c => { c.serviceOrigin = "https://other.invalid"; }], ["wrong deployment", c => { c.target.creditsHash = "0x1220" + "b".repeat(64); }],
  ["wrong wallet", c => { c.address = Signer.fromSeed("other-wallet").getAddress(); }], ["wrong device", c => { c.deviceId = "b".repeat(64); }],
  ["stale challenge", c => { c.issuedAt -= 600000; c.expiresAt -= 600000; c.sessionExpiresAt -= 600000; }],
  ["extended authority", c => { c.sessionExpiresAt += 1; }], ["changed free-only scope", c => { c.freeOnly = !c.freeOnly; }], ["unknown authority", c => { c.spendKoin = true; }]
]) test(`wallet connection refuses ${name} before signing`, async t => {
  const f = fixture(t); f.state.tamper = tamper;
  await assert.rejects(f.account.connectWallet(config, { review: async () => true }), /challenge/); assert.equal(f.state.signed, 0); assert.equal(fs.existsSync(f.account.file), false);
});
test("basic_text never persists a token; explicit temporary access remains in memory and expires on restart", async t => {
  const f = fixture(t, { basicText: true }); assert.equal(isProtectedStorage(f.storage), false);
  await assert.rejects(f.account.connectWallet(config, { review: async () => true }), { code: "secure-storage-required" });
  assert.equal(f.state.signed, 0);
  const result = await f.account.connectWallet(config, { sessionOnly: true, review: async value => { assert.equal(value.sessionOnly, true); return true; } });
  assert.equal(result.sessionOnly, true); assert.equal(fs.existsSync(f.account.file), false);
  const auth = await f.account.creditAuthorization(config.schedulerUrl); assert.equal(auth.sessionOnly, true);
  f.state.unlocked = false; f.account.assertCreditAuthorization(auth, config.schedulerUrl);
  const restarted = new AccountService(f.options); assert.equal(restarted._token(), null);
  await assert.rejects(restarted.creditAuthorization(config.schedulerUrl), { code: "signin-required" });
  assert.ok(fs.readdirSync(f.dir).every(file => !fs.readFileSync(path.join(f.dir, file)).includes(f.state.token)));
});
test("wallet or privacy changes during review cannot create access, and stored sessions cannot switch wallet", async t => {
  const f = fixture(t);
  await assert.rejects(f.account.connectWallet(config, { review: async () => { f.state.privacy = "local-only"; return true; } }), /online route/); assert.equal(f.state.signed, 0);
  f.state.privacy = "online"; await f.account.connectWallet(config, { review: async () => true });
  const bytes = fs.readFileSync(f.account.file); f.wallet.address = Signer.fromSeed("changed-wallet").getAddress();
  await assert.rejects(f.account.creditAuthorization(config.schedulerUrl), { code: "wallet-changed" }); assert.deepEqual(fs.readFileSync(f.account.file), bytes);
});
test("missing or locked credential store is distinct from a missing account and preserves saved access", async t => {
  const f = fixture(t); await f.account.connectWallet(config, { review: async () => true }); const bytes = fs.readFileSync(f.account.file);
  f.storage.isEncryptionAvailable = () => false; f.storage.decryptString = () => { throw Error("keyring locked"); };
  await assert.rejects(f.account.creditAuthorization(config.schedulerUrl), { code: "secure-storage-required" });
  assert.deepEqual(fs.readFileSync(f.account.file), bytes);
});

test("Buy preserves unreadable saved credentials before review or proof even when the keyring reports available", async t => {
  const { CreditService } = require("../../electron/credit-service");
  for (const unreadable of ["changed-keyring", "corrupted-record"]) {
    const f = fixture(t); await f.account.connectWallet(config, { review: async () => true });
    const decrypt = f.storage.decryptString;
    if (unreadable === "changed-keyring") f.storage.decryptString = () => { throw Error("Prior key unavailable"); };
    else fs.writeFileSync(f.account.file, Buffer.from("ENC1unreadable-fixture"));
    const saved = fs.readFileSync(f.account.file), signed = f.state.signed, challenged = f.state.challenged;
    let reviews = 0;
    const window = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false };
    const service = new CreditService({ dataDir: f.dir, account: f.account, storage: f.storage,
      service: require("../lib/koin-network/credit-service.json"), dialog: { showMessageBox: async () => { reviews++; return { response: 1 }; } } });
    t.after(() => service.dispose());
    assert.equal(isProtectedStorage(f.storage), true); assert.equal(f.account._token(), null);
    await assert.rejects(service.preparePurchase(window), { code: "saved-account-unavailable" });
    assert.deepEqual(fs.readFileSync(f.account.file), saved);
    assert.equal(reviews, 0); assert.equal(f.state.signed, signed); assert.equal(f.state.challenged, challenged);
    // An explicit sign-out still permits choosing a fresh connection. This
    // differs from a read failure silently discarding the prior identity.
    await f.account.signOut(); assert.equal(fs.existsSync(f.account.file), false);
    f.storage.decryptString = decrypt;
    assert.equal((await f.account.connectWallet(config, { review: async () => true })).state, "connected");
  }
});

test("temporary access can overlay an unreadable saved connection but cannot persist over it", async t => {
  const f = fixture(t); await f.account.connectWallet(config, { review: async () => true });
  const saved = fs.readFileSync(f.account.file);
  f.storage.decryptString = () => { throw Error("Prior key unavailable"); };
  assert.equal(isProtectedStorage(f.storage), true);
  assert.equal((await f.account.connectWallet(config, { sessionOnly: true, review: async () => true })).sessionOnly, true);
  assert.deepEqual(fs.readFileSync(f.account.file), saved);
  const signed = f.state.signed; let reviews = 0;
  await assert.rejects(f.account.connectWallet(config, { review: async () => { reviews++; return true; } }), { code: "saved-account-unavailable" });
  assert.equal(reviews, 0); assert.equal(f.state.signed, signed);
  assert.deepEqual(fs.readFileSync(f.account.file), saved); assert.equal(f.account._tokenRecord().sessionOnly, true);
});

test("expired authority and changed server account cannot reuse or overwrite prior credit identity", async t => {
  const f = fixture(t); await f.account.connectWallet(config, { review: async () => true });
  const original = fs.readFileSync(f.account.file), record = f.account._tokenRecord();
  f.account._saveToken(record.token, { ...record, expiresAt: Date.now() - 1 });
  await assert.rejects(f.account.creditAuthorization(config.schedulerUrl), { code: "wallet-reauthorization-required" });
  fs.writeFileSync(f.account.file, original); const accountId = f.state.accountId;
  f.state.accountId = "another-account";
  await assert.rejects(f.account.creditAuthorization(config.schedulerUrl), { code: "identity-changed" });
  await assert.rejects(f.account.connectWallet(config, { review: async () => true }), { code: "identity-changed" });
  assert.deepEqual(fs.readFileSync(f.account.file), original); assert.equal(f.account._tokenRecord().accountId, accountId);
});
test("unsupported backend and lost protected-store writes preserve saved credentials and never use plaintext", async t => {
  const f = fixture(t); await f.account.connectWallet(config, { review: async () => true }); const original = fs.readFileSync(f.account.file);
  f.storage.encryptString = () => { throw Error("Keyring closed during save"); };
  assert.throws(() => f.account._saveToken("replacement"), /Keyring closed/); assert.deepEqual(fs.readFileSync(f.account.file), original);
  f.account.fetchImpl = async () => new Response("Old service", { status: 404 });
  await assert.rejects(f.account.walletCapabilities(config), { code: "service-upgrade-required" });
  assert.deepEqual(fs.readFileSync(f.account.file), original);
});

test("native credit connection exposes precise storage/privacy state and cancellation cannot authorize", async t => {
  const f = fixture(t, { basicText: true }), { CreditService } = require("../../electron/credit-service");
  let dialogs = 0;
  const service = new CreditService({ dataDir: f.dir, account: f.account, storage: f.storage, service: require("../lib/koin-network/credit-service.json"),
    dialog: { showMessageBox: async (_window, options) => { dialogs++; assert.match(options.detail, /free credits only/); assert.equal(options.defaultId, 0); return { response: 0 }; } } });
  const status = await service.walletInfo(); assert.equal(status.state, "secure-storage-required"); assert.equal(status.canConnect, true); assert.equal(status.connected, false);
  const window = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false };
  assert.equal((await service.connectWallet(window, { sessionOnly: true })).state, "cancelled"); assert.equal(dialogs, 1); assert.equal(f.state.signed, 0);
  f.state.privacy = "local-only"; f.account.fetchImpl = () => { throw Error("Unexpected network egress"); };
  assert.equal((await service.walletInfo()).state, "online-required"); service.dispose();
});

test("temporary access cannot overwrite a latent protected connection for another account", async t => {
  const f = fixture(t);
  f.account._saveToken("prior-account-token", { accountId: "prior-account", scope: "wallet-credits", wallet: f.wallet.address, freeOnly: false, expiresAt: Date.now() + 86400000 });
  const old = fs.readFileSync(f.account.file), decrypt = f.storage.decryptString;
  f.storage.isEncryptionAvailable = () => false; f.storage.decryptString = () => { throw Error("Locked keyring"); };
  await f.account.connectWallet(config, { sessionOnly: true, review: async () => true });
  assert.equal(f.account._tokenRecord().accountId, f.state.accountId); assert.deepEqual(fs.readFileSync(f.account.file), old);
  f.storage.isEncryptionAvailable = () => true; f.storage.decryptString = decrypt;
  await assert.rejects(f.account.connectWallet(config, { review: async () => true }), { code: "identity-changed" });
  assert.deepEqual(fs.readFileSync(f.account.file), old); assert.equal(f.account._tokenRecord().sessionOnly, true);
});

test("a temporary credit service outage does not turn a connected wallet into an account-required error", async t => {
  const f = fixture(t); await f.account.connectWallet(config, { review: async () => true }); const saved = fs.readFileSync(f.account.file);
  f.account.fetchImpl = async () => Response.json({ ok: false, error: "restarting" }, { status: 503 });
  await assert.rejects(f.account.creditAuthorization(config.schedulerUrl), { code: "service-unavailable" });
  assert.deepEqual(fs.readFileSync(f.account.file), saved);
});

test("ending temporary access archives latent credentials without restoring a hidden account after restart", async t => {
  const f = fixture(t); f.account._saveToken("prior-session", { accountId: "prior-account" }); const old = fs.readFileSync(f.account.file), decrypt = f.storage.decryptString;
  f.storage.isEncryptionAvailable = () => false; f.storage.decryptString = () => { throw Error("locked"); };
  await f.account.connectWallet(config, { sessionOnly: true, review: async () => true });
  f.storage.isEncryptionAvailable = () => true; f.storage.decryptString = decrypt;
  await f.account.signOut(); assert.equal(f.state.revoked, 1); assert.equal(f.account._token(), null);
  assert.equal(fs.existsSync(f.account.file), false); assert.equal((await f.account.status()).savedConnectionPreserved, true);
  const archived = fs.readdirSync(f.dir).find(file => file.startsWith(path.basename(f.account.file) + ".saved-"));
  assert.ok(archived); assert.deepEqual(fs.readFileSync(path.join(f.dir, archived)), old);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(f.dir, archived)).mode & 0o777, 0o600);
  assert.equal(new AccountService(f.options)._token(), null);
});
