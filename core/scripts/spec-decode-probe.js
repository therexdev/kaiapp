#!/usr/bin/env node
"use strict";

/*
 * Can our inference engine VERIFY a draft it did not write?
 *
 * This is the gating question for the whole decentralized-inference program
 * (docs/DECENTRALIZED-INFERENCE.md). Speculative decoding only pays off if the
 * network node can take `prompt + k draft tokens`, do ONE forward pass, and
 * report how likely the model thought each of those k tokens was. If
 * llama-server cannot do that, Phase 1 does not exist in its current form and
 * we need to know now — before any protocol is designed around it.
 *
 * It is deliberately an EXPLORATION, not an assertion. It tries every plausible
 * shape the server might support and prints exactly what came back, because the
 * useful output here is "strategy C works and B silently returns the wrong
 * thing", not a green tick.
 *
 * Runs on a CI runner: the dev sandbox's proxy reaches neither huggingface.co
 * nor the llama.cpp releases. Read-only, no keys, nothing published.
 */

const { spawn } = require("child_process");

const SERVER = process.argv[2];
const MODEL = process.argv[3];
if (!SERVER || !MODEL) {
  console.error("usage: spec-decode-probe.js <llama-server> <model.gguf>");
  process.exit(2);
}

const PORT = 18099;
const BASE = `http://127.0.0.1:${PORT}`;
const PROMPT = "The capital of France is Paris. The capital of Japan is";
const K = 6; // draft length under test

const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; }
  catch { return { status: r.status, text: text.slice(0, 300) }; }
};

/** Compact view of whatever a strategy returned, so the log is the finding. */
const show = (label, v) => console.log(`    ${label}: ${JSON.stringify(v).slice(0, 240)}`);

