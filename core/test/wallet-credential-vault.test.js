"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { WalletService } = require("../lib/wallet"), { AccountService } = require("../lib/account");
const { isProtectedStorage, storageState } = require("../lib/protected-storage");
const { ProviderDevice } = require("../../electron/provider-device"), P = require("../lib/koin-network/provider-device-protocol");
const Access = require("../../electron/credit-purchase-access");
const service = require("../lib/koin-network/credit-service.json"), origin = new URL(service.config.schedulerUrl).origin;
const password = "vault fixture correct password";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-vault-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wallet = new WalletService(path.join(dir, "wallet"));
  const unsafe = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text", encryptString() { throw Error("basic_text must never encrypt"); }, decryptString() { throw Error("basic_text must never decrypt"); } };
  const storage = wallet.creditStorage(unsafe, origin);
  const account = new AccountService({ dataDir: dir, wallet, accountOrigin: origin, safeStorage: storage, settings: { get: () => "network" } });
  return { dir, wallet, storage, account, unsafe };
}
function reopen(f) {
  const wallet = new WalletService(path.join(f.dir, "wallet")), storage = wallet.creditStorage(f.unsafe, origin);
  const account = new AccountService({ dataDir: f.dir, wallet, accountOrigin: origin, safeStorage: storage, settings: { get: () => "network" } });
  return { wallet, storage, account };
}

test("Pi without an OS keyring saves only encrypted account, chat and payment capability records after wallet unlock", t => {
  const f = fixture(t); assert.equal(isProtectedStorage(f.storage), false); assert.equal(storageState(f.storage).state, "wallet-unlock-required");
  const created = f.wallet.create({ password });
  const token = "wc_" + crypto.randomBytes(32).toString("base64url");
  f.account._saveToken(token, { wallet: created.address, scope: "wallet-credits" });
  assert.equal(f.account._token(), token); assert.equal(storageState(f.storage).protection, "wallet-session");
  const raw = fs.readFileSync(f.account.file); assert.equal(raw.subarray(0, 8).toString(), "ENC1WCV1"); assert.equal(raw.includes(token), false);
  const chat = f.storage.forPurpose("network-chat"), message = "Private chat content never appears on disk";
  const chatFile = path.join(f.dir, "chat.enc"); fs.writeFileSync(chatFile, chat.encryptString(message), { mode: 0o600 });
  assert.equal(fs.readFileSync(chatFile).includes(message), false); assert.equal(chat.decryptString(fs.readFileSync(chatFile)), message);
  const config = { ...service.config, owner: created.address }, directory = path.join(f.dir, "payments"); fs.mkdirSync(directory);
  const installation = Access.installation({ dataDir: f.dir, directory, config, storage: f.storage.forPurpose("purchase-installation") });
  assert.equal(fs.readFileSync(path.join(directory, "purchase-installation.enc")).includes(installation), false);
  for (const file of [f.account.file, chatFile, path.join(directory, "purchase-installation.enc"), f.wallet.keystorePath]) {
    const bytes = fs.readFileSync(file); assert.equal(bytes.includes(created.wif), false); assert.equal(bytes.includes(f.wallet.signer.getPrivateKey("hex")), false);
  }
  assert.deepEqual(fs.readdirSync(f.dir).sort(), [path.basename(f.account.file), "chat.enc", "payments", "wallet"].sort(), "no adjacent plaintext vault key exists");
  const next = reopen(f); assert.equal(next.account._token(), null); assert.equal(isProtectedStorage(next.storage), false);
  assert.throws(() => next.wallet.unlock("wrong fixture password"), /Incorrect password/); assert.equal(isProtectedStorage(next.storage), false);
  next.wallet.signerFor(password); assert.equal(isProtectedStorage(next.storage), false, "one-shot financial authorization must not open the credential vault");
  assert.throws(() => next.account._saveToken("replacement"), /preserved/); assert.deepEqual(fs.readFileSync(f.account.file), raw);
  next.wallet.unlock(password); assert.equal(next.account._token(), token);
  assert.equal(next.storage.forPurpose("network-chat").decryptString(fs.readFileSync(chatFile)), message);
  assert.equal(Access.installation({ dataDir: f.dir, directory, config, storage: next.storage.forPurpose("purchase-installation") }), installation);
});

