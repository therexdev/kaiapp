"use strict";

/*
 * Anti-Sybil simulation — reputation-weighted pool distribution (§7.4, Task #20).
 *
 *   node tools/sybil-sim.js        # human tables
 *   node tools/sybil-sim.js --md   # markdown for the design doc
 *
 * THE PROBLEM. The scheduler pays protocol-funded work from ONE capped network-
 * wide pool (1,500 KAI/day). Today it splits by FLAT pro-rata over useful-work
 * demand (scheduler `_settleFor`: minted = full*pool/demand). Flat pro-rata
 * bounds TOTAL emission but NOT any actor's SHARE: a fake fleet that manufactures
 * useful-work receipts takes pool proportional to its fabricated volume, and it
 * manufactures volume by spinning up many identities.
 *
 * THREE SCHEMES COMPARED:
 *   flat    — today. weight = honestWork.                     (share ∝ volume)
 *   linear  — weight = honestWork · r.                        (naive fix)
 *   gated   — reputation ELIGIBILITY GATE + superlinear ramp:
 *             below r_GATE a node draws ZERO subsidy (but still earns full PAID
 *             revenue — equal work = equal pay); above it, weight =
 *             honestWork · ((r-GATE)/(1-GATE))^GAMMA.          (share ∝ proven-ness)
 *
 * WHY GATED. A linear weight only advantages honest nodes by their reputation
 * RATIO (~1.4× early), which a 4:1 fleet swamps. A gate makes low-reputation
 * identities contribute ~nothing, so a fresh fleet must first pay real compute +
 * real TIME (and, as it grows, serve real PAID DEMAND it cannot fake) before it
 * touches the pool at all. This matches the owner's principle exactly: reputation
 * governs ELIGIBILITY / EXPOSURE to the scarce protocol-funded reward — NOT pay
 * multipliers. Paid revenue is never gated; identical useful work has identical
 * base value.
 *
 * HONEST FRAMING. This is layer 2, not a silver bullet:
 *  - Layer 1 (§17 challenges) stops FABRICATED-work fleets — they can't pass
 *    class-discriminating challenges, so they get ~0 honest receipts (`scripted`).
 *  - The gate stops a challenge-passing fleet from capturing subsidy while it is
 *    young / unproven. A patient fleet that invests weeks of REAL compute on many
 *    machines converges toward its numeric share — that convergence is the cost
 *    the attack must pay, and the paid-demand signal + optional mainnet staking +
 *    the daily cap are the further layers. The sim shows this rather than hiding it.
 *
 * Deterministic and dependency-free (seeded LCG, no Math.random / Date.now).
 */

const MD = process.argv.includes("--md");

// ---- protocol constants ----
const POOL_KAI_PER_DAY = 1500;
const DAYS = 28;

// ---- reputation model (mirrors the scheduler design in the doc) ----
const R_MIN = 0.05;
const W_AGE = 0.45, W_PAID = 0.35, W_RELY = 0.1, W_CHAL = 0.1; // sum 1
const AGE_TAU_DAYS = 10;
const PAID_K = 40;

// ---- gated-scheme knobs ----
const R_GATE = 0.45; // below this: zero subsidy exposure (still full paid revenue)
const GAMMA = 2; // superlinear ramp above the gate

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ageScore = (d) => 1 - Math.exp(-Math.max(0, d) / AGE_TAU_DAYS);
const paidScore = (j) => j / (j + PAID_K);
function reputation({ ageDays, sr, chalPass, paidJobsCum }) {
  const raw = W_AGE * ageScore(ageDays) + W_PAID * paidScore(paidJobsCum) + W_RELY * clamp01(sr) + W_CHAL * clamp01(chalPass);
  return R_MIN + (1 - R_MIN) * clamp01(raw);
}
function eligibility(r) {
  return r <= R_GATE ? 0 : (r - R_GATE) / (1 - R_GATE);
}
function weightOf(scheme, honestWork, r) {
  if (scheme === "flat") return honestWork;
  if (scheme === "linear") return honestWork * r;
  return honestWork * Math.pow(eligibility(r), GAMMA); // gated
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (1103515245 * s + 12345) & 0x7fffffff) / 0x7fffffff);
}

