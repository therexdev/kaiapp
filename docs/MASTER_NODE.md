# Master Koinos AI Node

Independent copy of `therexdev/kaiapp:test` at `f57bae4062016e6b8fe0f538607637ee1b95896d`.
Distribution engine, UI and tests come from `therexdev/free-koinos-node` v0.10.0,
commit `b86dfaaffc0a0490b329f8a7b0c81d0cb26770a7`. Its MIT notice is retained
in `docs/licenses/FREE-KOINOS-NODE.txt` and included in packaged resources.

Master is maintained on `therexdev/kaiapp:master-kaiapp`, sharing the existing
repository's Actions/signing settings. The earlier standalone repository is
superseded. Master has its own app ID, update feed, profile and Core port (41101).
It does not modify Test/Alpha or the running Free Koinos Node installation.
Master uses KAI's Docker project names. Free Node has different project names,
but the migrated chain directory and several ports are shared: never run two
controllers against the same node directory. Stop Free Node's containers first.

## Distribution

Koinos Node → Distribution includes VHP-restoring reburn, extra compounding,
overlapping AI/producing/both pools, weighted or equal allocation, minimum VHP,
trusted AI roster, daily UTC settlement, named percentage recipients, minimum
payments, per-address carry, persistent payout queue, liquid/mana reserves,
cycle and transaction history, Check now and Distribute now.

It is OFF by default. Saving settings requires the wallet password; passwords
are not persisted. Authorization is tied to the local wallet and network.
External producer custody cannot run automatic payouts. Reward returns and
Distribution are mutually exclusive. Disabled Distribution blocks manual and
timer execution. Pause distribution needs no password and retains queued payouts.
Public API clients cannot configure or execute distribution.

## Migration from Free Koinos Node

Do not uninstall the old app or delete its profile. Migration reuses the chain
directory in place, without copying, resetting or re-syncing the database.

1. Back up the old wallet and profile. Record the producer address and review
   queued payments. Finish pending funding jobs and transaction submissions.
2. Stop the node in the old app, verify its Docker containers stopped, fully
   quit it from the tray, and disable its startup entry. Quit Master too.
3. Locate the old profile: usually `%APPDATA%/Free Koinos Node` on Windows or
   `~/.config/Free Koinos Node` on Linux. It contains `settings.json`,
   `state.json`, `wallet/wallet.json`, and `node/mainnet`.
4. Before opening Master, run the dry run with absolute paths:

   `npm run migrate:free-node -- --source "OLD_PROFILE" --target "NEW_MASTER_PROFILE/core"`

   Master profile: `%APPDATA%/Master Koinos AI Node` on Windows,
   `~/.config/Master Koinos AI Node` on Linux. The target `core` directory must
   not exist. Preserve any existing Master profile separately first.
5. Review the address and paths, then add `--apply --confirm-stopped`. The
   importer preserves encrypted wallet bytes, settings and accounting state.
   It changes only the compatible keystore type marker; your existing password
   still applies. Source files remain untouched. Failed import staging is kept.
6. Open Master, unlock, compare wallet/producer addresses, verify Distribution
   recipients/carry/queue/history and the Node data-directory path. Both spending
   engines and the API remain disabled until explicitly enabled.
7. Start the node in Master. Confirm sync, registration and block production.
   Master regenerates the node config and uses loopback JSON-RPC **8085**.
   Original generated configuration is backed up under `core/migration-backup`.
8. Review pending payouts, then save Distribution with the wallet password to
   authorize it. This is a local financial action, never part of installation.

Rollback: stop Master and fully quit it before starting the old controller.
Restore backed-up generated node configuration if needed. After Master has made
payments, reconcile/copy the newer distribution accounting before returning to
the old app; old accounting can duplicate payouts.

## Mainnet RPC priority

Koinos Node and the read-only Koinos tools now use these public RPCs in order:

1. `https://api.koinosblocks.com` — primary.
2. `https://api.koinos.io` — secondary.

Each request tries each endpoint at most once, with a 12-second timeout per
attempt. Transport/HTTP failures, invalid responses and missing RPC methods
advance to the next endpoint. Chain/contract rejections retain their original
error and do not trigger retries. Transport retries reuse the exact serialized
request, including any already-signed transaction; they never re-sign it.

