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
- Native-node integration exposed empty protobuf result traps that the original
  MockVM fixtures masked. Zero custody balances and empty credits-call results
  now decode safely; compiled-WASM regressions use the native omitted-field
  encoding, including initial deposits and refunds that empty custody.
- Closing paid-work totals requires the configured Rewards contract as the
  immediate caller. A treasury key signature alone cannot impersonate that call.
- Owner policy changes have a 48-hour notice and UTC-day boundary. Emergency
  pause blocks new spending and reward commitments; refunds, expired-session
  releases and finalized claims remain available.
- Chain client checks native-token identity, pinned chain/bytecode/roles and
  exact transaction intent. This client is not connected to desktop signing.
- Credit purchases and reward-pool funding now prepare one atomic transaction:
  native-token approval for the exact amount/owner/custody contract, followed
  by the matching deposit. Verification rejects partial, reordered, enlarged,
  redirected or additional operations, even with a recomputed transaction ID.
  Native-token identity is checked on every supported network. Submission
  rechecks pause state and uses an immutable snapshot of the reviewed request.
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

### Existing chat integration (rehearsal only)

Normal Network chat can use the master draft's account-grant consumer route.
Set `KAI_KOIN_SHADOW_CONSUMER_URL` before starting Core to a deliberately
configured test master; `earn.schedulerUrl` must match that URL. HTTPS is
required except on loopback. The master must explicitly bind the signed-in
account's existing linked-wallet grant to a separate synthetic session, pinned
model/version and output ceiling. No operator secret is sent to the desktop.
Worker opt-in remains `KAI_KOIN_SHADOW_JOBS=1`.

The existing grant establishes identity and revocation state. Its USD cap is
neither converted to KOIN nor charged by this path. Synthetic session limits
bound reservations independently. Requests use the usual chat screen with no
per-message confirmation. Replies carry a visible no-KOIN-spent label and arrive
after verification, without token-by-token generation streaming. Credentials
remain in Core; worker payloads contain no account token or grant secret.

The client verifies the quote, signed output, receipt ownership and arithmetic.
Master-observed tokenization and challenge acceptance remain trusted master
responsibilities. Stop and Local-Only abort pending HTTP; an already accepted
job retains its hold. A caller can reuse a 64-character lowercase SHA-256
`koin_request_id` to retrieve the same result, never to change the prompt or
restart cancelled work. The ordinary UI does not automatically retry errors.
Results are private, transient and retained for up to five minutes (32 results).
After restart or eviction, a completed request reports its missing answer and
does not run again; durable encrypted delivery is still future work.

The opt-in route refuses fallback to legacy billing. Installation alone enables
nothing on the live master. Regression coverage includes real account grants,
HTTP cancellation/revocation, isolated worker execution, receipt tampering and
cross-repository desktop/master integration. These use fixture inference and
prices; they are not provider benchmarks or evidence of deployed payments.

### One-time funded-session approval (accounting rehearsal)

The master funded ledger now accepts an owner-signed, account-bound session
certificate, separate from both USD grants and per-job signatures. It binds
chain/credits bytecode/policy/domain, funded session, wallet, account, grant,
model/version, output limit, total amount, per-request cap, maximum requests and
expiry. Each funded session permits one durable certificate. Revocation leaves
a tombstone; replay and a new certificate cannot reset its budget. Atomic
reservations count pending holds and settled charges across processes/restarts.
The native review also shows input/output prices per million tokens, checked
against the pinned tariff-policy commitment before signing.

For isolated developer use, set `KAI_KOIN_FUNDED_REHEARSAL_CONFIG` to a local JSON
file before starting Electron. It must contain exactly `schedulerUrl`, `target`,
`session`, `model`, `version`, `maxOutput`, `amount`, `perJob`, `maxJobs`, `expires`.
`target` has exactly `chainId`, `credits`, `creditsHash`, `domain`, `policyHash`.
Use reviewed pins for the isolated deployment, atom amounts as decimal strings,
and UTC epoch milliseconds for expiry. The configured account scheduler must
match the pinned URL. The master requires its explicit `koinFundedSessions`
configuration and the existing signed-in, linked-wallet grant. The app wallet
must be unlocked through its existing wallet controls to sign the certificate.

