# Dormant installation, consent and dedicated-engine supervision

This milestone adds trusted-host interfaces only. No existing app route, UI,
startup factory, payment/KOIN service, wallet or deployment setting imports them.
There is no plugin loader, general RPC dispatcher, sandbox or automatic engine
launch. The owner must retain every control-plane object described below.

## Installation and owner consent

`installation-host.js:createInstallationHost` wraps the permission policy with:

- A trusted publisher allowlist of pinned Ed25519 public keys. Installation
  verifies a signature over a domain-separated canonical manifest, publisher ID
  and SHA-256 of supplied artifact bytes (at most 16 MiB). Keys are never taken
  from package metadata. A signature identifies a publisher; it does not establish
  that its code is safe. Artifacts are hashed, not unpacked or executed.
- A fresh random installation UUID on **every** explicit install, including an
  identical reinstall. Replacing a publisher, version, manifest or artifact
  invalidates previous clients, grants and pending consent. Uninstall revokes
  before attempting durable removal.
- Opaque object handles in a private WeakMap. `connect(handle)` is host-only and
  yields only `infer`; plugin messages cannot select their caller by ID, UUID,
  publisher, copied handle or self-declared metadata. No message-to-method router
  is supplied. A future authenticated host transport must hold and bind handles.
- `prepareConsent(handle, request)` produces an immutable review containing the
  signed installation, exact scope, duration and limits. `approveConsent(review)`
  accepts only that host-created object once, rechecking current installation
  identity and consuming it synchronously. JSON copies and plugin-created objects
  cannot approve anything. The owner UI must call this method only after real
  consent; no `approved:true` field or plugin callback constitutes consent.
- Host-only revocation and close. Limits remain synchronously reserved before
  inference; multiple calls cannot spend a single-call grant twice. Existing
  reserved categories (wallet, account, personal data, background work and
  network spending) remain unapprovable.

A **trusted synchronous atomic store** supplies `load()` and `save(state)`.
The injectable interface is explicit; there is no new production profile store.
The tests exercise an actual temporary JSON file with atomic rename and restart.
Only signed installation inventory and host-assigned UUIDs persist. Private
publisher keys, grants, consent tickets and transport handles never persist.
On restart signatures are reverified against current pinned keys; all inference
requires a new handle and new owner grant. Both revoked and previously live grant
IDs fail. Unexpected state fields, including imported grants, are rejected.
Store mutation failure closes the host and revokes its live authority; asynchronous
store results are unsupported and rejected without leaving unhandled rejections.

Store integrity, atomicity and single-writer exclusion are host prerequisites.
The UUID is host state, not publisher-signed data. This does not protect a registry
from another process with owner-level disk access or provide a rollback-resistant
ledger. Replaying an older valid inventory cannot restore a grant (none are
persisted), but inventory rollback itself needs protected storage/version policy
before production. Startup does not execute any restored artifact.

## Dedicated-engine supervisor and platform proof

`engine-supervisor.js:createEngineSupervisor` adopts an **already spawned,
dedicated trusted child**. It does not provision or launch executables and does
not take the shared runtime manager's process. The supplied spec contains exact
resource, ChildProcess, port, engine key, deadline and expected executable/model
paths and SHA-256s; interpreted test engines also pin their entrypoint. These are
trusted host inputs, never plugin-selected paths, PIDs or URLs.

Admission reserves resource, PID and port synchronously before asynchronous
verification. Reservations are process-wide across supervisor instances. Ownership
is tracked by a unique reservation token, so a late/repeated close cannot release
a replacement's reservation. There is no queue or model/network fallback.

The platform interface is `{ supported, verify(spec, signal) }`. Only literal
`true` confirms ownership. Linux verification uses actual kernel state:

1. Canonical absolute executable and model paths are hashed through open file
   descriptors; before/after inode, size and nanosecond timestamps must agree.
   Symlink aliases are rejected. An interpreted test entrypoint is also hashed.
2. `/proc/<pid>/exe` device/inode must match the approved executable. Actual
   `/proc/<pid>/cmdline` must match the trusted ChildProcess launch arguments and
   contain the approved model path (and pinned entrypoint when applicable).
3. An open `/proc/<pid>/fd` must hold the approved model's device/inode. This
   proves a file handle, not semantic use of those bytes as a model.
4. The exact IPv4 `127.0.0.1:port` TCP LISTEN entry must have an inode held in that
   **same child's** descriptor table. Seeing a namespace-wide TCP entry alone is
   insufficient. Other processes' endpoints and wildcard listeners are refused.
5. The child must still be live and not killed. Proof is repeated before every
   inference, not just at admission.

Each verification phase has a bounded deadline and races cancellation. Linux
artifact hash streams receive its AbortSignal. A non-cooperative injected verifier
can continue its own internal work, but cannot cause late dispatch. On inference
cancellation/expiry, the engine is terminated even while verification is pending.
The existing local adapter additionally enforces its completion timeout and caps.
No downloaded runtime, paid inference, HTTP redirect or provider fallback exists.

On close or failure, the dedicated child is terminated and its exit is awaited.
Confirmed exit releases reservations. Unconfirmed shutdown permanently disables
the session and quarantines reservations; no replacement can silently reuse them.
After rejection **before admission** (unsupported platform, duplicate reservation,
or invalid adapter construction), the trusted caller still owns and must clean up
its child. On failed ownership verification after adoption, the supervisor performs
cleanup. The host must also close idle sessions when disposing a feature.

Only Linux verification is implemented. Windows and other unsupported platforms
refuse admission; this is an interface boundary, not a Windows sandbox. Tests use
original local Node fixture processes and inert model files. No unrecognized
executable was downloaded or run. No actual llama.cpp/GPU ownership or shutdown
claim is made.

## Limits and concrete integration gate

Kernel observations and rehashing reduce misbinding; they do not eliminate
filesystem/process races. Approved model/entrypoint files must be immutable to
plugins and concurrent writers. A retained model FD may not match the lifecycle
of a real engine that closes descriptors after mmap; that requires a separately
validated native contract. Process-level reservations are not cross-process locks
and do not survive host crashes. Startup needs child reconciliation and singleton
coordination before launching replacements. Direct child exit does not prove
Windows process-tree or GPU cleanup. Same-user native code remains trusted.

The next bounded gate is a **dormant authenticated host transport + supervisor
lifecycle harness** with protected single-writer registry storage and approved
immutable artifact loading. It must bind a transport endpoint to an opaque
installation handle, expose only inference, render exact owner consent in trusted
UI, and account for child startup/admission failure/crash recovery and idle close.
Validate one real pinned llama.cpp model/process/port contract, including Windows
process-tree termination and GPU cleanup, before enabling Windows execution or
connecting Compare Models UI. Untrusted plugin loading still requires an actual
OS isolation boundary, separately demonstrated.

## Independent review

An independent reviewer inspected the new interfaces, reproduced a hung-verifier
cancellation issue and a false-verification acceptance issue, and verified their
fixes. Strict tests also cover publisher/version/artifact changes, forged/reused
consent, persisted-state tampering, restart/revocation, uninstall/reinstall,
endpoint/process/model mismatches, resource contention, repeated close, quarantine,
and owner-consent expiry/uninstall through to real fixture process termination.
The final review found no blocking issue within the documented dormant trust scope.
Its optional asynchronous-store rejection hardening was also implemented and tested.
