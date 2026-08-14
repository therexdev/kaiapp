#!/usr/bin/env node
"use strict";

/*
 * §51 model benchmark harness. For each candidate in the bench catalog:
 * download (hash-verified) -> boot llama-server -> measure load time and
 * throughput (llama-server's own timings, best of 2 warm runs) -> capture
 * qualitative samples. Emits docs-ready JSON + Markdown.
 *
 *   node core/scripts/bench.js [--catalog <path>] [--out <dir>]
 *
 * Respects KAI_LLAMA_BIN (skip provisioning; used by tests with the fake
 * server). CPU-tier by design on CI; the same harness runs on GPU machines.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const hardware = require("../lib/hardware");
const { JsonStore } = require("../lib/store");
const { ModelManager } = require("../lib/model-manager");
const { RuntimeProvisioner } = require("../lib/runtime-provisioner");
const { LlamaCppRuntime } = require("../lib/runtimes/llamacpp");
const { buildReport } = require("../bench/report");

const PROBE = { role: "user", content: "Write two sentences about why local AI matters." };
const SAMPLES = [
  { name: "chat", prompt: "In one sentence, what are you?" },
  { name: "code", prompt: "Write a JavaScript function that reverses a string. Code only." },
];

async function chat(endpoint, messages, maxTokens) {
  const t0 = Date.now();
  const resp = await fetch(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "bench", messages, max_tokens: maxTokens, temperature: 0 }),
  });
  if (!resp.ok) throw new Error(`chat failed: HTTP ${resp.status}`);
  const j = await resp.json();
  const wallSec = (Date.now() - t0) / 1000;
  const genTps =
    j.timings?.predicted_per_second ??
    (j.usage?.completion_tokens ? j.usage.completion_tokens / wallSec : null);
  return {
    output: j.choices?.[0]?.message?.content ?? "",
    promptTps: j.timings?.prompt_per_second ?? null,
    genTps,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (f, d) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : d);
  const catalogPath = path.resolve(arg("--catalog", path.join(__dirname, "..", "bench", "candidates.json")));
  const outDir = path.resolve(arg("--out", path.join(process.cwd(), "bench-results")));
  const dataDir = process.env.KAI_CORE_DATA || fs.mkdtempSync(path.join(os.tmpdir(), "kai-bench-"));

  const hw = await hardware.detect({ dataDir });
  const models = new ModelManager({
    catalogPath,
    modelsDir: path.join(dataDir, "models"),
    state: new JsonStore(path.join(dataDir, "bench-state.json"), {}),
    onEvent: () => {},
  });

  let bin = process.env.KAI_LLAMA_BIN;
  if (!bin) {
    const prov = new RuntimeProvisioner({
      catalogPath: path.join(__dirname, "..", "runtimes", "catalog.json"),
      runtimesDir: path.join(dataDir, "runtimes"),
      hardware: hw,
      onEvent: () => {},
    });
    bin = await prov.ensure("llamacpp");
  }

  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const results = [];
  for (const [id, pkg] of Object.entries(catalog.packages)) {
    console.error(`[bench] ${id}: downloading…`);
    const modelPath = await models.ensurePackage(id);
    const runtime = new LlamaCppRuntime({ binPath: bin, port: 41190, onEvent: () => {} });
    try {
      const t0 = Date.now();
      const { endpoint } = await runtime.start({ modelPath, contextSize: pkg.contextSize || 4096, gpuLayers: 0 });
      const loadMs = Date.now() - t0;
      console.error(`[bench] ${id}: loaded in ${loadMs} ms, probing…`);

      // Warm-up + 2 measured probes; keep the best (steady-state) numbers.
      await chat(endpoint, [PROBE], 8);
      let promptTps = null;
      let genTps = null;
      for (let i = 0; i < 2; i++) {
        const p = await chat(endpoint, [PROBE], 48);
        if (p.promptTps != null) promptTps = Math.max(promptTps ?? 0, p.promptTps);
        if (p.genTps != null) genTps = Math.max(genTps ?? 0, p.genTps);
      }

      const samples = [];
      for (const s of SAMPLES) {
        const r = await chat(endpoint, [{ role: "user", content: s.prompt }], 96);
        samples.push({ name: s.name, prompt: s.prompt, output: r.output.trim().slice(0, 600) });
      }

      results.push({
        id,
        label: pkg.label || id,
        fileBytes: fs.statSync(modelPath).size,
        loadMs,
        promptTps,
        genTps,
        samples,
      });
      console.error(`[bench] ${id}: gen ${genTps?.toFixed(1)} tok/s`);
    } finally {
      runtime.stop();
    }
  }

  const report = buildReport({ hardware: hw, results, startedAt: new Date().toISOString() });
  fs.mkdirSync(outDir, { recursive: true });
  const base = `cpu-${hw.platform}-${new Date().toISOString().slice(0, 10)}`;
  fs.writeFileSync(path.join(outDir, `${base}.json`), JSON.stringify(report.json, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, `${base}.md`), report.markdown);
  console.log(report.markdown);
  console.log(`[bench] reports written to ${outDir}/${base}.{json,md}`);
}

main().catch((e) => {
  console.error(`BENCH FAIL: ${String(e?.message ?? e)}`);
  process.exit(1);
});
