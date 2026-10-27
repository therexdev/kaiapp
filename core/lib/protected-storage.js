"use strict";

// Electron's Linux basic_text backend uses a fixed password and does not
// protect credentials. A positive isEncryptionAvailable alone is insufficient.
function isProtectedStorage(storage) {
  try { return storage?.isEncryptionAvailable?.() === true && storage.getSelectedStorageBackend?.() !== "basic_text"; }
  catch { return false; }
}
function storageState(storage) {
  // The credit-only adapter can explain its wallet-unlock requirement. Other
  // callers retain their existing OS storage checks and never gain fallback.
  if (typeof storage?.storageState === "function") return storage.storageState();
  if (isProtectedStorage(storage)) return { available: true, state: "protected" };
  let backend;
  try { backend = storage?.getSelectedStorageBackend?.(); } catch {}
  return { available: false, state: backend === "basic_text" ? "keyring-unavailable" : "keyring-locked-or-unavailable",
    detail: "Unlock your operating system keyring to save network access securely. On Raspberry Pi, a working Secret Service keyring is required for access that survives restart." };
}
module.exports = { isProtectedStorage, storageState };
