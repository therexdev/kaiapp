"use strict";
const crypto = require("node:crypto");
const { isProtectedStorage } = require("./protected-storage");

const MAGIC = Buffer.from("WCV1");
const PURPOSES = new Set(["account-session", "network-chat", "purchase-installation", "provider-device"]);
const fail = message => Object.assign(Error(message), { code: "secure-storage-required" });
const lockedMessage = "Unlock your app wallet once to open saved network access on this computer. No operating system keyring setup is needed.";

// The controller remains inside WalletService. Adapters expose encryption,
// never the derived key, a wallet signer, or an operation that unlocks it.
function createWalletCredentialVault({ osStorage, namespace, walletAddress }) {
  let key = null, address = null, closed = false;
  const adapters = new Map();
  const clear = () => { key?.fill(0); key = null; address = null; };
  const ready = () => {
    if (address && address !== walletAddress()) clear();
    return !closed && key !== null;
  };
  const osReady = () => !closed && isProtectedStorage(osStorage);
  const scopedKey = purpose => crypto.hkdfSync("sha256", key, Buffer.from(address), Buffer.from(JSON.stringify(["KAI-CREDIT-VAULT-SCOPE-V1", namespace, purpose])), 32);
  const aad = (wallet, purpose) => Buffer.from(JSON.stringify(["KAI-CREDIT-VAULT-V1", namespace, wallet, purpose]));
  const scope = purpose => {
    if (!PURPOSES.has(purpose)) throw Error("Unknown credit credential purpose");
    if (adapters.has(purpose)) return adapters.get(purpose);
    const adapter = Object.freeze({
      isEncryptionAvailable: () => osReady() || ready(),
      getSelectedStorageBackend: () => osReady() ? osStorage.getSelectedStorageBackend?.() || "os-protected" : ready() ? "wallet-credit-vault" : "wallet-credit-vault-locked",
      storageState: () => osReady() ? { available: true, state: "protected", protection: "operating-system" }
        : ready() ? { available: true, state: "protected", protection: "wallet-session", detail: "Saved network access is encrypted by your wallet. Unlock once after restarting this app; locking the wallet now does not end authorized network access." }
          : { available: false, state: "wallet-unlock-required", detail: lockedMessage },
      forPurpose: scope,
      encryptString(value) {
        if (typeof value !== "string") throw TypeError("Credential text must be a string");
        if (osReady()) return osStorage.encryptString(value);
        if (!ready()) throw fail(lockedMessage);
        const derived = Buffer.from(scopedKey(purpose));
        try {
          const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", derived, iv);
          cipher.setAAD(aad(address, purpose));
          const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
          return Buffer.concat([MAGIC, Buffer.from(JSON.stringify({ wallet: address, purpose, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }))]);
        } finally { derived.fill(0); }
      },
      decryptString(bytes) {
        if (!Buffer.isBuffer(bytes)) throw TypeError("Encrypted credential must be bytes");
        if (!bytes.subarray(0, 4).equals(MAGIC)) {
          if (!osReady()) throw fail("This saved connection uses the previous operating system credential store and has been preserved. Recover that store before replacing or migrating the connection.");
          return osStorage.decryptString(bytes);
        }
        if (!ready()) throw fail(lockedMessage);
        if (bytes.length > 16777216) throw fail("Saved network access is too large and has been preserved.");
        let record;
        try { record = JSON.parse(bytes.subarray(4).toString("utf8")); } catch { throw fail("Saved network access is damaged and has been preserved."); }
        if (!record || Object.keys(record).sort().join() !== "data,iv,purpose,tag,wallet" || record.wallet !== address || record.purpose !== purpose ||
            ![record.iv, record.tag, record.data].every(value => typeof value === "string" && Buffer.from(value, "base64").toString("base64") === value) ||
            Buffer.from(record.iv, "base64").length !== 12 || Buffer.from(record.tag, "base64").length !== 16)
          throw fail("Saved network access belongs to another wallet or purpose, or is damaged. Its encrypted record has been preserved.");
        const derived = Buffer.from(scopedKey(purpose));
        try {
          const decipher = crypto.createDecipheriv("aes-256-gcm", derived, Buffer.from(record.iv, "base64"));
          decipher.setAAD(aad(record.wallet, purpose)); decipher.setAuthTag(Buffer.from(record.tag, "base64"));
          return Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]).toString("utf8");
        } catch { throw fail("Saved network access could not be authenticated and has been preserved."); }
        finally { derived.fill(0); }
      },
    });
    adapters.set(purpose, adapter); return adapter;
  };
  return Object.freeze({
    storage: scope("account-session"),
    unlock(wallet, derivedKey) {
      clear();
      if (closed || wallet !== walletAddress() || !Buffer.isBuffer(derivedKey) || derivedKey.length !== 32) throw Error("Wallet credential vault identity mismatch");
      address = wallet; key = Buffer.from(derivedKey);
    },
    clear,
    dispose() { clear(); closed = true; },
  });
}

function scopedStorage(storage, purpose) { return storage?.forPurpose ? storage.forPurpose(purpose) : storage; }
module.exports = { createWalletCredentialVault, scopedStorage };
