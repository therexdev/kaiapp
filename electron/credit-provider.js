"use strict";
const fs = require("fs"), path = require("path");
const { Worker } = require("../core/lib/worker");
// Public account setup, scoped to this deployment and device. No custody migration.
class CreditProvider {
  constructor({ service, core, createWorker = options => new Worker(options), readStatus = require("./koin-provider-status").readProviderStatus }) {
    Object.assign(this, { service, core, createWorker, readStatus }); this.worker = null; this.busy = false; this.closed = false; this.error = ""; this.generation = 0; this.modelHint = null;
  }
  savedPreference(c) {
    const file = path.join(c.directory, "provider-preference.json");
    if (!fs.existsSync(file)) return { schema: 1, enabled: false };
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 1024) throw Error("Provider preference needs recovery");
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    if (p.schema !== 1 || typeof p.enabled !== "boolean" || (p.model !== undefined &&
        (typeof p.model !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(p.model)))) throw Error("Provider preference needs recovery");
    return p;
  }
  preference(c, enabled, model) {
    const saved = this.savedPreference(c);
    if (enabled === undefined) return saved.enabled;
    const file = path.join(c.directory, "provider-preference.json");
    model ??= saved.model;
    const temp = file + ".tmp", fd = fs.openSync(temp, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ schema: 1, enabled, ...(model ? { model } : {}) })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temp, file);
  }
  guard(c, signal) {
    signal?.throwIfAborted(); if (this.closed) throw Error("Provider is closing");
    this.service.account.assertCreditAuthorization(c.auth, c.config.schedulerUrl);
    const wallet = this.core.account.wallet;
    if (!wallet.address) throw Error("Open Reward wallet to set up or unlock your existing wallet.");
    if (wallet.address !== c.config.owner) throw Error("Open AI credit account in Settings and link this computer's reward wallet.");
    if (!wallet.status().unlocked) throw Error("Unlock your wallet using Reward wallet, then check setup again.");
  }
  async models(c, signal) {
    // The buyer's committed catalog also defines which local packages may earn.
    // A model need not already have a remote provider to become a new provider.
    const catalog = await c.flow.models(signal), tariffs = catalog?.tariffs;
    if (!Array.isArray(tariffs) || !tariffs.length || tariffs.length > 64) throw Error("The approved provider model catalog is unavailable");
    const ramGb = this.core.hardware?.ramBytes / 1e9, candidates = [];
    for (const tariff of tariffs) {
      const alias = this.core.models.catalog.aliases[tariff.model], pkg = alias && this.core.models.catalog.packages[alias.package];
      if (!alias || alias.custom || alias.dev || !pkg || pkg.custom || !/^[a-f0-9]{64}$/.test(pkg.sha256 || "") || pkg.sha256 !== tariff.modelHash || this.core.models.quarantineOf(alias.package)) continue;
      if (!Number.isFinite(ramGb) || !Number.isFinite(alias.minRamGb) || ramGb < alias.minRamGb) continue;
      candidates.push({ id: tariff.model, package: alias.package, label: alias.label || tariff.model, bytes: pkg.sizeBytes, requiredRamGb: alias.minRamGb,
        installed: this.core.models.packageStatus(alias.package).status === "ready" });
    }
    c.providerModels = tariffs.map(t => t.model);
    if (!candidates.length) throw Error("No approved provider model is supported on this computer");
    return candidates;
  }
  async model(c, signal, candidates = null) {
    candidates ??= await this.models(c, signal);
    const saved = this.savedPreference(c).model;
    if (saved) {
      const selected = candidates.find(m => m.id === saved);
      if (!selected) throw Error("The saved provider model is no longer approved or supported. Choose another model in Earn.");
      return selected;
    }
    const hinted = this.modelHint?.directory === c.directory && candidates.find(m => m.installed && m.id === this.modelHint.model);
    if (hinted) return hinted;
    // Older preferences did not record the provider model. A fresh authenticated
    // readiness report can recover an already qualified model after an update.
    // This is a selection hint only; it never grants eligibility or paints ONLINE.
    try {
      const status = await this.readStatus({ config: c.config, approvedModels: c.providerModels,
        access: { authorize: pin => { this.service.account.assertCreditAuthorization(c.auth, pin); return c.auth; } },
        fetchImpl: this.service.fetchImpl, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
      const eligible = new Set(["online", "qualifying", "preparing", "connecting", "qualification-expired", "network-paused"]);
      for (const row of [status, ...(status.models || [])]) {
        const selected = eligible.has(row.state) && candidates.find(m => m.installed && m.id === row.model);
        if (selected) { this.modelHint = { directory: c.directory, model: selected.id }; return selected; }
      }
    } catch { signal.throwIfAborted(); }
    const active = this.core.runtime.status?.().activeAlias;
    const selected = candidates.find(m => m.installed && m.id === active) || candidates.find(m => m.installed && m.id === c.config.model) || candidates.find(m => m.installed) || candidates.find(m => m.id === c.config.model);
    if (!selected) throw Error("No approved provider model is installed for this computer. Install a supported model from Models before sharing");
    return selected;
  }
  async info() {
    try {
      const signal = AbortSignal.timeout(10000), c = await this.service.context(signal), models = await this.models(c, signal), enabled = this.preference(c);
      let model, selectionError = "";
      try { model = await this.model(c, signal, models); } catch (e) { selectionError = e.message; }
      this.preferenceContext = c;
      let blocked = ""; try { this.guard(c); } catch (e) { blocked = e.message; }
      const progress = this.downloading ? this.core.models.downloadProgress() : null;
      // A successful read while Off supersedes earlier connection failures.
      // Current setup requirements always take priority over a saved error.
      if (!blocked && !enabled && !this.busy) this.error = "";
      return { state: blocked ? "wallet-required" : selectionError ? "model-required" : this.downloading ? "downloading" : !model.installed ? "download-required" : this.busy ? "starting" : "ready", blocked,
        model, models, enabled, running: !!this.worker?.running, progress: progress ? { pct: progress.pct } : null,
        detail: blocked || selectionError || this.error || (!model.installed ? "Download the approved model to this computer. Sharing stays off until you turn it on." : "Ready to connect and check model quality. Turning on sharing loads this model automatically. Qualification renews while sharing is on.") };
    } catch (e) { return { state: "unavailable", enabled: !!this.context && this.preference(this.context), running: !!this.worker?.running, detail: e.message }; }
  }
  async selectModel(id, signal) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(id)) throw Error("Choose an approved provider model");
    if (this.busy || this.closed || this.worker?.running) throw Error("Turn sharing off before changing the provider model");
    this.busy = true; const generation = this.generation;
    try {
      const c = await this.service.context(signal); this.guard(c, signal);
      const models = await this.models(c, signal); this.guard(c, signal);
      if (generation !== this.generation) throw Error("Provider model selection cancelled");
      if (this.preference(c)) throw Error("Turn sharing off before changing the provider model");
      if (!models.some(m => m.id === id)) throw Error("Choose an approved provider model supported on this computer");
      this.preference(c, false, id); this.preferenceContext = c; this.error = "";
      return { state: "model-selected", model: id };
    } finally { this.busy = false; }
  }
  async download(signal) {
    if (this.busy) throw Error("Provider setup is already in progress"); this.busy = true;
    this.downloadAbort = new AbortController(); signal = AbortSignal.any([signal, this.downloadAbort.signal]);
    const stop = () => { if (this.downloading) this.core.models.cancelDownload(); };
    try {
      const c = await this.service.context(signal); this.guard(c, signal); const model = await this.model(c, signal); this.guard(c, signal);
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
    const current = () => { signal.throwIfAborted(); if (generation !== this.generation) throw Error("Provider startup cancelled"); };
    try {
      const c = await this.service.context(signal); current(); this.guard(c, signal); const model = await this.model(c, signal); current(); this.guard(c, signal);
      if (!model.installed) throw Error("Download the approved model before turning on sharing");
      if (resume && !this.preference(c)) return { state: "offline" };
      this.context = c; this.preference(c, true, model.id); this.error = "";
      // The host lease coordinates the existing wallet; it creates no credential.
      const access = require("./credit-purchase-access"), id = access.installation({ dataDir: this.service.dataDir, directory: c.directory, config: c.config, storage: this.core.account.safeStorage });
      await access.claimHost({ c, account: this.service.account, wallet: this.core.account.wallet, installation: id, fetchImpl: this.service.fetchImpl, signal }); current(); this.guard(c, signal);
      await this.core.gateway.earn?.stop?.({ userIntent: true });
      current();
      const cfg = c.config, target = { chainId: cfg.deployment.chainId, credits: cfg.deployment.credits, creditsHash: cfg.deployment.creditsHash,
        policyHash: cfg.policyHash, domain: require("../core/lib/koin-network/payment-mode").testDomain(cfg.deployment, cfg.schedulerUrl) };
      this.abort = new AbortController(); this.release = this.core.gateway.network.trackShadowRequest(this.abort);
      this.worker = this.createWorker({ schedulerUrl: cfg.schedulerUrl, wallet: this.core.account.wallet, runtime: this.core.runtime, hardware: this.core.hardware, models: this.core.models,
        fundedOnly: true, qualificationTarget: target, koinShadowJobs: false, koinFundedRehearsalJobs: cfg.mode === "test-deployment", koinMainnetPilotJobs: cfg.mode === "mainnet-pilot", koinMainnetTarget: target });
      this.abort.signal.addEventListener("abort", () => { this.worker?.stop().catch(() => {}); }, { once: true });
      const combined = AbortSignal.any([signal, this.abort.signal]);
      const hold = await this.core.runtime.acquireFor(model.id); hold.release(); current(); this.guard(c, combined);
      await this.worker.start(); current(); this.guard(c, combined); return { state: "running" };
    } catch (e) { this.error = String(e.message); await this.stop(false); throw e; }
    finally { this.busy = false; }
  }
  async stop(user = true) {
    this.generation++; this.downloadAbort?.abort();
    if (user) for (const c of new Set([this.context, this.preferenceContext].filter(Boolean))) this.preference(c, false);
    this.abort?.abort(); await this.worker?.stop(); this.release?.(); this.release = null;
    return { state: "offline" };
  }
  async status() {
    if (!this.worker?.running || !this.context) return { state: "offline", label: "OFFLINE", detail: this.error || "Sharing is off. Turn it on to connect and check model quality." };
    const c = this.context; this.guard(c);
    if (this.worker.status().backoff) return { state: "paused", label: "PAUSED", detail: this.worker.status().backoffReason || "This computer is busy." };
    return this.readStatus({ config: c.config, approvedModels: c.providerModels, access: { authorize: pin => { this.service.account.assertCreditAuthorization(c.auth, pin); return c.auth; } }, fetchImpl: this.service.fetchImpl, signal: AbortSignal.timeout(10000) });
  }
  async earnings() {
    const c = await this.service.context(AbortSignal.timeout(10000));
    const value = await require("./koin-provider-status").readProviderAccount({ config: c.config,
      access: { authorize: pin => { this.service.account.assertCreditAuthorization(c.auth, pin); return c.auth; } }, fetchImpl: this.service.fetchImpl, signal: AbortSignal.timeout(10000) });
    if (!Number.isSafeInteger(value.observedAt) || Math.abs(Date.now() - value.observedAt) > 30000 || !Array.isArray(value.payouts) || value.payouts.length > 4096) throw Error("Reward history observation is unavailable or stale");
    const payouts = value.payouts.filter(p => p.account === c.config.owner).slice(0, 64).map(p => {
      if (typeof p.epoch !== "string" || !/^(0|[1-9]\d{0,9})$/.test(p.epoch) || typeof p.state !== "string" || !/^[a-z_]{1,40}$/.test(p.state) ||
          [p.availability, p.work].some(n => typeof n !== "string" || !/^(0|[1-9]\d{0,19})$/.test(n))) throw Error("Reward history could not be verified");
      return { epoch: p.epoch, state: p.state, availability: p.availability, work: p.work };
    });
    return { observedAt: value.observedAt, lastCycleCheck: Number.isSafeInteger(value.lastCycleCheck) ? value.lastCycleCheck : null, payouts };
  }
  async tick() {
    if (this.busy || this.closed) return;
    try {
      const c = await this.service.context(AbortSignal.timeout(10000)); this.guard(c);
      if (this.context && (this.context.directory !== c.directory || this.context.auth.sessionToken !== c.auth.sessionToken)) await this.stop(false);
      if (!this.worker?.running && this.preference(c)) await this.start(AbortSignal.timeout(60000), true);
    } catch (e) { this.error = String(e.message); await this.stop(false); }
  }
  dispose() { this.closed = true; return this.stop(false); }
}
module.exports = { CreditProvider };