function makeHonest(n, joinDay, rnd) {
  const a = [];
  for (let i = 0; i < n; i++) a.push({ kind: "honest", joinDay, workPerDay: 80 + Math.floor(rnd() * 40), sr: 0.97 + rnd() * 0.02, chalPass: 0.95 + rnd() * 0.04, paidJobsCum: 0, passesChallenges: true });
  return a;
}
function makeSybils(strategy, n, joinDay, rnd) {
  const a = [];
  for (let i = 0; i < n; i++) {
    const b = { kind: "sybil", strategy, joinDay, workPerDay: 80 + Math.floor(rnd() * 40), paidJobsCum: 0 };
    if (strategy === "scripted") { b.sr = 0.9; b.chalPass = 0.15; b.passesChallenges = false; }
    else { b.sr = 0.95 + rnd() * 0.02; b.chalPass = 0.95 + rnd() * 0.02; b.passesChallenges = true; } // compute-backed
    a.push(b);
  }
  return a;
}
const paidFractionOfDay = (day) => 0.02 + 0.33 * (1 - Math.exp(-day / 12));

function distribute(nodes, absDay, scheme) {
  const rows = nodes.map((nd) => {
    const honestWork = nd.passesChallenges === false ? 0 : nd.workPerDay;
    const r = reputation({ ageDays: absDay - nd.joinDay, sr: nd.sr, chalPass: nd.chalPass, paidJobsCum: nd.paidJobsCum });
    return { nd, r, weight: weightOf(scheme, honestWork, r) };
  });
  const tot = rows.reduce((a, b) => a + b.weight, 0);
  for (const row of rows) row.mint = tot > 0 ? (POOL_KAI_PER_DAY * row.weight) / tot : 0;
  return rows;
}

// honestJoinDay < 0 models an ESTABLISHED network that a fresh fleet (joinDay 0)
// attacks; honestJoinDay 0 models a simultaneous cold-start (the hardest case).
function simulate(strategy, honestN, sybilN, honestJoinDay) {
  const rnd = lcg(0xc0ffee + strategy.length + honestN * 7 + sybilN * 13 - honestJoinDay);
  const honest = makeHonest(honestN, honestJoinDay, rnd);
  const sybils = makeSybils(strategy, sybilN, 0, rnd);
  const nodes = [...honest, ...sybils];
  const schemes = ["flat", "linear", "gated"];
  const acc = Object.fromEntries(schemes.map((s) => [s, { sybil: 0, honest: 0 }]));
  const timeline = [];
  for (let day = 0; day < DAYS; day++) {
    const paidToday = paidFractionOfDay(day) * honest.reduce((a, n) => a + n.workPerDay, 0);
    const perHonest = paidToday / Math.max(1, honestN);
    for (const n of honest) n.paidJobsCum += perHonest;
    for (const n of sybils) n.paidJobsCum += 0.02 * perHonest;
    for (const s of schemes) {
      const rows = distribute(nodes, day, s);
      for (const row of rows) acc[s][row.nd.kind] += row.mint;
    }
    if ([0, 6, 13, 27].includes(day)) {
      const g = distribute(nodes, day, "gated");
      const sy = g.find((r) => r.nd.kind === "sybil");
      const ho = g.find((r) => r.nd.kind === "honest");
      const cap = (rows) => (100 * rows.filter((r) => r.nd.kind === "sybil").reduce((a, b) => a + b.mint, 0)) / POOL_KAI_PER_DAY;
      timeline.push({ day: day + 1, rHonest: ho.r, rSybil: sy.r, flat: cap(distribute(nodes, day, "flat")), linear: cap(distribute(nodes, day, "linear")), gated: cap(g) });
    }
  }
  const pct = (s) => (100 * acc[s].sybil) / (acc[s].sybil + acc[s].honest);
  return { strategy, honestJoinDay, flat: pct("flat"), linear: pct("linear"), gated: pct("gated"), timeline };
}

