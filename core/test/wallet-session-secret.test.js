"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { machineSecret } = require("../../electron/wallet-session-secret");
const { WalletService } = require("../lib/wallet");

const password = "session-secret fixture password";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-wallet-session-secret-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function storage() {
  const key = crypto.randomBytes(32);
  return {
    encrypted: 0, decrypted: 0,
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString(value) {
      this.encrypted++;
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(bytes) {
      this.decrypted++;
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}

function write(dir, name, bytes = crypto.randomBytes(40)) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

function snapshot(dir) {
  const saved = new Map();
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else saved.set(name, fs.readFileSync(path.join(dir, name)));
    }
  }
  visit("");
  return saved;
}

function assertPreserved(dir, saved) {
  for (const [name, bytes] of saved) assert.deepEqual(fs.readFileSync(path.join(dir, name)), bytes, `${name} preserved`);
}

test("OS-protected wallet resume survives restart with an encrypted exclusive 0600 machine secret", t => {
  const dir = fixture(t), osStorage = storage();
  const secret = machineSecret(dir, osStorage);
  assert.match(secret, /^[a-f0-9]{64}$/);
  const file = path.join(dir, "machine-secret.bin"), bytes = fs.readFileSync(file);
  assert.equal(bytes.includes(secret), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const wallet = new WalletService(path.join(dir, "wallet"));
  const created = wallet.create({ password });
  assert.equal(wallet.saveSession(secret), true);
  const saved = snapshot(dir);
  const resumedSecret = machineSecret(dir, osStorage);
  const reopened = new WalletService(path.join(dir, "wallet"));
  assert.equal(resumedSecret, secret);
  assert.equal(reopened.tryResumeSession(resumedSecret), true);
  assert.equal(reopened.address, created.address);
  assert.equal(osStorage.encrypted, 1);
  assert.equal(osStorage.decrypted, 1);
  assertPreserved(dir, saved);
});

test("confirmed basic_text retires only live wallet resume files while the password wallet, account ciphertext and backups survive", t => {
  const dir = fixture(t), wallet = new WalletService(path.join(dir, "wallet"));
  const created = wallet.create({ password }), secret = crypto.randomBytes(32).toString("hex");
  wallet.saveSession(secret);
  write(dir, "machine-secret.bin", Buffer.from(`legacy-basic-text:${secret}`));
  for (const name of ["account.bin", "credit-account.bin", "credit-account-v2/customer/deployment/chat.json",
    "credit-account-v2/customer/deployment/purchase-installation.enc", "credit-account-v2/customer/deployment/provider-device.enc",
    "test-profile-backups/prior/wallet/wallet.json", "test-profile-backups/prior/wallet/session.bin",
    "test-profile-backups/prior/machine-secret.bin", "wallet/wallet.backup.json", "settings.json"]) write(dir, name);
  const saved = snapshot(dir);
  saved.delete("machine-secret.bin"); saved.delete(path.join("wallet", "session.bin"));
  const unsafe = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text",
    encryptString() { assert.fail("basic_text must not encrypt"); }, decryptString() { assert.fail("basic_text must not decrypt"); } };
  assert.equal(machineSecret(dir, unsafe), null);
  assert.equal(fs.existsSync(path.join(dir, "machine-secret.bin")), false);
  assert.equal(fs.existsSync(path.join(dir, "wallet/session.bin")), false);
  assertPreserved(dir, saved);
  assert.equal(machineSecret(dir, unsafe), null, "retirement is idempotent");
  const reopened = new WalletService(path.join(dir, "wallet"));
  assert.equal(reopened.tryResumeSession(secret), false);
  reopened.unlock(password);
  assert.equal(reopened.address, created.address, "the real password-encrypted wallet remains usable");
});

test("locked, missing and failed OS stores preserve every existing file without attempting encryption", t => {
  const dir = fixture(t);
  for (const name of ["machine-secret.bin", "wallet/session.bin", "wallet/wallet.json", "credit-account.bin", "test-profile-backups/old/wallet/session.bin"]) write(dir, name);
  const saved = snapshot(dir);
  const unavailable = [undefined, {},
    { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => "gnome_libsecret" },
    { isEncryptionAvailable() { throw Error("keyring locked"); }, getSelectedStorageBackend: () => "kwallet6" },
    { isEncryptionAvailable: () => true, getSelectedStorageBackend() { throw Error("OS store unavailable"); } },
  ];
  for (const candidate of unavailable) {
    assert.equal(machineSecret(dir, candidate), null);
    assertPreserved(dir, saved);
    assert.equal(machineSecret(path.join(dir, "not-created"), candidate), null);
    assert.equal(fs.existsSync(path.join(dir, "not-created")), false);
  }
});

test("an inaccessible protected machine secret is preserved for OS recovery instead of silently replaced", t => {
  const dir = fixture(t), osStorage = storage();
  const secret = machineSecret(dir, osStorage);
  write(dir, "wallet/session.bin"); write(dir, "wallet/wallet.json");
  const saved = snapshot(dir), foreignStore = storage();
  assert.equal(machineSecret(dir, foreignStore), null);
  assert.equal(foreignStore.encrypted, 0);
  assertPreserved(dir, saved);
  assert.equal(machineSecret(dir, osStorage), secret, "recovering the original OS store recovers the same secret");
  fs.writeFileSync(path.join(dir, "machine-secret.bin"), osStorage.encryptString("not a wallet machine secret"));
  const invalid = snapshot(dir);
  assert.equal(machineSecret(dir, osStorage), null);
  assertPreserved(dir, invalid);
});

test("oversized, empty and directory records are rejected before decryption and preserved", t => {
  const dir = fixture(t), osStorage = storage(), file = path.join(dir, "machine-secret.bin");
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(16385, 3)]) {
    fs.writeFileSync(file, bytes);
    assert.equal(machineSecret(dir, osStorage), null);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(osStorage.decrypted, 0);
    assert.equal(osStorage.encrypted, 0);
  }
  fs.unlinkSync(file); fs.mkdirSync(file); write(file, "preserve");
  assert.equal(machineSecret(dir, osStorage), null);
  assert.equal(fs.existsSync(path.join(file, "preserve")), true);
});

