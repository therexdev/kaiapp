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
    onEvent: events,
    makeRuntime: (binPath) => new LlamaCppRuntime({ binPath: binPath || forcedBin, onEvent: events }),
    // A local Ollama install is a ready-made fallback engine (§6): used when
    // the managed llama.cpp build can't run here, or forced via KAI_RUNTIME.
    // If the daemon isn't running, Core starts it — no manual step.
    makeFallback: async () =>
      (await OllamaRuntime.ensureRunning({ ...ollamaAddr, onEvent: events }))
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
    const url = settings.get("earn.schedulerUrl", process.env.KAI_SCHEDULER_URL || "");
    const address = wallet.address;
    if (!url || !address) return null;
    if (Date.now() - earningsCache.at < 30000) return earningsCache.data;
    let data = null;
    try {
      const r = await fetch(`${url.replace(/\/$/, "")}/balance?address=${encodeURIComponent(address)}`, {
        signal: AbortSignal.timeout(4000),
      });
      const j = await r.json();
      if (j.ok) data = { kai: j.kai, pendingReceipts: j.pendingReceipts ?? 0 };
    } catch {
      /* scheduler unreachable or chain read down — the row just shows a dash */
    }
    // Successes cache for the full 30s; a failed read retries in ~3s so one
    // slow moment doesn't blank the balance row for half a minute.
    earningsCache = { at: data ? Date.now() : Date.now() - 27000, data };
    return data;
  };
  const earn = {
    status: async () => ({
      wallet: wallet.status(),
      worker: worker ? worker.status() : { running: false, jobsDone: 0, receiptsAccepted: 0 },
      schedulerUrl: settings.get("earn.schedulerUrl", process.env.KAI_SCHEDULER_URL || ""),
      earnings: await fetchEarnings(),
    }),
    configure: ({ schedulerUrl }) => {
      settings.set("earn.schedulerUrl", String(schedulerUrl || "").trim());
      earningsCache = { at: 0, data: null };
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
    start: async () => {
      const s = wallet.status();
      if (!s.exists) throw new Error("Create a wallet first");
      if (!s.unlocked) throw new Error("Unlock the wallet first");
      const url = settings.get("earn.schedulerUrl", process.env.KAI_SCHEDULER_URL || "");
      if (!url) throw new Error("Set the scheduler URL first");
      if (worker?.running) return worker.status();
      worker = new Worker({ schedulerUrl: url, wallet, runtime, hardware: hw, onEvent: events });
      const st = await worker.start();
      settings.set("earn.autoStart", true);
      return st;
    },
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
  const network = {
    status: () => ({
      privacyMode: settings.get("network.privacyMode", "local-only"),
      schedulerUrl: settings.get("earn.schedulerUrl", process.env.KAI_SCHEDULER_URL || ""),
    }),
    configure: ({ privacyMode }) => {
      const m = String(privacyMode || "");
      if (!["local-only", "local-first", "network"].includes(m)) {
        throw new Error("privacyMode must be local-only, local-first, or network");
      }
      settings.set("network.privacyMode", m);
      return network.status();
    },
  };

  // The desktop UI is plain web content served by the gateway itself — the
  // Electron shell just opens a window onto it, and a browser works too.
  const uiDir = path.join(__dirname, "..", "ui");
  const gateway = new Gateway({
    port: port ?? Number(process.env.KAI_CORE_PORT || 41100),
    runtime,
    models,
    keys,
    onEvent: events,
    uiDir: require("fs").existsSync(uiDir) ? uiDir : null,
    earn,
    network,
    coreInfo: () => ({ version: VERSION, dataDir, hardware: hw }),
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
      return p;
    },
    async stop() {
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
