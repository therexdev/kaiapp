# Economics — sprint 02 (mainnet-readiness pass)

> 2026-08-16. Inputs: `tools/econ-sim.js` (constants unchanged from sim-01) plus LIVE
> field data from the alpha network (server-measured speeds, §51 phase 2). Prior
> findings F1–F4: `docs/economics-sim-01.md`. Numbers below are recommendations for
> the owner to accept, adjust, or reject — nothing here changes production by itself.

## What the simulator says, updated with field reality

Sim-01's tables still hold (re-run today, identical): chat-only break-even needs
40–90%+ utilization on every hardware class, and at every plausible KAI price the
**eval subsidy dominates provider income** (80% of income at $0.01/KAI, 98% at $0.10).

New since sim-01: the network now **measures** every provider. The three alpha
machines measure 0.47–6.85 tok/s served — below even the sim's 6 tok/s "CPU-only"
row, and far below its GPU tiers (24–95 tok/s). Alpha economics are therefore
subsidy-carried almost entirely, which is fine for a testnet bootstrap and is
exactly what §16 intended. It is NOT fine on mainnet.

## Findings and recommendations

**F5 — the eval subsidy Sybil-scales and must become a pool before mainnet.**
Today every provider can mint up to 768 KAI/day (cap 8/epoch × 96 epochs) of
protocol-funded evals, and observed cadence mints ~480. That is per PROVIDER, and
providers are free to create: N fake machines → N × 480 KAI/day, at whatever the
market price of KAI is. The bootstrap cap (§54) bounds each worker but not the
fleet. **Recommendation: replace per-provider eval minting with a fixed per-epoch
bootstrap POOL** (X KAI per epoch, total, split across honest eval receipts).
Total emission becomes a constant the treasury can budget for a runway, and Sybil
machines only dilute each other. X is an owner decision (it is your token
emission); the mechanism is a contained scheduler change once X is chosen.

**F6 — keep the rates.** Reaffirming sim-01 F2 with field data: providers are
nowhere near break-even on chat revenue, so cutting rates would be answering a
question nobody asked. Revisit only after real utilization exists. The per-class
ladder (up to $1.00/$4.00 per 1M for 32B) is defensible as listed.

**F7 — bound the free tier globally.** The free allowance is ~$0.35/address-day
and addresses are free; the per-IP ceiling (3×) helps but a botnet has IPs.
**Recommendation: add a global per-epoch free-token budget** (scheduler-wide,
e.g. 40 × the per-address allowance per epoch) so the worst-case daily giveaway
is a fixed dollar figure regardless of Sybil count. Small scheduler change;
degrades gracefully (free tier exhausts for the epoch, paid traffic unaffected).

**F8 — splits activate with one env var.** The 3% verification / 7% protocol
splits are built and tested but inactive without `KAI_TREASURY_ADDR`. Set it at
mainnet launch; at alpha volumes the revenue impact is negligible either way.

## Price oracle: rehearsal now, real feeds at listing

The oracle machinery (median → EMA → step clamp → floor/ceil, stale-hold, epoch
pinning) is built and now hardened (atomic state writes; crossed floor/ceil fails
loudly at boot) — but it has never eaten live data. KAI itself has no market feed
until it lists, so:

- **Now (testnet rehearsal):** run the machinery against real, moving data using
  KOIN feeds as a stand-in reference. Set on the host (one env var, then restart):

  ```
  KAI_PRICE_SOURCES=[{"url":"https://api.coingecko.com/api/v3/simple/price?ids=koinos&vs_currencies=usd","path":"koinos.usd"},{"url":"https://api.coinpaprika.com/v1/tickers/koin-koinos","path":"quotes.USD.price"}]
  ```

  Breakers bound any move to ±10% per refresh inside $0.001–$0.10, and `/pricing`
  publicly shows oracle status for monitoring. This changes the testnet KAI↔USD
  conversion testers see (testnet KAI has no real value — the point is soaking
  the mechanism). Owner's call to set it; the exact string above is ready.
- **Mainnet launch:** stay in anchor mode (operator-set price) until KAI actually
  lists; then flip `KAI_PRICE_SOURCES` to the KoinDX pool quote plus at least one
  independent aggregator, so no single feed can move the median.

## Decisions made & implemented (2026-08-16)

The owner reviewed the findings and set the parameters. All are now IN CODE
(`kai/lib/scheduler.js`), env-overridable, and proven by `kai/scripts/probe-perf-routing.js`:

1. **Bootstrap = a capped network-wide POOL, not a per-machine mint (F5).** Replaced
   the per-worker cap with one pool per epoch, divided across the epoch's *verified
   useful work* (eval/verification + the free-allowance fraction of chat). **Unused
   budget is not emitted — it stays in reserve. Passive uptime earns zero. Paid jobs
   are never capped.** Because the cap is network-wide, N machines don't raise total
   expense — they only dilute each machine's share, so Sybil farming is pointless.
   Initial budget **1,500 KAI/day** (`KAI_BOOTSTRAP_KAI_PER_DAY`, = 15.625 KAI per
   15-min epoch; governance-adjustable). This is *spending from an allocated reserve*,
   not perpetual inflation.
2. **Free tier is DAILY with a global ceiling (F7 + the epoch bug).** Found and fixed:
   the free allowance was resetting every 15-min settlement epoch, i.e. **96× looser**
   than the sim's per-day basis. Now **25k tokens/account/day** + a **~1M tokens/day
   network-wide ceiling** (`KAI_FREE_TOKENS_PER_DAY`, `..._GLOBAL`), tracked by UTC day,
   never reset by a settlement close. When the global ceiling is spent, **only
   public-network free inference pauses until 00:00 UTC — local AI and paid KAI usage
   keep working** (distinct 402 message tells the user which limit they hit).
3. **Terminology fixed:** "epoch" now means only the 15-min settlement window; the free
   tier is stated in "days." No silent double meaning.

## Still owner-gated (not code-forced)

4. **Oracle live sources (testnet rehearsal):** validated surrogate feed —
   `KAI_PRICE_SOURCES` with CoinGecko `koinos.usd` (+ a second source) and
   `KAI_REF_USD=0.042` as the rehearsal anchor. **KOIN is a surrogate for exercising
   the mechanism, NOT a peg — KAI price ≠ KOIN price.** Set on the host when you want
   the rehearsal; the oracle break-test harness (below) proves the machinery first.
5. **Treasury address (F8):** splits (3%/7%) activate the moment `KAI_TREASURY_ADDR`
   is set; choose the mainnet address when ready.
6. **Mainnet contract deploy + adversarial audit of the settlement contract** — still
   the big pre-mainnet gate, separate from these scheduler parameters.
