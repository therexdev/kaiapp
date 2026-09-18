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

## Node access and AI privacy

Koinos Node works while AI Privacy remains Local-Only. Enable Run Koinos Node
in Settings, then use its node controls as usual. Loading the node UI, syncing,
block production and explicit wallet actions do not require enabling online AI.
The node's own start/stop, reward and Distribution settings govern its activity.
Wallet password checks and local Core access controls still apply. AI web tools,
cloud providers and account connections continue to follow AI Privacy.

Version `0.54.9-master.2` fixes the “Failed to start UI” privacy error. The same
fix is also maintained on `therexdev/kaiapp:test` for its separate Test feed.

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

Version `0.54.9-master.3` adds standard JSON-RPC alongside the producer feed.
Fully sync mainnet, then open Koinos Node → Node API. The listener remains off
by default. Private upstream: `http://127.0.0.1:8085`. API listener:
`127.0.0.1:41110`. Keep memory-saver mode OFF because it stops JSON-RPC.

Enable **API endpoint** and **Allow blockchain RPC and already-signed
transactions**, set Public HTTPS address to `https://api.koinosai.com`, and save.
Existing enabled producer APIs also gain RPC unless the RPC checkbox is cleared.
Saving restarts only the API listener, never Docker or the node.

| Method and route | Response |
| --- | --- |
| `POST /` or `POST /rpc` | Standard JSON-RPC 2.0 blockchain requests |
| `GET /` or `GET /v1/status` | Public RPC and producer-index status |
| `GET /healthz/rpc` | 200 when local Mainnet RPC has a recent head; otherwise 503 |
| `GET /healthz` | 200 only when the full producer index is fresh; otherwise 503 |
| `GET /v1/token-tracker/producers` | Producer addresses, block counts and last block times |
| `OPTIONS` on these routes | Browser CORS preflight, without credentials |

RPC readiness is independent of producer-index backfill. It requires the Mainnet
chain ID `EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==`, a head less than
90 seconds old, and a successful health observation in the last 15 seconds.

The gateway accepts chain/head/fork/resource information, contract reads,
account nonce/mana, block queries, selected read-only system calls used by
wallets, and `chain.submit_transaction`. Transactions must already contain
signatures and the Mainnet chain ID. The node checks their signature, nonce,
mana and operation validity. Master forwards them unchanged, once, without
using its own wallet or signing keys. Chain rejection details are preserved.
A transport timeout can leave submission outcome unknown; clients should check
the same transaction ID before deciding to retry.

It rejects block submission/proposal, block-store mutation, mutable system
calls, all Core/wallet/Distribution/node-admin methods, and caller-supplied
upstream URLs. Cookies, Authorization and other client headers never reach
the private node. Only the saved public hostname and loopback hosts are accepted.
The gateway has 2 MiB request and 8 MiB response limits, batches of at most ten,
block/history queries of at most 100 items, four simultaneous public upstream
calls, 30 RPC items/second and 60 HTTP requests/second globally. Local upstream
attempts time out at eight seconds and complete public requests at twelve.
These are protective limits, not a public throughput commitment. Configure
per-client limits at Cloudflare as well; the origin does not trust proxy headers
for client identity. HTTP failures allow clients to try their backup endpoints.

### Optional history and metadata services

For account history, transaction-by-ID lookup and contract metadata, select
**Enable account history, transaction and contract metadata services on the
next node start**, save, then use the node's Stop and Start controls when
convenient. This enables the existing Compose profiles `account_history`,
`transaction_store` and `contract_meta_store`. Saving alone does not start them.
They consume additional disk, memory and indexing time. Turning the checkbox
off blocks these public methods immediately; apply the container change with
the same manual Stop/Start sequence.

The public methods are `account_history.get_account_history`,
`transaction_store.get_transactions_by_id`, and
`contract_meta_store.get_contract_meta`. They return method-unavailable
(`-32601`) while the option is off, so compatible clients can use backups.
When enabled, their results depend on the installed services and stored data.
An enabled setting or RPC-ready status does not prove those indexes are fully
populated. A quick-sync snapshot does not guarantee complete historical
records. Verify the required old transactions and contract metadata before
making this the only source; retain Koinos Blocks and api.koinos.io as backups.
Restoring or replaying historical service data is a separate node operation.

