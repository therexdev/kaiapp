"use strict";

/*
 * Runtime manager (spec §4/§6): owns which model is loaded on which runtime.
 * M1 scope: one active runtime + one loaded model at a time; the gateway
 * asks ensure(alias) before proxying. Switching models stops the current
 * runtime and starts the requested one.
 */

const {
  CONTEXT_PROTOCOL,
  OPT_IN_TIERS,
  LEGACY_CONTEXT_TOKENS,
  LEGACY_MAX_TOKENS,
  sanitizeContextSettings,
  validateModelContext,
} = require("./context-terms");

const LEGACY_CAP = Object.freeze({ contextTokens: LEGACY_CONTEXT_TOKENS, maxOutputTokens: LEGACY_MAX_TOKENS });

class RuntimeManager {
  constructor({ models, makeRuntime, hardware, provisioner, makeFallback, preferFallback, onEvent, state, contextSettings }) {
    this.models = models; // ModelManager
    this.makeRuntime = makeRuntime; // (binPath|null) => runtime adapter instance
    this.hardware = hardware; // detection snapshot (may be null in tests)
    this.provisioner = provisioner || null; // RuntimeProvisioner (null when a bin is forced)
    this.makeFallback = makeFallback || null; // async () => alt runtime (e.g. Ollama) or null
    this.preferFallback = !!preferFallback; // KAI_RUNTIME override: skip llama.cpp entirely
    this.onEvent = onEvent || (() => {});
    this.state = state || null; // JsonStore: remembers builds that crash on THIS machine
    this.appVersion = arguments[0]?.appVersion || null; // scopes that memory to one app version
    this.runtime = null;
    this.activeAlias = null;
    this._loading = null; // in-flight ensure() promise
    this._stopped = false; // stop() raced against an in-flight load
    this._testedBins = new Set(); // self-test once per binary per session
    this._failedTests = new Map(); // binPath -> error message: a crash is remembered, never re-run
    this._llamaDead = false; // full ladder failure this session: go straight to the fallback
    this._inflight = 0; // generations currently streaming from the active runtime
    this._drainWaiters = []; // switches parked until the count reaches zero
    this.drainMaxMs = 120000; // a switch never waits longer than this on a stream
    /*
     * Network context opt-in (docs/NETWORK_CONTEXT_PROTOCOL.md §4/§5). Absent
     * settings mean everything runs exactly as before: legacy launch, legacy
     * advertisement. A larger window is used only after the live engine
     * proved it; a start that fails is remembered for the session so a
     * broken tier can never become a reload loop.
     */
    this.contextSettings =
      contextSettings && typeof contextSettings.get === "function" && typeof contextSettings.set === "function" ? contextSettings : null;
    this._ctxFailed = new Set(); // "alias@N" whose opt-in start threw this session
    this._verified = new Map(); // alias -> tier N proved this session
    this._loadedCtx = null; // tier the active engine was launched with (null = legacy)
    this._activeVerified = false; // ...and whether that engine proved it
    this._ctxListeners = new Set();
    this.ctxExitWaitMs = 10000; // opt-in child must release device memory first
    this.ctxProbeBackoffMs = 250; // /props retry spacing (3 attempts)
  }

  /** Name the active runtime serves the model under (null = passthrough). */
  servedModelName() {
    return this.runtime?.servedName?.() ?? null;
  }

  /** True while anything is streaming from the engine or a model is
   *  mid-load. The load guard reads this for attribution: GPU activity
   *  during our own work is ours, and never a reason to back off. */
  busy() {
    return this._inflight > 0 || !!this._loading;
  }

  status() {
    return {
      activeAlias: this.activeAlias,
      loading: !!this._loading,
      runtime: this.runtime ? this.runtime.status() : null,
      // Why the last load failed (null after a success) — the UI shows
      // this instead of a bare "Model load failed" nobody can act on.
      lastLoadError: this.lastLoadError || null,
    };
  }

