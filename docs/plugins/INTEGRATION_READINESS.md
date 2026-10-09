# Integration-readiness review — stop foundation expansion here

## Recommendation

Use a bundled, reviewed **first-party Compare Models** controller as the first
explicitly permissioned demonstration. Run two separately approved local model
sessions serially. Do not build a marketplace, general TCP plugin API, native-code
loader, alternate runtime downloader or another Windows launcher. The existing
`community.compare-models` JSON is an illustrative manifest, not a vetted plugin;
a real demo should use an explicitly first-party identity.

The current branch is sufficient for a developer demonstration of installation,
exact owner consent, denied access, bounded prompts, cancellation, replacement and
restart behavior using inert signed fixture artifacts and fixture inference. The
new transport is usable between trusted Node host/worker code. It is **not** a
packaged Electron UI demo or a real-model Windows demo. No production startup or
UI path imports these modules.

## Final bounded boundary implemented

### Host-created transport

`transport.js:createPluginTransport({host, installation, review})` is called only
by trusted owner code after consent. It consumes a genuine one-use review, binds
one installed identity/resource and a dedicated grant, and creates a private
`worker_threads.MessageChannel`. Only its client port is delivered to bundled
code. There is no client-chosen caller, installation, grant, scope, endpoint or
host operation. Messages contain exactly an increasing request ID, literal prompt
and token ceiling; non-JSON, oversized, extra-field, replayed and concurrent
messages close the session and revoke its grant. Closing the port cancels pending
work; late replies are suppressed. Update/expiry continues to invalidate the
underlying installation/grant. Output is bounded and failures are generic.

Authentication here means possession of a **host-minted, identity-bound channel**.
A MessagePort is transferable bearer authority: a holder can transfer it or proxy
requests. This does not attest the code on the far end, prevent malicious holder
delegation, or isolate native code. The owner policy has no delegated-grant API,
but that is distinct from an OS guarantee against capability sharing. This remains
a trusted first-party boundary. Node MessagePort is not a drop-in renderer-facing
Electron MessagePortMain bridge; use existing exact-document IPC checks for any
future Electron handoff.

### Protected public registry and inert artifact lifecycle

`protected-store.js:createProtectedStore({directory, integrityKey})` implements
the installation store contract on Linux only:

- Requires an already-created canonical owned `0700` directory. It anchors file
  operations to an open directory descriptor, refuses symlinks and checks that
  the external directory/lock identity still matches. No automatic mode repair.
- Uses an exclusive lifetime writer lock across processes. A stale lock fails
  closed; do not guess that a PID is dead and steal it. Recovery requires trusted
  operator confirmation that the host has stopped. No automatic crash recovery.
- Authenticates bounded `0600` inventory using HMAC over purpose/path-bound input,
  with atomic temp-file replacement and file/directory fsync. Registry symlinks,
  hardlinks, incorrect modes, malformed data and in-session revision replay fail.
- Receives a separate 32-byte integrity key from trusted host secure storage;
  does not generate or persist that key, use a core wallet/session key, or provide
  a plaintext secret fallback. Inventory is public metadata, not encrypted data.
- Stages only publisher-verified artifact bytes before inventory commit, in
  content-addressed read-only `0400` files. Each snapshot is at most 16 MiB.
  Reads verify hash, type, ownership, link count and mode and return detached
  byte copies, never an executable path or shared writable view.
- Revalidates referenced artifacts on inventory load/save and before inference.
  Drift closes the installation host and denies access. Updates commit the new
  inventory atomically, revoke old authority and retain previous inert snapshots
  for review/recovery. Pre-commit failure retains old inventory; an interruption
  after atomic rename can leave the old or new complete inventory, never a partial
  file. Reported persistence failure closes the host; restart restores no grants.
  Invalid signatures do not stage artifacts. Uninstall retains bytes but removes
  authority; no automatic GC. Retained bytes are not automatic rollback: reinstall
  still needs a valid signed manifest and fresh owner consent.

This is immutability **by content identity and verified detached snapshot**, plus
filesystem protections from other OS users. It is not an immutable filesystem
against the same UID/owner, a signed executable loader, a GGUF store or a native
sandbox. The 16 MiB cap is deliberately for small inert plugin bundles; runtime
and model artifacts still use their separate reviewed provisioning mechanisms.
No grant, consent ticket or session is ever persisted. HMAC does not prevent an
owner-level attacker replaying old valid inventory after restart; all grants still
start denied. Existing signed inventory has no external rollback counter.

## What is sufficient for a first-party demo

A small subsequent **integration**, not another generic infrastructure milestone:

1. Add a development-only bundled Compare controller with a pinned first-party
   manifest/artifact identity and no arbitrary entrypoint loading. Keep the full
   app default and payment UI unchanged.
2. Present two trusted owner reviews, each naming installation/publisher/version,
   one exact local model, foreground inference, expiry, total calls and input/output
   ceilings. Create each transport only after actual owner confirmation. Installation
   alone must visibly yield no inference permission. Do not accept approval in chat
   or in plugin messages.
