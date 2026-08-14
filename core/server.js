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

async function createCore({ dataDir, port, llamaBin, onEvent } = {}) {
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
      return p;
    },
    async stop() {
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
