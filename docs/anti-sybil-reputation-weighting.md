# Anti-Sybil: reputation-gated pool distribution (design + simulation)

**Status: DESIGN — for owner review before any code ships.** Task #20 / SOURCE_OF_TRUTH §7.4.
Nothing in here is live. This is the "concrete design + sim before shipping" the roadmap asked for.

---

## Plain-language summary (read this first)

The network gives away up to **1,500 KAI/day** from a shared pool to bootstrap honest
providers. Today that pool is split **by how much useful work each machine did.** That
bounds the *total* we give away, but not *who gets it*: someone who spins up 40 fake
machines that each do "useful work" simply takes 40 machines' worth of the pool. The
scheduler's own code comment admits this is an open hole.

The fix has two ideas the owner already set as principles:

1. **Real customer money is never touched.** If two machines do the same useful work, they
   earn the same *paid* revenue — always. Reputation does **not** change anyone's pay.
2. **The free pool is a privilege, not a right.** A machine only draws from the shared pool
   once it has *proven itself* — earned enough **reputation** through time on the network,
   passing verification challenges, reliability, and (as the network grows) actually serving
   real paying customers. Below a reputation bar, a machine earns full pay for its work but
   draws **nothing** from the pool.

Why this works: a fake fleet can fabricate "work," but it can't fast-forward time, and it
can't conjure real paying customers. To reach the pool it must run **real** models (real
electricity) on every fake machine for **weeks** with zero pool reward — at which point it's
just... doing honest work. The simulation below shows a fresh 40-machine fleet attacking an
established network gets **0% of the pool for its first two weeks** and only crawls up as it
burns real compute.

This is **layer 2**, not a magic bullet. Layer 1 is the §17 challenges (a fleet that can't
pass them never counts as "useful" at all). Later layers are optional mainnet staking and
anomaly detection. Honest limits are stated plainly at the end.

---

## 1. The problem, precisely

`scheduler.js#_settleFor` distributes the bootstrap pool by flat pro-rata:

```
minted_i = subsidyValue_i × (pool / Σ subsidyValue_j)      // when demand > pool
```

`subsidyValue_i` is the protocol-funded value of worker *i*'s honest receipts. A worker's
share of the pool is therefore **exactly its share of network useful-work volume.** Volume is
the one thing a Sybil manufactures cheaply — by running many identities. The code says so:

> "this bounds TOTAL emission but not any one actor's SHARE — Sybil distribution resistance
> is a separate, still-open design item (needs staking/attestation/reputation)."

Paid revenue is **not** in this pool — it's real money from real consumers and is settled
separately (and consumption is already authorized only against the guaranteed paid floor,
per the debt-hole fix). So we can change pool distribution **without touching pay at all.**

## 2. The two streams (unchanged principle, made explicit)

| Stream | Funded by | Distribution | Reputation? |
|---|---|---|---|
| **Paid revenue** | real consumer spend | by useful work, equal-for-equal | **never gated** |
| **Bootstrap pool** (≤1,500 KAI/day) | protocol reserve | reputation-**gated** exposure | yes |

"Identical completed useful work has the same base value" holds — that's the paid stream.
Reputation governs only *exposure to the scarce protocol-funded reward*, exactly the owner's
wording.

## 3. Reputation `r ∈ [0.05, 1]`

Built only from signals the scheduler **already tracks** — no new client trust surface, and
nothing the server takes on a worker's word:

```
r = R_MIN + (1 - R_MIN) · clamp01(
        0.45 · ageScore          // 1 − e^(−ageDays/10)     — time on network (Sybil-HARD)
      + 0.35 · paidDemandScore   // paidJobs/(paidJobs+40)  — real customers served (Sybil-HARD)
      + 0.10 · reliability       // smoothed success rate sr
      + 0.10 · challengePass )   // §17 pass rate over recent window
R_MIN = 0.05
```

