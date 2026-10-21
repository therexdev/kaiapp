# Credit purchases: current status and activation handoff

Backend source rechecked October 21, 2026. Desktop baseline: Test 200.1,
`5b9ef8d9b58d2aba9cdbf893b4aaaca457864dd8`. Backend base reviewed:
`therexdev/kai`, branch `codex/revision2-implementation`,
`ba82f8a59b1543f54d43e2ae1071288589de1e68`.

## The next operator action

Run the prepared read-only report on the Vultr server after saving the reviewed
`scripts/koin-credit-activation-preflight.py` file there:

```bash
sudo python3 kai-credit-activation-preflight.py
```

It uses Python's standard library and prints one sanitized JSON report. It checks
the two known services, installed source commits, known runtime/bootstrap paths,
local and HTTPS health, actual public signup capability, configured pricing/free
policy/qualification, and counts of saved purchase, request and reward states.
It never signs, transfers, deploys, restarts, retries or clears a payment. It does
not read wallet keys, runtime signing keys, invitations, account databases or
operator-secret files; no account addresses, credential values, prompts or
transaction payloads are printed. It queries bounded private temporary copies of
SQLite files so even SQLite shared-memory files in the live state remain untouched.
The temporary copies are removed before it exits.

Send that report back. It distinguishes an existing USD installation from the old
pilot without asking the owner to investigate configuration files. Missing at a
known path is not proof that no configuration exists elsewhere. Configured fields
are not claimed valid or funded: on-chain pins, price evidence and funding require
the next read-only checks. A busy database is reported as unavailable to inspect,
never stopped or repaired. `--offline` skips the HTTP checks.

The operator report is the only server action requested at this point. The next
engineering deliverable is a completed activation package using the actual server
state, followed by one review of its exact destinations, transfers and deployment.
The owner should not have to choose polling intervals, JSON fields or RPC retry
settings.

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
That public observation was repeated October 21 UTC; use the report for current status.

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

## A concrete pilot pricing proposal

These are proposed limited-pilot settings for **Koinos Fast**, not an approved
commercial price, a cost-recovery claim or values already installed:

| Setting | Proposal | Configuration amount |
| --- | --- | --- |
| Input usage | $0.10 per million AI tokens | `inputAtomsPerMillion: "10000000"` |
| Output usage | $0.30 per million AI tokens | `outputAtomsPerMillion: "30000000"` |
| Daily free allowance | 7.5 credits per verified account ($0.0075) | `accountDaily: "750000"` |
| Network daily free budget | 300 credits ($0.30; 40 full allowances) | `networkDaily: "30000000"` |
| Origin daily free budget | 22.5 credits ($0.0225; three full allowances) | `originDaily: "2250000"` |
| Free concurrency | One request per account | `accountConcurrent: 1` |

At the higher output tariff, 25,000 AI tokens cost 7.5 credits, so this allowance
covers at least the historical 25,000-token daily entitlement for this model when
network/origin budget is available. Input-heavy usage costs less. For example,
1,000 input tokens plus 250 output tokens costs $0.000175, or **0.175 credits**.
Conversation history is included in measured input; this is not a fixed price per
message. Other models need separately measured and priced tariffs.

The free budget is an accounting/sponsorship ceiling, not an extra $0.30 daily
transfer from the owner. Sponsored work participates in the already bounded
reward pool and is subject to its funding/eligibility checks. The approved 10,000
KOIN seed remains a separate real funding transaction. Reverse-proxy requests
currently share an origin budget unless a trusted origin adapter is configured;
the two-computer pilot must verify this deliberately before a wider cohort.

The owner can approve or change this price/free-allowance proposal as one policy.
The Master funding allocation remains a separate commercial decision; existing
reburn and Mana-retention settings must not be changed by assumption. Engineers
must prepare a specific allocation from the actual Master configuration, not ask
the owner to calculate percentages blind.

## Installation issues found before handoff

At backend base `ba82f8a`, public account setup intentionally creates no invitation
file, but the installer still tries to copy `invitations.json`. The focused
installer correction on the implementation branch makes that copy conditional
on invitation mode. Use the exact reviewed installer revision in the activation
package; the older base alone is insufficient for public installation.

Public sign-in also needs a protected SMTP and/or Google OAuth environment for
the new service. The existing account implementation is reused; its database and
sessions are separate under the prepaid state directory. Reuse approved provider
credentials through a protected service environment, with the new origin/callback
registered as needed. Do not point the new service at the live account database or
assume existing sessions transfer. `/auth/methods` must actually advertise a
working account-creation method. An email/provider credential value must never be
included in the public manifest or report.

The corrected installer uses `/etc/kai-koin-prepaid/account.env`, root-owned with
mode `0600`, generated from a protected, allowlisted JSON input. The preflight
reports only whether that file exists and has private permissions; it never opens
the credential file. Actual signup capability is read from `/auth/methods`.

The pricing attestation must be readable by the unprivileged prepaid service;
the unit's `ProtectHome=yes` prevents reading an attestation left under `/root`.
Prepare a protected service-readable path and safe refresh procedure. Preserve
the quote signature/evidence checks; do not replace an expiring attestation with a
hardcoded 1:1 wrapped/native assumption. These installation checks are engineering
work, not additional user-facing setup screens.

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

## Testing begins in the app

The completed activation package must include free credits, paid purchases, a
qualified provider and the public service pins together. First run the immediate
flow: sign in → see free allowance → normal Chat; then Buy credits → one exact
KOIN approval → confirmed balance → normal Chat → one measured debit. Repeat
Stop, partial-answer recovery, restart, provider Off and a temporarily unavailable
price. Price and payout failures must not freeze existing purchased credits.

Paid requests cannot be assigned to a provider belonging to the same account,
including its other linked wallets. Two computers alone do not establish genuine
customer/provider independence. Use actual independent customer work for reward
acceptance; never create accounts merely to bypass this exclusion. Preserve that
rule when choosing the two-computer test participants.

Provider qualification must run fresh through the guided flow. The expired
October 16 benchmark does not renew itself, and a 7/10 historical result is not
permission to weaken the reviewed quality threshold. Engineering should prepare
unambiguous checks and validate latency on the actual provider computer.

After the immediate buyer/provider flow works, observe **three closed reward
days**, including the existing one-day review and successful automatic payout,
before a limited external cohort. This is the approved Revision 2 acceptance
target; seven telemetry days is not an additional unresolved owner decision. The
daily observation does not delay starting functional Buy credits/Chat testing.

References: [USD credit semantics](USD_CREDITS.md),
[implementation checkpoint](REVISION_2_CONTINUATION.md), and backend
`REVISION_2_IMPLEMENTATION.md`, `V4_PURCHASE_PRICING.md`,
`deploy/koin-mainnet/prepare.js`, `deploy/koin-mainnet/setup.js` and
`lib/koin-network/prepaid-router.js` at the revision above. The older backend
`PREPAID.md` statement that the v4 adapter is unimplemented is superseded by
the implementation checkpoint; live pricing configuration remains outstanding.