The KOIN screen then exposes **Review session limits**, **Retry saved approval**,
**Refresh session** and **Revoke session approval**. Native confirmation is
restricted to the trusted main document and accepts no renderer-supplied terms
or signing bytes. Hiding, minimizing, navigation, Local-Only or shutdown aborts
the operation. Once a saved approval may have reached the master, cancellation
reports uncertainty instead of claiming the server did nothing.

The exact signed certificate is saved privately in
`koin-funded-session-approval.json` before submission. It contains no account
session token or private key. Retry first queries the existing approval; a
missing approval can resend the same certificate without another signature.
Server funding observations are transient. After a server restart a retry may
need to observe again and wait for finality. Configuration changes cannot
silently replace a saved approval. This developer prototype supports one
configured session per profile; it is not a general session-management screen.

Revocation stops new reservations and cancels undispatched ones. Dispatched,
accepted and uncertain work keeps its liability and may still be settled by
the accounting rehearsal. This is not on-chain session revocation or a refund.
History remains accessible to its account after unlinking/grant revocation.

With that explicit Electron configuration, normal Network chat now uses the
saved funded-session approval. Before approval, or if configuration is invalid,
it fails closed rather than using legacy billing. The master also requires
`koinFundedSessions.work: { qualify, waitMs }` and an independent `accept`
callback. Workers opt in separately with `KAI_KOIN_FUNDED_REHEARSAL_JOBS=1`.
Default chat, synthetic-session configuration and live token prices are unchanged.

Each request checks current account/grant authority and fresh irreversible
funding before reservation and dispatch. Worker payloads contain only public
pins, session/request IDs, quote and prompt; no account token, grant certificate
or private-wallet capability. The approved public model and exact local token
IDs must match before raw llama.cpp inference. Funded result signatures have a
distinct rehearsal domain. The master independently counts output tokens and
checks acceptance; the desktop verifies the signed result, approved tariff
policy, request, usage arithmetic and prepared settlement commitment.

Accepted work prepares an unsigned settlement intent with the next session
nonce. Later accepted jobs remain verified while that nonce is unresolved.
There is no keeper, signing or broadcast route. A prepared intent is not a
payment. Dispatched timeouts, disconnects and restarts retain their holds and
never requeue automatically. Only undispatched work can release its hold on
Stop. Accepted answers are transient (32 answers/up to five minutes); replaying
the same valid accepted worker result can restore an evicted answer without a
new charge. Otherwise retry reports that the answer is no longer available.
Durable encrypted delivery and automatic retry UI remain future work. Callers
can preserve the existing `koin_request_id` to recover a request safely.

Production signing, broadcasts, purchases and refunds remain disconnected.
These signatures use a rehearsal-only domain and must never be accepted as
live-payment authorization.

### Automatic reward payouts

Automatic sponsored claims are the intended default, confirmed by the owner.
After daily rewards finalize and their 24-hour review hold ends, the master
should submit valid claims and cover Mana, delivering KOIN to the committed
provider wallet. Users should not need to click Claim or sign each reward
payment. A manual claim remains a fallback. The rewards contract already fixes
the recipient and permits a relayer to submit the proof. The master draft now
includes signed rehearsal reward manifests and an automatic claim queue with
injected fixture signing and submission. It verifies the irreversible root,
review hold, exact recipient/proof, custody and per-provider paid-work cap before
requesting a sponsor signature. It saves the full signed envelope and bounded
Mana attempt before submission, retries the same bytes after a lost response,
and records payment only after exact irreversible transaction and claimed-state
checks. A manual claim skips unsigned work; an outstanding sponsor nonce remains
fenced until its own outcome is resolved. Restart during signing requires the
original envelope to be recovered, rather than another signature.