- **Weights are deliberate.** Age and paid-demand — the two things a fleet cannot cheaply
  replicate across many identities — dominate. Reliability and challenge-pass, which *any*
  machine running real models maxes out immediately (honest or attacker), carry low weight so
  they can't by themselves lift a fresh fleet over the bar.
- **Non-transferable.** `r` is keyed to the earning identity (wallet address), and should be
  additionally bound to a device/benchmark fingerprint so one proven machine can't "vouch"
  another onto the network. 10,000 wallets = 10,000 *unproven* identities.
- **Earned slowly, lost fast.** A confirmed challenge failure / fraud signal decays `r`
  sharply (asymmetric — building trust takes weeks, losing it takes one caught lie). This is
  the reputation dent the owner specified for ordinary failure; slashing stays reserved for
  provable fraud only (unchanged, narrow).
- **Floor `R_MIN=0.05`, not 0.** An honest newcomer isn't bricked; below the gate it simply
  earns pay-only. The floor matters for the *ungated* linear fallback, not the gate.

## 4. The distribution mechanism: eligibility gate + superlinear ramp

Replace the flat weight `subsidyValue_i` with an **eligibility-weighted** one:

```
elig(r)   = r ≤ R_GATE ? 0 : (r − R_GATE) / (1 − R_GATE)      // 0 at the gate → 1 at r=1
weight_i  = subsidyValue_i × elig(r_i)^GAMMA
minted_i  = weight_i × (pool / Σ weight_j)                     // same pool, same cap, reweighted
R_GATE = 0.45,  GAMMA = 2      (tunable)
```

- Below `R_GATE`: **zero** pool exposure. Full paid revenue still flows.
- Above it: exposure ramps **superlinearly** (γ=2), so freshly-over-the-bar nodes still draw
  little and only well-proven nodes draw near-full. This is what a plain linear weight lacks.
- **Total emission is unchanged**: it's the *same* pool divided among the *same* receipts,
  only reweighted. The ≤1,500 KAI/day ceiling and "unused → reserve" behavior are untouched.
  If everyone is below the gate (early cold-start), the pool simply sits in reserve that day.

Scheduler seam: this is a change to `_networkSubsidyBudget` (weight `demandSat`) and the
`minted()` closure in `_settleFor` (weight each receipt's mint by the worker's `elig^γ`).
The guaranteed-floor consumption path (`_consumeCapacity`, `poolSat:0n`) is **not** touched —
consumers still spend only against real paid revenue.

## 5. Simulation results

`node tools/sybil-sim.js` (deterministic, dependency-free). 10 honest nodes vs a **40-node
fake fleet (4:1)**, 28-day window, pool 1,500 KAI/day, gate 0.45, γ=2. "Capture %" = the
fleet's share of the whole pool.

### Cold-start (honest + fleet both fresh — the hardest case for the defender)
| Attacker | flat (today) | linear | **gated** | flat→gated |
|---|---|---|---|---|
| `scripted` | 0.0% | 0.0% | 0.0% | n/a |
| `compute-backed` | 80.3% | 74.7% | **30.1%** | 63% |

### Established network (honest 30d old, fleet fresh — the realistic case)
| Attacker | flat (today) | linear | **gated** | flat→gated |
|---|---|---|---|---|
| `scripted` | 0.0% | 0.0% | 0.0% | n/a |
| `compute-backed` | 79.8% | 69.6% | **21.7%** | 73% |

### Established network vs a fresh compute-backed fleet — over time
| Day | honest r | fleet r | flat cap | linear cap | **gated cap** |
|---|---|---|---|---|---|
| 1 | 0.66 | 0.23 | 79.8% | 58.2% | **0.0%** |
| 7 | 0.85 | 0.44 | 79.8% | 66.8% | **0.0%** |
| 14 | 0.94 | 0.57 | 79.8% | 70.7% | **20.5%** |
| 28 | 0.97 | 0.71 | 79.8% | 74.1% | **48.9%** |

