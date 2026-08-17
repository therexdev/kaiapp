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

## Price source: the on-chain vKOIN/USDT market (owner-chosen, validated 2026-08-17)
The reference is the real tradeable market — **vKOIN** ("Vortex Koin", the KOIN market on
Ethereum), token `0xa50ad3a559a10f384a5bb2e27516f63e0b937b1a`, whose deepest pair is the
Uniswap-v4 vKOIN/USDT pool. Read via **two independent aggregators** of the SAME token for
median-of-two redundancy (either can carry if the other is down; a single manipulated feed
can't move a median of two):

| Source | URL | path | value 2026-08-17 |
|---|---|---|---|
| DexScreener | `…/latest/dex/tokens/0xa50ad3…b937b1a` | `pairs.0.priceUsd` | 0.008735 |
| GeckoTerminal | `…/networks/eth/tokens/0xa50ad3…b937b1a` | `data.attributes.price_usd` | 0.008687 |

**Note the discrepancy that motivated this**: CoinGecko's `koinos.usd` reported ~$0.042 —
~5× the actual vKOIN/USDT DEX price (~$0.0087). The on-chain market is the honest number.
This market is thin (~$14.5k liquidity), so price can be volatile — which is exactly what the
oracle's breakers (median, ±10%/epoch step, floor/ceil, stale-hold) are for. Dead free feeds
(don't list KOIN or need a key): CryptoCompare, MEXC, KuCoin, CoinCap, CoinPaprika, Gate.io.

## Enable (run on the box as root)
Floor/ceil bracket the ~$0.0087 vKOIN price; the anchor doubles as the all-sources-down fallback:

```bash
cat >> /opt/koinos/kai.env <<'EOF'
KAI_PRICE_SOURCES=[{"url":"https://api.dexscreener.com/latest/dex/tokens/0xa50ad3a559a10f384a5bb2e27516f63e0b937b1a","path":"pairs.0.priceUsd"},{"url":"https://api.geckoterminal.com/api/v2/networks/eth/tokens/0xa50ad3a559a10f384a5bb2e27516f63e0b937b1a","path":"data.attributes.price_usd"}]
KAI_REF_USD=0.0087
KAI_PRICE_FLOOR_USD=0.001
KAI_PRICE_CEIL_USD=0.05
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
sed -i -E '/^KAI_(PRICE_|REF_USD)/d' /opt/koinos/kai.env && systemctl restart koinos
```

## Safety
- Testnet only; no real money. Fully reversible in one restart.
- Break-tests for spike / crash / stale / all-down / outlier / breaker / recovery already pass
  offline: `kai/scripts/probe-oracle.js`.
- Feed formats validated live via the kaiapp Netcheck `[pricecheck]` step.
