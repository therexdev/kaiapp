# Shared wallet nonce rehearsal

`core/lib/koinos/wallet-nonce.js` reserves a wallet's next transaction across
funding, ordinary KOIN/VHP sends, burns, producer registration and exported offline
producer drafts, sponsored bridge/swap builders and remote wallet approvals.
Construction requires an actual `KoinChain` with the explicit
isolated loopback deployment and `mode: "isolated-rehearsal"`. It does not load
keys or create a submission loop. Normal wallet construction does not install it.

The funding journal always opens `wallet-nonces.sqlite` alongside
`funding-recovery.sqlite`. `ChainService(settings, { nonceCoordinator })` and
`ProducerCustody` use that same coordinator only when explicitly injected by the
fixture harness. The provider must be the coordinator's exact injected provider.
Different handles sharing the same directory serialize reservations with SQLite
transactions and a unique active-wallet index. Different wallets remain independent.

## Reservation and recovery

`reserve(id, purpose, unsignedTransaction)` verifies the chain, current nonce and
exact transaction commitment, then saves the signing fence before returning
`sign_original`. An existing request ID returns `recover_existing`; it never
permits a second signing call. One unresolved request blocks other purposes and
other request IDs for the same owner. Completed records prevent nonce regression.

`stage(id, signedTransaction)` verifies and saves the exact original envelope and
the owner signature before submission. A sponsored transaction reserves its
payee's nonce, while its payer covers Mana. Its expected payer signature may be
appended without changing any signed fields or replacing the owner's signature.
No replacement nonce, resource limit, operation or owner signature can replace it.
The isolated external-draft adapter also
requires the original resource limit. The existing production external signing
flow's lower-resource-limit support remains unchanged.

Timeouts, Stop, lost acknowledgments, draft expiration and a later tip nonce do
not release a reservation. Exported bytes might already have been signed on
another device. There is deliberately no automatic timeout-based deletion or
"unlock" operation. Missing signatures need original-envelope recovery; abandoned
requests need a separately reviewed repair procedure before production use.

`reconcile(id)` is read-only on the chain. It checks the exact transaction and
receipt in a canonical block at or below a fresh irreversible height. A verified
successful receipt or revert releases the nonce. Pending, reversible, forked,
malformed or unrelated receipts cannot. This proves nonce consumption, not the
application result: funding still needs its stricter transfer-event, allowance
and backed-custody checks before it becomes `funded`.

The nonce envelope is written before the funding envelope. If a process exits
between those writes, funding recovers the saved signed bytes without another
signature. If only a signing fence was persisted, recovery stops for the original
envelope. Separate journals intentionally fail closed after partial writes; they
are not presented as one atomic multi-file commit. Keep both journals together
when backing up/restoring. An existing funding database with a missing shared
nonce database refuses to open. Old disposable rehearsal databases should be
archived and rehearsed afresh, not silently migrated or cleared.

## Sponsored and remote wallet approvals

`buildRedeemTransaction` and `buildSwapTransaction` accept an optional isolated
`nonceCoordinator`. They reserve before the owner signs and save the partial
envelope before returning it to a caller. Rebuilding an outstanding request is
refused; it needs original-envelope recovery. No production orchestrator injects
the adapter, and this does not test live bridge, DEX or relayer execution.

`VaultRecovery` also requires explicit isolated mode, that same coordinator,
an expected sponsor and a positive resource ceiling. `ProducerVault` accepts it
only with the exact isolated provider and an injected fixture transport. The
public wallet transport cannot be used with this adapter. Normal construction
does not import SQLite or install recovery.

Before exposing an operations-only approval, `reserveRemote` persists its owner,
current nonce, chain, expected payer, exact operations and resource ceiling.
The local draft at that ceiling is a policy template, not a predicted remote
transaction ID. A recovered transaction may have a lower positive RC limit;
every other signed field must match. Once both expected signatures are observed,
the first complete envelope is immutable. A changed nonce, sponsor, operations,
chain or excessive cost fails closed. Request IDs and session credentials from
the wallet service are not saved. Restart restores the local reservation and
operations without reconnecting, requesting approval or submitting anything.

Read-only `recover({ reservationId, txId })` resolves the original transaction
from fixture wallet history. The RPC lookup must carry valid owner and payer
signatures. Only its exact irreversible receipt releases the hold; the receipt's
payer is the sponsor. A revert releases the nonce but reports `reverted`, not
success. Remote rejection/failure, session expiry, disconnection and lost delivery
all retain the reservation. A request with no recoverable transaction remains
held pending a separately reviewed repair procedure.

## Scope and remaining work

The existing password checks, producer custody controls and native funding
review remain the authorization boundaries. A nonce reservation is not permission
to spend. The new adapters are exercised with fixture keys and isolated RPC only;
the shipped live wallet, network services and payment activation remain unchanged.

Sponsored and remote adapters are fixture-only. The operations-only public wallet
protocol does not promise our pinned nonce/sponsor/ceiling; backend agreement and
explicit production approval are still required. Production activation must
include every orchestrator and recovery UI, one durable journal location for every participating
wallet action, cross-host/dual-boot ownership, reviewed repair and backup handling,
and clear pending-request recovery controls. Transactions made by unrelated apps
using the same key cannot be locked by a local journal. The observer trusts its
pinned RPC and is not a consensus light client.

Focused local verification:

```sh
node --test core/test/koin-vault-recovery.test.js core/test/koin-wallet-nonce.test.js core/test/koin-funding-approval.test.js core/test/koin-funding-recovery.test.js core/test/koin-funding.test.js core/test/koin-chain.test.js core/test/producer-custody.test.js core/test/producer-vault.test.js core/test/koinos-node.test.js
```

The master isolated-chain harness also proves that a stopped deposit blocks an
ordinary desktop send before signing. After the deposit finalizes, that send
executes once, loses its response and blocks further deposits across restart
until its exact irreversible receipt releases the shared reservation.
The next native extension runs the actual `ProducerVault` module against a local
wallet-protocol fixture, with real sponsored transfers and lost approval responses.
It is not a test of the public Koin Vault service. Focused local verification:
91 passes, two browser skips; desktop/master integration: three passes.