**What this says:**
- A **scripted** fleet gets ~0 under every scheme — §17 challenges already gate it. Reputation
  is layer 2, for fleets that *do* pass challenges by running real models.
- **Linear weighting is not enough** — a 4:1 fleet still takes ~70–75%, because share stays
  roughly proportional to volume. This is why the naive "multiply by reputation" fix fails and
  the **gate** is the load-bearing idea.
- The **gate** cuts capture by 63–73% and, against an established network, holds a fresh fleet
  at **0% for two weeks.** The fleet only converges toward its numeric share by paying weeks of
  real compute across 40 machines with no pool reward — that cost *is* the deterrent.

## 6. Rollout (shadow-first, same discipline as §17)

1. **Shadow.** Compute `r` and the *would-be* gated shares every epoch; **log** them and expose
   them in the admin network view; keep distributing by flat pro-rata. Watch for real honest
   nodes that the gate would wrongly starve. Env: reputation computed always, enforcement OFF.
2. **Verify** against field data: do our 3 real honest workers clear the gate? Does any honest
   newcomer get stuck below it longer than intended? Tune `R_GATE`, weights, `AGE_TAU`.
3. **Arm** on the subsidy pool only, behind `KAI_REPUTATION_ENFORCE` (default off), the same way
   `KAI_CLASS_ENFORCE` / `KAI_CLAMP_ENFORCE` gate §17. Flip when shadow data looks right.

## 7. Probe (must FAIL on old code, PASS on new — the standing rule)

`scripts/probe-reputation.js` will assert, against a synthetic epoch:
- A fresh 4:1 compute-backed fleet captures **< 35%** of the pool under enforcement (fails today:
  flat gives ~80%).
- Two workers doing **identical useful work** receive **identical paid revenue** regardless of
  reputation (equal-work-equal-pay invariant — fails if reputation ever leaks into pay).
- A mature honest worker clears the gate and draws near-full exposure; a below-gate worker draws
  **0** subsidy but **non-zero** pay.
- Total minted across all workers **≤ pool** (ceiling invariant preserved).

## 8. Honest limitations (state these, don't paper over them)

- **A patient, funded attacker converges.** Given weeks of real compute on many machines, a
  fleet's reputation rises and it approaches its numeric share (day-28 ≈ 49% above). The gate
  buys *time and cost*, not immunity. The further layers exist for exactly this: the paid-demand
  term (a fleet with no real customers stays suppressed as usage grows), **optional mainnet
  staking** (per-identity capital cost — never required to start, no passive yield), and anomaly
  detection on device/benchmark fingerprints.
- **Cold-start is the weak case.** When honest nodes are themselves brand-new, reputation can't
  yet tell them from a patient fleet; resistance leans on age + challenge-compute-cost + the daily
  cap until paid demand diverges. The 1,500 KAI/day ceiling caps the worst case regardless.
- **Gate hardness is a real trade-off.** `R_GATE=0.45` means an honest newcomer earns pay-only
  for its first several days. That's the owner's "new machines get limited subsidy exposure" —
  but the exact bar is an owner call (§9).

## 9. Owner decisions before this ships

1. **Gate hardness `R_GATE`** (0.45 default): how many days should a brand-new honest machine
   earn pay-only before it can draw from the pool? Lower = friendlier to newcomers, weaker
   against fresh fleets.
2. **Weights**: is 0.45 age / 0.35 paid-demand / 0.10 reliability / 0.10 challenge the right
   emphasis? (Paid-demand strengthens as real usage grows.)
3. **Shadow period length** before arming.
4. **Device fingerprint binding** — do we want `r` bound to a hardware/benchmark fingerprint now
   (stronger, more engineering) or wallet-only for phase 1?

Once these are set, next builds are: (a) shadow reputation + admin surfacing, (b) the probe,
(c) adversarial multi-agent review, (d) arm behind the env flag.
