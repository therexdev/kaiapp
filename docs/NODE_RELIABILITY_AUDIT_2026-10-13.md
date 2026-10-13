# Node reliability audit — 2026-10-13

## Evidence and scope

Reviewed the supplied October 13 service logs and current `therexdev/kaiapp` Test and Master sources. Master base: `a725c6a`; Test base: `5c4fd74`. The log contains a gap in activity around 09:26–11:53 UTC, then service startup and AMQP reconnections. By 11:55 the chain reports sync progress at height 40,170,000. Seed failures coexist with successful peer block requests. This excerpt does **not** prove database corruption or identify whether the host slept, Docker exited, or the app/controller stopped the stack. There is no live access to the owner's Windows host in this task.

## Findings and fixes

| Finding | Change |
| --- | --- |
| Master had fallen behind Test's existing node recovery fixes. | Port lifetime-aware logs, broker health/dependency checks, recovery serialization, RPC retention, failed-attempt backoff and advancing-chain protection. Preserve Master's patched block-store runtime, API, wallet and distribution boundaries. |
| Master lost watchdog coverage after app reopen; renderer polling determined adoption in Test. | Core supervises independently of the visible screen; resumes saved run intent and adopts only an already-running, verified own stack during upgrade. Explicit Stop is persisted. |
| Master and Test used the same Docker project with different profiles. | Verify Compose ownership labels and hold a per-user project lease. Fail closed for unknown/foreign ownership. Persist a conflict pause so another profile cannot seize the project in a restart gap. Keep existing data paths and ports; do not migrate a database. |
| Empty service sets were treated as unknowable health forever. | Distinguish Docker/query failure from a successful empty inventory. Recreate a missing stack only for the profile with saved running intent. |
| Docker Desktop failure required manual relaunch. | Retry launching the already-installed engine, with cooldown. No unattended installation, WSL shutdown, daemon reset or system reboot. |
| One failed service could bring down the whole stack. | Recreate only that service first. Repair RPC separately, try P2P before escalating a stalled chain, then use a coordinated stop/start only when needed. |
| Restart failure/panics/parse errors could imply corrupted data. | Require database-specific evidence. Repeated infrastructure failures keep retrying with backoff rather than ordering Quick Sync. |
| Slow catch-up or old errors could trigger needless recovery. | Consider successful head advance and fresh, current-process chain progress. Wait through startup and backoff periods; never claim health merely because Compose returned success. |
| Memory saver could remove Master's public RPC. | Keep RPC and enabled API profiles; reduce jobs. Monitor configured API index containers too. |
| Blockchain-only operation did not prevent idle sleep. | Include the managed node in the existing Electron sleep blocker; nudge supervision on wake/unlock. |
| Restarting Windows required manually reopening the app. | Add a reversible, native **Start at Windows sign-in** setting, bound to this installed executable and trusted Settings IPC. |
| Recovery could operate on an unavailable data drive. | Wait for the original files/drive; do not initialize a replacement chain silently. Low disk space produces a retryable, explicit message and does not delete data. |
| Docker logs were unbounded; short stop deadlines risked forced kills during DB flushes. | Bound container logs to 3 × 10 MB per service and allow a 120-second shutdown grace. This does not cap database growth or every application-managed log. |
| Ordinary service repair required troubleshooting commands. | Add **Repair services**, distinct from snapshot restore, with operation/ownership guards. |
| Master's API startup listener could remain unavailable after a transient port conflict. | Retry the configured listener every 30 seconds while enabled; keep public RPC read-only boundaries. |

## Validation

- Deterministic recovery, ownership, persistence, cancellation, low-level service commands, log classification, UI painters, API and login-startup tests.
- Added a CI gate using real Docker Compose with disposable Alpine services, no published ports, no real chain and no wallet: stop an RPC container, verify only RPC is recreated, reopen the manager, remove the entire stack, verify recreation and retained data, block a foreign profile, then verify explicit Stop.
- Both normal release pipelines retain browser/Windows packaging/signature gates. Master retains its packaged block-store patch check; the package fixture isolates Docker ownership because it tests file generation only.
- Local full-suite attempt was limited by unavailable Chromium; its download endpoint returned an invalid archive. Browser coverage must be assessed from CI. No live Windows node restart, storage repair, wallet operation or payment was performed here.

## Operation and remaining requirements

Install the completed release, keep **Automatic recovery** on, enable **Start at Windows sign-in**, and keep the app in the notification area. Use Master to manage the node that backs the public API; Test can stay open for AI/payment testing without controlling Master's Docker project. An older unpatched controller still needs to remain closed; it does not implement the new ownership guard.

Automatic service recovery preserves the chain and producer configuration. Verified corruption still offers the guarded snapshot repair flow; it does not silently replace tens of gigabytes or delete rollback copies. Interrupted restore markers remain fail closed rather than guessing which partial state to use. The supervisor runs in Core, not as an independent OS service: explicitly quitting or crashing the entire app leaves Docker restart policies active, but app-level recovery resumes only when the app starts again. Sign-in startup covers login after reboot, not pre-login or a host with no power.

A powered-off, sleeping-by-explicit-request, offline, full, failing or disconnected host cannot provide uninterrupted service. An independent second synchronized RPC host with health-checked traffic failover is still required to keep the public API available through total host outages. That infrastructure has not been deployed by this change. Do not present unit/fixture success as a live-host or 24/7 uptime certification.
