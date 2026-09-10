# KAI security and reliability sweep — 10 September 2026

Baseline: `test` at `708d92ede92b52f0f8a09ed39b8a949be3e05401`.

This review followed the desktop, Core HTTP API, remote relay client, wallet and settings persistence, model/runtime installation, public research, Brain/workflow egress, email/calendar/MCP connections, Agent Network and scheduler boundaries. Existing tests also exercise node management, producer custody, account approvals, CLI confinement, desktop tasks, voice and UI state. The source inventory includes 231 files across the principal application directories; the updated Core suite has 118 test files. This is a repository review with targeted adversarial regressions, not a claim of complete line or hardware coverage.

All new network regressions use synthetic data and loopback servers or injected transports. No live funds, user credentials, account writes, contract deployment or production server changes were used for testing.

## Findings fixed

Severity below is review triage based on the capability required and possible impact, not a formal CVSS assessment.

| Area | Finding and resulting behavior | Priority | Regression evidence |
| --- | --- | --- | --- |
| Remote access | A `/v1/` prefix check accepted paths that URL normalization could turn into `/core/` access. Strict paths, normalized-origin comparison and redirect refusal now confine replay to the public API. | High | The baseline reached a loopback control endpoint; traversal, encoded paths and backslashes are now rejected. |
| Remote API keys | Removing the final key could restore unauthenticated local access for forwarded requests. Forwarded requests now require a valid key at the gateway even if revocation races the relay check. | High | Empty-key, valid-key and revoked-key gateway requests are tested. |
| Local HTTP server | Same-origin browser requests after DNS rebinding could omit Origin. Core now verifies the local Host authority and rejects foreign absolute request URLs. Framing and content-sniffing headers are explicit. | High | A foreign Host with same-origin fetch metadata gets 403; localhost and normal loopback clients work. |
| Wallet password storage | Legacy password length plus a short fast SHA-256 fingerprint provided an offline password-guessing prefilter before scrypt. New wallets omit it; opening an old wallet atomically removes the hint without changing ciphertext or identity. | High | Legacy migration, unchanged encrypted bytes, correct/wrong password and restart/session tests. |
| Wallet file parsing | File-controlled scrypt parameters could request excessive work. Version 1 now requires its fixed KDF profile and exact hex field sizes before derivation. | Medium | Hostile KDF settings and malformed encrypted fields fail before derivation. |
| Settings and wallet writes | Dotted settings paths could traverse object prototypes. Paths reject reserved keys and inherited properties; settings defaults are isolated between instances. Private atomic writes use unique exclusive temporary files. | High for prototype writes | Prototype pollution reproducer, independent defaults, reload and POSIX permission checks. |
| Desktop shell | Native pickers, window controls and preferences lacked consistent trusted-document checks. They now require the main frame of the app document; navigation and webview attachment are restricted. | Medium | Wrong window, frame and document refusals, allowed app navigation and external-link handling. |
| Public web requests | DNS was checked before a second independent network lookup. Research, Brain sources and workflow HTTP requests now pin sockets to the validated addresses while retaining hostname TLS verification; redirects are handled by each caller's policy. | High | Checked-address socket lookup, forbidden targets and existing workflow/source privacy tests. |
| Web response resource limits | Page extraction previously read an unbounded body. Live responses are decoded and capped while streaming, including chunked/compressed responses; unsupported encodings fail safely. | Medium | Oversized stream cancellation and gzip/hostile encoding tests. |
| Runtime ZIP extraction | Archive entries needed stronger bounds, symlink handling and inflated-size checks. Extraction rejects unsafe names/symlinks, validates entry bounds and sizes, and strips special Unix mode bits. | High for file escape | Hostile names, symlink entries, forged deflate lengths, permissions and existing runtime archive tests. |
| Model downloads | Ignoring writable backpressure and asynchronous disk errors could buffer excessive data or crash Core. Streaming now uses pipeline error handling, validates resume ranges and enforces expected size. | Medium | Missing destination directory, incorrect partial range and successful hash-verified install. |
| Privacy and shutdown | Earnings status could send a wallet address in Local-Only while earning was stopped. It now stays offline in that state. Core shutdown stops remote polling; relay retries are interruptible and concurrent work is bounded. | Medium | No-request earnings test, allowed online read, shutdown and remote-access tests. |
| Agent Network results | Delivery used the truncated preview value and could reject valid structured output. It now sends full workflow output in the declared type, subject to the advertised byte limit. | Reliability | End-to-end free-service delivery of 20,000 characters, object, array, boolean and integer output. |
| Agent Network Stop | Stopping left established HTTP requests active. Active requests now abort on Stop or Local-Only and have a total request deadline. | Medium | An already connected loopback request is cancelled and removed from the active set. |
| MCP | SSE replies waited for connection close even after the answer arrived. Incremental parsing now resolves the matching response immediately, caps RPC data, preserves split UTF-8 on stdio, and clears pending timers on exit. | Reliability / resource exhaustion | Persistent SSE response closes promptly; existing real subprocess and HTTP handshakes pass. |
| Calendar | Carriage returns could inject ICS properties; invalid end times reached request building. Text is correctly escaped, end time must follow start, remote collections require HTTPS, and credential-bearing requests refuse redirects. Existing saved URLs are revalidated before use. | Medium | Injected ATTENDEE text stays literal; invalid times and new/legacy insecure URLs fail. |
| Email and credential status | SMTP could fall back to plaintext on a STARTTLS port. Delivery now requires TLS and has bounded connection timeouts. Email/calendar do not label Electron's `basic_text` backend as encryption. | High for credential transport | A real plaintext SMTP fixture receives no AUTH or email commands; credential roundtrip tests pass. |
| Scheduler operator API | Missing operator configuration left administrative routes open. Every operator route, including epoch close, now fails closed without a configured matching secret. | High | Missing/wrong/correct-secret requests. Server deployment required. |
| Scheduler jobs and billing input | Results were not bound to the assigned worker; usage could contain invalid numbers. Worker ownership and bounded integer usage are checked before receipt acceptance. Polling now refreshes the stored worker's liveness. | High | Another signed worker's result and malformed counts are rejected without losing the job; valid signed result is accepted. |
| Scheduler consumer lifecycle | Signed requests could be replayed, concurrent wallet requests shared the same capacity, nonnumeric timestamps bypassed the age comparison, and disconnects left orphan work. Replay tracking, wallet serialization, finite timestamps and cleanup now cover these cases. | High | Replay, concurrent request, invalid timestamp and disconnect cleanup regressions. |

