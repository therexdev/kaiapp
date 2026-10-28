"use strict";
const fs = require("fs"), path = require("path");
const { Worker } = require("../core/lib/worker");
const modelId = id => typeof id === "string" && /^[a-zA-Z0-9._-]{1,100}$/.test(id);
const rewardStates = new Set(["queued", "signing", "staged", "unknown", "pending", "reversible", "needs_review", "paid", "paid_elsewhere"]);
const rewardScope = config => require("node:crypto").createHash("sha256").update(JSON.stringify([
  config.schedulerUrl, config.mode, config.deployment?.chainId, config.deployment?.credits, config.deployment?.creditsHash,
  config.deployment?.rewards, config.deployment?.rewardsHash, config.owner
])).digest("hex");
function modelSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "mode,models" ||
      !["all", "selected"].includes(value.mode) || !Array.isArray(value.models) || value.models.length > 64 ||
      value.models.some(id => !modelId(id)) || new Set(value.models).size !== value.models.length ||
      (value.mode === "all" ? value.models.length !== 0 : !value.models.length)) throw Error("Choose at least one installed model, or share all compatible installed models");
  return { mode: value.mode, models: [...value.models].sort() };
}
// Public account setup, scoped to this deployment and device. No custody migration.
class CreditProvider {
  constructor({ service, core, device, dialog, createWorker = options => new Worker(options), readStatus = require("./koin-provider-status").readProviderStatus }) {
    Object.assign(this, { service, core, createWorker, readStatus });
    this.device = device || (service.service ? new (require("./provider-device").ProviderDevice)({ service, core, dialog }) : null); this.worker = null; this.busy = false; this.closed = false; this.error = ""; this.generation = 0; this.modelHint = null;
  }
  savedPreference(c) {
    const file = path.join(c.directory, "provider-preference.json");
    if (!fs.existsSync(file)) return { schema: 1, enabled: false };
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 16384) throw Error("Provider preference needs recovery");
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    if (p.schema !== 1 || typeof p.enabled !== "boolean" || (p.model !== undefined &&
        !modelId(p.model))) throw Error("Provider preference needs recovery");
    if (p.selection !== undefined) p.selection = modelSelection(p.selection);
    return p;
  }
  selection(c) { return this.savedPreference(c).selection || { mode: "all", models: [] }; }
  selected(c, models) {
    const selection = this.selection(c);
    return selection.mode === "all" ? models : models.filter(m => selection.models.includes(m.id));
  }
  preference(c, enabled, model, selection) {
    const saved = this.savedPreference(c);
    if (enabled === undefined) return saved.enabled;
    const file = path.join(c.directory, "provider-preference.json");
    model ??= saved.model;
    selection = selection === undefined ? saved.selection : modelSelection(selection);
    const temp = file + ".tmp", fd = fs.openSync(temp, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ schema: 1, enabled, ...(model ? { model } : {}), ...(selection ? { selection } : {}) })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temp, file);
  }
  networkAllowed() {
    if (this.core.gateway.network.status?.().privacyMode === "local-only" || this.core.settings?.get?.("network.privacyMode") === "local-only")
      throw Error("Local-Only is on. Choose Network or Local-First before starting earning.");
  }
  providerContext(signal) { return this.device ? this.device.context(signal) : this.service.context(signal); }
  providerAccess(c) { return c.access || { authorize: pin => { this.service.account.assertCreditAuthorization(c.auth, pin); return c.auth; } }; }
  async authorize(window, input, signal) {
    if (!this.device) throw Error("Wallet-first earning is unavailable on this service");
    if (this.busy || this.closed) throw Error("Provider setup is already in progress");
    this.busy = true; const generation = this.generation;
    try {
      const result = await this.device.authorize(window, input, signal);
      if (generation !== this.generation || this.closed) return { state: "cancelled" };
      if (result.state === "authorized") this.error = "";
      return result;
    } finally { this.busy = false; }
  }
  async revoke(window, signal) {
    if (!this.device) throw Error("Device authorization is unavailable on this service");
    if (this.busy || this.closed) throw Error("Provider setup is already in progress");
    this.busy = true;
    try {
      const result = await this.device.revoke(window, signal);
      if (result.state === "revoked") await this.stop(true);
      return result;
    } finally { this.busy = false; }
  }
  guard(c, signal) {
    signal?.throwIfAborted(); if (this.closed) throw Error("Provider is closing");
    this.networkAllowed();
    if (this.device) { this.device.assert(c, signal); return; }
    this.service.account.assertCreditAuthorization(c.auth, c.config.schedulerUrl);
    const wallet = this.core.account.wallet;
    if (!wallet.address) throw Error("Open Reward wallet to set up or unlock your existing wallet.");
    if (wallet.address !== c.config.owner) throw Error("Open AI credit account in Settings and link this computer's reward wallet.");
    if (!wallet.status().unlocked) throw Error("Unlock your wallet using Reward wallet, then check setup again.");
  }
  async models(c, signal) {
    this.networkAllowed();
    // The buyer's committed catalog also defines which local packages may earn.
    // A model need not already have a remote provider to become a new provider.
    const catalog = await c.flow.models(signal), tariffs = catalog?.tariffs;
    if (!Array.isArray(tariffs) || !tariffs.length || tariffs.length > 64) throw Error("The approved provider model catalog is unavailable");
    const ramGb = this.core.hardware?.ramBytes / 1e9;
    const vramGb = Math.max(0, ...(this.core.hardware?.gpus || []).map(g => (Number(g?.vramMb) || 0) / 1024));
    const capacityGb = Math.max(Number.isFinite(ramGb) ? ramGb : 0, vramGb), candidates = [];
    for (const tariff of tariffs) {
      const alias = this.core.models.catalog.aliases[tariff.model], pkg = alias && this.core.models.catalog.packages[alias.package];
      if (!alias || alias.custom || alias.dev || tariff.model.startsWith("dev-") || !pkg || pkg.custom || !/^[a-f0-9]{64}$/.test(pkg.sha256 || "") || pkg.sha256 !== tariff.modelHash || this.core.models.quarantineOf(alias.package)) continue;
      if (!Number.isFinite(alias.minRamGb) || Math.round(capacityGb) < alias.minRamGb) continue;
      candidates.push({ id: tariff.model, package: alias.package, label: alias.label || tariff.model, bytes: pkg.sizeBytes, requiredRamGb: alias.minRamGb,
        installed: this.core.models.packageStatus(alias.package).status === "ready" });
    }
    c.providerModels = tariffs.map(t => t.model);
    c.providerModelPins = Object.fromEntries(this.selected(c, candidates).map(m => [m.id, this.core.models.catalog.packages[m.package].sha256]));
    c.offeredModelPins = Object.fromEntries(this.selected(c, candidates).filter(m => m.installed).map(m => [m.id, c.providerModelPins[m.id]]));
    // Explain public installed models that cannot be offered without exposing
    // private imports or treating installation as network qualification.
    c.modelAvailability = Object.entries(this.core.models.catalog.aliases).filter(([id, a]) => modelId(id) && !a.custom && !a.dev && !id.startsWith("dev-") &&
      this.core.models.packageStatus(a.package).status === "ready").slice(0, 64).map(([id, a]) => {
      const compatible = candidates.some(m => m.id === id), pkg = this.core.models.catalog.packages[a.package], tariff = tariffs.find(t => t.model === id);
      const reason = compatible ? "" : this.core.models.quarantineOf(a.package) ? "This installed model needs an update before sharing."
        : !tariff || !pkg || pkg.custom || pkg.sha256 !== tariff.modelHash ? "This installed model is not in the approved network catalog."
        : "This model needs more available RAM or GPU memory.";
      return { id, label: a.label || id, installed: true, compatible, reason };
    });
    if (!candidates.length) throw Error("No approved provider model is supported on this computer");
    return candidates;
  }
  async model(c, signal, candidates = null) {
    candidates = this.selected(c, candidates ?? await this.models(c, signal));
    if (!candidates.length) throw Error("None of your selected models is available. Choose an installed model in Models to share.");
    // Sharing offers every selected installed model. The saved model is only
    // a warm-start hint, never a requirement to select a model or send a chat.
    // Prefer fresh network evidence so an old Fast choice cannot strand a
    // computer whose Smart capacity is already qualified.
    try {
      const status = await this.readStatus({ config: c.config, approvedModels: c.providerModels,
        access: this.providerAccess(c),
        fetchImpl: this.service.fetchImpl, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
      for (const state of ["online", "qualifying", "preparing", "connecting", "qualification-expired", "network-paused"]) {
        for (const row of [status, ...(status.models || [])]) {
          const selected = row.state === state && candidates.find(m => m.installed && m.id === row.model);
          if (selected) { this.modelHint = { directory: c.directory, model: selected.id }; return selected; }
        }
      }
    } catch { signal.throwIfAborted(); }
    const hinted = this.modelHint?.directory === c.directory && candidates.find(m => m.installed && m.id === this.modelHint.model);
    if (hinted) return hinted;
    // A new provider has no qualification observation yet. Smart is the
    // product's default shared capacity when installed and supported; prepare
    // it before its first timed quality check rather than making Chat warm it.
    const smart = candidates.find(m => m.installed && m.id === "koinos-smart");
    if (smart) return smart;
    const saved = this.savedPreference(c).model;
    const previous = candidates.find(m => m.installed && m.id === saved);
    if (previous) return previous;
    const active = this.core.runtime.status?.().activeAlias;
    const selected = candidates.find(m => m.installed && m.id === active) || candidates.find(m => m.installed && m.id === c.config.model) || candidates.find(m => m.installed) || candidates.find(m => m.id === c.config.model);
    if (!selected) throw Error("No approved provider model is installed for this computer. Install a supported model from Models before sharing");
    return selected;
  }
  async info() {
    try {
      this.networkAllowed();
      const signal = AbortSignal.timeout(10000), c = await this.providerContext(signal), models = await this.models(c, signal), enabled = this.preference(c);
      let model, selectionError = "";
      try { model = await this.model(c, signal, models); } catch (e) { selectionError = e.message; }
      this.preferenceContext = c;
      let blocked = "", blockedState = ""; try { this.guard(c); } catch (e) { blocked = e.message; blockedState = e.code || "wallet-required"; }
      const progress = this.downloading ? this.core.models.downloadProgress() : null;
      // A successful read while Off supersedes earlier connection failures.
      // Current setup requirements always take priority over a saved error.
      if (!blocked && !enabled && !this.busy) this.error = "";
      const modelDiagnostics = !blocked && enabled && this.worker?.running && this.context?.directory === c.directory &&
        this.context?.auth.sessionToken === c.auth.sessionToken
        ? require("../core/lib/koin-network/provider-diagnostics").sanitize(this.worker.status?.()?.modelDiagnostics, Object.keys(c.offeredModelPins || {})) : [];
      return { ...(this.device?.describe() || {}), state: blocked ? blockedState : selectionError ? "model-required" : this.downloading ? "downloading" : !model.installed ? "download-required" : this.busy ? "starting" : "ready", blocked,
        model, models, automatic: true, selection: this.selection(c), modelAvailability: c.modelAvailability,
        offeredModels: this.selected(c, models).filter(m => m.installed).map(m => m.id), modelDiagnostics, enabled, running: !!this.worker?.running, progress: progress ? { pct: progress.pct } : null,
        detail: blocked || selectionError || this.error || (!model.installed ? "Download an approved model to this computer, then start earning." : "Ready to connect. Start earning offers your selected installed models and loads them automatically when needed. The network checks each model before paid work.") };
    } catch (e) { return { ...(this.device?.describe() || {}), state: e.code || "unavailable", canAuthorize: ["authorization-required", "authorization-expired", "authorization-revoked", "secure-storage-required"].includes(e.code), enabled: !!this.context && this.preference(this.context), running: !!this.worker?.running, detail: e.message }; }
  }
  async selectModel(id, signal) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(id)) throw Error("Choose an approved provider model");
    if (this.busy || this.closed || this.worker?.running) throw Error("Turn sharing off before changing the provider model");
    this.busy = true; const generation = this.generation;
    try {
      this.networkAllowed();
      const c = await this.providerContext(signal); this.guard(c, signal);
      const models = await this.models(c, signal); this.guard(c, signal);
      if (generation !== this.generation) throw Error("Provider model selection cancelled");
      if (this.preference(c)) throw Error("Turn sharing off before changing the provider model");
      if (!models.some(m => m.id === id)) throw Error("Choose an approved provider model supported on this computer");
      this.preference(c, false, id); this.preferenceContext = c; this.error = "";
      return { state: "model-selected", model: id };
    } finally { this.busy = false; }
  }
  async selectModels(input, signal, reconcile = false) {
    const selection = modelSelection(input);
    if (this.busy || this.closed) throw Error("Provider setup is already in progress");
    this.busy = true; const generation = this.generation, controller = this.selectionAbort = new AbortController();
    signal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(120000)]);
    const current = c => { signal.throwIfAborted(); if (generation !== this.generation) throw Error("Provider model selection cancelled"); this.guard(c, signal); };
    let hold, changed = false;
    try {
      this.networkAllowed();
      const c = await this.providerContext(signal); current(c);
      const models = await this.models(c, signal); current(c);
      if (selection.mode === "selected" && selection.models.some(id => !models.some(m => m.id === id && m.installed)))
        throw Error("Choose only compatible installed models to share");
      this.preferenceContext = c;
      if (!reconcile && JSON.stringify(selection) === JSON.stringify(this.selection(c))) return { state: "models-selected", selection, running: !!this.worker?.running };
      if (this.worker?.running && (this.context?.directory !== c.directory || this.context?.auth.sessionToken !== c.auth.sessionToken))
        throw Error("The AI credit account changed. Wait for earning to reconnect before changing shared models.");
      // Stop accepting work, then let an already assigned job finish through
      // its signed result acknowledgement before changing the worker identity.
      if (this.worker?.running) {
        if (!this.core.runtime.pauseNetworkWork) throw Error("Update the app before changing models while earning is on");
        hold = await this.core.runtime.pauseNetworkWork(signal); current(c);
        await this.disconnect(); current(c);
      }
      const enabled = this.preference(c);
      this.preference(c, enabled, undefined, selection); this.modelHint = null; changed = true; this.error = "";
      if (enabled) await this.connect(signal, true, generation, c);
      return { state: "models-selected", selection, running: !!this.worker?.running };
    } catch (error) {
      this.error = String(error.message);
      // Before the drain completes the old selection remains intact. Once a
      // new selection is saved, a failed connection can resume that same intent.
      let unauthorized = false;
      try { if (this.context) this.guard(this.context); } catch { unauthorized = true; }
      if (changed || unauthorized) await this.stop(false);
      throw error;
    } finally {
      hold?.release(); if (this.selectionAbort === controller) this.selectionAbort = null; this.busy = false;
    }
  }
  async download(signal) {
    if (this.busy) throw Error("Provider setup is already in progress"); this.busy = true;
    this.downloadAbort = new AbortController(); signal = AbortSignal.any([signal, this.downloadAbort.signal]);
    const stop = () => { if (this.downloading) this.core.models.cancelDownload(); };
    try {
      this.networkAllowed();
      const c = await this.providerContext(signal); this.guard(c, signal); const model = await this.model(c, signal); this.guard(c, signal);
      if (!model.installed) {
        if (this.core.models.downloadProgress()) throw Error("Finish the current model download first");
        this.downloading = true; signal.addEventListener("abort", stop, { once: true }); signal.throwIfAborted();
        await this.core.models.ensurePackage(model.package); this.guard(c, signal);
      }
      return { state: "model-ready" };
    } finally { signal.removeEventListener("abort", stop); this.downloading = false; this.downloadAbort = null; this.busy = false; }
  }
  async start(signal, resume = false) {
    if (this.busy || this.closed) throw Error("Provider setup is already in progress");
    if (this.worker?.running) return { state: "running" };
    this.busy = true; const generation = this.generation;
    try { return await this.connect(signal, resume, generation); }
    catch (e) { this.error = String(e.message); await this.stop(false); throw e; }
    finally { this.busy = false; }
  }
  async connect(signal, resume, generation, context = null) {
    const current = () => { signal.throwIfAborted(); if (generation !== this.generation) throw Error("Provider startup cancelled"); };
      this.networkAllowed();
      const c = context ?? await this.providerContext(signal); current(); this.guard(c, signal); const model = await this.model(c, signal); current(); this.guard(c, signal);
      if (!model.installed) throw Error("Download the approved model before turning on sharing");
      if (resume && !this.preference(c)) return { state: "offline" };
      this.context = c; this.preference(c, true, model.id); this.error = "";
      // The host lease coordinates the existing wallet; it creates no credential.
      if (!this.device) {
      const access = require("./credit-purchase-access"), id = access.installation({ dataDir: this.service.dataDir, directory: c.directory, config: c.config, storage: this.service.purchases.storage });
      await access.claimHost({ c, account: this.service.account, wallet: this.core.account.wallet, installation: id, fetchImpl: this.service.fetchImpl, signal }); current(); this.guard(c, signal);
      }
      await this.core.gateway.earn?.stop?.({ userIntent: true });
      current();
      const cfg = c.config, target = { chainId: cfg.deployment.chainId, credits: cfg.deployment.credits, creditsHash: cfg.deployment.creditsHash,
        policyHash: cfg.policyHash, domain: require("../core/lib/koin-network/payment-mode").testDomain(cfg.deployment, cfg.schedulerUrl) };
      this.abort = new AbortController(); this.release = this.core.gateway.network.trackShadowRequest(this.abort);
      this.worker = this.createWorker({ schedulerUrl: cfg.schedulerUrl, ...(this.device ? { providerSigner: c.signer } : { wallet: this.core.account.wallet }), runtime: this.core.runtime, hardware: this.core.hardware, models: this.core.models, modelPins: c.providerModelPins, idlePollMs: 5000,
        fundedOnly: true, qualificationTarget: target, koinShadowJobs: false, koinFundedRehearsalJobs: cfg.mode === "test-deployment", koinMainnetPilotJobs: cfg.mode === "mainnet-pilot", koinMainnetTarget: target });
      this.registeredModelPins = { ...c.offeredModelPins };
      const worker = this.worker;
      this.abort.signal.addEventListener("abort", () => { this.stopWorker(worker).catch(() => {}); }, { once: true });
      const combined = AbortSignal.any([signal, this.abort.signal]);
      const hold = await this.core.runtime.acquireFor(model.id); hold.release(); current(); this.guard(c, combined);
      await this.worker.start(combined); current(); this.guard(c, combined); return { state: "running" };
  }
  stopWorker(worker = this.worker) {
    if (!worker) return Promise.resolve();
    if (this.stoppingWorker?.worker === worker) return this.stoppingWorker.promise;
    const promise = worker.stop(); this.stoppingWorker = { worker, promise }; return promise;
  }
  async disconnect() {
    this.abort?.abort(); await this.stopWorker(); this.release?.(); this.release = null;
  }
  async stop(user = true) {
    this.generation++; this.device?.cancelPending(); this.downloadAbort?.abort(); this.selectionAbort?.abort();
    if (user) for (const c of new Set([this.context, this.preferenceContext].filter(Boolean))) this.preference(c, false);
    await this.disconnect();
    return { state: "offline" };
  }
  async status() {
    if (!this.worker?.running || !this.context) return { state: "offline", label: "OFFLINE", detail: this.error || "Sharing is off. Turn it on to connect and check model readiness." };
    if (this.selectionAbort) return { state: "checking", label: "UPDATING SHARED MODELS", detail: "Finishing current work and reconnecting with your model selection.", models: [], readyModels: [] };
    const c = this.context; this.guard(c);
    if (this.worker.status().backoff) return { state: "paused", label: "PAUSED", detail: this.worker.status().backoffReason || "This computer is busy." };
    const worker = this.worker, generation = this.generation;
    const result = await this.readStatus({ config: c.config, approvedModels: c.providerModels, access: this.providerAccess(c), fetchImpl: this.service.fetchImpl, signal: AbortSignal.timeout(10000) });
    if (this.selectionAbort || generation !== this.generation || worker !== this.worker || !worker.running) return { state: "checking", label: "CHECKING CONNECTION", detail: "Waiting for the current model selection to connect." };
    const offered = Object.keys(this.registeredModelPins || {}), rows = (result.models || [result]).filter(row => offered.includes(row.model));
    const primary = rows.find(row => row.state === "online") || rows.find(row => row.model === result.model) || rows.find(row => row.state === "qualifying") || rows[0];
    if (!primary) return { state: "checking", label: "CHECKING CONNECTION", detail: "Waiting for the network to check your selected models.", models: [], readyModels: [] };
    const ready = rows.filter(row => row.state === "online");
    return { ...primary, ...(this.device && ready.length && !this.core.account.wallet.status().unlocked ? { walletLocked: true, detail: "Wallet locked — earning continues. " + (primary.detail || "") } : {}), ...(ready.length ? { validUntil: Math.min(...ready.map(row => row.validUntil)) } : {}), models: rows, readyModels: ready.map(row => row.model) };
  }
  async earnings() {
    this.networkAllowed();
    if (this.closed) throw Error("Provider is closing");
    const signal = AbortSignal.timeout(10000), c = await this.providerContext(signal), walletAddress = c.config.owner, scope = rewardScope(c.config);
    const access = this.providerAccess(c);
    const current = () => {
      signal.throwIfAborted(); this.networkAllowed();
      if (this.closed || rewardScope(c.config) !== scope) throw Error("The reward wallet or service changed while checking rewards");
      // Read-only access stays usable with the financial wallet locked. The
      // account/device authorization still has to match after an awaited read.
      access.authorize(c.config.schedulerUrl);
    };
    current();
    const value = await require("./koin-provider-status").readProviderAccount({ config: c.config,
      access, fetchImpl: this.service.fetchImpl, signal });
    current();
    if (!Number.isSafeInteger(value.observedAt) || Math.abs(Date.now() - value.observedAt) > 30000 || !Array.isArray(value.payouts) || value.payouts.length > 4096) throw Error("Reward history observation is unavailable or stale");
    const epochs = new Set(), ids = new Set(), maxAtoms = (1n << 64n) - 1n;
    const payouts = value.payouts.filter(p => p?.account === walletAddress).map(p => {
      if (typeof p.epoch !== "string" || !/^(0|[1-9]\d{0,9})$/.test(p.epoch) || !rewardStates.has(p.state) ||
          [p.availability, p.work].some(n => typeof n !== "string" || !/^(0|[1-9]\d{0,19})$/.test(n))) throw Error("Reward history could not be verified");
      if (BigInt(p.availability) + BigInt(p.work) > maxAtoms || epochs.has(p.epoch) ||
          p.id !== undefined && (typeof p.id !== "string" || !/^[a-f0-9]{64}$/.test(p.id) || ids.has(p.id)) ||
          p.txId !== undefined && p.txId !== null && (typeof p.txId !== "string" || !/^0x1220[a-f0-9]{64}$/.test(p.txId))) throw Error("Reward history could not be verified");
      epochs.add(p.epoch); if (p.id !== undefined) ids.add(p.id);
      return { epoch: p.epoch, state: p.state, availability: p.availability, work: p.work,
        ...(p.id !== undefined ? { id: p.id } : {}), ...(p.txId ? { txId: p.txId } : {}) };
    }).sort((a, b) => Number(b.epoch) - Number(a.epoch)).slice(0, 64);
    // The server reports a UTC reward day, not a payment timestamp. Only the
    // observation time and the last successful processing check are available.
    return { walletAddress, scope, observedAt: value.observedAt, lastCycleCheck: Number.isSafeInteger(value.lastCycleCheck) &&
      value.lastCycleCheck >= 0 && value.lastCycleCheck <= value.observedAt + 5000 ? value.lastCycleCheck : null, payouts };
  }
  async tick() {
    if (this.busy || this.closed) return;
    let generation = this.generation;
    const current = () => generation === this.generation && !this.busy && !this.closed;
    try {
      this.networkAllowed();
      const c = await this.providerContext(AbortSignal.timeout(10000)); if (!current()) return; this.guard(c);
      if (this.context && (this.context.directory !== c.directory || this.context.auth.sessionToken !== c.auth.sessionToken)) {
        const stopping = this.stop(false); generation = this.generation; await stopping; if (!current()) return;
      }
      if (this.worker?.running) {
        await this.models(c, AbortSignal.timeout(10000)); if (!current()) return; this.guard(c);
        if (JSON.stringify(c.offeredModelPins) !== JSON.stringify(this.registeredModelPins))
          await this.selectModels(this.selection(c), AbortSignal.timeout(120000), true);
      }
      if (current() && !this.worker?.running && this.preference(c)) await this.start(AbortSignal.timeout(60000), true);
    } catch (e) { if (current()) { this.error = String(e.message); await this.stop(false); } }
  }
  dispose() { this.closed = true; this.device?.dispose(); return this.stop(false); }
}
module.exports = { CreditProvider };