### Producer index

Master's dashboard reads the enabled local producer index and labels its scope.
The index covers 28,800 finalized blocks, approximately one day. It is **not**
a VHP-holder directory or connected-peer count. `tracked_scope` explicitly says
`producers-in-finalized-window`. Finalization adds reporting delay. Initial
backfill, stale data, missing history or upstream errors return 503.

The persistent index validates continuity and canonical checkpoints, rebuilds
after a rewind, and refuses chain-ID changes. Bounded background reads update
cached public results. No account-history replay is required for this index.
Distribution still uses its configured public/custom account-history RPCs and
trusted AI roster; the producer feed does not replace either of those sources.

### Windows and Cloudflare Tunnel

Install the signed Master update from the `master-build` release. Keep Master,
Docker Desktop and the node running, with Windows sleep disabled while serving
requests. First confirm **RPC ready: yes** in Node API. In PowerShell:

```powershell
$endpoint = 'http://127.0.0.1:41110'
Invoke-RestMethod "$endpoint/healthz/rpc"
$body = @{ jsonrpc = '2.0'; id = 1; method = 'chain.get_chain_id'; params = @{} } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "$endpoint/" -Method Post -ContentType 'application/json' -Body $body
Invoke-RestMethod "$endpoint/v1/token-tracker/producers"
```

The first response must have `ready: true`, and the RPC response must contain
the Mainnet chain ID above. The producer response must have `available: true`.

1. In the Cloudflare dashboard, open **Networking → Tunnels → Create a tunnel**.
   Name it `master-kai-node` and choose **Windows**. Run the dashboard's Windows
   installation/service command on the **same Windows computer as Master**,
   using an Administrator terminal when required. Keep its tunnel token private.
2. Once connected, choose the tunnel's **Routes → Add route → Published
   application**. Use the values below, with `koinosai.com` already on Cloudflare.
3. Save the route. The public root now forwards to Master's API listener.
   Cloudflare supplies the public HTTPS connection; the local service uses HTTP.
   No inbound router port forwarding is needed for this tunnel.

| Cloudflare field | Value |
| --- | --- |
| Subdomain | `api` |
| Domain | `koinosai.com` |
| Path | Leave empty |
| Service type | `HTTP` |
| Service URL | `127.0.0.1:41110` (combined URL: `http://127.0.0.1:41110`) |

These instructions follow Cloudflare's
[dashboard tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/).
Do not set the route to the producer path: the root must carry both RPC and
producer requests. Do not point it at Core 41101 or raw node RPC 8085. Leave the
origin HTTP Host override unset (or use `api.koinosai.com`). Do not apply an
interactive Access login or browser challenge to the public API: wallets need
JSON responses. Keep caching disabled for these routes, and use edge rate
limits to control abuse. No Cloudflare credentials or live DNS changes are made
by the app update. Caddy is an alternative (`deploy/master-api.Caddyfile`),
not required with Cloudflare Tunnel.

Repeat the PowerShell checks with `$endpoint = 'https://api.koinosai.com'` from
another Internet connection. A 502 suggests cloudflared cannot reach Master;
503 from `/healthz/rpc` means the local node is not ready; 403 with Unknown API
hostname means the public address/Host settings do not match. Confirm CORS with
the real browser applications and verify the optional history methods they use.
Do not use a real payment as a connectivity test.

After those checks pass, configure clients in this order:

1. `https://api.koinosai.com` — primary JSON-RPC.
2. `https://api.koinosblocks.com` — first backup.
3. `https://api.koinos.io` — second backup.

Use `https://api.koinosai.com/v1/token-tracker/producers` only for producer data.
This release does not switch other apps to an endpoint that has not yet been
verified. Master already supports the above priority via its Custom RPC setting.

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
