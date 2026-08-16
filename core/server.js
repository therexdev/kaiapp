"use strict";

/*
 * Koinos AI Core (spec §4) — the persistent service everything else talks to.
 * The desktop UI is a client; the headless Koinos AI Server (§9) reuses this
 * entrypoint unchanged. M1 modules: hardware detection, model manager,
 * llama.cpp runtime manager, local OpenAI-compatible gateway.
 *
 * Environment:
 *   KAI_CORE_DATA   data directory   (default ~/.koinos-ai)
 *   KAI_CORE_PORT   gateway port     (default 41100, always 127.0.0.1)
 *   KAI_LLAMA_BIN   path to llama-server (default <data>/runtimes/llamacpp/llama-server)
 */

const os = require("os");
const path = require("path");

const { JsonStore } = require("./lib/store");
const hardware = require("./lib/hardware");
const { ApiKeys } = require("./lib/keys");
const { ModelManager } = require("./lib/model-manager");
const { RuntimeProvisioner } = require("./lib/runtime-provisioner");
const { LlamaCppRuntime } = require("./lib/runtimes/llamacpp");
const { RuntimeManager } = require("./lib/runtime-manager");
const { Gateway } = require("./lib/gateway");

const VERSION = require("./package.json").version;
// The project-operated scheduler (§12): baked in so Start Earning and
// network mode work out of the box. KAI_SCHEDULER_URL overrides for
// self-hosters; the Earn tab field overrides per machine.
const DEFAULT_SCHEDULER_URL = process.env.KAI_SCHEDULER_URL || "https://koinosai.com/scheduler";

