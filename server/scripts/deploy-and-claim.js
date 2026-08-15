#!/usr/bin/env node
"use strict";

/*
 * Deploy the KAI settlement contract to the Koinos testnet and prove the
 * full §46.4 loop against it: earn loop -> epoch close -> submit_root ->
 * Merkle claim -> KAI minted to the provider. Operator pays all MANA (§21
 * spirit: providers never need KOIN).
 *
 *   KAI_OPERATOR_WIF=... node server/scripts/deploy-and-claim.js
 *   KAI_CONTRACT_DEPLOYED=1 to skip the upload (already deployed).
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

const { Scheduler } = require("../scheduler");
const { ChainClient, KaiContract } = require("../chain");
const { WalletService } = require("../../core/lib/wallet");
const { Worker } = require("../../core/lib/worker");
const { LlamaCppRuntime } = require("../../core/lib/runtimes/llamacpp");

async function main() {
  const wif = process.env.KAI_OPERATOR_WIF;
  if (!wif) throw new Error("KAI_OPERATOR_WIF required");
  const chain = new ChainClient({ wif });
  await chain.assertChain();
  console.log(`[kai] operator: ${chain.address}`);

  const kai = new KaiContract({ chain });
  if (!process.env.KAI_CONTRACT_DEPLOYED) {
    const dep = await kai.deploy();
    console.log(`[kai] contract deployed at ${dep.contractId} (tx ${dep.txId})`);
  }
  console.log(`[kai] token: ${JSON.stringify((await kai.contract.functions.name({})).result)}`);

  // --- run a real earn round locally ---
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-claim-"));
  const wallet = new WalletService(path.join(dir, "wallet"));
  const { address: provider } = wallet.create({ password: "demo-provider-pass" });
  const fakeBin = path.join(__dirname, "..", "..", "core", "test", "fixtures", "fake-llama-server");
  const rt = new LlamaCppRuntime({ binPath: fakeBin, port: 41261, onEvent: () => {} });
  await rt.start({ modelPath: "demo.gguf", gpuLayers: 0 });
  const runtime = { ensure: async () => rt.endpoint, servedModelName: () => null };
  const sched = new Scheduler({ dataDir: path.join(dir, "sched"), onEvent: () => {} });
  const port = await sched.listen();
  const worker = new Worker({ schedulerUrl: `http://127.0.0.1:${port}`, wallet, runtime, hardware: {}, onEvent: () => {} });
  await worker.start();
  sched.enqueue({ prompt: "Say hello." });
  sched.enqueue({ prompt: "Say hello.", expected: "Hello" });
  while (sched.receipts.length < 2) await new Promise((r) => setTimeout(r, 100));
  // Use a chain-unique epoch number so re-runs never collide with stored roots.
  sched.epoch = Number(process.env.KAI_EPOCH || Math.floor(Date.now() / 1000));
  const summary = sched.closeEpoch();
  await worker.stop();
  await sched.close();
  rt.stop();
  console.log(`[kai] epoch ${summary.epoch}: ${summary.receipts} receipts, root ${summary.root}`);

  // --- settle on-chain ---
  const sub = await kai.submitRoot(summary.epoch, summary.root);
  console.log(`[kai] root submitted (tx ${sub.txId})`);
  const onchain = await kai.getRoot(summary.epoch);
  if (onchain !== summary.root) throw new Error(`root mismatch on-chain: ${onchain}`);
  console.log(`[kai] on-chain root verified`);

  const entry = summary.claims[provider];
  const cl = await kai.claim(summary.epoch, provider, entry);
  console.log(`[kai] claimed for ${provider} (tx ${cl.txId})`);

  const bal = await kai.kaiBalance(provider);
  console.log(`[kai] provider KAI balance: ${bal} (${Number(bal) / 1e8} KAI)`);
  if (bal !== BigInt(entry.count) * 100000000n) throw new Error("unexpected balance");
  console.log("SETTLEMENT COMPLETE: receipts -> root -> on-chain -> Merkle claim -> KAI minted");
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
});