// ---- scenarios: 10 honest vs a 40-node fake fleet (4:1) ----
const HN = 10, SN = 40;
const nets = [
  { label: "Cold-start (honest + fleet both fresh)", join: 0 },
  { label: "Established network (honest 30d old, fleet fresh)", join: -30 },
];
const strategies = ["scripted", "compute-backed"];

function line(s = "") { console.log(s); }
line(`${MD ? "# " : ""}Reputation-gated pool distribution — Sybil-capture simulation`);
line();
line(`Window ${DAYS} days · pool ${POOL_KAI_PER_DAY} KAI/day · ${HN} honest vs ${SN}-node fake fleet (4:1).`);
line(`Capture % = share of the total pool the fleet takes over the window. Gate r_GATE=${R_GATE}, γ=${GAMMA}.`);
line();

for (const net of nets) {
  line(`${MD ? "## " : "### "}${net.label}`);
  if (MD) { line(`| Attacker | flat (today) | linear | gated | flat→gated |`); line(`|---|---|---|---|---|`); }
  else line("attacker         flat%   linear%   gated%   flat->gated");
  for (const strat of strategies) {
    const r = simulate(strat, HN, SN, net.join);
    const red = r.flat > 0.5 ? (100 * (1 - r.gated / r.flat)).toFixed(0) + "%" : "n/a";
    if (MD) line(`| \`${strat}\` | ${r.flat.toFixed(1)}% | ${r.linear.toFixed(1)}% | ${r.gated.toFixed(1)}% | ${red} |`);
    else line(strat.padEnd(16) + r.flat.toFixed(1).padStart(6) + r.linear.toFixed(1).padStart(9) + r.gated.toFixed(1).padStart(9) + red.padStart(12));
  }
  line();
}

// Timeline for the realistic case: established network, compute-backed fresh fleet.
const est = simulate("compute-backed", HN, SN, -30);
line(`${MD ? "## " : "### "}Established network vs a fresh compute-backed fleet — over time`);
if (MD) { line(`| Day | honest r | fleet r | flat cap | linear cap | gated cap |`); line(`|---|---|---|---|---|---|`); }
else line("day   honest_r  fleet_r   flat%   linear%   gated%");
for (const t of est.timeline) {
  if (MD) line(`| ${t.day} | ${t.rHonest.toFixed(2)} | ${t.rSybil.toFixed(2)} | ${t.flat.toFixed(1)}% | ${t.linear.toFixed(1)}% | ${t.gated.toFixed(1)}% |`);
  else line(String(t.day).padEnd(6) + t.rHonest.toFixed(2).padStart(8) + t.rSybil.toFixed(2).padStart(9) + t.flat.toFixed(1).padStart(8) + t.linear.toFixed(1).padStart(10) + t.gated.toFixed(1).padStart(9));
}
line();
line(`${MD ? "## " : "### "}Reading`);
line(`- scripted fleets get ~0 under every scheme — §17 challenges gate them before the pool. Reputation is layer 2.`);
line(`- linear weighting barely dents a 4:1 fleet (share still ∝ volume). The GATE is what converts "spin up N fakes`);
line(`  and farm immediately" into "pay real compute + wait weeks + serve real demand first."`);
line(`- Against an ESTABLISHED network a fresh fleet is gated to ~0 for its first weeks; it only converges toward its`);
line(`  numeric share by paying weeks of real compute — the deterrent. Paid-demand weighting + optional mainnet`);
line(`  staking + the ${POOL_KAI_PER_DAY} KAI/day cap are the remaining layers. Defense in depth, honestly bounded.`);