3. For the initial consent/UI demonstration, use clearly labelled fixture results.
   Demonstrate denial, one approved call, revocation/Stop, expiry, update invalidation
   and restart requiring fresh approval. Existing tests already exercise these paths,
   including an actual trusted worker and protected-update/live-channel interaction.
4. For real inference, admit a dedicated proven local engine through the platform
   verifier and serialize the two sessions to avoid competing model loads. Close
   each engine before releasing its resource and opening the next. No scheduler,
   provider transport, tool registry or generic gateway fallback.

Do not label a fixture UI as actual model comparison. Native third-party plugins
remain outside the demonstrated trust boundary.

## Exact blockers for a real Windows local-model demo

| Gap | Required evidence / smallest adaptation |
| --- | --- |
| Windows engine admission currently refuses | Implement the existing platform interface with evidence tying the actual child, approved model and exact loopback listener together. Do not return `supported:true` on faith. |
| Real llama.cpp model contract not validated | Demonstrate the pinned engine's model-file lifecycle. The Linux proof requires an open model FD; a mmap-and-close engine may not satisfy it. Validate a real engine contract rather than weakening verification to metadata. |
| Authenticated dedicated endpoint launch | Reuse the existing launcher but supply a fresh private engine API key, exact local binding and fixed permitted completion route. Verify child/listener ownership after startup; a successful health probe or free-port choice is insufficient. |
| Stop only proven on local fixture child | In packaged Windows, witness actual process exit/tree termination, no new inference after revoke/expiry, safe reservation release and GPU resource cleanup. Treat unconfirmed cleanup as unavailable; never restart into its reservation. |
| Protected Windows registry/key storage absent | Adapt the store interface using the existing fail-closed OS `safeStorage` patterns, a separate integrity-key namespace, private Windows ACL/reparse/hardlink protection and atomic writes. Preserve shared-profile single-instance exclusion. Never borrow core keys or trust POSIX mode bits on Windows. |
| Owner UI/renderer bridge not wired | Reuse exact sender/main-frame/document validation and cancellation on navigation/crash/destroy. Main process retains all install/consent/engine objects; renderer receives only narrow Compare controls. Verify actual consent and update-invalidation in the packaged app. |
| Real model and packaging verification absent | Test both local models, output caps, no-egress failure, shutdown and packaged paths on Windows. Chromium is still unavailable here; its official download was blocked. |

A Windows consent-only fixture demonstration can proceed without turning on the
Windows engine or store adapters, provided it says so plainly. A persisted/real-model
Windows demo cannot yet claim these guarantees. Current Windows admission remains
fail closed, and no code in this milestone changes that.

## Reuse existing app machinery; do not duplicate it

| Existing implementation | Reuse | What it does not establish |
| --- | --- | --- |
| `electron/window-security.js:trustedMainDocument` and `protectNavigation`; `electron/providers.js:registerProviderIPC` | Exact window/main-frame/origin/document checks, bounded request tracking, navigation/crash/destroy cancellation and frame-checked replies. Add one narrow Compare bridge using these patterns. | Provider HTTP is paid/network transport; do not expose or reuse it for local grants. |
| `electron/tool-approval.js:createToolApproval` | Native owner-dialog and cancelled-generation pattern; a dedicated exact grant review can follow it. | Existing app-action wording/semantics are not plugin consent. Do not silently reuse old approvals. |
| `electron/main.js` single-instance lock and profile backup flow | Existing Live/Test exclusion and original profile recovery. | Not an OS sandbox or a cross-process plugin execution quota. |
| `electron/providers.js` / `companion-store.js` secure-storage and atomic-write patterns | Reject unavailable/basic-text storage, use OS-backed protection and atomic replacement for a **separate** plugin registry/key. | Do not share provider credentials, Brain stores, wallet keys or current session secrets. |
| `core/lib/runtimes/llamacpp.js:LlamaCppRuntime`, `runtime-provisioner.js` | Dedicated launcher instance, Windows CRT placement, `engineEnv`, pinned runtime artifacts, local arguments, Windows-hidden child, health/crash reporting. Adapt these instead of a second launcher/downloader. | `stop()` currently calls `child.kill()` and drops its handle immediately; it does not await exit or prove process-tree/GPU cleanup. Health checks do not authenticate ownership. |
| `electron/native-computer.js`, `windows-voice.js`, `pocket-voice.js` | Established bounded request IDs, child error handling, timeout and idle-cancellation patterns. | Their kill/terminate paths and inherited environment are not proof of native isolation; do not transplant them as such. |
| `RuntimeManager` / gateway / CompanionHub | Keep current full-app behavior intact. | Shared switching, provisioning, fallback, accounts and data dependencies are too broad for this per-model permission boundary. |

## Readiness conclusion

The dormant policy/identity/transport/store foundation is complete for its bounded
trusted-first-party scope. Stop adding general infrastructure. The next useful work
is a small explicit-consent Compare demonstration and the missing packaged Windows
runtime/storage evidence, using the existing app machinery above. Do not enable
untrusted loading, marketplace installation, automatic profile migration or network
spending to make that demonstration work.
