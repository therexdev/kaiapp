"use strict";

/*
 * §52 economic simulation v1 — provider break-even sweep.
 *
 *   node tools/econ-sim.js        # human tables
 *   node tools/econ-sim.js --md   # markdown for docs/economics-sim-01.md
 *
 * AS-BUILT NOTE (2026-08-16): the subsidy structure this sim analyzes (a
 * per-PROVIDER eval mint) was SUPERSEDED. The scheduler now pays protocol-
 * funded work from ONE capped NETWORK-WIDE pool (1,500 KAI/day, divided by
 * useful work, unused left in reserve), and the free tier is DAILY with a
 * global ceiling — see docs/economics-sprint-02.md. The hardware break-even
 * tables below still hold (they don't depend on subsidy structure); the
 * "eval subsidy share" and "protocol liabilities" tables describe the OLD
 * per-provider model and are kept for historical comparison only.
 *
 * Deterministic, dependency-free. Every input is a named constant below so
 * the next simulation run can vary one thing at a time. Grounded where
 * possible in MEASURED alpha data (the 2026-08-15 §46.3 acceptance run),
 * not guesses:
 *   - request shape: 12,426 in / 2,302 out tokens over 10 real requests
 *   - eval subsidy cadence: 5 eval receipts per 15-min epoch per provider
 */

// ---- fixed protocol parameters (PROVISIONAL rates as shipped) ----
const RATE_IN_USD_PER_M = 0.10; // koinos-fast input
const RATE_OUT_USD_PER_M = 0.40; // koinos-fast output
const EVAL_KAI_PER_RECEIPT = 1; // §16 bootstrap subsidy
const FREE_TOKENS_PER_EPOCH = 25000;
const EPOCHS_PER_DAY = 96; // 15-minute epochs

// ---- measured alpha traffic shape (acceptance run 2026-08-15) ----
const REQ_IN_TOK = 1243; // avg prompt tokens per request
const REQ_OUT_TOK = 230; // avg completion tokens per request
const EVAL_RECEIPTS_PER_EPOCH = 5; // observed at current seed cadence

// ---- hardware classes (typical 7B-class GGUF decode rates) ----
const GPUS = [
  { name: "CPU-only (8c)", tps: 6, watts: 65, priceUsd: 0 },
  { name: "RTX 3060", tps: 24, watts: 170, priceUsd: 280 },
  { name: "RTX 4070", tps: 42, watts: 200, priceUsd: 520 },
  { name: "RTX 4090", tps: 95, watts: 450, priceUsd: 1700 },
];
const PREFILL_X = 8; // prompt tokens process ~8x faster than decode

// ---- sweep axes (§52: stress-test approximately $0.005 through $0.50+) ----
const KAI_USD = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5];
const UTILIZATION = [0.05, 0.25, 0.6, 0.9]; // fraction of wall time serving chat
const KWH_USD = [0.08, 0.15, 0.25];
const AMORT_HOURS = 3 * 8760; // 3-year straight-line hardware amortization

const REV_PER_REQ_USD = (REQ_IN_TOK * RATE_IN_USD_PER_M + REQ_OUT_TOK * RATE_OUT_USD_PER_M) / 1e6;

function perGpu(g, util) {
  const secPerReq = REQ_IN_TOK / (g.tps * PREFILL_X) + REQ_OUT_TOK / g.tps;
  const reqPerHr = (util * 3600) / secPerReq;
  const chatUsdPerHr = reqPerHr * REV_PER_REQ_USD;
  const outTokPerHr = reqPerHr * REQ_OUT_TOK;
  return { secPerReq, reqPerHr, chatUsdPerHr, outTokPerHr };
}

function breakEvenUtil(g, kwh) {
  // utilization where chat revenue alone covers power + amortization
  const costPerHr = (g.watts / 1000) * kwh + g.priceUsd / AMORT_HOURS;
  const revAtFull = perGpu(g, 1).chatUsdPerHr;
  return revAtFull > 0 ? costPerHr / revAtFull : Infinity;
}

const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "—");
const md = process.argv.includes("--md");
const lines = [];
const out = (s = "") => lines.push(s);

out(`Request shape (measured): ${REQ_IN_TOK} in / ${REQ_OUT_TOK} out tokens -> $${REV_PER_REQ_USD.toFixed(7)}/request`);
out("");

