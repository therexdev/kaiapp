# USD credits contract product

Product identifier: `prepaid-usd-v1`. Fresh contract addresses and code hashes are required; do not upload this WASM over either refundable custody or `prepaid-v1`.

## Customer flow and units

Buy credits → one native wallet payment approval → irreversible purchase confirmation → credit balance → normal Chat. The approval displays KOIN amount, USD value, credits, price expiry and payment destination. Credits are nontransferable, nonrefundable service entitlements with no expiry; they are not KOIN custody or a redeemable USD stablecoin.

| Quantity | Atomic unit | Display |
| --- | --- | --- |
| Native KOIN | 10^-8 KOIN | 8 decimals |
| Purchased/consumed credits | 10^-8 USD | 100,000 atoms = 1 credit |
| USD service denomination | 100,000,000 atoms | $1 = 1,000 credits |
| Model input/output tariff | USD atoms per million tokens | Must be explicitly priced in USD |
| Provider reward | 10^-8 KOIN | Native KOIN |

The 1,000 credits/$1 denomination is an implementation default, not a per-model tariff. The operator must select actual USD input/output prices before deployment. Old KOIN tariff numbers cannot be reinterpreted as USD prices.

`credit_atoms = floor(koin_atoms × usd_per_koin_atoms / 100,000,000)`. Multiplication/division uses 128-bit arithmetic in WASM and BigInt in JavaScript. Zero-output purchases and uint64 overflows are rejected. Example only: at $0.25/KOIN, 2 KOIN purchases $0.50 = 500 credits. If KOIN later halves in price, those 500 credits are unchanged; a new 2 KOIN purchase would buy 250 credits.

## Purchase contract

`prepaid-usd.wasm` implements a domain-bound price signature: `KAI-USD-PURCHASE-V1\0`, chain ID, credit contract, Master Node, and canonical protobuf purchase quote. The pinned verifier signs the account, exact KOIN payment, USD credit amount, price, policy version, unique quote ID and expiry (at most five minutes). The contract checks the signature and conversion, owner authority, current policy and block time, and rejects reused quotes.

The owner transaction atomically grants the exact native-token allowance and calls purchase. Purchase transfers the KOIN directly from buyer to **15CM9Qr4GKREDgqnyXJ8tckPj2biERTM1T**, verifies the recipient balance delta, then records account credit and the purchase event. A failed transaction rolls back both operations. The backend credits a purchase only after verifying irreversible inclusion, exact operation bytes, native transfer and matching credit-attribution event. A quote may expire while finality is pending; expiry never invalidates a purchase already included successfully.

## Chat and accounting

The server transactionally accounts for a verified answer before returning its plaintext. Failed, cancelled or interrupted unfinished work releases its bounded internal hold. The saved encrypted answer and receipt permit recovery without a second debit. Durable settlement records consume the same credits on-chain later, once per charge ID; USD settlement makes no KOIN transfers. Existing credits are independent of purchase-price availability and reward-payout progress.

A submitted wallet transaction can remain pending until its outcome is known. This is shown as purchase confirmation and does not freeze existing service credits. Saved signatures are reconciled or resubmitted exactly; unknown network state is not treated as proof of failure.

## Separately funded rewards

The reward contract uses `reward_basis = 1`; each epoch snapshots that basis. Default daily budget is 5% of native KOIN **not already committed** to outstanding reward days. The first partial UTC day is prorated; no backdated rewards are minted for downtime. A full day starting with 10,000 uncommitted KOIN budgets 500 KOIN: 350 for qualified model availability, 150 for verified completed work. Without replenishment, the next full-day budget is 475 KOIN after the first 500 is committed or paid.

Existing model-size/coverage/reliability and qualification rules determine availability. Work receives a proportional share of the work budget, weighted by verified USD consumption. The contract caps each provider at `floor(work_budget × provider_consumption / total_consumption)`. This replaces the legacy KOIN-spend cap only for the new product; USD credits and KOIN rewards are never compared as if they were the same unit. With no eligible work, its slice stays in the pool. Unused allocations and rounding stay in the pool.

The backend opens days, commits signed allocation roots, waits the existing one-day review and irreversible confirmation, and sends claims automatically. Daily accounting does not mean immediate same-day payment. A payout failure never reverses a customer's paid answer or blocks another chat.

The pool can receive ordinary native KOIN transfers from the Master Node. Configure the deployed pool as the Master app's daily distribution recipient; preserve its existing production reburn/Mana-retention policy. The 10,000 KOIN seed is separate from operational Mana funding. Neither the seed nor a new Master distribution setting has been sent/applied by this change.

## Trust and launch gates

### Contract verification

The native Koinos rehearsal deploys fresh contracts, uses the private desktop purchase and normal Chat clients, transfers native fixture KOIN to the Master account, seeds a separate 10,000 KOIN pool, recovers a lost settlement response, and pays the provider automatically. Legacy customer principal remains intact. The compiled-WASM suite additionally checks real quote signatures, price changes, replay/domain/expiry failures, atomic transfer failure, integer limits and maximum-depth reward proofs.

Builds explicitly use AssemblyScript's `stub` allocator: each bounded invocation owns its allocations until the VM discards that instance. The default incremental runtime reproduced a native-only pause trap; diagnostic logging hid it. Switching the allocator with the original pause body restored the complete native sequence, including repeated pause/resume on both prepaid products and rewards. This identifies a runtime compatibility issue, not an independently established upstream compiler root cause. Requests remain limited to 16 KiB and claims to 16 siblings. The WASM test exercises a valid 16-sibling claim and rejects 17/400-sibling inputs while staying below 1 MiB per tested invocation. Native receipts remain the basis for production Mana calibration.

The pinned verifier attests the market quote and work/availability evidence. Contracts enforce signatures, identity, conversion, budgets, sum proofs and duplicate protection; they cannot independently determine external USD market value or semantic answer quality. Model qualification and economic abuse controls remain backend responsibilities. This has not received an independent contract audit.

The initial purchase-price adapter requires two fresh KOIN/USD market observations, maximum age ten minutes, disagreement at most 10%, no stale fallback, and a five-minute signed purchase quote. These are backend implementation defaults. They must pass live feed validation before funding/launch. On October 16, 2026, the CoinGecko KOIN endpoint returned a March timestamp and the CoinPaprika ticker was unavailable. The app's existing Uniswap dashboard quote is a spot estimate from a thin pool, not a reviewed purchase oracle; it has deliberately not been substituted silently. A dependable current feed (or a reviewed time-weighted pool oracle and liquidity policy) is still required.

Remaining live gates: choose USD model tariffs and validate production market data; prepare exact new contract addresses, seed plus operational funding budget; deploy and verify code/policy pins; configure Master daily funding; then run the actual two-computer Buy credits/Chat and provider On/Off acceptance including retries, disconnects, restart and a delayed payout. Resolve the old 0.1 KOIN obligation from its original records. Code release does not complete these live gates.
