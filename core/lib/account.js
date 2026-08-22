"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/*
 * Koinos AI account client (task #49, app side). One person <-> one account
 * <-> N wallets/devices; the server half lives at koinosai.com (kai
 * lib/accounts.js). The app NEVER embeds a browser login: it uses the
 * device-link flow — ask the server for a short human code, the person
 * approves it at <site>/link in any signed-in browser, the app polls and
 * receives its own bearer session.
 *
 * The session token is a credential, so it's stored exactly like email
 * credentials (core/lib/email.js): OS-keychain-encrypted via Electron
 * safeStorage when available, 0600 plain file with the mode SAID out loud
 * otherwise. Never in settings.json.
 *
 * Wallet linking signs sha256(`link|address|accountId|ts`) with the wallet's
 * own key — the §17 proof shape the scheduler already trusts. It moves no
 * value, so like receipt signing it uses the unlocked signer; the password
 * stays reserved for money.
 *
 * Every call here is EGRESS. The gateway refuses the routes in Local-Only
 * mode before this file is ever reached.
 */

const POLL_MIN_MS = 2000;

class AccountService {
  constructor({ dataDir, settings, wallet, safeStorage = null, onEvent = () => {} }) {
    this.file = path.join(dataDir, "account.cfg");
    this.settings = settings;
    this.wallet = wallet;
    this.safeStorage = safeStorage;
    this.onEvent = onEvent;
    this._pending = null; // in-flight device link {userCode, deviceSecret, verifyUrl, expiresAt}
    this._lastPoll = 0;
  }

  /** koinosai.com, derived from the scheduler URL so a self-hosted network
   *  automatically gets its own account server. */
  origin() {
    const DEFAULT = "https://koinosai.com/scheduler";
    const sched = String(this.settings.get("earn.schedulerUrl", process.env.KAI_SCHEDULER_URL || DEFAULT));
    try {
      return new URL(sched).origin;
    } catch {
      return "https://koinosai.com";
    }
  }

  /* ------------------------------------------------- token at rest ---- */
  _encrypted() {
    return Boolean(this.safeStorage?.isEncryptionAvailable?.());
  }

  _saveToken(token) {
    const payload = JSON.stringify({ token });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (this._encrypted()) {
      fs.writeFileSync(this.file, Buffer.concat([Buffer.from("ENC1"), this.safeStorage.encryptString(payload)]), { mode: 0o600 });
    } else {
      fs.writeFileSync(this.file, Buffer.concat([Buffer.from("PLN1"), Buffer.from(payload)]), { mode: 0o600 });
    }
  }

  _token() {
    let raw;
    try {
      raw = fs.readFileSync(this.file);
    } catch {
      return null;
    }
    const tag = raw.slice(0, 4).toString();
    const body = raw.slice(4);
    try {
      if (tag === "ENC1") return JSON.parse(this.safeStorage.decryptString(body)).token;
      if (tag === "PLN1") return JSON.parse(body.toString()).token;
    } catch {
      /* corrupted or wrong keychain — treated as signed out */
    }
    return null;
  }

  _clearToken() {
    fs.rmSync(this.file, { force: true });
  }

  /* ---------------------------------------------------- http helper ---- */
  async _call(pathname, { method = "GET", body, auth = true } = {}) {
    const headers = { "content-type": "application/json" };
    if (auth) {
      const t = this._token();
      if (t) headers.authorization = `Bearer ${t}`;
    }
    const r = await fetch(this.origin() + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ...j };
  }

  /* --------------------------------------------------------- status ---- */
  async status() {
    const base = {
      site: this.origin(),
      tokenStored: Boolean(this._token()),
      credsEncrypted: this._encrypted(),
      pendingCode: this._pending && this._pending.expiresAt > Date.now() ? this._pending.userCode : null,
      verifyUrl: this._pending && this._pending.expiresAt > Date.now() ? this._pending.verifyUrl : null,
    };
    if (!base.tokenStored) return { ...base, signedIn: false };

    /*
     * The account server being UNREACHABLE is not the same as being signed
     * out, and this used to conflate them: fetch rejects on a refused
     * connection and the throw escaped status(), so the whole account panel
     * blanked with an error whenever the site was mid-deploy.
     */
    let r;
    try {
      r = await this._call("/auth/session");
    } catch (e) {
      return { ...base, signedIn: false, offline: true, error: `Can't reach ${this.origin()} right now — ${e.message}` };
    }

    if (r.status === 401) {
      /*
       * Report signed out, but KEEP the token file.
       *
       * This used to delete it on the first 401, which made one bad answer
       * permanent: a person had to redo the whole device-link dance on
       * another machine to get back in. And a 401 is not always the truth —
       * a deploy mid-restart, a locked database, a clock skew — while the
       * cost of being wrong is asymmetric. Keeping a genuinely dead token
       * costs nothing (it is a random string that authenticates nothing) and
       * the next poll recovers by itself if the rejection was transient.
       *
       * Deleting it is still what signOut() does, deliberately and on
       * request. That is the only thing that should.
       */
      return { ...base, signedIn: false, sessionRejected: true };
    }
    if (!r.ok) return { ...base, signedIn: false, error: r.error || `account server answered ${r.status}` };
    const walletAddr = this.wallet?.address ?? null;
    const thisWalletLinked = Boolean(walletAddr && r.account.wallets?.some((w) => w.address === walletAddr));
    return {
      ...base,
      signedIn: true,
      account: r.account,
      thisWalletLinked,
      /*
       * The live spending grant for THIS machine's wallet, if there is one.
       * Resolved here rather than in the UI because "which of my grants is
       * the one this window can revoke" is a question about this machine,
       * and the answer is only correct where the wallet address is known.
       *
       * Gated on the wallet still being LINKED, not merely on the grant row
       * looking live. Production revokes grants when a wallet is unlinked, so
       * the two should never disagree — but if they ever do, the safe answer
       * is that this machine offers no web access it cannot prove it owns.
       */
      thisWalletGrant:
        (thisWalletLinked && (r.account.grants || []).find((g) => g.live && g.address === walletAddr)) || null,
    };
  }

  /* ---------------------------------------------------- device link ---- */
  async linkStart() {
    const r = await this._call("/auth/device/start", { method: "POST", body: {}, auth: false });
    if (!r.ok) throw new Error(r.error || "the account server refused to start a sign-in");
    this._pending = {
      userCode: r.userCode,
      deviceSecret: r.deviceSecret,
      verifyUrl: r.verifyUrl,
      expiresAt: Date.now() + (Number(r.expiresInSec) || 600) * 1000,
    };
    this.onEvent({ type: "account:link-started" });
    return { userCode: r.userCode, verifyUrl: r.verifyUrl, expiresInSec: r.expiresInSec };
  }

  async linkPoll() {
    if (!this._pending) throw new Error("no sign-in in progress — start one first");
    if (this._pending.expiresAt < Date.now()) {
      this._pending = null;
      throw new Error("the sign-in code expired — start again");
    }
    // Server asks for >=2s spacing; a hot UI loop must not turn into a hammer.
    const wait = this._lastPoll + POLL_MIN_MS - Date.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    this._lastPoll = Date.now();
    const r = await this._call("/auth/device/poll", {
      method: "POST",
      auth: false,
      body: { userCode: this._pending.userCode, deviceSecret: this._pending.deviceSecret },
    });
    if (!r.ok) {
      this._pending = null;
      throw new Error(r.error || "sign-in failed — start again");
    }
    if (r.pending) return { pending: true };
    this._pending = null;
    this._saveToken(r.token);
    this.onEvent({ type: "account:signed-in" });
    return { pending: false, account: r.account };
  }

  async signOut() {
    await this._call("/auth/logout", { method: "POST", body: {} }).catch(() => {});
    this._clearToken();
    this.onEvent({ type: "account:signed-out" });
  }

  /* --------------------------------------------------- wallet link ---- */
  async linkWallet() {
    const st = this.wallet?.status?.();
    if (!st?.unlocked || !st?.address) throw new Error("Unlock your earning account first — the wallet signs the link proof");
    const session = await this._call("/auth/session");
    if (!session.ok) throw new Error("Sign in to your Koinos AI account first");
    const address = st.address;
    const ts = Date.now();
    const hash = crypto.createHash("sha256").update(`link|${address}|${session.account.id}|${ts}`).digest();
    // WalletService.signHash already returns base64 (field lesson from this
    // file's own test: re-wrapping it in Buffer.from() double-encodes).
    const signature = await this.wallet.signHash(hash);
    const r = await this._call("/account/wallets", { method: "POST", body: { address, ts, signature } });
    if (!r.ok) throw new Error(r.error || "the account server refused the wallet link");
    this.onEvent({ type: "account:wallet-linked", address });
    return r.account;
  }

  async unlinkWallet(address) {
    const r = await this._call(`/account/wallets/${encodeURIComponent(String(address || ""))}`, { method: "DELETE" });
    if (!r.ok) throw new Error(r.error || "unlink failed");
    return r.account;
  }

  /* --------------------------------------------------- spend grants ---- */
  /*
   * Authorise koinosai.com to spend from this wallet, up to a cap, until a
   * date. This lives HERE, in the desktop app, for one unavoidable reason:
   * the signature has to come from the wallet's own key, and the key is on
   * this machine. A browser has nothing to sign with, so the web app can
   * show a grant and revoke it, but only this app can create one.
   *
   * The message names the cap and the expiry, so neither can be edited after
   * the fact without a new signature. The verb is `spend`, not `link` —
   * different verb, different hash, so a link proof can never be replayed as
   * permission to spend money.
   */
  async grantSpend({ maxUsd, days } = {}) {
    const st = this.wallet?.status?.();
    if (!st?.unlocked || !st?.address) throw new Error("Unlock your earning account first — the wallet signs the spending grant");
    const usd = Number(maxUsd);
    if (!Number.isFinite(usd) || usd <= 0) throw new Error("Set a spending cap above zero");
    const d = Number(days);
    if (!Number.isFinite(d) || d <= 0) throw new Error("Set how long the grant should last");
    const session = await this._call("/auth/session");
    if (!session.ok) throw new Error("Sign in to your Koinos AI account first");

    const address = st.address;
    // Round to whole micro-dollars the same way the server does, and sign the
    // ROUNDED value — signing 5.0000004 and sending 5000000 would recover a
    // different hash and be refused as a bad signature.
    const maxMicro = Math.floor(usd * 1e6);
    const expiresAt = Date.now() + Math.round(d * 24 * 3600 * 1000);
    const ts = Date.now();
    const hash = crypto.createHash("sha256")
      .update(`spend|${address}|${session.account.id}|${maxMicro}|${expiresAt}|${ts}`).digest();
    const signature = await this.wallet.signHash(hash);
    const r = await this._call("/account/grants", { method: "POST", body: { address, maxMicro, expiresAt, ts, signature } });
    if (!r.ok) throw new Error(r.error || "the account server refused the spending grant");
    this.onEvent({ type: "account:spend-granted", address, maxUsd: maxMicro / 1e6 });
    return { grant: r.grant, account: r.account };
  }

  /** Revoking needs no key — only the session. Effective immediately. */
  async revokeGrant(id) {
    const r = await this._call(`/account/grants/${encodeURIComponent(String(id || ""))}`, { method: "DELETE" });
    if (!r.ok) throw new Error(r.error || "revoke failed");
    this.onEvent({ type: "account:spend-revoked", grant: String(id || "") });
    return r.account;
  }
}

module.exports = { AccountService };
