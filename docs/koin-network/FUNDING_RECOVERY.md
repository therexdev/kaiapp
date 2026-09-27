# Durable funding recovery rehearsal

`electron/koin-funding-recovery.js` adds a durable owner-paid deposit journal and
bounded driver. `core/lib/koin-network/funding-observer.js` verifies the exact
atomic allowance/deposit transaction, native transfer receipt, irreversible
inclusion and backed custody state. Both credit purchases and reward-pool funding
use this path in the master repository's disposable-chain harness.

This is an isolated rehearsal. Construction requires `mode: "isolated-rehearsal"`
and an actual `KoinChain` configured for the injected loopback `isolated` network.
There is no IPC registration, wallet key loader, timer, purchase control or
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
coordination with all other wallet actions, key custody, reviewed repairs for
abandoned signatures, rollback-resistant backups, cross-host fencing and monitoring.
No mainnet deposit, funding configuration or live payment setting is changed.

Run `node --test core/test/koin-funding-recovery.test.js core/test/koin-funding.test.js`.
The focused suite covers both purposes, lost responses, restart, concurrent
handles, exact retries, resource limits, forks, reverts, altered signatures/terms,
expiry, custody backing, changed code, malformed reads and journal damage.