test("ordinary wallet Lock retains scoped credit access but cannot sign or unlock the financial wallet; disposal erases access", async t => {
  const f = fixture(t); f.wallet.create({ password }); const bytes = f.storage.encryptString("credit capability");
  f.wallet.lock(); assert.equal(f.wallet.status().unlocked, false); assert.equal(f.storage.decryptString(bytes), "credit capability");
  assert.throws(() => f.wallet.signer, /locked/); await assert.rejects(f.wallet.signHash(crypto.randomBytes(32)), /locked/);
  assert.throws(() => f.wallet.signerFor(""), /password/); assert.equal(f.wallet.tryResumeSession(null), false);
  assert.equal(fs.existsSync(f.wallet._sessionPath()), false); assert.equal(Object.hasOwn(f.storage, "key"), false);
  f.wallet.disposeCreditStorage(); assert.equal(isProtectedStorage(f.storage), false); assert.throws(() => f.storage.decryptString(bytes), /Unlock/);
});

test("Core wires only the separate credit account to the wallet vault and clears it on shutdown", async t => {
  const f = fixture(t), core = await require("../server").createCore({ dataDir: f.dir, port: 0, creditAccountOrigin: origin, onEvent() {} });
  await core.start(); t.after(() => core.stop());
  assert.notEqual(core.account.safeStorage, core.creditAccount.safeStorage);
  assert.equal(core.account.safeStorage?.forPurpose, undefined, "website account and other OS consumers do not inherit wallet fallback");
  const wallet = core.creditAccount.wallet; wallet.create({ password });
  assert.equal(isProtectedStorage(core.creditAccount.safeStorage), true);
  core.creditAccount._saveToken("credit-only-secret"); const bytes = fs.readFileSync(core.creditAccount.file);
  wallet.lock(); assert.equal(core.creditAccount._token(), "credit-only-secret");
  await core.stop(); assert.equal(isProtectedStorage(core.creditAccount.safeStorage), false);
  assert.deepEqual(fs.readFileSync(core.creditAccount.file), bytes, "shutdown removes the in-memory key, not encrypted credentials");
});

test("AES-GCM rejects altered ciphertext, wallet, purpose and service origin; a wallet identity replacement cannot read old access", t => {
  const f = fixture(t); const first = f.wallet.create({ password }); const bytes = f.storage.encryptString("secret");
  assert.throws(() => f.storage.forPurpose("provider-device").decryptString(bytes), /purpose/);
  const otherOrigin = f.wallet.creditStorage(null, "https://other.invalid"); assert.throws(() => otherOrigin.decryptString(bytes), /authenticated/);
  const record = JSON.parse(bytes.subarray(4)); record.data = Buffer.from("tampered").toString("base64");
  assert.throws(() => f.storage.decryptString(Buffer.concat([Buffer.from("WCV1"), Buffer.from(JSON.stringify(record))])), /authenticated/);
  const other = new WalletService(path.join(f.dir, "other")), second = other.create({ password });
  f.wallet.restore({ wif: second.wif, password }); assert.throws(() => f.storage.decryptString(bytes), /another wallet/);
  f.wallet.restore({ wif: first.wif, password }); assert.equal(f.storage.decryptString(bytes), "secret", "verified key recovery restores the same credit key without storing it separately");
  f.wallet.remove({ password, confirm: "REMOVE" }); assert.equal(isProtectedStorage(f.storage), false);
});

