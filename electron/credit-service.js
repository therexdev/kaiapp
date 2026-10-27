"use strict";
const fs = require("fs"), path = require("path"), P = require("../core/lib/koin-network/job-protocol");
const { PrepaidChat } = require("./koin-prepaid-chat"), { configuration } = require("./koin-test-config");
const { storageState } = require("../core/lib/protected-storage");
function setupFailure(error) {
  const code = error?.code === "signin-required" ? "wallet-connection-required" : error?.code;
  const known = ["wallet-connection-required", "wallet-required", "wallet-unlock-required", "wallet-reauthorization-required", "wallet-changed", "secure-storage-required", "service-upgrade-required", "online-required"];
  return { activation: known.includes(code) ? code : /sign in/i.test(error?.message || "") ? "signin-required" : "unavailable", blocked: String(error?.message || "The network is unavailable") };
}
function manifest(value) {
  if (!value || value.schema !== 1 || !["ready", "unavailable"].includes(value.state)) throw Error("Invalid packaged credit service");
  if (value.state === "unavailable") {
    if (Object.keys(value).sort().join() !== "reason,schema,state" || typeof value.reason !== "string" || !value.reason || value.reason.length > 300) throw Error("Credit availability reason required");
    return structuredClone(value);
  }
  if (Object.keys(value).sort().join() !== "config,schema,state" || Object.hasOwn(value.config || {}, "owner") || value.config?.deployment?.product !== "prepaid-usd-v1") throw Error("Separate USD service configuration required");
  const validated = configuration({ ...value.config, owner: value.config.deployment.masterNode });
  const { owner, ...config } = validated;
  return { schema: 1, state: "ready", config };
}
class CreditService {
  constructor({ dataDir, account, storage, service, fetchImpl = fetch, progress = () => {}, purchaseProgress = () => {}, dialog, marketReader, deviceFreeAccount }) {
    Object.assign(this, { dataDir, account, storage, fetchImpl, progress, dialog }); this.service = manifest(service);
    this.storage = require("../core/lib/wallet-credential-vault").scopedStorage(storage, "network-chat");
    this.deviceFree = deviceFreeAccount === undefined && this.service.state === "ready" && account?.settings
      ? new (require("../core/lib/device-free-account").DeviceFreeAccount)({ dataDir, settings: account.settings, config: this.service.config, fetchImpl })
      : deviceFreeAccount;
    this.purchases = new (require("./credit-purchases").CreditPurchases)({ dataDir, account, storage, dialog, fetchImpl, marketReader, progress: purchaseProgress });
    this.runs = new (require("./credit-runs").CreditRuns)(this);
  }
  async walletInfo(signal) {
    const secureStorage = storageState(this.storage), wallet = this.account.wallet?.status?.() || {}, address = wallet.address || this.account.wallet?.address || null;
    const base = { walletReady: Boolean(address), address, secureStorage, sessionOnly: Boolean(this.account._memorySession), connected: false, canConnect: false, capabilityAvailable: false, savedConnectionPreserved: this.account._ignoreStoredSession === true };
    if (this.service.state !== "ready") return { ...base, state: "unavailable", detail: this.service.reason };
    if (this.account.settings?.get?.("network.privacyMode", "local-only") === "local-only") return { ...base, state: "online-required", detail: "Choose Network or another online route to connect your wallet" };
    try {
      const auth = await this.account.creditAuthorization(this.service.config.schedulerUrl, signal);
      const upgrade = auth.sessionOnly === true && secureStorage.available;
      return { ...base, connected: true, canConnect: upgrade && Boolean(wallet.unlocked), state: upgrade && !wallet.unlocked ? "wallet-unlock-required" : "ready",
        detail: upgrade ? wallet.unlocked ? "Save this wallet connection to buy and use paid credits. No email account is needed." : "Unlock your wallet to save this connection for purchases and paid credits. Temporary free access remains available."
          : auth.sessionOnly ? "Temporary access: free credits only while the app is open. Reconnect after restart." : "Connected to network credits",
        sessionOnly: auth.sessionOnly === true, freeOnlySession: auth.sessionOnly === true };
    } catch (error) {
      if (signal?.aborted) throw error;
      base.detail = String(error.message);
      if (!["signin-required", "wallet-reauthorization-required", "secure-storage-required", "wallet-unlock-required"].includes(error.code)) {
        const failure = setupFailure(error);
        return { ...base, state: failure.activation, detail: failure.blocked };
      }
    }
    if (this.deviceFree) {
      try {
        await this.deviceFree.creditAuthorization(this.service.config.schedulerUrl, signal);
        return { ...base, freeAccess: true, state: "free-ready", detail: "Free-credit access is ready. Choose Buy credits to use your KOIN wallet for a purchase." };
      } catch (error) { signal?.throwIfAborted(); /* Older services retain the existing wallet connection path. */ }
    }
    if (!address) return { ...base, state: "wallet-required", detail: "Create or import a wallet to connect to network credits" };
    try { await this.account.walletCapabilities(this.service.config, signal); }
    catch (error) { const failure = setupFailure(error); return { ...base, state: failure.activation, detail: failure.blocked }; }
    return { ...base, capabilityAvailable: true, canConnect: Boolean(wallet.unlocked),
      state: !wallet.unlocked ? "wallet-unlock-required" : secureStorage.available ? "wallet-connection-required" : "secure-storage-required",
      detail: !wallet.unlocked ? "Unlock your wallet once to connect to network credits" : secureStorage.available ? "Connect this wallet to use its network credits" : secureStorage.detail };
  }
  async connectWallet(window, input = {}, signal) {
    if (!input || Object.keys(input).some(key => key !== "sessionOnly") || (input.sessionOnly !== undefined && typeof input.sessionOnly !== "boolean")) throw Error("Invalid wallet connection request");
    if (this.service.state !== "ready") throw Error(this.service.reason);
    if (!window || window.isDestroyed?.() || !window.isVisible?.() || window.isMinimized?.()) throw Error("Return to the visible desktop app to connect your wallet");
    return this.account.connectWallet(this.service.config, { sessionOnly: input.sessionOnly === true, review: async review => {
      const result = await this.dialog.showMessageBox(window, { type: "question", title: "Connect wallet to network credits", message: "Connect this wallet?",
        detail: `Wallet: ${review.address}\nNetwork: ${review.serviceOrigin}\nDevice: ${review.deviceId}\n\nUse this wallet's existing network credit balance and service-provided free allowance. This proof does not transfer KOIN or authorize wallet transactions. The connection expires in 30 days and can be ended by signing out.\n\n${review.sessionOnly ? "Temporary access: this app will use free credits only. Access is kept in memory while the app is open; reconnect after restart. Private chat text will not be saved for automatic network recovery; resending the same message can recover its response." : "Access is saved encrypted on this computer and continues when your wallet is locked. On computers without an operating system keyring, unlock your wallet once after restarting the app. No keyring setup is needed. Purchases still require their own approval."}`,
        buttons: ["Cancel", review.sessionOnly ? "Connect for this session" : "Connect wallet"], defaultId: 0, cancelId: 0, noLink: true });
      signal?.throwIfAborted();
      return result.response === 1 && !window.isDestroyed?.() && window.isVisible?.() && !window.isMinimized?.();
    } }, signal);
  }
  async preparePurchase(window, signal) {
    if (this.service.state !== "ready") throw Error(this.service.reason);
    const visible = () => {
      signal?.throwIfAborted();
      if (!window || window.isDestroyed?.() || !window.isVisible?.() || window.isMinimized?.()) throw Error("Return to the visible desktop app to buy credits");
    };
    visible();
    const wallet = this.account.wallet, address = wallet?.address || null;
    const blocked = (state, detail) => ({ state, address, detail });
    if (this.account.settings?.get?.("network.privacyMode", "local-only") === "local-only")
      return blocked("online-required", "Choose Network or another online route to buy credits");
    if (!require("koilib").utils.isChecksumAddress(address || "")) return blocked("wallet-required", "Create or import your KOIN wallet to buy credits");
    if (!wallet.status?.().unlocked) return blocked("wallet-unlock-required", "Unlock your wallet to continue buying credits");
    if (!storageState(this.storage).available) return blocked("secure-storage-required", storageState(this.storage).detail);
    let expectedToken = this.account._token();
    const guard = () => {
      visible();
      if (wallet !== this.account.wallet || address !== this.account.wallet?.address || !wallet.status?.().unlocked ||
          this.account._token() !== expectedToken || !storageState(this.storage).available ||
          this.account.settings?.get?.("network.privacyMode", "local-only") === "local-only")
        throw Error("Wallet, network access or secure storage changed. Choose Buy credits again for the current wallet");
    };
    const matching = auth => {
      if (auth.owner !== address || auth.localWallet !== address) throw Object.assign(Error("The saved credit connection belongs to another wallet. Your existing connection and credits have been preserved"), { code: "wallet-changed" });
    };
    const ready = async (state, auth) => {
      const c = await this.context(signal, auth); guard();
      const purchaseInfo = { enabled: true, configured: true, product: "prepaid-usd-v1", activation: "ready", blocked: "", ...await this.purchaseState(c, signal) };
      guard(); return { state, address, purchaseInfo };
    };
    let auth;
    try { auth = await this.account.creditAuthorization(this.service.config.schedulerUrl, signal); }
    catch (error) {
      guard();
      // Only an absent/expired connection may prompt for new wallet proof.
      // Network failures and identity conflicts must retain saved authority.
      if (!["signin-required", "wallet-reauthorization-required"].includes(error.code)) throw error;
    }
    guard();
    if (auth) {
      matching(auth);
      if (!auth.sessionOnly) return ready("ready", auth);
    }
    // Buy explicitly requests durable access. A former temporary free-only
    // session can be upgraded after its keyring is available, never reused
    // for a paid purchase. connectWallet preserves any prior account identity.
    const result = await this.connectWallet(window, { sessionOnly: false }, signal);
    if (result.state === "cancelled") { guard(); return { state: "cancelled", address }; }
    if (result.state !== "connected" || result.address !== address || result.sessionOnly !== false) throw Error("The wallet connection was not confirmed for this purchase");
    expectedToken = this.account._token(); guard();
    auth = await this.account.creditAuthorization(this.service.config.schedulerUrl, signal); guard(); matching(auth);
    if (auth.sessionOnly) throw Error("A saved wallet connection is required to buy credits");
    return ready("connected", auth);
  }
  async context(signal, verifiedAuth) {
    if (this.service.state !== "ready") throw Error(this.service.reason);
    const base = this.service.config;
    for (const name of ["koin-foundation-test", "koin-prepaid-v1"]) {
      const file = path.join(this.dataDir, name, "deployment.json");
      if (!fs.existsSync(file)) continue;
      if (fs.statSync(file).size > 16384) throw Error("Earlier deployment records need recovery before activation");
      const old = JSON.parse(fs.readFileSync(file, "utf8")).deployment;
      if (!old || [old.credits, old.rewards].some(address => [base.deployment.credits, base.deployment.rewards].includes(address))) throw Error("USD activation requires fresh contracts; earlier balances and journals remain preserved");
    }
    // An explicit purchase preparation already verified its identity. Reuse
    // that snapshot for saved-payment reads while rechecking local authority.
    let auth = verifiedAuth, authority = this.account;
    if (!auth) {
      try { auth = await this.account.creditAuthorization(base.schedulerUrl, signal); }
      catch (error) {
        signal?.throwIfAborted();
        // Free access has its own non-spending installation identity. Never
        // replace a saved wallet/account credential or hide a service outage
        // behind a newly created financial account.
        if (!this.deviceFree || !["signin-required", "wallet-reauthorization-required", "secure-storage-required", "wallet-unlock-required"].includes(error.code)) throw error;
        auth = await this.deviceFree.creditAuthorization(base.schedulerUrl, signal);
        authority = this.deviceFree;
      }
    }
    if (auth.deviceFree) authority = this.deviceFree;
    if (verifiedAuth) authority.assertCreditAuthorization(auth, base.schedulerUrl);
    if (!auth.deviceFree) this.deviceFree?.clear();
    const config = { ...base, owner: auth.owner }, root = path.join(this.dataDir, "credit-account-v2", P.hash(auth.accountId)), key = P.hash(JSON.stringify(config));
    // New product files never overwrite custody/prepaid-v1 or their journals.
    const directory = path.join(root, key); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = path.join(directory, "context.json");
    if (!fs.existsSync(metadata)) fs.writeFileSync(metadata, JSON.stringify({ config, accountId: auth.accountId }), { flag: "wx", mode: 0o600 });
    const access = { ...(auth.deviceFree ? { invalidate: () => authority.invalidate(auth) } : {}), authorize: (pin, nextSignal) => {
      nextSignal?.throwIfAborted();
      authority.assertCreditAuthorization(auth, pin);
      return auth;
    } };
    // A renewed free-device bearer keeps the same verified owner and target.
    // Retain its in-memory recovery key until that authority changes or the
    // app exits; token expiry must not discard a pending private reply.
    const sessionIdentity = auth.deviceFree ? P.hash(JSON.stringify(["device-free-chat-store-v1", auth.scope, auth.accountId,
      auth.owner, auth.schedulerUrl, config.deployment, config.policyHash])) : auth.sessionToken;
    if (auth.sessionOnly && this.sessionIdentity !== sessionIdentity) {
      this.sessionStore?.dispose(); this.sessionStore = new (require("./session-free-chat").SessionFreeChatStore)(); this.sessionIdentity = sessionIdentity;
    } else if (!auth.sessionOnly && this.sessionStore) { this.sessionStore.dispose(); this.sessionStore = null; this.sessionIdentity = null; }
    const make = (cfg, dir) => auth.sessionOnly
      ? new (require("./session-free-chat").SessionFreeChat)({ config: cfg, file: path.join(dir, "chat-session-free.json"), sessionStore: this.sessionStore, access, fetchImpl: this.fetchImpl, progress: this.progress })
      : new PrepaidChat({ config: cfg, file: path.join(dir, "chat.json"), storage: this.storage, access, fetchImpl: this.fetchImpl, progress: this.progress });
    const flow = make(config, directory), recoverable = [], contexts = [{ config, directory }];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const dir = path.join(root, entry.name), file = path.join(dir, "context.json");
      if (!fs.existsSync(file) || fs.statSync(file).size > 16384) continue;
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved.accountId !== auth.accountId || saved.config.schedulerUrl !== config.schedulerUrl || JSON.stringify(saved.config.deployment) !== JSON.stringify(config.deployment)) continue;
      const checked = manifest({ schema: 1, state: "ready", config: Object.fromEntries(Object.entries(saved.config).filter(([key]) => key !== "owner")) });
      if (dir !== directory) contexts.push({ config: { ...checked.config, owner: saved.config.owner }, directory: dir });
      const candidate = make({ ...checked.config, owner: saved.config.owner }, dir), record = candidate.read();
      if (record && ["pending", "answered"].includes(record.state) && (!auth.sessionOnly || record.input)) recoverable.push({ flow: candidate, record });
    }
    const earlierRoot = path.join(this.dataDir, "koin-prepaid-usd-v1"), earlierConfig = path.join(earlierRoot, "deployment.json");
    if (!auth.sessionOnly && fs.existsSync(earlierConfig) && fs.statSync(earlierConfig).size <= 16384) {
      const saved = configuration(JSON.parse(fs.readFileSync(earlierConfig, "utf8")));
      if (saved.owner === auth.owner && saved.schedulerUrl === config.schedulerUrl && JSON.stringify(saved.deployment) === JSON.stringify(config.deployment)) {
        const candidate = new PrepaidChat({ config: saved, file: path.join(earlierRoot, "prepaid-chat-recovery.json"), storage: this.storage, access, fetchImpl: this.fetchImpl, progress: this.progress });
        const record = candidate.read();
        if (record && ["pending", "answered"].includes(record.state)) recoverable.unshift({ flow: candidate, record });
      }
    }
    return { config, flow, auth, recoverable, directory, contexts };
  }
  async purchaseState(c, signal) {
    let localPurchase;
    try { localPurchase = await this.purchases.status(c, signal); }
    catch { localPurchase = { state: "unavailable", detail: "Saved payment records could not be checked. Check again before starting another purchase." }; }
    let cancelledPurchases = [];
    try { cancelledPurchases = await this.purchases.cancelled(c, signal); } catch { /* Preserve the network purchase history if a local read fails. */ }
    return { localPurchase, cancelledPurchases, purchaseProgress: require("./credit-purchase-progress").purchaseProgress(this.purchases.progressSnapshot?.(c)) };
  }
  async purchaseInfo(signal) {
    if (this.service.state !== "ready") return { enabled: true, configured: true, product: "prepaid-usd-v1", blocked: this.service.reason, activation: "unavailable", recoveryAvailable: false };
    try {
      const c = await this.context(signal);
      if (c.auth?.sessionOnly) {
        const wallet = this.account.wallet?.status?.() || {};
        const activation = !wallet.address ? "wallet-required" : !wallet.unlocked ? "wallet-unlock-required" : "wallet-connection-required";
        return { enabled: true, configured: true, product: "prepaid-usd-v1", activation, blocked: activation === "wallet-required"
          ? "Set up your KOIN wallet to buy credits. Free-credit access does not require a wallet."
          : activation === "wallet-unlock-required" ? "Choose Buy to unlock your wallet and continue." : "Choose Buy to use your wallet and continue.", recoveryAvailable: false };
      }
      // Buying credits depends on this account and its saved payments. Loading
      // provider availability or advanced-chat capabilities must not hold Buy.
      return { enabled: true, configured: true, product: "prepaid-usd-v1", activation: "ready", blocked: "", ...await this.purchaseState(c, signal) };
    } catch (error) { return { enabled: true, configured: true, product: "prepaid-usd-v1", ...setupFailure(error), recoveryAvailable: false }; }
  }
  purchaseDisplayContext(signal) {
    signal?.throwIfAborted();
    if (this.service.state !== "ready") throw Error(this.service.reason);
    if (this.account.settings?.get?.("network.privacyMode", "local-only") === "local-only")
      throw Object.assign(Error("Choose Network or another online route to check the KOIN price"), { code: "online-required" });
    return { config: this.service.config };
  }
  async purchaseCapabilities(signal) {
    return this.purchases.estimateCapabilities(this.purchaseDisplayContext(signal), signal);
  }
  async info(signal) {
    if (this.service.state !== "ready") return { enabled: true, configured: true, product: "prepaid-usd-v1", blocked: this.service.reason, activation: "unavailable", recoveryAvailable: false };
    try {
      const c = await this.context(signal);
      let runBudgets = false, creditPriority = false, modelCatalog, modelError = "";
      try { modelCatalog = await c.flow.models(signal); } catch (error) { modelError = String(error.message).slice(0, 220); }
      try { const r = await c.flow.call("capabilities", {}, signal); creditPriority = r.capabilities?.creditPriority === true; runBudgets = !!modelCatalog && r.capabilities?.advancedRuns === true && modelCatalog.models.every(t => r.capabilities.models?.some(m => m.model === t.model && m.version === t.version && m.maxOutput >= t.maxOutput)); } catch { /* Normal Chat remains independent of advanced-run support. */ }
      return { enabled: true, configured: true, product: "prepaid-usd-v1", activation: "ready", blocked: modelError, ...(c.auth?.sessionOnly ? { localPurchase: null } : await this.purchaseState(c, signal)), model: c.config.model, maxOutput: c.config.maxOutput, models: modelCatalog?.models || [], modelAvailabilityUntil: modelCatalog?.validUntil || null,
        runBudgets: c.auth?.sessionOnly ? false : runBudgets, creditPriority: c.auth?.sessionOnly ? false : creditPriority, freeOnlySession: c.auth?.sessionOnly === true, deviceFree: c.auth?.deviceFree === true, maxRequestCredits: require("../core/lib/koin-network/purchase-quote").credits(c.config.limits.perJob), recoveryAvailable: c.recoverable.length > 0 };
    } catch (error) { return { enabled: true, configured: true, product: "prepaid-usd-v1", ...setupFailure(error), recoveryAvailable: false }; }
  }
  async run(action, input, signal, window) {
    if (action === "purchase-estimate") {
      const c = this.purchaseDisplayContext(signal), result = await this.purchases.estimate(c, input, signal);
      if (this.purchaseDisplayContext(signal).config !== c.config) throw Error("The pricing configuration changed; refresh the estimate");
      return result;
    }
    let c = await this.context(signal);
    if (c.auth?.sessionOnly && (action.startsWith("run-") || ["purchase-preview", "purchase-approve", "purchase-retry"].includes(action))) throw Object.assign(Error("Choose Buy credits to use your KOIN wallet for purchases. Free-credit access does not require a wallet."), { code: "wallet-connection-required" });
    if (action === "run-open") return this.runs.open(c, input, signal);
    if (action === "run-chat") return this.runs.chat(c, input, signal);
    if (action === "run-status") return this.runs.status(c, input, signal);
    if (action === "run-stop") return this.runs.stop(c, input, signal);
    if (action === "run-list") return { runs: this.runs.list(c) };
    if (action === "purchase-preview") return this.purchases.preview(c, input, signal);
    if (["purchase-approve", "purchase-retry"].includes(action)) return this.purchases.run(c, window, action, input, signal);
    if (action === "purchase-sync") return c.auth?.sessionOnly ? { state: "none" } : this.purchases.sync(c, signal);
    if (action === "credit-status") {
      let result;
      try { result = await c.flow.status(signal); }
      catch (error) {
        if (!c.auth?.deviceFree || error.code !== "credit-access-expired") throw error;
        signal?.throwIfAborted();
        c = await this.context(signal);
        result = await c.flow.status(signal);
      }
      return c.auth?.deviceFree ? { ...result, accessKind: "device-free", paidAccessLocked: Boolean(this.account.wallet?.address || this.account.file && fs.existsSync(this.account.file)) } : result;
    }
    if (action === "network-overview") return c.flow.call("network", {}, signal);
    if (action === "chat-estimate") return c.flow.estimate(input, signal);
    if (action === "chat-recover") {
      const saved = c.recoverable.at(-1); if (!saved) return { state: "none" };
      return saved.flow.recover(null, signal);
    }
    if (action === "chat-ack") {
      P.digest(input); for (const r of c.recoverable) if (r.record.id === input) r.flow.acknowledge(input);
      return { state: "delivered" };
    }
    if (action === "chat-completion") { if (input?.runId !== undefined) throw Error("Use the approved run for multi-step calls"); return c.flow.chat(null, input, signal); }
    throw Error("Unknown credit service operation");
  }
  dispose() { this.purchases.stop(); this.deviceFree?.dispose(); this.sessionStore?.dispose(); this.sessionStore = null; this.sessionIdentity = null; }
}
module.exports = { CreditService, manifest, setupFailure };
