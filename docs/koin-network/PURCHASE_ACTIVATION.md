# Credit purchases: current status and activation handoff

Evidence checked October 20, 2026. Desktop baseline: Test 195.1,
`30b51d000a4946f7a857e3c1d75e4a87a95fc958`. Backend implementation:
`therexdev/kai`, branch `codex/revision2-implementation`,
`ba82f8a59b1543f54d43e2ae1071288589de1e68`.

## What the missing balance means

The wallet's KOIN and the account's AI credits are different balances. Native
KOIN can be read through the existing `wallet:summary` / `chain:balances` paths
without a credit service or purchase quote. Test 195's Buy page omitted that
wallet read. Its blank credit total is not evidence that the wallet is empty.

Purchasing has a separate, confirmed blocker:
`core/lib/koin-network/credit-service.json` declares `state: unavailable`.
`electron/credit-service.js` rejects purchase requests before requesting a
quote. An old pilot deployment does not activate this new USD service. The
backend checkpoint also records that the new public service was not deployed;
this repository contains no verified production USD deployment manifest.

A bounded public read of `https://payments.koinosai.com/health` returned HTTP
200 with `mode: mainnet-pilot` and `mainnetPaymentsEnabled: true`, but no
`product` field. That shows the existing pilot responds; it does not establish
`prepaid-usd-v1` activation. The current backend emits an explicit product in
health responses, which must be checked against the deployment evidence.

Showing KOIN and an immediate explanation fixes the screen. It does not enable
payments. Changing the manifest to `ready` without actual deployed pins would
not complete the product.

## Smallest next deliverable

Prepare one **paid Chat pilot activation package** on the operator machine:
one supported model, a selected USD tariff, a validated live purchase-price
configuration, exact fresh contract identities and code hashes, an operational
funding budget, and the public desktop manifest. This is the next concrete
backend task; another visual redesign or manual old-account reserve is not
required. Generate the package before requesting approval for its exact
deployment transactions or transfers.

The backend sources are in the separate `therexdev/kai` repository, not this
desktop checkout. Existing scripts support preparation, but the operator's
private bootstrap directory, live service configuration, credentials and
approved numerical settings are not supplied by this app checkout. Do not
substitute fixture values or an earlier pilot's contract addresses.

## Sequence and evidence

1. **Prepare settings and read-only price evidence.** Start from backend
   `deploy/koin-mainnet/settings.prepaid-usd.example.json`, using
   `mode: mainnet-prepaid-usd-plan` and `settings.accountMode: public`.
   Its null amounts are deliberate missing inputs, not deployable defaults.
   Add `settings.purchasePricing` using the schema in
   `V4_PURCHASE_PRICING.md`. The implemented adapter uses the pinned Ethereum
   Uniswap v4 vKOIN/USDT pool; a dashboard spot price cannot replace it.
   Validate the resulting runtime configuration with
   `node scripts/validate-koin-purchase-pricing.js <runtime-config.json>`.
   This command makes no network calls or transactions; canonical archive
   history, executable depth and fresh oracle evidence still need bounded
   live read-only verification.
2. **Produce the exact private deployment package.** Build this desktop's
   `contracts/koin-network` artifacts. On the operator machine, backend
   `prepare.js ABS_PRIVATE_DIR SETTINGS_JSON BUILT_WASM_DIR` verifies chain
   identity and creates new role keys, `plan.json` and `plan-hash.json` without
   signing or broadcasting. After reviewing that plan, backend
   `setup.js configure --dir ... --approve ...` writes `deployment-plan.json`,
   its hash, `runtime.json` and restricted runtime keys. Keep generated keys
   on the operator machine and back them up; never commit them.
