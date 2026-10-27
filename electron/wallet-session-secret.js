"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isProtectedStorage } = require("../core/lib/protected-storage");

const MAX_ENCRYPTED_BYTES = 16384;
const SECRET = /^[a-f0-9]{64}$/;

function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function directory(file) {
  const info = stat(file);
  return info?.isDirectory() === true && !info.isSymbolicLink();
}

// Remove the resume capability, never the password-encrypted wallet or saved
// account records. unlink removes a final symlink itself, not its target.
function retireUnprotectedSession(dataDir) {
  if (!directory(dataDir)) return;
  const files = [path.join(dataDir, "machine-secret.bin")];
  const walletDir = path.join(dataDir, "wallet");
  if (directory(walletDir)) files.unshift(path.join(walletDir, "session.bin"));
  for (const file of files) {
    try {
      const info = stat(file);
      if (info && (info.isFile() || info.isSymbolicLink())) fs.unlinkSync(file);
    } catch { /* Retry retiring this exact resume file on the next launch. */ }
  }
}

function readEncrypted(file, info) {
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_ENCRYPTED_BYTES) return null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) return null;
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    return length === info.size ? bytes.subarray(0, length) : null;
  } finally { fs.closeSync(fd); }
}

// Only the native OS store may hold a wallet-resume secret. The separate
// wallet-backed credit vault must never create a way to unlock its own wallet.
function machineSecret(dataDir, safeStorage) {
  try {
    if (typeof safeStorage?.forPurpose === "function") return null;
    let backend;
    try { backend = safeStorage?.getSelectedStorageBackend?.(); } catch { return null; }
    if (backend === "basic_text") {
      retireUnprotectedSession(dataDir);
      return null;
    }
    if (!isProtectedStorage(safeStorage)) return null;

    const root = stat(dataDir);
    if (root && (!root.isDirectory() || root.isSymbolicLink())) return null;
    const file = path.join(dataDir, "machine-secret.bin");
    const existing = stat(file);
    if (existing) {
      const bytes = readEncrypted(file, existing);
      if (!bytes) return null;
      const secret = safeStorage.decryptString(bytes);
      return typeof secret === "string" && SECRET.test(secret) ? secret : null;
    }

    const secret = crypto.randomBytes(32).toString("hex");
    const bytes = safeStorage.encryptString(secret);
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_ENCRYPTED_BYTES) return null;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (!directory(dataDir)) return null;
    // Exclusive creation preserves any record that appeared during startup.
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return secret;
  } catch {
    // A locked, unavailable or damaged OS store is recoverable. Preserve its
    // encrypted files and ask for the wallet password instead of replacing it.
    return null;
  }
}

module.exports = { machineSecret };
