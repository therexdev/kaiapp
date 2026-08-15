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

  _checkPassword(password) {
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
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
  }

  create({ password }) {
    this._checkPassword(password);
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
    this._checkPassword(password);
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
    this._checkPassword(password);
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
    this._signer = this._signerFromKeystore(password);
    return { address: this._signer.getAddress() };
  }

  lock() {
    this._signer = null;
    return { locked: true };
  }

  revealWif(password) {
    // Requires the password again even when unlocked.
    const signer = this._signerFromKeystore(password);
    return { wif: signer.getPrivateKey("wif"), address: signer.getAddress() };
  }

  /** §17 receipt primitive: recoverable signature over a sha256 hash. */
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
    return { removed: true };
  }
}

module.exports = { WalletService, MIN_PASSWORD_LENGTH };