## Dependency changes

The root lockfile audit initially reported nine affected dependency entries: one critical, seven high and one moderate (including transitive/meta entries). The contract development tree initially reported 34. After updates, both `npm audit --json` results report **zero known vulnerabilities** as of this review. This counts advisories in the resolved dependency trees, not every possible defect in the application.

Updates include `protobufjs` 7.6.6, `sharp` 0.35.4, `nodemailer` 9.1.1, `mailparser` 3.9.23, `@xmldom/xmldom` 0.8.15 and `fast-uri` 3.1.7. Contract generation uses patched protobuf and YAML dependencies. The old SDK's transitive npm development tool is overridden to patched 11.19.1; the SDK itself stays at the version used by the contract. Contract ABI files were regenerated together.

Patched protobuf exposed an incompatibility in koilib's merged token ABI. Scheduler chain reads and the chain probe now use KAI's existing bundled token ABI. Token balance, settlement and protobuf decoding regressions pass.

The Test release workflow now audits both dependency trees and blocks high/critical findings before publishing installers.

## Validation

- Full local Core run: **855 tests; 801 passed, five failed to launch missing Chromium, 49 skipped**. All five failures are in the Node data-folder browser suite and occur before browser execution. Browser download attempts timed out in this environment. This is not recorded as a green full suite.
- The final focused lifecycle/Agent Network/store/remote run passed **31/31**; calendar/connector follow-up checks cover the final credential validation change.
- New coverage comprises 19 security/service tests plus one Agent Network result regression, with additional assertions in existing suites.
- Contract unit tests: **17/17 passed**. Contract release build succeeded; reported contract source coverage is approximately **73.9%**.
- Dependency audit: zero known vulnerabilities in both lockfiles.
- GitHub's Test installer workflow is the required full browser, native Windows, packaged voice, shared-profile and Windows/Linux packaging gate. Use the workflow run for the commit containing this report to determine the release result; local results alone do not establish installer readiness.

## Compatibility and remaining work

1. **Scheduler deployment:** committing `server/scheduler.js` does not replace any running hosted scheduler. Deploy through its established hosting process with an operator secret configured, then verify the operator and signed-consumer paths against that deployment. This turn does not claim the hosted service is patched.
2. **Paid network trust:** the current scheduler still relies on worker-reported usage and alpha registration behavior. The replay cache is process-local and the billing path is not a durable reservation system. Proxy IP trust, restart-spanning replay protection, independent usage verification and explicit maximum-cost reservations need a coordinated server/client protocol change before treating this as hardened adversarial paid infrastructure.
3. **Agent Network paid v1:** custody deployment, sponsorship and network acceptance remain incomplete as documented in `agent-network/COVERAGE.md`. Passing prototype tests is not a custody audit or approval to enable payments.
4. **Older wallet copies:** removing hint metadata from the active keystore cannot remove it from historical backups or copies already held elsewhere. Keep those copies protected. The migration preserves encrypted key material and the earning address.
5. **Intentional stricter connections:** custom reverse proxies must send a local upstream Host authority; remote CalDAV collections must use HTTPS and their final collection URL; SMTP servers must support TLS. Local loopback CalDAV fixtures remain supported.
6. **Hardware/accounts:** physical microphones, GPUs, Windows user keychains, real mail/calendar providers, cloud account permissions and multi-day resource behavior need installation-specific testing. Local live-testnet coverage was skipped for unavailable connectivity. Existing native release checks provide additional, bounded coverage.
7. **Local hostile processes:** file confinement blocks archive-controlled escapes but is not protection against a separate process already running as the same OS user swapping filesystem links between validation and use.

Test and Live installer identities, shared profile/wallet/node paths and single-instance behavior are preserved. The release workflow checks those invariants before publishing.