3. **Deploy the reviewed identities and service.** This is a real operation,
   not something the desktop release performs. Existing backend `setup.js`
   commands are `check-funding`, `tokenizer` and `deploy`; `deploy` requires
   the exact deployment-plan hash and signs/broadcasts contract transactions.
   It exports `desktop-manifest.json` only after verification.
   `install-prepaid.sh` installs the separate `kai-koin-prepaid.service` on
   loopback port 3109. Review its actual service/configuration changes before
   execution, then verify the intended HTTPS `/health` response and public
   account authorization. Preserve the old service and journals.
4. **Connect the app to verified deployment evidence.** Populate the packaged
   credit-service manifest with `schema: 1`, `state: ready` and the verified
   USD configuration, excluding the owner-specific field. The manifest
   validator in `electron/credit-service.js` already enforces this shape.
   Account origin, scheduler URL, contract hashes and model policy must agree.
   Validate and publish Test with these exact pins.
5. **Accept through the normal app.** On the buyer computer: show native
   wallet KOIN → choose credits → receive a fresh exact quote → one native
   payment review → finalized credit increase. Retry/restart must discover
   that same purchase without another charge. Then send normal Chat to a
   qualified provider on the second computer and verify one usage debit.

## Inputs that still need to be made concrete

| Input | What is required |
| --- | --- |
| Paid model price | USD input/output atoms per million tokens for the initial supported model. The denomination is already 1,000 credits/$1; it is not a usage tariff. |
| Price evidence | Two reviewed archive RPC sources, Ethereum USDT/USD feed, explicit averaging/depth/deviation limits and a fresh signed wrapped/native parity attestation. The schema and adapter exist; production values/evidence do not come from fixtures. |
| Operator deployment | Private bootstrap location, intended HTTPS account/scheduler origin, fresh identities and verified code hashes. Use existing operator access; do not put secrets in the app. |
| Operational budget | Measured deployment/transaction Mana limits, per-role KOIN funding and a total ceiling covering the exact plan. Prepare amounts and destinations for review rather than treating release permission as transfer permission. |
| Paid Chat availability | A current qualified provider/model and matching settlement configuration. A purchasable credit is not proof that an answer can be served. |

Routine engineering choices belong in the prepared package: use the existing
separate prepaid service layout, public account mode and one supported model
for the first acceptance. Developers should select and validate ordinary
timeouts, polling and test fixtures without sending each choice back to the
owner. Commercial prices, actual funding and externally attested market
evidence must remain explicit.

## Keep the scopes separate

| Scope | Needed now |
| --- | --- |
| Show native wallet KOIN | Independent read and clear loading/error state. No new contracts, quote or transfer. |
| Execute a credit purchase | Fresh USD deployment, authenticated service, valid signed quote, payment review and finalized credit attribution. |
| Deliver paid Chat | The purchase foundation plus chosen USD tariff, qualified provider, metering and settlement. Accept before presenting the service as usable. |
| Free credits | Explicit account/network/origin USD budgets, eligible models and matching sponsorship limits/funding. Backend public accounts work without `freePolicy`; no free entitlement is invented. |
| Automated rewards | Separate 10,000 KOIN seed, daily Master funding allocation, eligibility, payout operation and delayed-payout acceptance. These are not direct quote prerequisites. |

The existing preparation script budgets the reward seed alongside role funding;
that is its deployment-package structure, not a requirement to pay out rewards
before showing a wallet balance or quoting a purchase. Preserve the agreed
reward plan while keeping its activation evidence separate. Earlier KOIN
obligations remain recoverable in their original product; they are neither
silently converted into USD credits nor a reason to hide the wallet.

References: [USD credit semantics](USD_CREDITS.md),
[implementation checkpoint](REVISION_2_CONTINUATION.md), and backend
`REVISION_2_IMPLEMENTATION.md`, `V4_PURCHASE_PRICING.md`,
`deploy/koin-mainnet/prepare.js`, `deploy/koin-mainnet/setup.js` and
`lib/koin-network/prepaid-router.js` at the revision above. The older backend
`PREPAID.md` statement that the v4 adapter is unimplemented is superseded by
the implementation checkpoint; live pricing configuration remains outstanding.
