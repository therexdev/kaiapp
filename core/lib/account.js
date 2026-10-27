"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { isProtectedStorage, storageState } = require("./protected-storage");
const authError = (code, message) => Object.assign(Error(message), { code });

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
 * safeStorage. Legacy website accounts retain their explicitly reported
 * fallback; new credit sessions require protected storage or explicit
 * memory-only access. Never in settings.json.
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
  constructor({ dataDir, settings, wallet, safeStorage = null, onEvent = () => {}, accountOrigin = null, fetchImpl = null }) {
    if (accountOrigin !== null) {
      const url = new URL(accountOrigin);
      if (url.protocol !== "https:" || url.origin !== accountOrigin) throw Error("Account origin must be a canonical HTTPS origin");
    }
    Object.defineProperty(this, "accountOrigin", { value: accountOrigin });
    // A new service must never inherit or overwrite the website's bearer.
    this.file = path.join(dataDir, accountOrigin ? `credit-account-${crypto.createHash("sha256").update(accountOrigin).digest("hex")}.cfg` : "account.cfg");
    this.settings = settings;
    this.wallet = wallet;
    this.safeStorage = safeStorage;
    this.onEvent = onEvent;
    this.fetchImpl = fetchImpl;
    this._memorySession = null;
    this._ignoreStoredSession = false;
    this._pending = null; // in-flight device link {userCode, deviceSecret, verifyUrl, expiresAt}
    this._lastPoll = 0;
  }

  /** koinosai.com, derived from the scheduler URL so a self-hosted network
   *  automatically gets its own account server. */
  origin() {
    if (this.accountOrigin) return this.accountOrigin;
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
    return isProtectedStorage(this.safeStorage);
  }

  _saveToken(token, metadata = {}, { sessionOnly = false } = {}) {
    const record = { ...metadata, token };
    if (sessionOnly) { this._memorySession = record; return; }
    if (this.accountOrigin && fs.existsSync(this.file) && !this._storedTokenRecord()?.token)
      throw authError("saved-account-unavailable", "Your saved credit connection cannot be read and has been preserved. Recover it or explicitly sign out before saving another connection.");
    const payload = JSON.stringify(record);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (this.accountOrigin && !this._encrypted()) throw authError("secure-storage-required", storageState(this.safeStorage).detail);
    const temporary = this.file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
    let bytes;
    if (this._encrypted()) {
      bytes = Buffer.concat([Buffer.from("ENC1"), this.safeStorage.encryptString(payload)]);
    } else {
      bytes = Buffer.concat([Buffer.from("PLN1"), Buffer.from(payload)]);
    }
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(temporary, this.file); } finally { fs.rmSync(temporary, { force: true }); }
    this._memorySession = null;
    this._ignoreStoredSession = false;
  }

  _tokenRecord() {
    if (this._memorySession) return { ...this._memorySession, sessionOnly: true };
    if (this._ignoreStoredSession) return null;
    return this._storedTokenRecord();
  }
  _storedTokenRecord() {
    let raw;
    try {
      if (fs.statSync(this.file).size > 65536) return null;
      raw = fs.readFileSync(this.file);
    } catch {
      return null;
    }
    const tag = raw.slice(0, 4).toString();
    const body = raw.slice(4);
    try {
      if (tag === "ENC1") return { ...JSON.parse(this.safeStorage.decryptString(body)), encrypted: true, sessionOnly: false };
      if (tag === "PLN1") return { ...JSON.parse(body.toString()), encrypted: false, sessionOnly: false };
    } catch {
      /* corrupted or wrong keychain — treated as signed out */
    }
    return null;
  }
  _token() { return this._tokenRecord()?.token || null; }
  _sessionProtected() {
    const record = this._tokenRecord();
    return Boolean(record?.sessionOnly || this._encrypted() && record?.encrypted !== false);
  }
  walletCapabilities(config, signal) { return require("./wallet-credit-account").capabilities(this, config, signal); }
  connectWallet(config, options, signal) { return require("./wallet-credit-account").connect(this, config, options, signal); }

  _clearToken() {
    if (this._memorySession) {
      const preserved = fs.existsSync(this.file);
      if (preserved) {
        // A temporary login can mask a different saved account. Retire its
        // exact encrypted bytes instead of deleting them or silently restoring
        // that hidden login after an explicit sign-out/restart.
        const archive = this.file + ".saved-" + crypto.randomBytes(12).toString("hex") + ".cfg";
        if (!fs.lstatSync(this.file).isFile()) throw Error("The saved credential path needs recovery before sign-out can archive it");
        fs.chmodSync(this.file, 0o600);
        fs.renameSync(this.file, archive);
        if (process.platform !== "win32") {
          const directory = fs.openSync(path.dirname(this.file), "r");
          try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        }
      }
      this._memorySession = null;
      this._ignoreStoredSession = preserved;
      return;
    }
    this._memorySession = null;
    fs.rmSync(this.file, { force: true });
  }

  /* ---------------------------------------------------- http helper ---- */
  async _call(pathname, { method = "GET", body, auth = true } = {}) {
    const headers = { "content-type": "application/json" };
    if (auth) {
      const t = this._token();
      if (t) headers.authorization = `Bearer ${t}`;
    }
    const r = await (this.fetchImpl || fetch)(this.origin() + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(this.accountOrigin ? { redirect: "error", signal: AbortSignal.timeout(10000) } : {}),
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
      secureStorage: storageState(this.safeStorage),
      sessionOnly: Boolean(this._memorySession),
      authScope: this._tokenRecord()?.scope || "account",
      savedConnectionPreserved: this._ignoreStoredSession,
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
    await this._call(this._tokenRecord()?.scope === "wallet-credits" ? "/auth/wallet-credit/logout" : "/auth/logout", { method: "POST", body: {} }).catch(() => {});
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
  async creditAuthorization(pinnedScheduler, signal) {
    const { scheduler } = require("./koin-network/grant-chat"), pinned = scheduler(pinnedScheduler);
    const token = this._token();
    if (!token) {
      if (fs.existsSync(this.file) && !this._encrypted()) throw authError("secure-storage-required", storageState(this.safeStorage).detail);
      throw authError("signin-required", "Connect your wallet to use network credits, or sign in to your existing credit account");
    }
    if (!this._sessionProtected()) throw authError("secure-storage-required", storageState(this.safeStorage).detail);
    const saved = this._tokenRecord();
    if (saved?.expiresAt && saved.expiresAt <= Date.now()) throw authError("wallet-reauthorization-required", "Your wallet connection expired. Connect your wallet again; your credits are preserved");
    if (saved?.scope === "wallet-credits" && saved.wallet !== this.wallet?.address) throw authError("wallet-changed", "Choose the wallet connected to this credit balance, or connect the selected wallet");
    if (this.settings.get("network.privacyMode", "local-only") === "local-only") throw Error("Choose an online route to use network credits");
    if (new URL(pinned).origin !== this.origin()) throw Error("Sign in to the account service for this network");
    const response = await (this.fetchImpl || fetch)(new URL(pinned).origin + "/auth/session", { redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), headers: { authorization: "Bearer " + token } });
    const chunks = []; let size = 0;
    for await (const part of response.body) { size += part.length; if (size > 65536) throw Error("Account response too large"); chunks.push(part); }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if ([401, 403].includes(response.status)) throw authError(saved?.scope === "wallet-credits" ? "wallet-reauthorization-required" : "signin-required", saved?.scope === "wallet-credits" ? "Reconnect your wallet to network credits; your balance is preserved" : "Sign in to your credit account");
    if (!response.ok) throw authError("service-unavailable", "The credit service is temporarily unavailable. Your connection and balance are preserved");
    if (value.ok !== true || typeof value.account?.id !== "string" || !value.account.id || value.account.id.length > 200 || !Array.isArray(value.account.wallets) || value.account.wallets.length > 64 || value.account.wallets.some(w => !require("koilib").utils.isChecksumAddress(w?.address))) throw authError("identity-unverified", "The credit service did not return a verifiable account identity. Your saved connection is preserved");
    if (saved?.scope === "wallet-credits" && (value.scope !== "wallet-credits" || value.freeOnly !== saved.freeOnly || value.account.freeOnly !== saved.freeOnly || value.account.id !== saved.accountId || value.account.wallets.length !== 1 || value.account.wallets[0].address !== saved.wallet)) throw authError("identity-changed", "The network credit identity changed; your existing balances are preserved");
    const accountId = value.account.id, localWallet = this.wallet?.address || null;
    // With several linked wallets, use only the wallet explicitly loaded on
    // this device. No arbitrary first-wallet selection or balance transfer.
    const wallet = value.account.wallets.length === 1 ? value.account.wallets[0].address : value.account.wallets.find(w => w.address === localWallet)?.address;
    const auth = { sessionToken: token, accountId, localWallet, owner: wallet || "account-" + crypto.createHash("sha256").update("verified-account:" + accountId).digest("hex"), schedulerUrl: pinned,
      ...(saved?.sessionOnly ? { sessionOnly: true } : {}), ...(saved?.scope ? { scope: saved.scope } : {}) };
    this.assertCreditAuthorization(auth, pinned); return auth;
  }
  assertCreditAuthorization(auth, pinned) {
    if (auth.schedulerUrl !== pinned || new URL(pinned).origin !== this.origin() || auth.sessionToken !== this._token() ||
        (Object.hasOwn(auth, "localWallet") && auth.localWallet !== (this.wallet?.address || null)) || !this._sessionProtected() ||
        (this._tokenRecord()?.expiresAt && this._tokenRecord().expiresAt <= Date.now()) || this.settings.get("network.privacyMode", "local-only") === "local-only") throw Error("Account or privacy settings changed");
  }
  // Private Core-to-scheduler credential handoff for the explicitly pinned
  // rehearsal. Never returned by status(), IPC, a tool or a public API.
  async shadowAuthorization(pinnedScheduler, signal, { grantId = null, allowInactive = false } = {}) {
    const { scheduler } = require("./koin-network/grant-chat");
    const pinned = scheduler(pinnedScheduler);
    const current = () => scheduler(this.settings.get("earn.schedulerUrl", process.env.KAI_SCHEDULER_URL || "https://koinosai.com/scheduler"));
    const allowed = () => this.settings.get("network.privacyMode", "local-only") !== "local-only" && current() === pinned;
    if (!allowed()) throw Error("KOIN rehearsal requires its pinned scheduler and online privacy mode");
    const token = this._token(), owner = this.wallet?.address;
    if (!token || !owner) throw Error("Sign in and link this wallet before using the KOIN rehearsal");
    const response = await fetch(new URL(pinned).origin + "/auth/session", {
      headers: { authorization: `Bearer ${token}` }, redirect: "error", signal,
    });
    const result = await response.json();
    if (!response.ok || !result.ok || !result.account?.id || (!allowInactive && !result.account.wallets?.some(w => w.address === owner))) throw Error("Sign in and link this wallet before using the KOIN rehearsal");
    // A saved certificate may still be inspected/revoked after unlinking or
    // grant revocation. This private option grants no new spending authority.
    const grant = allowInactive && grantId ? { id: require("./koin-network/session-delegation").identity(grantId) } :
      result.account.grants?.find(g => g.live && g.address === owner && (!grantId || g.id === grantId));
    if (!grant) throw Error("Authorize a spending grant in Accounts before using the KOIN rehearsal");
    if (!allowed() || token !== this._token() || owner !== this.wallet?.address) throw Error("Account or network settings changed");
    return { sessionToken: token, accountId: result.account.id, grantId: grant.id, owner };
  }

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
