# Minimal Windows core and optional plugins — dormant foundation

## Status and decision

Based on remote `therexdev/kaiapp` **test**, verified at
`3ceb60bf629a6126b4747bc0baed2561b361bcab` on 2026-10-09. Remote HEAD is the
historical `claude/kai-production-website-fqx4pf`, not the development base.
Read root AGENTS.md; this checkout has no `.agents/skills` or nested AGENTS.md.
User scope overrides the repository's general release authorization: local work
only, no push, release, merge, deployment change or financial operation.

This work adds a dependency-free, in-memory permission policy module, an example
manifest and a dormant dedicated local-engine adapter (see `plugins/LOCAL_INFERENCE.md`). Nothing imports it from the running application. No loader,
profile switch, storage migration, wallet operation, IPC route or UI change is
introduced. Existing payment UI, KOIN pilot and full application stay intact.

Target: Windows core owns model/runtime management, local serving, AI network
payment/reward identity and earning. Optional community features are Chat/KAI and
voice, connections/workflows, Personal Brain, Compare Models and Koinos Node.
Core still needs its own wallet and recovery UI even if Node is absent.

## Observed dependencies and secret consumers

This is a source audit, not an examination of any real profile or keys. Paths
below are relative to the repository; these are current behaviors to untangle,
not permissions granted to future plugins.

| Current code | Observed dependency / secret access | Extraction consequence |
| --- | --- | --- |
| `core/server.js:createCore` | Eagerly constructs models/runtime, wallet, tools, memory, mail/calendar, Node, account, teams/bench, coding, voice and gateway; registers tools together. `start()` restores earning/reporting behavior. | Build explicit service factories and lifecycle dependencies before adding a minimal profile; construction alone is not proof of inertness. |
| `electron/main.js` | Calls `createCore` in Electron main. `machineSecret` uses OS safeStorage to resume `wallet/session.bin`; returns null when encryption unavailable. | Separate host control plane from plugin runtime. Keep existing profile name, single-instance lock, backup and resume semantics. |
| `core/lib/wallet.js`, `keystore.js` | Encrypted key store; unlocked signer, `signHash`, password-confirmed `signerFor` and WIF export. Ethereum identity/private key derives from the same key. | Core wallet remains core-owned. Never pass WalletService or its signer to a plugin. No key copying, implicit wallet migration or moving funds. |
| `core/server.js` network auth, `worker.js` | Core wallet signs consume/register/presence/receipt proofs; worker needs runtime, models, hardware and optional producer snapshot. | Keep AI earning identity in core. Replace Node snapshot dependency with an optional narrow status interface; no signer sharing. |
| `account.js`, `gateway.js`, `core/lib/koin-network/*` | Account wallet-link/spend-grant proofs, bearer account session, network consume and KOIN grant authorization. Account has legacy plaintext credential fallback when OS encryption unavailable. | Keep current payment behavior unchanged; future plugin permissions must not inherit account spending grants. New secret storage must fail closed. |
| `electron/koin-test-ipc.js`, `koin-session-review.js`, `koin-test-payments.js` | Pilot/session proofs use `core.account.wallet.signHash`; payment service holds wallet signer for reviewed KOIN operations. | Preserve pilot controls, review, recovery and receipts. New policy has no payment adapter and performs no transactions. |
| `core/lib/koinos.js` | Receives core wallet and obtains fresh password-confirmed signers. | Future Node plugin uses independent account/signer. |
| `core/lib/koinos-node.js`, `core/lib/koinos/*` | Full Node stack receives the core wallet; wallet UI channels, burn/register/rewards/bridge and ETH token operations consume signer or derived ETH private key. `createKoinosNode` starts RewardEngine and may resume jobs. Config/state under `koinos-node`; external producer custody already has separate producer-key generation and external wallet request flows. | Optional Node needs independent config, data/storage, account and signer. Do not equate existing external custody with complete Node separation. Existing core-wallet UI must first move into core-owned screens without changing behavior. |
| `core/lib/koinos/producer-custody.js` | Generates/rotates a separate block-production WIF in producer key files; legacy/local custody remains coupled to earning wallet paths. | Inventory Docker mounts and Windows ACLs; operational producer keys are distinct from account keys. No silent conversion of legacy custody. |
| `producer-reporter.js` | Signs Node reports with core earning wallet and consumes Node snapshot even when earning is off. | Core may opt into public Node status, but Node must not receive core signing authority. Revisit reporting protocol explicitly. |
| `mcp.js`, `mcp-manager.js`, `node-runtime.js` | Launch executable/stdio tools; `mcp.js` uses configured env or inherits `process.env`. Tool registry connects to shared app capabilities. | Existing MCP is trusted execution, not isolation. Future launch requires environment allowlist, no profile access, authenticated identity and host mediation. |
| `email.js`, `caldav.js`, `github.js` | Mail/calendar credentials use OS encryption or legacy plaintext fallback; GitHub token is persisted with POSIX 0600 best effort. | New plugins must never reuse these stores directly. Broker exact account operations; no credential delivery; Windows ACL/OS-key protection must be designed. |
| `electron/providers.js`, `provider-http.js` | Private desktop provider keys use encrypted storage and trusted IPC; direct provider transport can spend money. | Preserve desktop-only protections. Paid provider access is a separate grant category, never implied by local inference. |
| `electron/companion-hub.js`, `companion-store.js` | Shared encrypted store contains notes, sources, connections, workflow runs, Brain and settings; constructor migrates memory and starts agent network. Has account/chats/lookup/model access. | Separate ownership and schemas before splitting plugins. A read of Hub status is not an acceptable generic personal-data grant. Migration needs restore points and explicit review. |
| `core/lib/agent-network/*` | Separate signing/encryption identity in encrypted store; CompanionHub starts it. | Preserve independent identity; no delegation of core grants or implicit access to Brain. |
| `ui/app-extras.js:cmpStreamInto`, `ui/app.js`, `core/server.js` teams/bench | Compare UI calls `/core/chat/completions` from the full UI. Teams/bench use shared loopback chat, which inherits network routing and shared registry. | Do not wire the first plugin to generic loopback chat or bench. A local-only model adapter must prove no network fallback. |

