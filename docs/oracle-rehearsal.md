# Oracle testnet rehearsal (KOIN as a SURROGATE — not a peg)

**Purpose** (owner decision, SOURCE_OF_TRUTH §4.11 / §7.6): exercise the live §51 price
oracle end-to-end on the running network using KOIN's market price as a stand-in feed, to
confirm the machinery — median across sources → EMA smoothing → step/floor/ceil breakers →
stale-hold — behaves on real data before mainnet. **This is NOT a KAI↔KOIN peg**; KOIN is
only a convenient real, moving number to stress the mechanism. It runs on testnet, changes
only testnet billing math, and is fully reversible.

## What it does when enabled
- Without `KAI_PRICE_SOURCES` the oracle is an **anchor**: it holds `KAI_REF_USD` forever
  (today's behavior). With sources set it goes **live**: each epoch close (~15 min) it fetches
  every source, takes the **median** of those that answered, EMAs toward it (`alpha`), and
  clamps the move to `±KAI_PRICE_MAX_STEP_PCT` and to `[floor, ceil]`. If every source fails it
  **holds** the last price (stale-hold), never snapping back to the anchor. One price is pinned
  per epoch, so billing inside an epoch is consistent.
- Movement is deliberately gradual (10%/epoch step cap), so watch it converge over a few
  epochs, not seconds. That gradualness IS the breaker working.

## Available feeds (validated live 2026-08-17 via Netcheck `[pricecheck]`)
KOIN is thinly listed, so free live feeds are scarce. Only **CoinGecko** answers reliably
(`{"koinos":{"usd":0.0419}}`). Dead/rejected: CryptoCompare (now needs an API key), MEXC
(no `KOINUSDT`), KuCoin (`KOIN-USDT` null), CoinCap (host retired), CoinPaprika
(`koin-koinos` exists but `is_active:false`), Gate.io (no pair). So the live rehearsal runs
**single-source**. That exercises fetch → EMA smoothing → step clamp → floor/ceil bounds →
stale-hold → per-epoch pinning. The **median-across-sources / outlier-rejection** breaker
can't be tested live without a 2nd independent feed (none exists free) — it stays validated
by `kai/scripts/probe-oracle.js` (synthetic sources, all cases pass). To test median live
later, add the design's "operator-attested price file" as a 2nd source.

## Enable (run on the box as root)
Explicit floor/ceil bracket KOIN (~$0.04) so the bound breakers are exercised regardless of
the current anchor:

```bash
cat >> /opt/koinos/kai.env <<'EOF'
KAI_PRICE_SOURCES=[{"url":"https://api.coingecko.com/api/v3/simple/price?ids=koinos&vs_currencies=usd","path":"koinos.usd"}]
KAI_PRICE_FLOOR_USD=0.005
KAI_PRICE_CEIL_USD=0.30
KAI_PRICE_ALPHA=0.25
KAI_PRICE_MAX_STEP_PCT=10
EOF
systemctl restart koinos
```

## Watch it
```bash
curl -s http://localhost:3000/pricing
```
`status` moves `anchor` → `live` (or `stale-hold` if feeds are down); `usd` walks toward the
KOIN median over successive epochs. The oracle tolerates a bad/unreachable source — the median
of the ones that answer carries it, and a single manipulated feed can't move a median of three.

## Reverse (back to anchor)
Remove the block (or blank the sources) and restart:
```bash
sed -i '/^KAI_PRICE_/d' /opt/koinos/kai.env && systemctl restart koinos
```

## Safety
- Testnet only; no real money. Fully reversible in one restart.
- Break-tests for spike / crash / stale / all-down / outlier / breaker / recovery already pass
  offline: `kai/scripts/probe-oracle.js`.
- Feed formats validated live via the kaiapp Netcheck `[pricecheck]` step.