  /** Endpoint of the healthy runtime serving `alias`, starting it if needed. */
  /** Can ANY engine run on this machine? Called before big downloads so a
   *  platform with no managed build (today: Linux without Ollama) fails in
   *  plain language up front instead of after a gigabyte. A forced binary
   *  or a working fallback engine counts as viable. */
  async preflight() {
    if (!this.provisioner) return; // forced binary (KAI_LLAMA_BIN) — viable
    try {
      this.provisioner.selectBuild("llamacpp");
      return;
    } catch {
      /* no managed build — check the fallback before refusing */
    }
    if (this.makeFallback && (await Promise.resolve(this.makeFallback()).catch(() => null))) return;
    throw new Error(
      process.platform === "linux"
        ? "Koinos AI on Linux currently needs Ollama installed (free, from ollama.com) — install it and relaunch, and Koinos AI will use it as the engine."
        : "No AI engine build is available for this machine yet — check for an app update, or install Ollama (ollama.com) as a fallback engine."
    );
  }

  async ensure(alias) {
    this._stopped = false; // new demand revives the manager
    // §32: consult the catalog EVERY time — the already-running fast path
    // below must never keep serving a model that was quarantined after it
    // loaded. If this engine is the one running the revoked package, take
    // it down on the spot before refusing.
    try {
      this.models.resolveAlias(alias);
    } catch (e) {
      if (this.activeAlias === alias && this.runtime?.status().running) this.stop();
      throw e;
    }
    if (this._serving(alias)) {
      return this.runtime.endpoint;
    }
    // Single-flight: concurrent requests for the same alias share the load.
    // A different model mid-load (one runtime slot) is WAITED OUT rather
    // than refused — a boot warm-start racing the first chat message used
    // to throw here, which the §7 router would read as a real capability
    // miss and overflow a locally-servable request to the paid network.
    while (this._loading && this._loading.alias !== alias) {
      await this._loading.promise.catch(() => {});
    }
    if (this._loading) return this._loading.promise;
    if (this._serving(alias)) {
      return this.runtime.endpoint;
    }

    const promise = this._load(alias);
    this._loading = { alias, promise };
    try {
      return await promise;
    } finally {
      this._loading = null;
    }
  }

  /**
   * ensure() plus a hold on the runtime: while the hold is open, a model
   * switch WAITS instead of stopping the engine. Field report: answers cut
   * off mid-sentence while serving the network — a job for another class
   * called ensure(), which stopped the llama-server the previous answer was
   * still streaming from. Every serving path takes a hold now.
   */
  async acquireFor(alias) {
    for (;;) {
      const endpoint = await this.ensure(alias);
      // ensure() awaited — but a switch may have won the race in between.
      // The check-and-increment below is synchronous, so once it passes,
      // _load()'s drain sees this hold.
      if (this._serving(alias)) {
        this._inflight += 1;
        let done = false;
        return {
          endpoint,
          release: () => {
            if (done) return; // release() in a finally can run twice
            done = true;
            this._inflight -= 1;
            if (this._inflight <= 0) {
              this._inflight = 0;
              for (const w of this._drainWaiters.splice(0)) w();
            }
          },
        };
      }
    }
  }

  // Local evidence collection observes the existing process only. It must not
  // download, reload or switch models after a stale status observation.
  acquireCurrent(alias) {
    this.models.resolveAlias(alias);
    if (this._loading || this.activeAlias !== alias || !this.runtime?.status().running) throw new Error("The current model changed before the local check started");
    this._inflight += 1;
    let released = false;
    return { endpoint: this.runtime.endpoint, release: () => {
      if (released) return;
      released = true;
      this._inflight = Math.max(0, this._inflight - 1);
      if (!this._inflight) for (const waiter of this._drainWaiters.splice(0)) waiter();
    } };
  }