test("failure to encrypt never creates a machine secret or replaces an existing wallet session", t => {
  const dir = fixture(t), osStorage = storage();
  write(dir, "wallet/session.bin"); write(dir, "wallet/wallet.json");
  const saved = snapshot(dir);
  for (const encryptString of [() => { throw Error("OS store locked"); }, () => "plaintext", () => Buffer.alloc(0), () => Buffer.alloc(16385)]) {
    assert.equal(machineSecret(dir, { ...osStorage, encryptString }), null);
    assert.equal(fs.existsSync(path.join(dir, "machine-secret.bin")), false);
    assertPreserved(dir, saved);
  }
});

test("exclusive creation does not overwrite a machine secret that appears while OS encryption is running", t => {
  const dir = fixture(t), osStorage = storage(), record = crypto.randomBytes(92);
  const encryptString = osStorage.encryptString.bind(osStorage);
  osStorage.encryptString = value => { write(dir, "machine-secret.bin", record); return encryptString(value); };
  assert.equal(machineSecret(dir, osStorage), null);
  assert.deepEqual(fs.readFileSync(path.join(dir, "machine-secret.bin")), record);
});

test("a wallet-backed credit vault cannot store or recover the machine secret that unlocks its own wallet", t => {
  const dir = fixture(t), wallet = new WalletService(path.join(dir, "wallet"));
  wallet.create({ password });
  const unsafe = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text" };
  const vault = wallet.creditStorage(unsafe, "https://credits.example.invalid");
  assert.equal(vault.isEncryptionAvailable(), true);
  assert.equal(machineSecret(dir, vault), null);
  assert.equal(fs.existsSync(path.join(dir, "machine-secret.bin")), false);
  const osStorage = storage(), secret = machineSecret(dir, osStorage);
  const wrappedOS = wallet.creditStorage(osStorage, "https://other.example.invalid");
  assert.equal(wrappedOS.getSelectedStorageBackend(), "gnome_libsecret");
  assert.equal(machineSecret(dir, wrappedOS), null, "even the credit adapter's OS mode is not a wallet-resume API");
  assert.equal(machineSecret(dir, osStorage), secret);
});

function symlink(t, target, link, type) {
  try { fs.symlinkSync(target, link, type); return true; }
  catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) { t.skip("Windows symlink privilege unavailable"); return false; }
    throw error;
  }
}

test("linked machine-secret records are never read or written, and basic_text retirement unlinks only the link", t => {
  const dir = fixture(t), external = fixture(t), osStorage = storage();
  const externalSecret = machineSecret(external, osStorage), saved = snapshot(external);
  const link = path.join(dir, "machine-secret.bin");
  if (!symlink(t, path.join(external, "machine-secret.bin"), link, "file")) return;
  assert.equal(machineSecret(dir, osStorage), null);
  assert.equal(osStorage.decrypted, 0);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(machineSecret(dir, { getSelectedStorageBackend: () => "basic_text" }), null);
  assert.equal(fs.existsSync(link), false);
  assertPreserved(external, saved);
  assert.equal(machineSecret(external, osStorage), externalSecret);
});

test("linked wallet directories and linked profile roots never retire another location's files", t => {
  const dir = fixture(t), external = fixture(t);
  write(external, "session.bin"); write(external, "wallet.json"); write(external, "machine-secret.bin");
  const saved = snapshot(external);
  if (!symlink(t, external, path.join(dir, "wallet"), "junction")) return;
  write(dir, "machine-secret.bin");
  const unsafe = { getSelectedStorageBackend: () => "basic_text" };
  assert.equal(machineSecret(dir, unsafe), null);
  assert.equal(fs.existsSync(path.join(dir, "machine-secret.bin")), false);
  assertPreserved(external, saved);
  const rootLink = path.join(dir, "linked-profile");
  if (!symlink(t, external, rootLink, "junction")) return;
  assert.equal(machineSecret(rootLink, unsafe), null);
  assert.equal(machineSecret(rootLink, storage()), null);
  assertPreserved(external, saved);
});
