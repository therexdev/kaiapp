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
  constructor({ dataDir, account, storage, service, fetchImpl = fetch, progress = () => {}, purchaseProgress = () => {}, dialog, marketReader }) {
    Object.assign(this, { dataDir, account, storage, fetchImpl, progress, dialog }); this.service = manifest(service);
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
      return { ...base, connected: true, state: "ready", detail: auth.sessionOnly ? "Temporary access: free credits only while the app is open. Reconnect after restart." : "Connected to network credits", sessionOnly: auth.sessionOnly === true, freeOnlySession: auth.sessionOnly === true };
    } catch (error) {
      if (signal?.aborted) throw error;
      base.detail = String(error.message);
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
        detail: `Wallet: ${review.address}\nNetwork: ${review.serviceOrigin}\nDevice: ${review.deviceId}\n\nUse this wallet's existing network credit balance and service-provided free allowance. This proof does not transfer KOIN or authorize wallet transactions. The connection expires in 30 days and can be ended by signing out.\n\n${review.sessionOnly ? "Temporary access: this app will use free credits only. Access is kept in memory while the app is open; reconnect after restart. Private chat text will not be saved for automatic network recovery; resending the same message can recover its response." : "Access is saved in your operating system's protected credential storage and continues when your wallet is locked. Purchases still require their own approval."}`,
        buttons: ["Cancel", review.sessionOnly ? "Connect for this session" : "Connect wallet"], defaultId: 0, cancelId: 0, noLink: true });
      signal?.throwIfAborted();
      return result.response === 1 && !window.isDestroyed?.() && window.isVisible?.() && !window.isMinimized?.();
    } }, signal);
  }
  async context(signal) {
    if (this.service.state !== "ready") throw Error(this.service.reason);
    const base = this.service.config;
    for (const name of ["koin-foundation-test", "koin-prepaid-v1"]) {
      const file = path.join(this.dataDir, name, "deployment.json");
      if (!fs.existsSync(file)) continue;
      if (fs.statSync(file).size > 16384) throw Error("Earlier deployment records need recovery before activation");
      const old = JSON.parse(fs.readFileSync(file, "utf8")).deployment;
      if (!old || [old.credits, old.rewards].some(address => [base.deployment.credits, base.deployment.rewards].includes(address))) throw Error("USD activation requires fresh contracts; earlier balances and journals remain preserved");
    }
    const auth = await this.account.creditAuthorization(base.schedulerUrl, signal);
    const config = { ...base, owner: auth.owner }, root = path.join(this.dataDir, "credit-account-v2", P.hash(auth.accountId)), key = P.hash(JSON.stringify(config));
    // New product files never overwrite custody/prepaid-v1 or their journals.
    const directory = path.join(root, key); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = path.join(directory, "context.json");
    if (!fs.existsSync(metadata)) fs.writeFileSync(metadata, JSON.stringify({ config, accountId: auth.accountId }), { flag: "wx", mode: 0o600 });
    const access = { authorize: (pin, nextSignal) => {
      nextSignal?.throwIfAborted();
      this.account.assertCreditAuthorization(auth, pin);
      return auth;
    } };
    if (auth.sessionOnly && this.sessionIdentity !== auth.sessionToken) {
      this.sessionStore?.dispose(); this.sessionStore = new (require("./session-free-chat").SessionFreeChatStore)(); this.sessionIdentity = auth.sessionToken;
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
      if (c.auth?.sessionOnly) throw Object.assign(Error("Unlock your operating system keyring and reconnect with saved access before buying credits. Temporary access uses free credits only."), { code: "secure-storage-required" });
      // Buying credits depends on this account and its saved payments. Loading
      // provider availability or advanced-chat capabilities must not hold Buy.
      return { enabled: true, configured: true, product: "prepaid-usd-v1", activation: "ready", blocked: "", ...await this.purchaseState(c, signal) };
    } catch (error) { return { enabled: true, configured: true, product: "prepaid-usd-v1", ...setupFailure(error), recoveryAvailable: false }; }
  }
  async purchaseCapabilities(signal) {
    const c = await this.context(signal);
    return this.purchases.estimateCapabilities(c, signal);
  }
  async info(signal) {
    if (this.service.state !== "ready") return { enabled: true, configured: true, product: "prepaid-usd-v1", blocked: this.service.reason, activation: "unavailable", recoveryAvailable: false };
    try {
      const c = await this.context(signal);
      let runBudgets = false, creditPriority = false, modelCatalog, modelError = "";
      try { modelCatalog = await c.flow.models(signal); } catch (error) { modelError = String(error.message).slice(0, 220); }
      try { const r = await c.flow.call("capabilities", {}, signal); creditPriority = r.capabilities?.creditPriority === true; runBudgets = !!modelCatalog && r.capabilities?.advancedRuns === true && modelCatalog.models.every(t => r.capabilities.models?.some(m => m.model === t.model && m.version === t.version && m.maxOutput >= t.maxOutput)); } catch { /* Normal Chat remains independent of advanced-run support. */ }
      return { enabled: true, configured: true, product: "prepaid-usd-v1", activation: "ready", blocked: modelError, ...await this.purchaseState(c, signal), model: c.config.model, maxOutput: c.config.maxOutput, models: modelCatalog?.models || [], modelAvailabilityUntil: modelCatalog?.validUntil || null,
        runBudgets: c.auth?.sessionOnly ? false : runBudgets, creditPriority: c.auth?.sessionOnly ? false : creditPriority, freeOnlySession: c.auth?.sessionOnly === true, maxRequestCredits: require("../core/lib/koin-network/purchase-quote").credits(c.config.limits.perJob), recoveryAvailable: c.recoverable.length > 0 };
    } catch (error) { return { enabled: true, configured: true, product: "prepaid-usd-v1", ...setupFailure(error), recoveryAvailable: false }; }
  }
  async run(action, input, signal, window) {
    const c = await this.context(signal);
    if (c.auth?.sessionOnly && (action.startsWith("run-") || ["purchase-preview", "purchase-approve", "purchase-retry"].includes(action))) throw Object.assign(Error("Temporary network access uses free credits only. Unlock secure storage and reconnect with saved access for purchases and paid usage."), { code: "secure-storage-required" });
    if (action === "run-open") return this.runs.open(c, input, signal);
    if (action === "run-chat") return this.runs.chat(c, input, signal);
    if (action === "run-status") return this.runs.status(c, input, signal);
    if (action === "run-stop") return this.runs.stop(c, input, signal);
    if (action === "run-list") return { runs: this.runs.list(c) };
    if (action === "purchase-estimate") return this.purchases.estimate(c, input, signal);
    if (action === "purchase-preview") return this.purchases.preview(c, input, signal);
    if (["purchase-approve", "purchase-retry"].includes(action)) return this.purchases.run(c, window, action, input, signal);
    if (action === "purchase-sync") return this.purchases.sync(c, signal);
    if (action === "credit-status") return c.flow.status();
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
  dispose() { this.purchases.stop(); this.sessionStore?.dispose(); this.sessionStore = null; this.sessionIdentity = null; }
}
module.exports = { CreditService, manifest, setupFailure };
