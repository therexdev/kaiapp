"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Signer, utils } = require("koilib");
const { encryptKeystore, decryptKeystore } = require("./keystore");

const MIN_PASSWORD_LENGTH = 8;

/*
 * Wallet (M2 step 1) — ported from Koinos-Node's WalletService, minus the
 * ETH-bridge derivation (§47 out of scope). Encrypted keystore on disk
 * (scrypt + AES-256-GCM), koilib Signer in memory after unlock. Wallet keys
 * never leave Core and are never API keys (§8). §5: created automatically at
 * Earn opt-in; WIF backup lives behind Advanced, never in onboarding.
 */
class WalletService {
  constructor(walletDir) {
    this.walletDir = walletDir;
    this.keystorePath = path.join(walletDir, "wallet.json");
    this._signer = null;
  }

  readKeystore() {
    try {
      return JSON.parse(fs.readFileSync(this.keystorePath, "utf8"));
    } catch {
      return null;
    }
  }

  exists() {
    return fs.existsSync(this.keystorePath);
  }

  status() {
    const ks = this.readKeystore();
    return {
      exists: !!ks,
      unlocked: !!this._signer,
      address: this._signer ? this._signer.getAddress() : (ks?.address ?? null),
      createdAt: ks?.createdAt ?? null,
    };
  }

  get signer() {
    if (!this._signer) throw new Error("Wallet is locked");
    return this._signer;
  }

  get address() {
    return this._signer ? this._signer.getAddress() : (this.readKeystore()?.address ?? null);
  }

  /** Canonical password for saving: Unicode NFC, whitespace refused loudly.
   *  Accented characters can arrive composed or decomposed — pixel-identical,
   *  different bytes — so every save normalizes and every unlock retries the
   *  same normalization (NIST 800-63B's recommendation for exactly this). */
  _canonicalPassword(password) {
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    // A pasted trailing space is invisible and becomes a delayed lockout —
    // refuse it at save time, when the user can still fix it painlessly.
    if (password !== password.trim()) {
      throw new Error("Password can't start or end with a space — remove the stray whitespace and try again");
    }
    return password.normalize("NFC");
  }