async function createCore({ dataDir, port, llamaBin, sessionSecret, onEvent } = {}) {
  dataDir = dataDir || process.env.KAI_CORE_DATA || path.join(os.homedir(), ".koinos-ai");
  // Every event also lands in <dataDir>/core.log so packaged-app failures
  // in the field are diagnosable ("Model load failed" has a paper trail).
  const fsl = require("fs");
  fsl.mkdirSync(dataDir, { recursive: true });
  const logFile = path.join(dataDir, "core.log");
  const sink = onEvent || ((e) => console.log(`[core] ${e.type}`, e.message ?? ""));
  const events = (e) => {
    try {
      const detail = e.message ?? e.reason ?? e.error ?? e.endpoint ?? e.code ?? e.pct ?? "";
      fsl.appendFileSync(logFile, `${new Date().toISOString()} ${e.type} ${detail}\n`);
    } catch {
      /* logging must never break the app */
    }
    sink(e);
  };

  const settings = new JsonStore(path.join(dataDir, "settings.json"), {});
  const state = new JsonStore(path.join(dataDir, "state.json"), {});
  const hw = await hardware.detect({ dataDir });

  const keys = new ApiKeys(settings);
  const models = new ModelManager({
    catalogPath: path.join(__dirname, "models", "catalog.json"),
    modelsDir: path.join(dataDir, "models"),
    state,
    onEvent: events,
  });

  // KAI_LLAMA_BIN (or the llamaBin option) forces a specific binary and skips
  // provisioning; otherwise the right build is fetched on first need.
  const forcedBin = llamaBin || process.env.KAI_LLAMA_BIN || null;
  const provisioner = forcedBin
    ? null
    : new RuntimeProvisioner({
        catalogPath: path.join(__dirname, "runtimes", "catalog.json"),
        runtimesDir: path.join(dataDir, "runtimes"),
        hardware: hw,
        onEvent: events,
      });

  const { OllamaRuntime } = require("./lib/runtimes/ollama");
  const ollamaAddr = {
    host: process.env.KAI_OLLAMA_HOST || "127.0.0.1",
    port: Number(process.env.KAI_OLLAMA_PORT || 11434),
  };
  const runtime = new RuntimeManager({
    models,
    hardware: hw,
    provisioner,
    state,
    appVersion: VERSION,
    onEvent: events,
    makeRuntime: (binPath) => new LlamaCppRuntime({ binPath: binPath || forcedBin, onEvent: events }),
    // Ollama is the deep-fallback engine (§6): a system install if present,
    // otherwise Core provisions its own portable build (hash-pinned like
    // every engine) — used when the managed llama.cpp build can't run here,
    // or forced via KAI_RUNTIME. Nobody is ever sent to a website.
    makeFallback: async () =>
      (await OllamaRuntime.ensureRunning({
        ...ollamaAddr,
        onEvent: events,
        provision: () => provisioner.ensure("ollama", { cap: "cpu" }),
        modelsDir: path.join(dataDir, "ollama-models"),
      }))
        ? new OllamaRuntime({ ...ollamaAddr, onEvent: events })
        : null,
    preferFallback: process.env.KAI_RUNTIME === "ollama",
  });

  // Earn controller (M2 §5.7): wallet + worker behind the control plane.
  // Wallet keys stay in Core (§8); the worker only starts on explicit opt-in
  // and stops immediately on request (§10).
  const { WalletService } = require("./lib/wallet");
  const { Worker } = require("./lib/worker");
  const wallet = new WalletService(path.join(dataDir, "wallet"));
  let worker = null;
  // Machine session (§8-compatible): the Electron shell passes a secret held
  // by the OS (safeStorage/DPAPI); with it, an unlocked wallet survives app
  // restarts — no password re-typing — until the user presses Lock.
  sessionSecret = sessionSecret || process.env.KAI_SESSION_SECRET || null;
  if (sessionSecret && wallet.exists() && wallet.tryResumeSession(sessionSecret)) {
    events({ type: "wallet:session-resumed", message: wallet.address });
  }
  // On-chain KAI balance + open-epoch receipts, via the scheduler's /balance.
  // Cached 30s; only fetched while something asks (the Earn tab polls status).
  let earningsCache = { at: 0, data: null };
  const fetchEarnings = async () => {
    const url = settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL);
    const address = wallet.address;
    if (!url || !address) return null;
    if (Date.now() - earningsCache.at < 30000) return earningsCache.data;
    let data = null;
    try {
      const r = await fetch(`${url.replace(/\/$/, "")}/balance?address=${encodeURIComponent(address)}`, {
        signal: AbortSignal.timeout(4000),
      });
      const j = await r.json();
      if (j.ok) {
        data = {
          kai: j.kai,
          pendingReceipts: j.pendingReceipts ?? 0,
          tokensProcessed: j.tokensProcessed ?? null,
          pendingKai: j.pendingKai ?? null,
          usage: j.usage ?? null, // { inputTokens, outputTokens, costUsd }
          freeTokensRemaining: j.freeTokensRemaining ?? null,
          balanceUsd: j.balanceUsd ?? null,
          spentThisEpochKai: j.spentThisEpochKai ?? null,
        };
      }
    } catch {
      // Scheduler unreachable or chain read down: say so instead of
      // degrading to unexplained dashes — silence reads as "earnings gone".
      data = { error: "Balance temporarily unavailable — retrying" };
    }
    if (data === null) data = { error: "Balance temporarily unavailable — retrying" };
    // Successes cache for the full 30s; a failed read retries in ~3s so one
    // slow moment doesn't blank the balance row for half a minute.
    earningsCache = { at: !data.error ? Date.now() : Date.now() - 27000, data };
    return data;
  };
  const earn = {
    status: async () => ({
      wallet: wallet.status(),
      worker: worker ? worker.status() : { running: false, jobsDone: 0, receiptsAccepted: 0 },
      schedulerUrl: settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL),
      earnings: await fetchEarnings(),
    }),
    configure: ({ schedulerUrl }) => {
      let u = String(schedulerUrl || "").trim();
      if (u) {
        // A pasted bare host is the common case — repair it rather than
        // letting the worker's fetch throw a cryptic parse error later.
        if (!/^https?:\/\//i.test(u)) u = "https://" + u;
        try {
          new URL(u);
        } catch {
          throw new Error(`That doesn't look like a scheduler URL: "${schedulerUrl}"`);
        }
      } else {
        // Clearing the field means "back to the network default", not
        // "no scheduler" — a stored empty string would shadow the default.
        u = DEFAULT_SCHEDULER_URL;
      }
      settings.set("earn.schedulerUrl", u);
      earningsCache = { at: 0, data: null };
      syncKillSwitch().catch(() => {}); // §32: check the new scheduler's list promptly
      return earn.status();
    },
    createWallet: ({ password }) => {
      const r = wallet.create({ password });
      if (sessionSecret) wallet.saveSession(sessionSecret);
      events({ type: "wallet:created", message: r.address });
      return r;
    },
    restoreWallet: ({ wif, password }) => {
      const r = wallet.restore({ wif, password });
      if (sessionSecret) wallet.saveSession(sessionSecret);
      events({ type: "wallet:restored", message: r.address });
      return r;
    },
    revealWallet: ({ password }) => {
      const r = wallet.revealWif(password);
      events({ type: "wallet:backup-revealed", message: r.address });
      return r;
    },
    unlock: ({ password }) => {
      // Every attempt lands in core.log — locked-out users need a paper trail.
      try {
        const r = wallet.unlock(password);
        if (sessionSecret) wallet.saveSession(sessionSecret);
        events({ type: "wallet:unlocked", message: r.address });
        return r;
      } catch (e) {
        events({ type: "wallet:unlock-failed", message: String(e.message) });
        throw e;
      }
    },
    lock: async () => {
      if (worker) await worker.stop();
      wallet.lock(); // also ends the machine session
      settings.set("earn.autoStart", false);
      events({ type: "wallet:locked" });
      return earn.status();
    },
    // §21/§23: deposit KAI for network credits. The scheduler prepares the tx
    // (operator pays MANA), the wallet signs it HERE — the key never leaves —
    // and the signed tx goes back for the operator's co-signature.
    deposit: async ({ amountKai }) => {
      const url = settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL);
      if (!url) throw new Error("Set the scheduler URL first");
      const s = wallet.status();
      if (!s.unlocked) throw new Error("Unlock your earning account first");
      const amt = Number(amountKai);
      if (!(amt > 0)) throw new Error("Enter a positive KAI amount");
      const base = url.replace(/\/$/, "");
      const post = async (p, body) =>
        (await fetch(`${base}${p}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        })).json();
      const prep = await post("/deposit/prepare", { address: s.address, amountKai: amt });
      if (!prep.ok) throw new Error(prep.error || "Deposits are not available on this scheduler yet");
      const signed = await wallet.signer.signTransaction(prep.transaction);
      const sub = await post("/deposit/submit", { address: s.address, transaction: signed });
      if (!sub.ok) throw new Error(sub.error || "Deposit failed");
      earningsCache = { at: 0, data: null }; // pick up new credits promptly
      events({ type: "wallet:deposited", message: `${amt} KAI tx ${sub.txId}` });
      return { txId: sub.txId, amountKai: amt };
    },
    start: async () => {
      const s = wallet.status();
      if (!s.exists) throw new Error("Create a wallet first");
      if (!s.unlocked) throw new Error("Unlock the wallet first");
      const url = settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL);
      if (!url) throw new Error("Set the scheduler URL first");
      if (worker?.running) return worker.status();
      worker = new Worker({ schedulerUrl: url, wallet, runtime, hardware: hw, models, onEvent: events });
      const st = await worker.start();
      settings.set("earn.autoStart", true);
      return st;
    },
    nudge: async () => (worker ? worker.nudge() : { running: false }),
    // userIntent distinguishes the Stop button from process shutdown: only
    // the user's own Stop turns auto-resume off — a quit or update keeps
    // their "earning on" choice for the next launch.
    stop: async ({ userIntent = true } = {}) => {
      if (worker) await worker.stop();
      if (userIntent) settings.set("earn.autoStart", false);
      return earn.status();
    },
  };

  // §7 routing policy (M3): privacy mode gates all network consumption.
  // local-only is the default — nothing leaves the machine unless chosen.
  // §32 kill switch: poll the scheduler's revocation list. Earning or not,
  // compromised weights must stop serving — chat included. When the ACTIVE
  // model is hit, the engine stops immediately and §7 routing turns the
  // next request into a capability miss, so Local-First machines fail over
  // to the network instead of going dark. Quarantine persists locally;
  // recovery ships as a catalog update with a clean package, never by
  // un-forgetting.
  const syncKillSwitch = async () => {
    // §29 strict: a Local-Only machine emits NOTHING — not even safety
    // polls. Its kill-switch coverage rides app/catalog updates instead;
    // the moment the mode allows network participation, the live list is
    // fetched (network.configure triggers a sync on that transition).
    // EXCEPTION: an actively earning worker is already talking to the
    // scheduler — it must not escape the kill switch on a privacy label.
    const earning = worker && worker.status().running;
    if (!earning && settings.get("network.privacyMode", "local-only") === "local-only") return;
    const base = settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL);
    if (!base) return;
    let revoked;
    try {
      const r = await fetch(`${base.replace(/\/$/, "")}/policy`, { signal: AbortSignal.timeout(8000) });
      revoked = (await r.json())?.revoked;
    } catch {
      return; // unreachable — next tick retries
    }
    if (!Array.isArray(revoked)) return;
    for (const entry of revoked) {
      const hit = models.quarantineBySha(entry.sha256, entry.reason);
      if (!hit.length) continue;
      events({ type: "core:kill-switch", packages: hit, reason: entry.reason });
      const activePkg = runtime.activeAlias ? models.catalog.aliases[runtime.activeAlias]?.package : null;
      if (activePkg && hit.includes(activePkg)) {
        if (worker && worker.status().running) {
          await earn.stop({ userIntent: false }).catch(() => {});
        }
        runtime.stop();
        events({ type: "core:kill-switch-stopped-engine", package: activePkg });
      }
    }
  };

  const network = {
    status: () => ({
      privacyMode: settings.get("network.privacyMode", "local-only"),
      schedulerUrl: settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL),
      walletUnlocked: wallet.status().unlocked,
    }),
    // §23: network requests are signed by the earning account — identity and
    // metering in one. Null when there's no unlocked wallet to sign with.
    signConsume: async (messages) => {
      const s = wallet.status();
      if (!s.unlocked || !s.address) return null;
      const ts = Date.now();
      const cryptoNode = require("crypto");
      const hash = cryptoNode
        .createHash("sha256")
        .update(`consume|${s.address}|${ts}|${JSON.stringify(messages)}`)
        .digest();
      return { address: s.address, ts, signature: await wallet.signHash(hash) };
    },
    configure: ({ privacyMode }) => {
      const m = String(privacyMode || "");
      if (!["local-only", "local-first", "network"].includes(m)) {
        throw new Error("privacyMode must be local-only, local-first, or network");
      }
      settings.set("network.privacyMode", m);
      // §32: the moment network participation is allowed, fetch the
      // safety list — don't wait out the poll interval.
      if (m !== "local-only") syncKillSwitch().catch(() => {});
      return network.status();
    },
  };

  // The desktop UI is plain web content served by the gateway itself — the
  // Electron shell just opens a window onto it, and a browser works too.
  const uiDir = path.join(__dirname, "..", "ui");
  const { ChatStore } = require("./lib/chats");
  const gateway = new Gateway({
    port: port ?? Number(process.env.KAI_CORE_PORT || 41100),
    runtime,
    models,
    keys,
    onEvent: events,
    uiDir: require("fs").existsSync(uiDir) ? uiDir : null,
    earn,
    network,
    chats: new ChatStore(path.join(dataDir, "chats")),
    docs: new (require("./lib/docs").DocStore)(path.join(dataDir, "docs")),
    coreInfo: () => ({ version: VERSION, dataDir, hardware: hw }),
    // Feedback relay: one honest box in the app, straight to the project's
    // inbox. The diagnostic tail is core.log — events only, no chat
    // content and no keys ever land there.
    feedback: async ({ message, email, includeLog }) => {
      const text = String(message || "").trim().slice(0, 4000);
      if (!text) throw new Error("Feedback needs a message");
      let logTail = null;
      if (includeLog) {
        try {
          const raw = fsl.readFileSync(logFile, "utf8");
          logTail = raw.split("\n").slice(-120).join("\n").slice(-16000);
        } catch { /* no log yet */ }
      }
      const target = process.env.KAI_FEEDBACK_URL || "https://koinosai.com/api/feedback";
      const r = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: text,
          email: email ? String(email).slice(0, 200) : null,
          appVersion: VERSION,
          platform: `${process.platform}-${process.arch}`,
          logTail,
        }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => {
        throw new Error("Could not reach the feedback server — check your connection and try again");
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || `Feedback server answered ${r.status}`);
      events({ type: "feedback:sent" });
      return {};
    },
  });

  return {
    settings,
    state,
    hardware: hw,
    keys,
    models,
    runtime,
    gateway,
    async start() {
      const p = await gateway.listen();
      events({ type: "core:ready", message: `gateway on http://127.0.0.1:${p}` });
      // Scheduled tasks call chat through our own front door, so §7
      // privacy routing, budgets, and the kill switch govern them exactly
      // like a typed message.
      const { TaskRunner } = require("./lib/tasks");
      this.tasks = new TaskRunner({
        file: path.join(dataDir, "tasks.json"),
        chats: gateway.chats,
        onEvent: events,
        runChat: async ({ model, prompt }) => {
          const r = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
          });
          const j = await r.json();
          if (!r.ok) throw new Error(j?.error?.message || `chat failed (${r.status})`);
          return j.choices?.[0]?.message?.content ?? "";
        },
      });
      gateway.tasks = this.tasks;
      this.tasks.start();
      // Warm start (fire-and-forget): if the model is already on disk, bring
      // the whole engine ladder up now so the first message answers instantly
      // instead of paying engine startup at send time.
      const ready = models.aliases().filter((a) => a.status === "ready");
      if (ready.length === 1) {
        runtime.ensure(ready[0].alias).catch((e) => events({ type: "runtime:warmstart-failed", message: String(e.message) }));
      }
      // Earning resumes by itself after a restart when the machine session
      // unlocked the wallet and the user had left earning on (§10: their
      // last explicit choice keeps ruling; Stop or Lock clears it).
      if (wallet.status().unlocked && settings.get("earn.autoStart", false)) {
        earn.start().then(
          () => events({ type: "earn:auto-resumed" }),
          (e) => events({ type: "earn:auto-resume-failed", message: String(e.message) })
        );
      }
      syncKillSwitch().catch(() => {});
      this._policyTimer = setInterval(() => syncKillSwitch().catch(() => {}), 5 * 60 * 1000);
      this._policyTimer.unref?.();
      return p;
    },
    async stop() {
      if (this._policyTimer) clearInterval(this._policyTimer);
      this.tasks?.stop();
      await earn.stop({ userIntent: false }).catch(() => {});
      runtime.stop();
      await gateway.close();
    },
  };
}

module.exports = { createCore, VERSION };

if (require.main === module) {
  createCore()
    .then(async (core) => {
      const stop = async () => {
        await core.stop();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await core.start();
    })
    .catch((e) => {
      console.error("core failed to start:", e);
      process.exit(1);
    });
}