  /** Wait until nothing is streaming, or the cap runs out — a switch must
   *  never hang forever behind an abandoned connection. */
  async _drain() {
    if (this._inflight <= 0) return;
    this.onEvent({ type: "runtime:draining", inflight: this._inflight });
    await new Promise((resolve) => {
      // NOT unref'd: this bounded timer is the switch's only guaranteed
      // exit, so it must keep the event loop alive until it fires.
      const timer = setTimeout(resolve, this.drainMaxMs);
      this._drainWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ----- network context opt-in -----

  /** Validated `runtime.modelContext` map; {} when not configured. */
  contextPlan() {
    if (!this.contextSettings) return {};
    let raw = null;
    try {
      raw = this.contextSettings.get();
    } catch {
      raw = null;
    }
    return sanitizeContextSettings(this.models?.catalog, raw);
  }

  /** Tier `alias` should launch with, or null for legacy (also once its
   *  configured tier failed to start this session). */
  _desiredCtx(alias, plan = this.contextPlan()) {
    const e = Object.hasOwn(plan, alias) ? plan[alias] : null;
    if (!e || this._ctxFailed.has(`${alias}@${e.contextTokens}`)) return null;
    return e.contextTokens;
  }

  /** The one predicate ensure() and acquireFor() share: this alias is up
   *  AND was launched with the context it should have now. */
  _serving(alias) {
    return this.activeAlias === alias && !!this.runtime?.status().running && this._loadedCtx === this._desiredCtx(alias);
  }

  /** Public form of _serving for the worker: false means the next
   *  acquireFor(alias) loads or reloads the engine (incl. a same-alias
   *  reload at a different context), so a lease should get warming grace. */
  isServing(alias) {
    return this._serving(alias);
  }

  /** What the worker may advertise for `alias`: the configured terms when
   *  that tier was verified this session, else null (legacy 4096/512). */
  advertisedContext(alias) {
    const plan = this.contextPlan();
    const e = Object.hasOwn(plan, alias) ? plan[alias] : null;
    if (!e || this._ctxFailed.has(`${alias}@${e.contextTokens}`) || this._verified.get(alias) !== e.contextTokens) return null;
    return { contextTokens: e.contextTokens, maxOutputTokens: e.maxOutputTokens };
  }

  /** Pre-hold planning window for local requests: the tier a load would
   *  use, unless the engine already loaded at it failed verification. */
  plannedContext(alias) {
    const want = this._desiredCtx(alias);
    if (!want) return null;
    if (this.activeAlias === alias && this._loadedCtx === want && !this._activeVerified) return null;
    return want;
  }

  /**
   * Per-request verification (§5), called with a hold on `alias`: re-probe
   * the live engine and return {contextTokens, maxOutputTokens} it proves
   * now, or null. A failed probe marks the alias unverified (re-advertised
   * as legacy) — the caller refuses rather than truncating. READ-ONLY and
   * bounded: llama.cpp GET /props, Ollama GET /api/ps. It never warms up or
   * loads anything (the one warm-up belongs to the initial opt-in load), so
   * an Ollama runner that was unloaded fails closed with no implicit reload.
   */
  async verifiedContextFor(alias) {
    const rt = this.runtime;
    const tier = this._loadedCtx;
    if (this.activeAlias !== alias || !tier || !this._activeVerified || !rt?.status().running) return null;
    const ok = await this._probeTier(rt, tier, { warm: false });
    if (rt !== this.runtime || this.activeAlias !== alias || this._loadedCtx !== tier) return null;
    if (!ok) {
      this._activeVerified = false;
      this._setVerified(alias, null);
      this.onEvent({ type: "runtime:context", alias, contextTokens: tier, verified: false, reason: "live probe failed" });
      return null;
    }
    const e = this.contextPlan()[alias];
    return { contextTokens: tier, maxOutputTokens: e?.contextTokens === tier ? e.maxOutputTokens : LEGACY_MAX_TOKENS };
  }

  /** Subscribe to advertisement changes; returns the unsubscribe. */
  onContextChange(fn) {
    this._ctxListeners.add(fn);
    return () => this._ctxListeners.delete(fn);
  }

  _notifyContext() {
    for (const fn of [...this._ctxListeners]) {
      try {
        fn();
      } catch {
        /* a listener never breaks a load */
      }
    }
  }

  /** Record the verified tier (or null); listeners hear only real changes. */
  _setVerified(alias, tier) {
    const prev = this._verified.get(alias) ?? null;
    const next = tier || null;
    if (next) this._verified.set(alias, next);
    else this._verified.delete(alias);
    if (prev !== next) this._notifyContext();
  }

  /**
   * Does `rt` give ONE request at least `tier` tokens right now? llama.cpp:
   * GET /props, up to 3 attempts with a short backoff, n_ctx >= tier and a
   * single slot. Ollama: /api/ps, preceded by a bounded warm-up only when
   * `warm` (the initial opt-in load). Bounded; any doubt is false.
   */
  async _probeTier(rt, tier, { warm = false } = {}) {
    try {
      if (rt.status().kind === "ollama") {
        return typeof rt.verifyContext === "function" ? (await rt.verifyContext(tier, { warm })) === true : false;
      }
      if (typeof rt.probeContext !== "function") return false;
      for (let i = 0; i < 3; i++) {
        if (i) await new Promise((r) => setTimeout(r, this.ctxProbeBackoffMs * i));
        const p = await rt.probeContext().catch(() => null);
        if (p) return Number.isSafeInteger(p.nCtx) && p.nCtx >= tier && (p.totalSlots == null || p.totalSlots === 1);
      }
    } catch {
      /* fall through: unverified */
    }
    return false;
  }

  /** GET /core/runtime/context: per-alias opt-in, verification, advertised. */
  contextStatus() {
    const plan = this.contextPlan();
    const catalog = this.models?.catalog || {};
    const packages = catalog.packages || {};
    const models = [];
    for (const [alias, a] of Object.entries(catalog.aliases || {})) {
      if (a?.dev || alias.startsWith("dev-")) continue;
      const pkg = Object.hasOwn(packages, a?.package) ? packages[a.package] : null;
      const max = Number.isSafeInteger(pkg?.maxContextTokens) ? pkg.maxContextTokens : LEGACY_CONTEXT_TOKENS;
      const e = Object.hasOwn(plan, alias) ? plan[alias] : null;
      const adv = this.advertisedContext(alias);
      models.push({
        alias,
        maxContextTokens: max,
        tiers: OPT_IN_TIERS.filter((t) => t <= max),
        contextTokens: e ? e.contextTokens : LEGACY_CONTEXT_TOKENS,
        maxOutputTokens: e ? e.maxOutputTokens : LEGACY_MAX_TOKENS,
        // --parallel 1: an opted-in alias serves one request at a time.
        ...(e ? { parallel: 1 } : {}),
        failed: !!e && this._ctxFailed.has(`${alias}@${e.contextTokens}`),
        verified: !!adv,
        advertised: adv || { ...LEGACY_CAP },
      });
    }
    return {
      protocol: CONTEXT_PROTOCOL,
      configurable: !!this.contextSettings,
      models,
      active: this.activeAlias
        ? { alias: this.activeAlias, contextTokens: this._loadedCtx || LEGACY_CONTEXT_TOKENS, verified: !!this._loadedCtx && this._activeVerified }
        : null,
    };
  }

  /**
   * POST /core/runtime/context: set or clear one alias's opt-in. Validates
   * against the catalog, persists, and clears the alias's session-failed
   * and verified markers. Never loads a model: a running engine already at
   * the new tier is re-read in place (no warm-up); anything else changes on
   * the next real demand through the ordinary drain/hold path.
   */
  async configureContext(body) {
    if (!this.contextSettings) throw new Error("Model context settings are not available in this Core");
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const alias = String(b.alias ?? "");
    const catalog = this.models?.catalog;
    let entry = null;
    if (b.contextTokens == null || b.contextTokens === LEGACY_CONTEXT_TOKENS) {
      if (!alias || !Object.hasOwn(catalog?.aliases || {}, alias)) throw new Error(`Unknown model "${alias}"`);
    } else {
      entry = validateModelContext(catalog, alias, { contextTokens: b.contextTokens, maxOutputTokens: b.maxOutputTokens });
    }
    const next = { ...this.contextPlan() };
    if (entry) next[alias] = entry;
    else delete next[alias];
    this.contextSettings.set(next);
    for (const k of [...this._ctxFailed]) if (k.startsWith(`${alias}@`)) this._ctxFailed.delete(k);
    this._verified.delete(alias);
    const rt = this.runtime;
    if (entry && this.activeAlias === alias && this._loadedCtx === entry.contextTokens && rt?.status().running) {
      const ok = await this._probeTier(rt, entry.contextTokens, { warm: false });
      if (rt === this.runtime && this.activeAlias === alias && this._loadedCtx === entry.contextTokens) {
        this._activeVerified = ok;
        if (ok) this._verified.set(alias, entry.contextTokens);
        this.onEvent({ type: "runtime:context", alias, contextTokens: entry.contextTokens, verified: ok });
      }
    }
    this.onEvent({
      type: "runtime:context-configured",
      alias,
      contextTokens: entry ? entry.contextTokens : LEGACY_CONTEXT_TOKENS,
      maxOutputTokens: entry ? entry.maxOutputTokens : LEGACY_MAX_TOKENS,
    });
    this._notifyContext();
    return this.contextStatus();
  }

  async _load(alias) {
    const resolved = this.models.resolveAlias(alias);
    const modelPath = await this.models.ensurePackage(resolved.packageId);
    const kind = resolved.runtime || "llamacpp";
    const wantGpu = !!this.hardware?.capabilities?.cudaEligible;
    // The tier this load tries first (null = legacy), and what it achieved.
    let wantCtx = this._desiredCtx(alias);
    let ctxOutcome = { ctx: null, verified: false };
    const markCtxFailed = (n) => {
      this._ctxFailed.add(`${alias}@${n}`);
      this._setVerified(alias, null);
      wantCtx = null; // every later attempt in this load is plain legacy
    };
    const emitCtxFallback = (n, e, via) =>
      this.onEvent({ type: "runtime:context-fallback", alias, contextTokens: n, via, reason: String(e?.message || e).slice(0, 300) });
    // Ollama registration: legacy name and bodies exactly as before; an
    // opt-in gets its own model name with num_ctx pinned, verified via the
    // loaded runner. A create that throws falls back to legacy once.
    const startOllama = async (rt) => {
      const legacyName = `koinos-${alias}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
      if (wantCtx) {
        const n = wantCtx;
        try {
          await rt.start({ modelPath, sha256: resolved.sha256, modelName: `${legacyName}-ctx${n}`, contextTokens: n });
          ctxOutcome = { ctx: n, verified: await this._probeTier(rt, n, { warm: true }) };
          return;
        } catch (e) {
          if (this._stopped) throw e;
          markCtxFailed(n);
          emitCtxFallback(n, e, "ollama");
        }
      }
      await rt.start({ modelPath, sha256: resolved.sha256, modelName: legacyName });
      ctxOutcome = { ctx: null, verified: false };
    };

    // Fast switch on a llama-dead machine: the fallback daemon hosts every
    // model — register the next one with it and serve. Without this, EVERY
    // model switch re-ran the full crash-test ladder (field log: switches
    // every few seconds, each one a blocking multi-second freeze that
    // starved the worker's own presence signals while jobs kept serving).
    if (this._llamaDead && this.runtime?.status().kind === "ollama" && this.runtime.status().running) {
      const rt = this.runtime;
      try {
        this.onEvent({ type: "runtime:fast-switch", from: this.activeAlias, to: alias, via: "ollama" });
        await startOllama(rt);
        if (this._stopped) {
          this.stop();
          throw new Error("Core is stopping");
        }
        this.activeAlias = alias;
        this.lastLoadError = null;
        this._adoptCtx(alias, ctxOutcome);
        return rt.endpoint;
      } catch (e) {
        if (this._stopped) throw e;
        // The daemon died under us: fall through to the full path, which
        // rebuilds the fallback from scratch. That path is instant now —
        // every crashing binary is cached, nothing re-tests.
        this.onEvent({ type: "runtime:fast-switch-failed", reason: String(e.message) });
      }
    }

    if (this.runtime) {
      // Let whatever is still streaming from this engine finish first —
      // stopping it here is what cut answers off mid-sentence.
      await this._drain();
      this.onEvent({ type: "runtime:switching", from: this.activeAlias, to: alias });
      this.runtime.stop();
      this.runtime = null;
      this.activeAlias = null;
      this._loadedCtx = null;
      this._activeVerified = false;
    }

    // Escalation ladder (§5: never strand the user): CUDA/Vulkan/Metal when
    // eligible -> CPU build -> external fallback runtime (Ollama) when one
    // is present. Every provisioned binary passes a self-test before boot,
    // so a build this machine can't run fails fast and quietly moves on.
    const { selfTest, stripCpuVariants, dirSnapshot } = require("./runtimes/llamacpp");
    // Self-test with an escalating heal ladder: the plain test (which
    // internally heals a stale CRT), then a fresh re-extract of the build
    // (corrupted extraction), then stripping exotic ggml-cpu variant DLLs
    // (dispatch crashes on very new CPUs). Whatever still fails reports
    // with a directory snapshot — remote debugging needs to see the disk.
    this._healed = this._healed || new Set();
    const testHard = async (binPath, cap) => {
      // A binary that crashed its self-test crashes it again 10 seconds
      // later — the test can burn 15s per attempt, and field log showed it
      // re-running on EVERY model switch, several times a minute. Cache the
      // verdict; the test itself is async so even a slow probe no longer
      // starves polls, heartbeats, or timers.
      if (this._failedTests.has(binPath)) {
        throw new Error(`${this._failedTests.get(binPath)} (cached — not re-tested this session)`);
      }
      try {
        try {
          return await selfTest(binPath);
        } catch (e1) {
          if (typeof this.provisioner?.reprovision !== "function" || this._healed.has(binPath)) {
            throw new Error(`${e1.message} [beside: ${dirSnapshot(binPath)}]`);
          }
          this._healed.add(binPath);
          this.onEvent({ type: "runtime:heal", step: "reprovision", binPath, reason: String(e1.message) });
          await this.provisioner.reprovision(kind, { cap });
          try {
            return await selfTest(binPath);
          } catch (e2) {
            if (stripCpuVariants(binPath)) {
              this.onEvent({ type: "runtime:heal", step: "strip-cpu-variants", binPath });
              try {
                return await selfTest(binPath);
              } catch (e3) {
                throw new Error(`${e3.message} [after reprovision + variant strip; beside: ${dirSnapshot(binPath)}]`);
              }
            }
            throw new Error(`${e2.message} [after reprovision; beside: ${dirSnapshot(binPath)}]`);
          }
        }
      } catch (terminal) {
        this._failedTests.set(binPath, String(terminal.message).slice(0, 600));
        throw terminal;
      }
    };
    // Vision packages ship a projector file; llama-server takes it as
    // --mmproj and then accepts OpenAI-style image_url content parts.
    // Projector trouble (unpinned, download failed) must never take TEXT
    // serving down with it — degrade to text-only and say so.
    let mmprojPath = null;
    if (resolved.vision && resolved.mmproj) {
      try {
        mmprojPath = await this.models.ensureMmproj(resolved.packageId);
      } catch (e) {
        this.onEvent?.({ type: "runtime:vision-degraded", alias, message: String(e.message).slice(0, 200) });
      }
    }
    const boot = async (binPath, gpuLayers, cap) => {
      if (binPath && !this._testedBins.has(binPath)) {
        await testHard(binPath, cap);
        this._testedBins.add(binPath);
      }
      const legacyOpts = {
        modelPath,
        contextSize: resolved.contextSize || 4096,
        gpuLayers,
        sizeBytes: resolved.sizeBytes || 0,
        extraArgs: mmprojPath ? ["--mmproj", mmprojPath] : [],
      };
      if (wantCtx) {
        // Opt-in: same rung, same binary, one slot so the whole window
        // belongs to one request; then prove it from /props.
        const n = wantCtx;
        const optIn = this.makeRuntime(binPath);
        try {
          await optIn.start({ ...legacyOpts, contextSize: n, parallel: 1 });
          ctxOutcome = { ctx: n, verified: await this._probeTier(optIn, n) };
          return optIn;
        } catch (e) {
          // Never a verdict on the build: the opt-in asked for more memory
          // than a legacy launch. Wait for the child to let go of device
          // memory, then retry once at legacy on this same rung.
          try {
            optIn.stop();
          } catch {
            /* already gone */
          }
          markCtxFailed(n);
          if (typeof optIn.waitForExit === "function") await optIn.waitForExit(this.ctxExitWaitMs);
          emitCtxFallback(n, e, "llamacpp");
          const legacy = this.makeRuntime(binPath);
          try {
            await legacy.start(legacyOpts);
          } catch (e2) {
            // Memory may still be settling after the opt-in: this failure
            // falls through the ladder but records nothing about the build.
            e2.afterOptIn = true;
            throw e2;
          }
          ctxOutcome = { ctx: null, verified: false };
          return legacy;
        }
      }
      const runtime = this.makeRuntime(binPath);
      await runtime.start(legacyOpts);
      ctxOutcome = { ctx: null, verified: false };
      return runtime;
    };

    const bootLlama = async () => {
      if (!this.provisioner) return boot(null, wantGpu ? 999 : 0);
      // Engine ladder by capability: CUDA (NVIDIA), Vulkan (supported Linux/
      // Windows GPUs), Metal (macOS), then CPU. Each rung self-tests first.
      const caps = [];
      if (wantGpu) caps.push("cuda");
      if (this.hardware?.capabilities?.vulkanEligible) caps.push("vulkan");
      if (this.hardware?.capabilities?.metalEligible) caps.push("metal");
      caps.push("cpu");
      const rungErrors = [];
      let classify = ""; // rung errors allowed to classify this machine
      const badBuilds = this.state?.get("badBuilds", {}) || {};
      for (let i = 0; i < caps.length; i++) {
        const cap = caps[i];
        try {
          const binPath = await this.provisioner.ensure(kind, { cap });
          // A build that crashed its self-test on this machine stays
          // skipped for the rest of THIS app version — each app update
          // retries once, because updates ship loader fixes (the v0.22.1
          // CRT heal) that can revive a build without changing its bits.
          const bad = badBuilds[binPath];
          const badReason = typeof bad === "string" ? bad : bad?.reason; // pre-0.22.1 entries were plain strings
          const badVersion = typeof bad === "string" ? null : bad?.appVersion;
          if (badReason && badVersion === (this.appVersion || null)) {
            const skipped = `[${cap}] skipped — crashed on this machine before (${badReason})`;
            rungErrors.push(skipped);
            // A remembered self-test crash classifies this machine exactly as
            // it did before the opt-in work (an afterOptIn failure never
            // writes badBuilds, so this cannot be one).
            classify += ` ${skipped}`;
            continue;
          }
          return await boot(binPath, cap === "cpu" ? 0 : 999, cap);
        } catch (e) {
          rungErrors.push(`[${cap}] ${String(e.message)}`);
          if (!e.afterOptIn) classify += ` ${String(e.message)}`;
          // Two machine-stable signatures are worth remembering: a crashed
          // self-test, and a HARD crash at real startup (Windows access
          // violations arrive as 32212xxxxx exit codes; POSIX as SIGSEGV/
          // SIGILL). Field log: the Vulkan build passed its self-test and
          // then died with 0xC0000005 on EVERY model switch, riding the
          // crash-then-fallback ladder several times a minute. A plain
          // "exited during startup" without those codes stays retryable —
          // port conflicts and OOM are transient.
          const hardCrash = /exit code 32212\d+|SIGSEGV|SIGILL/i.test(String(e.message));
          if (!e.afterOptIn && this.state && (hardCrash || /self-test failed/i.test(String(e.message))) && cap !== "cpu") {
            const bad = this.state.get("badBuilds", {});
            try {
              bad[await this.provisioner.ensure(kind, { cap })] = {
                reason: String(e.message).slice(0, 160),
                appVersion: this.appVersion || null,
              };
              this.state.set("badBuilds", bad);
            } catch { /* provisioning itself failed — nothing to remember */ }
          }
          if (i < caps.length - 1) {
            this.onEvent({ type: "runtime:fallback", from: cap, to: caps[i + 1], reason: String(e.message) });
          }
        }
      }
      // Every rung's reason survives — reporting only the last one hid
      // the GPU failure that started the slide (field finding).
      const err = new Error(rungErrors.join(" · "));
      err.classify = classify;
      throw err;
    };

    const bootFallback = async (why) => {
      const fb = this.makeFallback ? await this.makeFallback() : null;
      if (!fb) return null;
      if (why) this.onEvent({ type: "runtime:fallback", from: "llamacpp", to: fb.status().kind, reason: why });
      await startOllama(fb);
      return fb;
    };

    let runtime;
    try {
      if (this.preferFallback) {
        runtime = await bootFallback(null);
        if (!runtime) throw new Error("KAI_RUNTIME requested the fallback runtime, but none is available");
      } else {
        try {
          runtime = await bootLlama();
        } catch (e) {
          // A machine-incompatibility signature (crashing self-tests) is a
          // session-stable fact: stop paying the ladder on every switch and
          // go straight to the fallback from here on. Transient failures
          // (a download blip) don't set it — the ladder retries next load.
          // A failure right after a context opt-in classifies nothing.
          if (!e.afterOptIn && /self-test failed/i.test(String(e.classify ?? e.message))) this._llamaDead = true;
          runtime = await bootFallback(String(e.message));
          if (!runtime) throw e;
        }
      }
      this.lastLoadError = null;
    } catch (e) {
      this.lastLoadError = { alias, message: String(e.message), at: new Date().toISOString() };
      throw e;
    }

    this.runtime = runtime;
    this.activeAlias = alias;
    this._adoptCtx(alias, ctxOutcome);
    // stop() may have run while this load was in flight (quick app quit
    // during the warm start): the child it never saw must not outlive us.
    if (this._stopped) {
      this.stop();
      throw new Error("Core is stopping");
    }
    return runtime.endpoint;
  }

  /** Record what the engine just loaded for `alias` proved (§5). */
  _adoptCtx(alias, outcome) {
    this._loadedCtx = outcome.ctx || null;
    this._activeVerified = !!(outcome.ctx && outcome.verified);
    if (!outcome.ctx) return;
    this._setVerified(alias, this._activeVerified ? outcome.ctx : null);
    this.onEvent({ type: "runtime:context", alias, contextTokens: outcome.ctx, verified: this._activeVerified });
  }

  stop() {
    this._stopped = true;
    if (this.runtime) this.runtime.stop();
    this.runtime = null;
    this.activeAlias = null;
    this._loadedCtx = null;
    this._activeVerified = false;
  }
}

module.exports = { RuntimeManager };