  _persist(signer, password) {
    const keystore = encryptKeystore({
      privateKeyHex: signer.getPrivateKey("hex"),
      address: signer.getAddress(),
      password,
    });
    keystore.compressed = signer.compressed !== false;
    fs.mkdirSync(this.walletDir, { recursive: true });
    const tmp = `${this.keystorePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(keystore, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.keystorePath);
    // Prove the file we just wrote reopens with this password before reporting
    // success — "saved but won't unlock later" must be impossible, not rare.
    if (decryptKeystore(this.readKeystore(), password) !== signer.getPrivateKey("hex")) {
      throw new Error("Keystore verification failed after write — the wallet was NOT saved correctly");
    }
  }

  create({ password }) {
    password = this._canonicalPassword(password);
    if (this.exists()) {
      throw new Error("A wallet already exists. Back it up and remove it before creating a new one.");
    }
    let signer = null;
    while (!signer) {
      try {
        signer = new Signer({ privateKey: crypto.randomBytes(32).toString("hex") });
      } catch {
        // Astronomically rare: key outside curve order. Try again.
      }
    }
    this._persist(signer, password);
    this._signer = signer;
    // WIF returned once so the user can write down a backup (Advanced flow).
    return { address: signer.getAddress(), wif: signer.getPrivateKey("wif") };
  }

  _signerFromWif(wif) {
    const cleanWif = String(wif || "").trim();
    try {
      if (!utils.isChecksumWif(cleanWif)) throw new Error("bad checksum");
      return Signer.fromWif(cleanWif);
    } catch {
      throw new Error("Invalid backup code — check for typos and missing characters");
    }
  }

  importWif({ wif, password }) {
    password = this._canonicalPassword(password);
    if (this.exists()) {
      throw new Error("A wallet already exists. Back it up and remove it before importing another one.");
    }
    const signer = this._signerFromWif(wif);
    this._persist(signer, password);
    this._signer = signer;
    return { address: signer.getAddress() };
  }

  /**
   * Recovery (§8): the WIF backup is stronger proof of ownership than the
   * password, so it may replace a keystore whose password is lost. A new
   * password is set; the old keystore is set aside on disk, never destroyed.
   */
  restore({ wif, password }) {
    password = this._canonicalPassword(password);
    const signer = this._signerFromWif(wif);
    if (this.exists()) {
      fs.renameSync(this.keystorePath, `${this.keystorePath}.bak-${Date.now()}`);
    }
    this._persist(signer, password);
    this._signer = signer;
    return { address: signer.getAddress(), restored: true };
  }

  _signerFromKeystore(password) {
    const ks = this.readKeystore();
    if (!ks) throw new Error("No wallet found");
    const privateKeyHex = decryptKeystore(ks, password);
    const signer = new Signer({ privateKey: privateKeyHex, compressed: ks.compressed !== false });
    if (ks.address && signer.getAddress() !== ks.address) {
      throw new Error("Keystore address mismatch — file may be corrupted");
    }
    return signer;
  }

  unlock(password) {
    // Equivalent-looking input must open the wallet: retry the Unicode-NFC
    // and trimmed forms of what was typed — pixel-identical variants that
    // differ only in bytes. Order: exact first, so byte-exact always wins.
    const typed = String(password ?? "");
    const variants = [...new Set([typed, typed.normalize("NFC"), typed.trim(), typed.normalize("NFC").trim()])];
    let lastErr = null;
    for (const candidate of variants) {
      try {
        this._signer = this._signerFromKeystore(candidate);
        return { address: this._signer.getAddress() };
      } catch (e) {
        lastErr = e;
        if (!/Incorrect password/.test(String(e.message))) throw e;
      }
    }
    // Name the exact file that refused, and say WHAT differs: a wrong length
    // is a missing/extra character; a right length is a changed one.
    const ks = this.readKeystore();
    let detail = "";
    if (ks?.pwHint?.len != null) {
      const typedLen = [...typed].length;
      detail =
        typedLen !== ks.pwHint.len
          ? ` — you typed ${typedLen} characters, but this wallet's password has ${ks.pwHint.len}`
          : " — same length as the saved password, so one character differs (check Caps Lock and keyboard layout)";
    }
    throw new Error(
      `Incorrect password for wallet ${ks?.address ?? "?"} (file created ${ks?.createdAt ?? "?"})${detail}`,
      { cause: lastErr }
    );
  }

  lock() {
    this._signer = null;
    this.clearSession();
    return { locked: true };
  }

  // ----- machine session (§8-compatible convenience) -----
  // The unlocked key can be kept across app restarts, encrypted under a
  // machine-local secret the OS guards (Electron safeStorage / DPAPI). The
  // key still never leaves the machine; "Lock wallet" ends the session.

  _sessionPath() {
    return path.join(this.walletDir, "session.bin");
  }

  saveSession(secret) {
    if (!secret || !this._signer) return false;
    const key = crypto.createHash("sha256").update(String(secret)).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([
      cipher.update(Buffer.from(this._signer.getPrivateKey("hex"), "hex")),
      cipher.final(),
    ]);
    fs.mkdirSync(this.walletDir, { recursive: true });
    fs.writeFileSync(this._sessionPath(), Buffer.concat([iv, cipher.getAuthTag(), data]), { mode: 0o600 });
    return true;
  }

  tryResumeSession(secret) {
    try {
      if (!secret) return false;
      const blob = fs.readFileSync(this._sessionPath());
      const key = crypto.createHash("sha256").update(String(secret)).digest();
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
      decipher.setAuthTag(blob.subarray(12, 28));
      const priv = Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("hex");
      const ks = this.readKeystore();
      const signer = new Signer({ privateKey: priv, compressed: ks?.compressed !== false });
      // The session must agree with the keystore on disk: if the wallet file
      // was replaced with a different account, stay locked instead of
      // silently signing with a key the file no longer represents.
      if (ks?.address && signer.getAddress() !== ks.address) return false;
      this._signer = signer;
      return true;
    } catch {
      return false;
    }
  }

  clearSession() {
    try {
      fs.rmSync(this._sessionPath(), { force: true });
    } catch {
      /* best-effort */
    }
  }

  revealWif(password) {
    // Requires the password again even when unlocked.
    const signer = this._signerFromKeystore(password);
    return { wif: signer.getPrivateKey("wif"), address: signer.getAddress() };
  }

  /** §17 receipt primitive: recoverable signature over a sha256 hash. */
  /**
   * A ONE-SHOT signer, derived from the password, for a single operation that
   * moves value on chain.
   *
   * Two problems, one primitive.
   *
   * The password one: core/server.js resumes an unlocked wallet at boot from a
   * secret the OS holds, so the app starts unlocked with no human present.
   * "Unlocked" therefore never means "someone is at the keyboard", and a check
   * at unlock time protects nothing. Anything that moves value has to prove the
   * password AT THE MOMENT it moves it. Same reasoning as revealWif() below.
   *
   * The aliasing one: koilib's Contract mutates the signer it is handed
   * (signer.provider = p). `this._signer` is the object core/lib/worker.js signs
   * earn receipts with, so chain code must never be given it. This returns a
   * FRESH Signer that nothing else holds a reference to; the caller may mutate
   * it freely and it is garbage once the operation finishes.
   *
   * Never caches, never stores the password, never touches this._signer.
   */
  signerFor(password) {
    if (!this.exists()) throw new Error("No wallet found");
    const typed = String(password ?? "");
    if (!typed) throw new Error("Enter your wallet password to confirm this");
    // Same forgiving variants unlock() accepts — a password that opens the
    // wallet must also confirm an operation, or the rule reads as a bug.
    const variants = [...new Set([typed, typed.normalize("NFC"), typed.trim(), typed.normalize("NFC").trim()])];
    for (const candidate of variants) {
      try {
        return this._signerFromKeystore(candidate);
      } catch (e) {
        if (!/Incorrect password/.test(String(e.message))) throw e;
      }
    }
    throw new Error("That password does not match this wallet");
  }

  async signHash(hashBuffer) {
    const sig = await this.signer.signHash(hashBuffer);
    return Buffer.from(sig).toString("base64");
  }

  /** Server-side counterpart: which address signed this hash? */
  static recoverAddress(hashBuffer, signatureBase64) {
    return Signer.recoverAddress(hashBuffer, Buffer.from(signatureBase64, "base64"));
  }

  remove({ password, confirm }) {
    if (confirm !== "REMOVE") {
      throw new Error('Type "REMOVE" to confirm deleting the wallet file');
    }
    this._signerFromKeystore(password); // proves the caller could have backed up
    fs.rmSync(this.keystorePath, { force: true });
    this._signer = null;
    this.clearSession();
    return { removed: true };
  }
}

module.exports = { WalletService, MIN_PASSWORD_LENGTH };