// Table 1: chat economics per GPU class at each utilization ($0.15/kWh)
out("### 1. Chat-only provider economics ($0.15/kWh, 3-year amortization)");
out("");
out("| GPU | util | req/hr | chat $/hr | power+amort $/hr | margin $/hr |");
out("|---|---|---|---|---|---|");
for (const g of GPUS) {
  const costPerHr = (g.watts / 1000) * 0.15 + g.priceUsd / AMORT_HOURS;
  for (const u of UTILIZATION) {
    const p = perGpu(g, u);
    out(`| ${g.name} | ${(u * 100).toFixed(0)}% | ${fmt(p.reqPerHr, 0)} | ${fmt(p.chatUsdPerHr, 4)} | ${fmt(costPerHr, 4)} | ${fmt(p.chatUsdPerHr - costPerHr, 4)} |`);
  }
}
out("");

// Table 2: break-even utilization per electricity price
out("### 2. Break-even utilization (chat revenue covers power + amortization)");
out("");
out(`| GPU | ${KWH_USD.map((k) => `$${k}/kWh`).join(" | ")} |`);
out(`|---|${KWH_USD.map(() => "---").join("|")}|`);
for (const g of GPUS) {
  out(`| ${g.name} | ${KWH_USD.map((k) => {
    const be = breakEvenUtil(g, k);
    return be > 1 ? `>100%` : `${(be * 100).toFixed(0)}%`;
  }).join(" | ")} |`);
}
out("");

// Table 3: KAI price ladder — what the SAME USD flows become in KAI
out("### 3. KAI price ladder (RTX 4070 @ 60% util, plus the eval subsidy)");
out("");
const g4070 = GPUS[2];
const p4070 = perGpu(g4070, 0.6);
const evalKaiPerDay = EVAL_RECEIPTS_PER_EPOCH * EVAL_KAI_PER_RECEIPT * EPOCHS_PER_DAY;
out("| KAI ref price | chat KAI/day | eval subsidy KAI/day | subsidy USD/day | subsidy share of income |");
out("|---|---|---|---|---|");
for (const price of KAI_USD) {
  const chatKaiDay = (p4070.chatUsdPerHr * 24) / price;
  const subsidyUsdDay = evalKaiPerDay * price;
  const share = (evalKaiPerDay / (evalKaiPerDay + chatKaiDay)) * 100;
  out(`| $${price} | ${fmt(chatKaiDay, 1)} | ${evalKaiPerDay} | $${fmt(subsidyUsdDay, 2)} | ${fmt(share, 0)}% |`);
}
out("");

// Table 4: protocol liabilities per day
out("### 4. Protocol-funded liabilities (per day)");
out("");
const freeBlendUsd =
  ((FREE_TOKENS_PER_EPOCH * (REQ_IN_TOK / (REQ_IN_TOK + REQ_OUT_TOK)) * RATE_IN_USD_PER_M) +
    (FREE_TOKENS_PER_EPOCH * (REQ_OUT_TOK / (REQ_IN_TOK + REQ_OUT_TOK)) * RATE_OUT_USD_PER_M)) / 1e6;
out("| Liability | Unit | USD value | At $0.01/KAI | At $0.50/KAI |");
out("|---|---|---|---|---|");
out(`| Eval subsidy | per provider-day | rate-independent mint | $${fmt(evalKaiPerDay * 0.01, 2)} | $${fmt(evalKaiPerDay * 0.5, 2)} |`);
out(`| Free allowance (fully drained) | per address-day | $${fmt(freeBlendUsd * EPOCHS_PER_DAY, 4)} | ${fmt((freeBlendUsd * EPOCHS_PER_DAY) / 0.01, 1)} KAI | ${fmt((freeBlendUsd * EPOCHS_PER_DAY) / 0.5, 2)} KAI |`);
out("");
out(`Eval subsidy/day/provider = ${EVAL_RECEIPTS_PER_EPOCH}/epoch x ${EPOCHS_PER_DAY} epochs = ${evalKaiPerDay} KAI minted regardless of the KAI price.`);
out(`Free allowance liability is PER ADDRESS and addresses are free (Sybil surface).`);

const text = lines.join("\n");
if (md) {
  process.stdout.write(text + "\n");
} else {
  process.stdout.write(text.replace(/^\| /gm, "  | ") + "\n");
}
