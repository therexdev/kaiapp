# KOIN implementation status

This is the Test implementation of the approved plan. It includes contract
prototypes and shadow protocols, not an activated KOIN payment system.

The master draft now includes a durable synthetic job ledger, a pinned Qwen
tokenizer loader and an operator-controlled HTTP job flow. This Test worker can
opt in with `KAI_KOIN_SHADOW_JOBS=1`. It checks the public model hash, exact
quote/prompt commitment and local llama.cpp token IDs, then uses raw completion
with the quoted output limit. Shadow receipts and job totals stay separate from
legacy rewards. Normal workers remain opted out. See the master repository's
`docs/koin-paid-jobs.md` for configuration and current integration limits.

## Implemented

- Integer KOIN accounting, 5% free-balance budgets, 70/30 availability/work
  allocation, 60/25/15 consumed-revenue split, and the 80% paid-work cap.
- Two separately built contracts. Credits retain unused customer principal,
  reserve bounded session grants, accept verifier settlements, and refund
  available principal. Rewards reserve daily budgets, review roots for 24
  hours, validate Merkle-sum claims and preserve committed liabilities.
- Owner policy changes have a 48-hour notice and UTC-day boundary. Emergency
  pause blocks new spending and reward commitments; refunds, expired-session
  releases and finalized claims remain available.
- Chain client checks native-token identity, pinned chain/bytecode/roles and
  exact transaction intent. This client is not connected to desktop signing.
- Signed resident-model telemetry with timestamp, sequence and scheduler
  domain binding. Collection requires an operator-issued capacity qualification.
  Full minute coverage is conservative: a model switch, report gap or missing
  boundary observation earns nothing for that interval. Only qualified slots
  are scored. These estimates are always labelled simulated.
- KOIN Earn/wallet screen, translated into all five app languages. Legacy test
  KAI is separate. Credit purchases and claims remain disabled. No migration,
  seed transfer, burn, deployment or master-wallet configuration is performed.

## Master integration

`therexdev/kai/lib/scheduler.js` is the canonical master; `server/scheduler.js`
in this app is a test fixture and must not be deployed. The companion master
review branch is `claude/koin-shadow-integration`. It mounts the shared shadow
router behind an explicit switch and advertises its capability during worker
registration and balance reads. Default operation is unchanged.

On an isolated master instance, set `KAI_KOIN_SHADOW=1`, an operator secret,
and `KAI_KOIN_AUDIENCE` to the exact public scheduler base URL without a trailing
slash. The router needs no signing key. All monetary amounts below are decimal
strings in KOIN atoms (100,000,000 atoms per KOIN).

| Route | Access | Effect |
| --- | --- | --- |
| `GET /koin/status?address=...` | Public | Shadow status; never a spendable balance |
| `POST /koin/presence` | Wallet-signed, fresh report; qualified address | Record a current model observation |
| `POST /koin/shadow/qualify` | `x-operator-secret` | Record benchmark hash, unique capacity ID, model/hash/weight, bounded coverage and expiry within one day |
| `POST /koin/shadow/open` | `x-operator-secret` | Open a **simulated** budget using supplied balance/liabilities; does not read or move chain funds |
| `GET /koin/shadow/manifest?epoch=...` | `x-operator-secret` | Reproducible closed-day allocations plus content hash |

Presence contains only public model identity, readiness and replay-protection
metadata. No prompt, output, Brain memory, provider credential or private model
is sent. Reports stop with the earning worker and are not sent to older masters.
The shadow ledger is a separate file, written atomically; production operation
still needs tested backup, disk-loss recovery, retention and load limits.

## Required before paid activation

1. Implement and calibrate master-observed token metering, tariffs, SLA/challenge
   results and a durable per-job reservation ledger inside each on-chain grant.
   The master has a synthetic reservation/receipt flow and pinned tokenizer
   support, but funded grants, measured tariffs and real paid-work ingestion
   remain disabled. Provider token counts and signed presence are not proof of
   useful work. The Qwen tokenizer has reference vectors; hardware costs and
   accepted SLA/challenge rules still need measurements.
2. Implement finality-aware reconciliation, signed reward manifests, keeper
   recovery and sponsored claim submission. Read-only finality reconciliation
   and synthetic restart/fork/replay tests are implemented in the master draft.
   The current reward manifest remains hashed, not signed; no keeper broadcasts.
3. Benchmark real providers and complete at least seven days of shadow data.
   Validate capacity deduplication, model-switch observations, workload costs
   and collusive/self-funded work. The work cap is not a proof that all economic
   manipulation is impossible.
4. Review and test both contracts on an isolated chain, including actual native
   token transfers and resource costs. Unit and WASM tests use the SDK MockVM;
   they are not an independent audit. Custody currently trusts owner-held
   contract keys, which can upload replacement code; the policy notice does
   not constrain that key's upgrade authority. Decide the upgrade guard before
   deployment and keep the final bytecode pins under review.
5. Implement the reviewed desktop purchase/session/refund/claim flows with
   password or external-wallet confirmation and exact transaction previews.
   No scheduler setting may enable the old arbitrary-transaction deposit flow.
6. Complete a concrete deployment manifest: chain ID, native KOIN contract,
   credits/rewards addresses and bytecode hashes, owner/verifier/sponsor roles,
   funding destinations, tested resource limits and activation date. Do not put
   keys in the manifest. Owner review covers the intended 1,000 KOIN seed and
   master distribution destination before any transaction.
7. Track consumed-revenue mining transfers as new capital and implement the
   separately authorized Proof-of-Burn/reconciliation route. The existing
   master's earned-reward reburn and retained-wallet settings are unchanged;
   incoming deposits are not automatically counted as block rewards.

## Verification

```sh
npm test
npm ci --ignore-scripts --prefix contracts/koin-network
npm test --prefix contracts/koin-network
npm run build --prefix contracts/koin-network
node contracts/koin-network/scripts/probe-runtime.js
```

The Test release gate runs these checks and publishes separate credits/rewards
WASM files, their ABIs and these documents. Browser CI covers the existing
wallet create/unlock/restore flow and inactive KOIN controls. Financial tests
cover custody conservation, replay, caller authority, settlement deadlines,
late epoch opening, payout caps, duplicate claims, root review and failed
transfer rollback. Runtime tests execute the compiled entry points as well as
contract-class unit tests.