async function waitReady(ms = 180000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

(async () => {
  const child = spawn(SERVER, ["-m", MODEL, "--port", String(PORT), "--host", "127.0.0.1",
                               "-c", "512", "--no-warmup", "-t", "2"],
                      { stdio: ["ignore", "pipe", "pipe"] });
  let serverLog = "";
  child.stdout.on("data", (d) => { serverLog += d; });
  child.stderr.on("data", (d) => { serverLog += d; });

  const done = (code) => { try { child.kill("SIGKILL"); } catch {} process.exit(code); };

  if (!(await waitReady())) {
    console.error("llama-server never became healthy. Last output:\n" + serverLog.slice(-2000));
    return done(1);
  }
  console.log("llama-server is up\n");

  /* ---------------------------------------------------------------- */
  console.log("0) baseline — generate the draft normally, and keep its probabilities");
  const gen = await post("/completion", {
    prompt: PROMPT, n_predict: K, temperature: 0, n_probs: 3, cache_prompt: false,
  });
  if (gen.status !== 200) { console.error("generation failed", gen); return done(1); }
  const draftText = gen.json.content;
  const genProbs = (gen.json.completion_probabilities || []).map((p) => ({
    tok: p.content ?? p.token,
    // llama.cpp has renamed this field across versions; accept either.
    p: (p.probs && p.probs[0] && (p.probs[0].prob ?? p.probs[0].probability)) ?? null,
  }));
  console.log(`  drafted ${K} tokens: ${JSON.stringify(draftText)}`);
  show("per-token probabilities from GENERATION", genProbs);
  console.log(`  timings: ${JSON.stringify(gen.json.timings || {})}\n`);

  const tk = await post("/tokenize", { content: PROMPT });
  const dk = await post("/tokenize", { content: draftText });
  const promptToks = tk.json?.tokens || [];
  const draftToks = dk.json?.tokens || [];
  console.log(`  /tokenize: prompt=${promptToks.length} tokens, draft=${draftToks.length} tokens\n`);
  if (!promptToks.length || !draftToks.length) {
    console.error("  /tokenize did not return tokens — every strategy below depends on it");
  }

  /* ---------------------------------------------------------------- */
  console.log("A) /v1/completions with echo + logprobs  (the OpenAI shape)");
  /*
   * If this works it is the cleanest answer by far: send prompt+draft as the
   * prompt, generate nothing, and read logprobs back for the echoed tokens.
   */
  const a = await post("/v1/completions", {
    prompt: PROMPT + draftText, echo: true, logprobs: 1, max_tokens: 0, temperature: 0,
  });
  show("status", a.status);
  const aLp = a.json?.choices?.[0]?.logprobs;
  show("choices[0].logprobs", aLp ?? null);
  const A_WORKS = !!(aLp && Array.isArray(aLp.token_logprobs) && aLp.token_logprobs.filter((x) => x != null).length >= K);
  console.log(`  → echo+logprobs returns per-prompt-token values: ${A_WORKS ? "YES" : "NO"}\n`);

  /* ---------------------------------------------------------------- */
  console.log("B) /completion with the draft appended and n_predict: 0");
  const b = await post("/completion", {
    prompt: promptToks.concat(draftToks), n_predict: 0, n_probs: 3, temperature: 0, cache_prompt: false,
  });
  show("status", b.status);
  show("completion_probabilities", b.json?.completion_probabilities ?? null);
  show("tokens_evaluated", b.json?.tokens_evaluated ?? null);
  const B_WORKS = Array.isArray(b.json?.completion_probabilities) && b.json.completion_probabilities.length >= K;
  console.log(`  → n_predict:0 yields per-draft-token values: ${B_WORKS ? "YES" : "NO"}\n`);

  /* ---------------------------------------------------------------- */
  console.log("C) /completion with the draft appended and n_predict: 1");
  /*
   * Expected to give the distribution at the FINAL position only — one token's
   * worth. If that is all we get, verification costs one round trip PER draft
   * token, which is exactly the thing speculative decoding exists to avoid.
   */
  const c = await post("/completion", {
    prompt: promptToks.concat(draftToks), n_predict: 1, n_probs: 3, temperature: 0, cache_prompt: false,
  });
  show("status", c.status);
  show("completion_probabilities length", (c.json?.completion_probabilities || []).length);
  show("timings", c.json?.timings ?? null);
  console.log("");

  /* ---------------------------------------------------------------- */
  console.log("D) does the server expose native speculative decoding to the CLIENT?");
  /*
   * llama.cpp supports a LOCAL draft model (-md). The question here is whether
   * a client can hand it a draft over the wire — which is what we would need,
   * since our drafter runs on the user's machine and the verifier does not.
   */
  const d = await post("/completion", {
    prompt: PROMPT, n_predict: K, temperature: 0, cache_prompt: false,
    "speculative.n_max": K, draft: draftToks,
  });
  show("status", d.status);
  show("accepts a client-supplied draft field", d.json?.error ? d.json.error : "no error returned");
  console.log("");

  /* ---------------------------------------------------------------- */
  console.log("E) the economics — is ONE pass over k drafts cheaper than k decodes?");
  /*
   * The whole argument rests on this. If verifying k tokens in one pass costs
   * about the same as decoding them one at a time, speculative decoding buys
   * nothing and the latency maths in the design doc is wrong.
   */
  const t0 = Date.now();
  for (let i = 0; i < K; i++) {
    await post("/completion", { prompt: PROMPT, n_predict: 1, temperature: 0, cache_prompt: false });
  }
  const sequentialMs = Date.now() - t0;

  const t1 = Date.now();
  await post("/completion", {
    prompt: promptToks.concat(draftToks), n_predict: 1, temperature: 0, cache_prompt: false,
  });
  const onePassMs = Date.now() - t1;

  console.log(`  ${K} separate single-token decodes: ${sequentialMs} ms`);
  console.log(`  one pass over prompt+${K} drafts:   ${onePassMs} ms`);
  console.log(`  → ratio ${(sequentialMs / Math.max(onePassMs, 1)).toFixed(2)}x\n`);

  /* ---------------------------------------------------------------- */
  console.log("VERDICT");
  console.log(`  A (/v1/completions echo+logprobs): ${A_WORKS ? "WORKS — use this" : "no"}`);
  console.log(`  B (/completion n_predict:0):       ${B_WORKS ? "WORKS — use this" : "no"}`);
  if (!A_WORKS && !B_WORKS) {
    console.log("  Neither shape returns per-draft-token probabilities from this build.");
    console.log("  Phase 1 as designed needs one of: a newer llama.cpp, a server patch,");
    console.log("  or a different verify formulation. Do NOT design the protocol until");
    console.log("  this is settled — the round-trip budget depends entirely on it.");
  }
  done(0);
})().catch((e) => { console.error("PROBE FAILED", e); process.exit(1); });