`kaiapp/server/scheduler.js` is a fixture. Protocol changes, if later needed,
belong in `therexdev/kai/lib/scheduler.js`; this milestone changes neither.

## Permission contract implemented

`core/lib/plugins/permissions.js` exports `validateManifest` and
`createPermissionHost`. Strict schema v1 uses exact resource/action/kind tuples;
unknown fields, wildcards, duplicate scopes and unsupported schema versions fail.
A declaration requests eligibility only. Install has no side effects or access.
Manifest digest covers canonicalized declarations and version; *any* manifest
change revokes old grants and invalidates old client handles. A fresh owner
approval is required even for narrowing. Uninstall also invalidates handles.

The trusted host retains `install`, `approve`, `revoke`, `uninstall`, `connect`.
Only an authenticated, trusted owner-consent surface may call `approve`; this
library does not implement that surface. The host binds `connect(caller)` to a
verified installation/transport, never to a plugin-supplied RPC caller string.
Plugins receive only the bound inference method; grants cannot be delegated.
Knowing another plugin's grant ID confers no access.

Owner grants require caller, manifest digest, exact scope, expiry (up to 24h),
and limits: total calls, UTF-16 input characters per call and maximum requested
output tokens per call. Budget reservation is synchronous before dispatch;
failed/cancelled calls are charged. Separate grants are separate owner-approved
budgets. No implicit aggregation or renewal. Approval stores copies, not caller
mutable objects. Grants are session-only; restart loses them, requiring approval.

Only foreground `local-inference/infer` can be approved. `background-work`,
`network-spend`, `wallet`, `connected-account`, `personal-data` and `plugin`
declarations are recognized for explicit separation but **cannot be approved or
executed** in this milestone. Core wallet access is never a plugin capability.
No wallet adapter, arbitrary signing, filesystem, account, HTTP or registry object
is supplied. Future plugin wallet services must bind an independent account and
signer, possibly sharing reviewed implementation code, never core key material.