The new master settlement outbox concerns **customer usage charges**, not
provider reward payouts. It atomically saves the full signed transaction with
its held charge, returns only identical bytes on retry, limits sponsored Mana
and clears holds only after exact irreversible transaction/accounting checks.
An explicit rehearsal driver now connects this outbox and the provider claim
queue. Its tests simulate submission with deterministic fixture keys; it has no
production key loader, RPC write transport, HTTP endpoint or background timer.
The live master and app enable no payment behavior. See the master repository's
`docs/koin-automatic-claims.md` for the interface and recovery limits.

### Funding review rehearsal

`electron/koin-funding-review.js` provides an in-process native preview for the
exact transaction prepared by `KoinChain`. Customer usage-credit deposits and
reward-pool funding have distinct explanations; funding the pool does not
create a refundable customer balance. The dialog shows the precise amount,
wallet, custody and token addresses, chain, Mana payer/ceiling, nonce and full
transaction ID. Cancel is the default.

The preview expires after three minutes. Changed terms, nonce, code, authorities,
policy or pause state invalidate it, as do hiding/minimizing, navigation, a
renderer crash or cancellation. It returns only a preview receipt, not signing
authority or reusable transaction bytes. No IPC, UI control, signer, wallet
unlock, persistent permission or submission transport is attached to it. The
existing purchase button remains disabled. Production wiring still needs the
existing password/external-wallet confirmation, durable signed-envelope
recovery, fresh checks and irreversible deposit/credit reconciliation.

The explicit `isolated` chain-client mode requires an injected provider; the
disposable-node harness supplies its peerless loopback transport only after
verifying the fresh genesis marker. Normal deployment remains unconfigured.

### Remaining activation work

1. Implement and calibrate master-observed token metering, tariffs, SLA/challenge
   results and a durable per-job reservation ledger inside each on-chain grant.
   The master now connects synthetic and funded-session rehearsal reservations,
   worker receipts and unsigned settlement preparation with pinned tokenizer
   support. Measured production tariffs and real paid-work ingestion remain
   disabled. Provider token counts and signed presence are not proof of
   useful work. The Qwen tokenizer has reference vectors; hardware costs and
   accepted SLA/challenge rules still need measurements.
2. Implement finality-aware reconciliation, signed reward manifests, keeper
   recovery and sponsored claim submission. Read-only finality reconciliation
   and synthetic restart/fork/replay tests are implemented in the master draft.
   The master now also has a durable signed-settlement outbox, exact-envelope
   retry decisions, bounded sponsorship accounting and crash/restart tests.
   A restricted driver now exercises settlement submission and automatic claims
   with fixture-only signing/transport. Signed rehearsal reward manifests and
   a durable claim/signing/Mana journal are implemented; production manifest
   ingestion, epoch/root writes, key custody, broadcasting and monitoring remain
   unconnected. The original shadow-report route still returns hashed simulation
   data. No production keeper broadcasts.
3. Benchmark real providers and complete at least seven days of shadow data.
   Validate capacity deduplication, model-switch observations, workload costs
   and collusive/self-funded work. The work cap is not a proof that all economic
   manipulation is impossible.
4. The first [isolated native-transfer run](https://github.com/therexdev/kai/actions/runs/36260927761)
   passed 12 checks, including automatic sponsor-only payouts and real resource
   receipts. Broader proof sizes, load and production Mana calibration still
   need testing; fixture measurements are not production costs. Contract review
   remains required. Unit and WASM tests use the SDK MockVM;
   they are not an independent audit. Custody currently trusts owner-held
   contract keys, which can upload replacement code; the policy notice does
   not constrain that key's upgrade authority. Decide the upgrade guard before
   deployment and keep the final bytecode pins under review.
5. Implement the reviewed desktop purchase/session/refund/claim flows with
   password or external-wallet confirmation and exact transaction previews.
   Exact approval/deposit validation and native funding preview are implemented;
   signing, durable recovery and finality-aware credit activation remain disconnected.
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
