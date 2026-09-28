# Durable funding recovery rehearsal

`electron/koin-funding-recovery.js` adds a durable owner-paid deposit journal and
bounded driver. `core/lib/koin-network/funding-observer.js` verifies the exact
atomic allowance/deposit transaction, native transfer receipt, irreversible
inclusion and backed custody state. Both credit purchases and reward-pool funding
use this path in the master repository's disposable-chain harness.

This is an isolated rehearsal. Construction requires `mode: "isolated-rehearsal"`
and an actual `KoinChain` configured for the injected loopback `isolated` network.
There is no IPC registration, wallet key loader, background runner, purchase control or
production signer. The existing native funding preview still returns only a
preview receipt and cannot authorize this driver or a real payment.

## Journal and driver

`FundingRecovery(directory, { mode, client, clock, maxRcPerDay, maxAttempts,
minRetryMs })` stores `funding-recovery.sqlite` with WAL, FULL synchronization and
private file permissions. Deployment pins and resource policy are immutable for
that journal. Every instance for that wallet/deployment must use the same DB.
Only owner-paid transactions are supported here; sponsored funding is deferred.

`begin(id, intent)` accepts a stable 64-character lowercase hex request ID and
exactly `{ kind, method, args: { account, amount }, actor, maxRc }`. It prepares the
two-operation draft locally and commits a signing fence before returning it.
One unresolved request fences that owner's deposits across both custody contracts.
The [shared wallet nonce journal](WALLET_NONCES.md) extends that fence to the
isolated adapters for ordinary sends, burns, registration and offline drafts.
Reusing an ID recovers its existing deposit; different terms under that ID fail.
New IDs after a confirmed/reverted deposit require a new explicit signing call.

`stage(id, transaction)` accepts only the original draft's commitment and one
valid owner signature. It saves the complete envelope before any submission.
The runner's explicit fixture `sign` callback must return bytes without submitting.
A lost signing response blocks further signing until those original bytes are
recovered. It never prepares a replacement automatically.

`advance(id)` returns a bounded recovery decision. Exact retries require verified
current pins/policy, stable irreversible reads, an unchanged owner nonce, a retry
delay, an attempt cap and a per-owner daily RC reservation. The journal reserves
the entire signed limit before handing bytes to transport, once per transaction
per UTC day. Initial submission expires three minutes after draft preparation;
already-attempted envelopes remain recoverable and never receive a new nonce.
The daily cap applies to this journal's submissions, not other wallet activity.

`FundingRecoveryRunner({ mode, journal, sign, submit, timeoutMs })` supplies
`start(id, intent)` and `tick(id)`. Callbacks receive cloned values and an abort
signal; their default timeout is five seconds (bounded to 50–30,000 ms). Transport
timeouts/errors keep the saved request uncertain. Acknowledgments never confirm
funding. Restart resumes with `tick`; repeating `start` does not sign again.

## Native approval, Stop and resume

`createFundingApproval` in `electron/koin-funding-approval.js` connects a native
dialog to this journal for isolated fixture wallets. It requires the same client
instance as the journal, explicit fixture signing/transport callbacks and a
trusted main-process intent supplier. The existing preview receipt is never an
approval input. No renderer or production wallet imports this coordinator.

`approve(window, id, supplier)` displays the exact purpose, amount, owner/Mana
payer, custody and native-token addresses/code pins, chain, transaction ID, nonce,
resource ceiling and three-minute review deadline. After confirmation it checks
the intent, policy and nonce again. The journal's final preparation must match
the reviewed transaction before it commits the signing fence. Cancel before
that fence creates no deposit. Window hide, close, minimize, navigation, renderer
failure and explicit `cancel()` stop the operation.

Stop after the fence persists `held: true`. A late valid signing response can
still save the original envelope, but cannot send it. A process exit before the
envelope is saved leaves the existing signing fence for exact-envelope recovery;
there is no replacement signature. Signer and transport calls are bounded. Stop
aborts their signals but cannot retract an already transmitted transaction.

`check(id)` reconciles read-only through `advance(id, { allowSubmit: false })`.
It never reserves an attempt or returns bytes to transport. It can confirm a
held deposit or its revert from exact irreversible evidence. The coordinator
holds every nonterminal request after one send decision, including uncertain
transport responses; it never starts unattended retries.

`resume(window, id, supplier)` requires a new native review of the original saved
draft and sends only its saved signature. It can renew the initial-submission
review deadline for that same transaction. It preserves nonce fences, retry
counts, cooldown and daily Mana reservations; it cannot reset changed-policy,
external-nonce or attempt-limit failures. A signed envelope remains held after a
cancelled review. Shared journal handles elect one initial signer. Cross-host
coordination and coordination with other wallet actions remain deferred.

The lower-level runner remains available to the trusted isolated harness. Its
automatic exact retry decisions respect durable holds. It is not exposed as a
user-facing bypass of native approval.

## Confirmation and failure behavior

Confirmation needs the original transaction in a canonical block at or below
the node's irreversible height, its exact successful receipt, and exactly one
native transfer event from the owner to the intended custody account for the
approved amount. Reads of config, native balance, liabilities, account credits
and remaining allowance are captured at a stable head and rechecked after that
same block becomes irreversible. Custody must remain backed; allowance must be
zero for success. Head changes, forks and inconsistent receipts cannot confirm.

`funded` means this exact deposit completed. It does not add an artificial local
credit balance or assert that those credits remain unspent. Current available
and reserved credits still come from the contract's separately verified state.
Reward-pool funding creates no refundable customer credits.

A canonical irreversible revert plus fresh state resolves as `reverted`, allowing
a separately reviewed new request. Unknown inclusion, external nonce use, expired
initial reviews, changed policies and exhausted attempts preserve the fence for
review. Later exact successful finality can still resolve an exhausted request.
Saved journal hashes, identity bindings, attempt/Mana consistency and a durable
clock watermark detect damaged records and backwards clocks.

The observer trusts its pinned RPC; it is not a consensus light client. Production
still requires the native password/external-wallet approval flow, shared nonce
coordination with sponsored/remote-wallet actions, key custody, reviewed repairs for
abandoned signatures, rollback-resistant backups, cross-host fencing and monitoring.
No mainnet deposit, funding configuration or live payment setting is changed.

Run `node --test core/test/koin-funding-approval.test.js core/test/koin-funding-recovery.test.js core/test/koin-funding.test.js core/test/koin-chain.test.js`.
The focused suite covers both purposes, lost responses, restart, concurrent
handles, exact retries, resource limits, forks, reverts, altered signatures/terms,
expiry, custody backing, changed code, malformed reads and journal damage. Native
approval tests also cover Cancel, window lifecycle, late signatures, signing
timeout, Stop during transport, read-only restart, exact resume, concurrent
controllers, changed reviews and preserved resource limits.
Each hold/resume also advances a durable review version: Stop through another
journal handle invalidates a resume dialog that was already open.
