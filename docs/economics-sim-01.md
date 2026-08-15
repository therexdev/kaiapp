# §52 Economic Simulation 01 — provider break-even sweep

**Status:** first pass at the spec's Required Economic Simulation Queue.
**Regenerate:** `node tools/econ-sim.js --md` (all inputs are named constants
at the top of the script — vary one at a time).

Unlike a whiteboard model, this run is anchored in **measured alpha data**
from the 2026-08-15 §46.3 acceptance run: the real request shape
(1,243 in / 230 out tokens per request across 10 live network chats) and the
real eval-subsidy cadence (5 receipts per 15-minute epoch per provider).
Rates are the shipped PROVISIONAL ones: $0.10/M input, $0.40/M output,
1 KAI per eval receipt, 25,000 free tokens per epoch per address.

## Results

Request shape (measured): 1243 in / 230 out tokens -> $0.0002163/request

### 1. Chat-only provider economics ($0.15/kWh, 3-year amortization)

| GPU | util | req/hr | chat $/hr | power+amort $/hr | margin $/hr |
|---|---|---|---|---|---|
| CPU-only (8c) | 5% | 3 | 0.0006 | 0.0097 | -0.0091 |
| CPU-only (8c) | 25% | 14 | 0.0030 | 0.0097 | -0.0067 |
| CPU-only (8c) | 60% | 34 | 0.0073 | 0.0097 | -0.0025 |
| CPU-only (8c) | 90% | 50 | 0.0109 | 0.0097 | 0.0012 |
| RTX 3060 | 5% | 11 | 0.0024 | 0.0362 | -0.0337 |
| RTX 3060 | 25% | 56 | 0.0121 | 0.0362 | -0.0240 |
| RTX 3060 | 60% | 135 | 0.0291 | 0.0362 | -0.0071 |
| RTX 3060 | 90% | 202 | 0.0436 | 0.0362 | 0.0075 |
| RTX 4070 | 5% | 20 | 0.0042 | 0.0498 | -0.0455 |
| RTX 4070 | 25% | 98 | 0.0212 | 0.0498 | -0.0286 |
| RTX 4070 | 60% | 235 | 0.0509 | 0.0498 | 0.0011 |
| RTX 4070 | 90% | 353 | 0.0764 | 0.0498 | 0.0266 |
| RTX 4090 | 5% | 44 | 0.0096 | 0.1322 | -0.1226 |
| RTX 4090 | 25% | 222 | 0.0480 | 0.1322 | -0.0842 |
| RTX 4090 | 60% | 532 | 0.1152 | 0.1322 | -0.0170 |
| RTX 4090 | 90% | 799 | 0.1728 | 0.1322 | 0.0406 |

### 2. Break-even utilization (chat revenue covers power + amortization)

| GPU | $0.08/kWh | $0.15/kWh | $0.25/kWh |
|---|---|---|---|
| CPU-only (8c) | 43% | 80% | >100% |
| RTX 3060 | 50% | 75% | >100% |
| RTX 4070 | 42% | 59% | 82% |
| RTX 4090 | 52% | 69% | 92% |

### 3. KAI price ladder (RTX 4070 @ 60% util, plus the eval subsidy)

| KAI ref price | chat KAI/day | eval subsidy KAI/day | subsidy USD/day | subsidy share of income |
|---|---|---|---|---|
| $0.005 | 244.4 | 480 | $2.40 | 66% |
| $0.01 | 122.2 | 480 | $4.80 | 80% |
| $0.02 | 61.1 | 480 | $9.60 | 89% |
| $0.05 | 24.4 | 480 | $24.00 | 95% |
| $0.1 | 12.2 | 480 | $48.00 | 98% |
| $0.2 | 6.1 | 480 | $96.00 | 99% |
| $0.5 | 2.4 | 480 | $240.00 | 99% |

### 4. Protocol-funded liabilities (per day)

| Liability | Unit | USD value | At $0.01/KAI | At $0.50/KAI |
|---|---|---|---|---|
| Eval subsidy | per provider-day | rate-independent mint | $4.80 | $240.00 |
| Free allowance (fully drained) | per address-day | $0.3524 | 35.2 KAI | 0.70 KAI |

Eval subsidy/day/provider = 5/epoch x 96 epochs = 480 KAI minted regardless of the KAI price.
Free allowance liability is PER ADDRESS and addresses are free (Sybil surface).

## Findings

**F1 — The eval subsidy dominates provider income at every KAI price
(66–99%), and an uncapped mint is a real risk.** The observed 5 receipts ×
96 epochs = 480 KAI/provider-day is protocol-funded regardless of demand.
Today the *global* mint happens to be bounded by the seed loop's
backpressure (one job per 45s tick, queue ≤ 3 → ≈ 1,920 KAI/day network-wide
shared across all providers), but that is an accident of the dispatcher, not
a declared budget — and §54 explicitly supersedes "permanent fixed subsidy on
every inference job" with **capped bootstrap budgets**.
→ **Actioned in this change:** `KAI_EVAL_CAP_PER_EPOCH` (default 8) — eval
receipts beyond the cap per worker per epoch still count for honesty stats
but mint nothing. Applied identically in pending-balance display,
authorization capacity, and epoch close, so displayed and settled amounts
never disagree. The default sits above the observed single-worker cadence,
so today's behavior is unchanged; it is now a ceiling, not a hope.

**F2 — At the current PROVISIONAL token rates, chat-only economics clear
break-even only at 40–90%+ utilization** (Table 2), depending on hardware
and electricity. That is the normal marketplace shape (idle hardware loses
money), and it is exactly what the §16 bootstrap subsidy exists to bridge —
but it tells us the *order* of §52 iteration: as organic demand grows, either
utilization rises, token rates rise, or targeted shortage bonuses (§16)
replace the flat subsidy. Rates should not be cut before utilization data
exists.

**F3 — The free allowance is a per-address Sybil surface.** 25,000
tokens/epoch fully drained ≈ $0.35/day *per address*, and addresses are
free. Not urgent at alpha scale (the drain still requires a provider to
serve it, and the allowance pays providers real receipts — it is marketing
spend, not theft), but before public launch the §51 queue item stands:
per-device/IP rate limits and risk scoring at `/consume`, on top of the
signature identity that already exists.

**F4 — Price-ladder liquidity (§52 staged discovery):** a single RTX 4070
provider at 60% utilization cashing out daily sells ≈ $6/day of KAI at any
reference price (chat value + subsidy × price). KoinDX paired-liquidity
requirements therefore scale with *provider count × payout cadence*, not
with the KAI price itself — depth planning should key on provider counts.

## Still open in the §52 queue

Multi-model classes (only koinos-fast exists), regional electricity
distributions, organic-vs-bootstrap demand separation over real weeks of
data, protocol fee/burn scenarios, treasury runway modeling, royalty bounds
(§20 splits), and the staged price-discovery ladder simulations.
