# Dormant trusted local inference adapter

`core/lib/plugins/local-inference.js` exports `createLocalInferenceAdapter`.
It is not imported by application startup, existing UI, payment or KOIN code.
Its only callers are tests. No process, model download or network request occurs
on module import. This milestone starts only fixture processes during tests.

## Host contract

The trusted host supplies exactly `{ resource, port, child, apiKey, timeoutMs }`:

- `resource`: an exact `model:` identifier bound to an already-loaded model.
- `child`: a real Node ChildProcess **dedicated to this adapter**, not the shared
  core serving engine. The host must prove that this child owns the endpoint and
  requested model. Merely passing a ChildProcess does not establish that fact.
- `port`: the dedicated engine's port on literal IPv4 `127.0.0.1`. No URL, DNS,
  Unix socket path, route or address is accepted from plugins.
- `apiKey`: a host-owned random 32–128 character URL-safe engine API key. The
  engine must have been started with the same key. No core wallet/provider/API
  key is reused. This authenticates the client; it does not independently prove
  server/process identity or constitute OS isolation.
- `timeoutMs`: an independent hard request deadline, 1–60,000 ms. It is distinct
  from the owner's grant duration and cannot be chosen by a plugin.

The host passes only `adapter.infer` to `createPermissionHost` as its trusted
`localInference` callback. The plugin receives only the caller-bound permission
client, never the adapter, its `close` operation, child or approval authority.
The host closes the adapter on session disposal. Grant revocation is the current
host Stop path; there is no plugin-controlled stop/consent UI in this milestone.

This adapter deliberately bypasses the generic gateway, RuntimeManager.acquireFor,
model provisioner, account, provider transport, tool registry and scheduler.
The current runtime manager can load/download models and use fallback engines;
those paths are not suitable for this bounded foreground adapter. Existing
`LlamaCppRuntime.stop()` does not await child exit; it is not substituted for
this adapter's confirmed termination handling.

## Request and cancellation behavior

One request at a time; concurrent demand is refused, never queued or rerouted.
Only native llama.cpp `POST /completion` is called. It receives a literal raw
prompt, `n_predict` equal to the approved output-token ceiling, `stream:false`
and `cache_prompt:false`. It receives no model-selection URL, tool instructions,
wallet, connected account, personal data store or network routing settings.
This is raw completion, not a chat-template integration.

The permission host first enforces owner input and output ceilings and reserves
a call synchronously. Adapter ceilings are additionally 100,000 UTF-16 input
characters, 32,768 output tokens and a 1 MiB response body. The trusted engine
must honor `n_predict`; reported `tokens_predicted` must be an integer within the
ceiling before any output is returned. Missing/invalid counts, unfinished output,
malformed replies and excess output are rejected. This verifies the trusted
engine contract, not a hostile engine's token claims or an OS GPU-work quota.

The HTTP client uses a literal loopback address, a fixed path and `agent:false`.
There is no redirect handling, proxy adapter, fetch, remote URL or fallback.
Only an uncompressed JSON success response is accepted. Failure is generic;
engine messages, credentials and internal paths are never returned to plugins.

Revocation, grant expiry, adapter timeout or adapter failure destroys the active
HTTP request and sends SIGKILL to the dedicated child. The adapter waits up to
2 seconds for confirmed child exit, then stays permanently unavailable whether
shutdown succeeded or not. It never starts/restarts an engine. `close()` reports
whether exit was confirmed; a false result requires host/operator cleanup, not
retry through another model/provider. The permission host rejects cancellation
promptly while adapter cleanup can continue. A process that cannot be terminated
might still compute; no further work can be dispatched through this adapter.

Tests start a separate local HTTP fixture subprocess and confirm actual process
exit, including stalled replies and cancellation. They also test synchronous and
asynchronous kill failures with permanent disablement. They do **not** establish
llama.cpp token accuracy, Windows process-tree/GPU cleanup, loopback-port ownership,
or a sandbox against malicious native code. The current caller/engine/transport
remain trusted. No financial operations are added.

## Independent review and fixes

A separate review agent inspected the original commit and reproduced:

1. Accessor values changing between validation and dispatch/copy (limit bypass
   and revocation during argument evaluation).
2. Cancellation stuck behind a non-settling adapter.
3. Raw internal adapter errors crossing the boundary.
4. Observed expiry becoming usable again after wall-clock rollback.

Fixed using descriptor-only snapshots, dense array validation, an abort race,
generic errors, grant-level expiry timers and permanent retirement on observed
expiry. Manifest/identity binding, non-transitive grants and synchronous budget
reservation remain intact. The follow-up review found two further edge cases:
post-result expiry also needed retirement; synchronous revoke-then-throw needed
rejection handling attached safely. Both have regression tests, including a
subprocess running with strict unhandled-rejection handling. Shutdown also handles
asynchronous child kill errors, cleans up listeners and stays disabled.

## Next integration boundary

The dormant owner-consent/installation contract and Linux engine supervisor now
exist; see `IDENTITY_SUPERVISION.md`. The dormant transport/store/snapshot boundary
is also complete; `INTEGRATION_READINESS.md` identifies the first-party demo and
Windows evidence required next. Demonstrate model absence/busy denial
without download or fallback, Windows process-tree termination, and a genuine
Stop path. Keep shared serving/earning unaffected. Only then connect a reviewed
Compare Models harness behind explicit owner grants. Untrusted plugin loading
still requires a separately demonstrated OS isolation boundary.