Once our own mainnet JSON-RPC endpoint is ready, set it under Koinos Node →
Settings → Custom RPC. It becomes primary with Koinos Blocks and api.koinos.io
as the two backups. Existing custom RPCs also remain primary. Duplicate URLs
are tried only once. Testnet uses only its own custom/local endpoint.

Explicit local-node health/sync probes and the producer-index upstream still
query only the local node. The producer feed below is a separate GET API;
it is not a JSON-RPC endpoint and must not be entered as a custom RPC URL.
KoinosScan's prepared producer feed is unchanged when the local index is off.

## Node API

Fully sync mainnet, then open Koinos Node → Node API. It is off by default.
Private upstream: `http://127.0.0.1:8085`. Listener: `127.0.0.1:41110`.
Keep memory-saver mode OFF: it stops the node's JSON-RPC service.

| GET route | Response |
| --- | --- |
| `/healthz` | 200 only when the full index is fresh; otherwise 503 |
| `/v1/status` | Public chain ID, head/indexed height and observation time |
| `/v1/token-tracker/producers` | Observed producer addresses, block counts and last block times |

When enabled, Master's dashboard reads this same local index, labels its scope,
and stops relying on KoinosScan for the displayed producer counts.

The index covers 28,800 finalized blocks, approximately one day. It is **not**
a VHP-holder directory or connected-peer count. `tracked_scope` explicitly says
`producers-in-finalized-window`. Finalization adds reporting delay. Initial
backfill, stale node data, missing history or upstream errors return 503.

The persistent index validates block continuity and canonical checkpoints,
rebuilds after a rewind, and refuses chain-ID changes. Reads are bounded in
background batches; public requests only use cached results. Upstream responses
have time/size limits. The HTTP server exposes only three GET routes, with
connection/request limits and no wallet, signing, arbitrary-RPC forwarding or
Core access. No account-history replay is required for this index.

Distribution statistics still use KAI's public/custom account-history RPC
selection. This API does not replace the account-history service or AI roster.
Retain a trusted roster URL for AI pools.

For public use, assign a DNS name and run a TLS reverse proxy on the node host
(example `deploy/master-api.Caddyfile`). Expose only HTTPS 443, plus 80 if needed
for certificate issuance. Never forward Core 41101, node RPC 8085, AMQP, Docker
or wallet/admin ports. Behind CGNAT, use a controlled outbound tunnel instead.
Add per-client rate limits at the edge. Keep the host awake with Master/Docker
running. No DNS, firewall, tunnel or live-node change is made by this code.

After the host/domain is configured and verified, a separate Test app update
can select this producer-data source with the correct scope and fallback label.

## Build and verification

Node 22: `npm ci`, `npm test`, `npm start`. Headless Core defaults to
`~/.master-koinos-ai`, or an explicit `KAI_CORE_DATA` directory.
Master CI runs the full suite including browser tests and an offline check of
Distribution settings, recipient persistence, pausing and Node API controls.
The **Master KAI release** workflow runs on `master-kaiapp` when a commit message
includes `[release]`. It also supports manual dispatch on that branch when the
workflow is available in GitHub's default-branch UI. It checks signing credentials, runs the
full suite, builds Windows Setup/portable EXEs and a Linux x64 AppImage, then
publishes the `master-build` prerelease in `therexdev/kaiapp`. Both platform builds must
pass before publication. A draft is made public only after all files upload.
The publication job rechecks Windows signature evidence against the exact
commit/run and verifies both update feeds against their installer hashes.

Windows reuses these existing kaiapp Actions secrets: `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`,
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and, if a different
Azure region is used, `AZURE_SIGNING_ENDPOINT`. Use the established signing
account/profile for publisher Michael Milas. Signing, timestamp and publisher
verification remain gates. A missing secret stops before packaging; after
adding it, re-run failed jobs on the release workflow. Versioned binaries are
retained; increment the `-master.N` version for subsequent releases. Only the
`master*.yml` files advance Master's generic updater. The release tag deliberately
is not semver. Legacy `latest*.yml` files point to the current stable Alpha's
original artifacts and hashes, so older Alpha updaters cannot install Master.
Test continues to use `test-build`; its branch and releases are unaffected.
Upstream release workflows are archived under `docs/upstream-workflows`.
