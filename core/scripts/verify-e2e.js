#!/usr/bin/env node
"use strict";

/*
 * Real end-to-end verification: boots Core with NO overrides, so the actual
 * provisioning path runs — llama.cpp build downloaded + hash-verified +
 * extracted, model downloaded + hash-verified, llama-server supervised, and
 * a completion streamed back through the OpenAI-compatible gateway.
 *
 *   node core/scripts/verify-e2e.js [alias]        (default: dev-tiny)
 *
 * Needs normal internet access (a networked dev machine or CI). Exit 0 with
 * "E2E PASS" plus the model's actual reply on success. Respects
 * KAI_CORE_DATA/KAI_LLAMA_BIN like the app, so a smoke run against a local
 * binary is possible too.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { createCore } = require("../server");

const ENSURE_TIMEOUT_MS = 15 * 60 * 1000;

async function main() {
  const alias = process.argv[2] || "dev-tiny";
  const dataDir = process.env.KAI_CORE_DATA || fs.mkdtempSync(path.join(os.tmpdir(), "kai-e2e-"));
  console.log(`[e2e] data dir: ${dataDir}`);

  const core = await createCore({
    dataDir,
    port: 0,
    onEvent: (e) => {
      if (e.type.endsWith(":download")) {
        if (e.pct !== null && e.pct % 10 === 0) console.log(`[e2e] ${e.type} ${e.pct}%`);
      } else {
        console.log(`[e2e] ${e.type}`);
      }
    },
  });
  const port = await core.start();
  const base = `http://127.0.0.1:${port}`;

  // Drive it through the gateway exactly like the UI does.
  const kick = await fetch(`${base}/core/models/ensure`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alias }),
  }).then((r) => r.json());
  if (!kick.ok) throw new Error(`ensure refused: ${kick.error}`);

  const deadline = Date.now() + ENSURE_TIMEOUT_MS;
  for (;;) {
    const m = await fetch(`${base}/core/models`).then((r) => r.json());
    if (m.ensure?.state === "ready") break;
    if (m.ensure?.state === "error") throw new Error(`ensure failed: ${m.ensure.error}`);
    if (Date.now() > deadline) throw new Error("timed out waiting for model+engine");
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log("[e2e] model + engine ready, requesting a streamed completion…");

  const resp = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: alias,
      stream: true,
      max_tokens: 48,
      messages: [{ role: "user", content: "Reply with one short sentence: what are you?" }],
    }),
  });
  if (!resp.ok) throw new Error(`chat/completions answered HTTP ${resp.status}: ${await resp.text()}`);

  const decoder = new TextDecoder();
  let buf = "";
  let reply = "";
  for await (const chunk of resp.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          reply += JSON.parse(data).choices?.[0]?.delta?.content || "";
        } catch {
          /* keep-alive */
        }
      }
    }
  }

  await core.stop();
  if (!reply.trim()) throw new Error("empty completion — streaming chain broken");
  console.log(`[e2e] model replied: ${JSON.stringify(reply.trim())}`);
  console.log("E2E PASS");
}

main().catch((e) => {
  console.error(`E2E FAIL: ${String(e?.message ?? e)}`);
  process.exit(1);
});