The injected trusted adapter receives an exact model resource, literal prompt,
output-token ceiling and abort signal, and must return text. The dormant trusted
local adapter targets one dedicated resident llama.cpp child, with no routing or
provisioning dependency. It is not connected to the production app. Revocation,
uninstall and manifest updates signal abort and suppress late results; expiry
also signals abort and suppresses results. The policy promptly rejects even if an
adapter ignores abort, while the new local adapter destroys the HTTP request and
terminates its dedicated child. It retires permanently if termination cannot be
confirmed. Limits are not OS CPU/RAM quotas or billing controls.

`docs/plugins/compare-models.manifest.json` is an illustrative two-model request;
the tests use fake inference only. It is not a packaged plugin or a claim that
Compare Models is extracted. Unknown resources can be declared; a future owner
surface must resolve them against an explicit local model catalog before consent.

## Trust and security limits

This is a host-side policy foundation for trusted mediation, not a security
sandbox for arbitrary code. Same-process native/JS code can bypass it; an MCP
server or child process with the owner's OS permissions can read files, inherit
secrets or call existing local APIs. No untrusted native plugin is safe to install
on this evidence. Manifest hashes are not code signatures or artifact integrity
checks. There is no loader, authenticated IPC transport, consent UI, persistent
approval ledger, OS isolation, concurrent runtime quota or enforced egress boundary.
Use only parsed JSON DTOs across a future transport. Validation now rejects
accessors, symbols, unexpected prototypes and sparse/custom arrays, but hostile
same-process Proxies are still outside this boundary. Never expose the host authority object.

A production release needs authenticated code/installation identity, immutable
artifact binding, closed and resource-scoped broker APIs, OS-enforced filesystem,
process and network restrictions, and adversarial Windows verification. Output
limits depend on the trusted inference adapter. Existing full-app routes/tools
are not retrofitted with this policy and retain their current trust model.

## Phased extraction and rollback

1. **This milestone:** inventory plus dormant policy and fake Compare tests.
   Rollback removes the new files/commit; there is no profile migration.
2. **Dormant adapter implemented:** a dedicated already-running local engine,
   strict loopback request path, per-call limits, timeout and process termination.
   Subprocess tests verify cancellation and forbidden fallback. **Next bounded
   step:** the signed installation/one-use consent contract and Linux supervisor
   now exist (`plugins/IDENTITY_SUPERVISION.md`). Next build dormant authenticated
   transport, protected single-writer storage and immutable artifact/lifecycle
   integration; real Windows termination remains unverified. Do not connect the
   shared RuntimeManager or enable Compare/full UI yet.
3. **Composition seam:** refactor `createCore` into explicit factories/lifecycles,
   preserving the full profile default. Model minimal/full profiles in tests;
   absent optional factories must not construct stores, timers, tools or workers.
   Keep core wallet/payment UI, AI earning and recovery independent of Node.
4. **Windows isolation proof:** choose and verify an actual restricted execution
   mechanism with denied profile access, environment, network and process escape
   tests. Until then only reviewed bundled code, no untrusted native loader. Then
   extract Compare against local inference plus explicit foreground grants.
5. **Data and Node separation:** split Hub data/services with encrypted versioned
   exports, dry-run manifests and restore tests; owner selects data and accounts.
   Give Node new independent configuration/storage/wallet. Existing users retain
   legacy behavior until an explicit migration/recovery plan; never copy the core
   private key or move funds to create separation. Reuse reviewed keystore code
   if appropriate, but create a separate account and OS credential namespace.
   Design independent producer reporting and protocol compatibility before change.
6. **Optional features:** Chat/KAI/voice, accounts/workflows and Brain receive exact
   non-transitive grants and separate storage. Background execution and paid
   network/provider spending need separately reviewed permission schemas,
   accounting, cancellation/reapproval and consent, not an inference permission.

Retain Live/Test shared-profile exclusion and existing pre-open configuration
backups throughout. Do not relocate the existing Node database. Before any future
migration, verify encrypted backup restore with the original OS identity, retain
original stores, make migration idempotent and offer rollback; backup is not
permission to duplicate private keys into plugin stores. No new storage fallback.

No source was copied from `levineam/koinos-router` at
`0c32b28d96db8bc39f90077390681f2ffb622c04`. Its slim profiles/Windows packaging are
only a design reference supplied in the brief. Package MIT metadata is not
resolved provenance for community-specific code without a top-level license.
Do not port its plaintext storage fallback or Mac-only Touch ID/power defaults.
