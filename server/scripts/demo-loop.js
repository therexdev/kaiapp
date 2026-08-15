#!/usr/bin/env node
"use strict";

/*
 * §46.4 alpha demonstration: a real job ROUTED (scheduler) -> COMPLETED
 * (worker + local inference) -> VERIFIED (signed receipt + hidden challenge)
 * -> SETTLED (epoch Merkle root anchored on the Koinos testnet).
 *
 *   KAI_OPERATOR_WIF=... node server/scripts/demo-loop.js
 *
 * Uses the fake llama fixture for inference so it runs anywhere; on a
 * machine with a working engine, point KAI_LLAMA_BIN at the real thing.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

const { Scheduler } = require("../scheduler");
const { ChainClient } = require("../chain");
const { WalletService } = require("../../core/lib/wallet");
const { Worker } = require("../../core/lib/worker");
const { LlamaCppRuntime } = require("../../core/lib/runtimes/llamacpp");

async function main() {
  const wif = process.env.KAI_OPERATOR_WIF;
  if (!wif) throw new Error("KAI_OPERATOR_WIF required (faucet-funded operator key)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-demo-"));

  // Provider wallet (the earner) — separate key from the operator.
  const wallet = new WalletService(path.join(dir, "wallet"));
  const { address } = wallet.create({ password: "demo-provider-pass" });
  console.log(`[demo] provider address: ${address}`);

  // Local inference: fake llama-server via the real runtime adapter.
  const fakeBin = path.join(__dirname, "..", "..", "core", "test", "fixtures", "fake-llama-server");
  const rt = new LlamaCppRuntime({ binPath: fakeBin, port: 41260, onEvent: () => {} });
  await rt.start({ modelPath: "demo.gguf", gpuLayers: 0 });
  const runtime = { ensure: async () => rt.endpoint, servedModelName: () => null };

  // Scheduler with REAL chain anchoring.
  const chain = new ChainClient({ wif, onEvent: (e) => console.log(`[demo] ${e.type} tx=${e.txId}`) });
  const sched = new Scheduler({ dataDir: path.join(dir, "sched"), chain, onEvent: (e) => console.log(`[demo] ${e.type}`) });
  const port = await sched.listen();

  const worker = new Worker({
    schedulerUrl: `http://127.0.0.1:${port}`,
    wallet,
    runtime,
    hardware: { capabilities: { cpuFallback: true } },
    onEvent: (e) => console.log(`[demo] ${e.type}`),
  });
  await worker.start();

  sched.enqueue({ prompt: "Say hello." });
  sched.enqueue({ prompt: "Say hello.", expected: "Hello" }); // hidden challenge

  while (sched.receipts.length < 2) await new Promise((r) => setTimeout(r, 100));
  console.log(`[demo] ${sched.receipts.length} verified receipts for ${address}`);

  // Close the epoch through the HTTP API so the anchor path is the real one.
  const close = await (await fetch(`http://127.0.0.1:${port}/epoch/close`, { method: "POST" })).json();
  console.log(`[demo] epoch ${close.epoch} root ${close.root}`);
  if (close.anchorError) throw new Error(`anchor failed: ${close.anchorError}`);
  console.log(`[demo] ANCHORED tx ${close.anchor.txId} -> ${close.anchor.anchorAddress}`);

  const check = await chain.verifyAnchor(close.root);
  console.log(`[demo] independent verification: anchored=${check.anchored} balance=${check.balance}`);

  await worker.stop();
  await sched.close();
  rt.stop();
  if (!check.anchored) throw new Error("verification failed");
  console.log("§46.4 ALPHA LOOP COMPLETE: routed -> completed -> verified -> settled");
}

main().catch((e) => {
  console.error(`DEMO FAIL: ${e.message}`);
  process.exit(1);
});