test("unreadable legacy OS ciphertext is never interpreted by the wallet vault or overwritten; genuine OS storage remains compatible", async t => {
  const f = fixture(t); f.wallet.create({ password });
  const osKey = crypto.randomBytes(32), protectedOS = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString(value) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", osKey, iv); const data = Buffer.concat([c.update(value), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]); },
    decryptString(bytes) { const d = crypto.createDecipheriv("aes-256-gcm", osKey, bytes.subarray(0, 12)); d.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([d.update(bytes.subarray(28)), d.final()]).toString(); } };
  const saved = Buffer.concat([Buffer.from("ENC1"), protectedOS.encryptString(JSON.stringify({ token: "legacy-private-token" }))]); fs.writeFileSync(f.account.file, saved);
  assert.equal(f.account._token(), null); assert.throws(() => f.account._saveToken("replacement-token"), /preserved/);
  await assert.rejects(f.account.connectWallet(service.config, { review: async () => { throw Error("must not review or sign"); } }), { code: "saved-account-unavailable" });
  assert.deepEqual(fs.readFileSync(f.account.file), saved);
  const restarted = new WalletService(path.join(f.dir, "wallet")), storage = restarted.creditStorage(protectedOS, origin);
  const account = new AccountService({ dataDir: f.dir, wallet: restarted, accountOrigin: origin, safeStorage: storage, settings: { get: () => "network" } });
  assert.equal(restarted.status().unlocked, false); assert.equal(account._token(), "legacy-private-token"); assert.equal(storageState(storage).protection, "operating-system");
  assert.deepEqual(fs.readFileSync(f.account.file), saved, "decrypting a legacy connection does not migrate or rewrite it");
});

test("real delegated provider authorization uses the credit vault, survives Lock and verified restart unlock, and cannot spend KOIN", async t => {
  const f = fixture(t); f.wallet.create({ password }); const now = Date.now();
  const coreFor = f => ({ account: { wallet: f.wallet, safeStorage: f.unsafe }, creditAccount: f.account, settings: { get: () => "network" }, gateway: { network: { status: () => ({ privacyMode: "network" }) } } });
  const options = { service: { service, dataDir: f.dir }, core: coreFor(f), clock: () => now };
  const device = new ProviderDevice(options), c = device.identity(), pair = crypto.generateKeyPairSync("ed25519");
  const authorization = { schema: 1, purpose: "provider", schedulerUrl: c.config.schedulerUrl, target: c.target, wallet: f.wallet.address,
    deviceId: crypto.randomBytes(32).toString("hex"), publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"), challenge: crypto.randomBytes(32).toString("hex"), issuedAt: now, challengeExpiresAt: now + 300000, expiresAt: now + 2592000000, actions: [...P.ACTIONS] };
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), walletSignature = await f.wallet.signHash(P.authorizationHash(authorization));
  const record = { schema: 1, authorization, walletSignature, privateKey, sessionOnly: false, enrolled: true };
  device.save(c, record); const file = path.join(c.directory, "authorization.enc"), bytes = fs.readFileSync(file); assert.equal(bytes.subarray(0, 4).toString(), "WCV1"); assert.equal(bytes.includes(privateKey), false);
  f.wallet.lock(); const ctx = await device.context(), digest = P.hash("work"); const proof = device.proof(ctx, "presence", digest);
  assert.equal(P.verifyAction(proof, "presence", digest, { now }).wallet, f.wallet.address); await assert.rejects(f.wallet.signHash(digest), /locked/);
  assert.throws(() => device.proof(ctx, "transfer", digest), /action/i);
  const next = reopen(f), nextDevice = new ProviderDevice({ ...options, core: coreFor({ ...f, ...next }) });
  await assert.rejects(nextDevice.context(), { code: "secure-storage-required" }); assert.deepEqual(fs.readFileSync(file), bytes);
  next.wallet.unlock(password); const restored = await nextDevice.context(); assert.equal(restored.record.privateKey, privateKey);
  next.wallet.lock(); assert.equal(P.verifyAction(nextDevice.proof(restored, "presence", digest), "presence", digest, { now }).wallet, next.wallet.address);
  next.wallet.disposeCreditStorage(); assert.throws(() => nextDevice.proof(restored, "presence", digest), { code: "secure-storage-required" });
  const another = new WalletService(path.join(f.dir, "different-wallet")), replacement = another.create({ password });
  next.wallet.restore({ wif: replacement.wif, password });
  assert.throws(() => nextDevice.proof(restored, "presence", digest), /authorization changed/);
  assert.equal(restored.record.privateKey, "", "identity switch releases cached delegated keys even if an old context is retained");
  assert.deepEqual(fs.readFileSync(file), bytes);
});
