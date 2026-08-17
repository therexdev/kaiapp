# Durable ledger storage — phases 0 AND 1 SHIPPED (kai `3713164`, 2026-08-17)

> **As-built status.** Everything below the phase-1 heading is now BUILT and deployed,
> hardened by a 22-agent adversarial review (14 confirmed findings fixed before deploy —
> highlights: charge-time spend durability closing a CRITICAL resume over-mint; strict
> close persistence that withholds on-chain settlement when the disk write failed; boot
> settlement repair; per-epoch price pinning across restarts; db-export retiring the DB on
> rollback; backup view refresh; 200-epoch caps). The sqlite backend is INERT until the
> owner sets `KAI_STORE=sqlite` on the box (json stays the default; the probe suite proves
> the refactor is behavior-identical). One documented one-time transition cost: the FIRST
> boot under the resume feature resurrects the pre-deploy in-flight epoch's receipts
> without its (never-persisted) spend counters — bounded to that single epoch, after which
> charge-time persistence keeps spend and receipts in lockstep.
>
> Also shipped alongside (same review batch): epoch RESUME on boot (a restart used to
> abandon up to 15 min of workers' earned receipts), persistent daily free-tier counters,
> and the fast-restart submit_root collision guard.
#

Task #26. The scheduler's money records (balances, receipts, epoch settlements) live as
JSON files on one disk. Two failure classes matter as we approach mainnet:

1. **Torn writes** — a host recycle / SIGKILL mid-write leaves a truncated file; on the
   next boot the ledger fails to parse and balances are silently gone.
2. **Cross-file inconsistency** — one logical action touches several files (debit a
   balance, append a receipt, update perf). A crash between writes leaves them
   disagreeing, and JSON files cannot be updated in one transaction.

## Phase 0 — SHIPPED (dependency-free hardening)

Every persistence write in the scheduler now goes through one atomic helper
(`_atomicWrite`: tmp + rename): `credits.json` (balances), `workers.json`,
`revoked.json`, `epoch-*.json`, `perf.json` (already had it), `oracle.json` (already had
it). Rename is atomic on POSIX — a crash mid-write can truncate only the tmp file, never
the ledger; the last good state always survives. Additionally, perf persists on **process
exit** (not just epoch close) — the auto-deploy restarting twice inside one epoch was
wiping measured perf/reputation signals each time (field finding 2026-08-17).

Verified by `scripts/probe-durable-writes.js` (simulated crash mid-write; perf-through-
`process.exit()`; listener hygiene) — fails on the old scheduler, passes on the new one.
This closes failure class 1. It does NOT close class 2.

## Phase 1 — SQLite cutover (DESIGN — owner review before build)

**Goal**: all mutable scheduler state in ONE SQLite database with WAL, so every logical
action commits atomically (class 2 closed), reads never see half-updated state, and the
DB file backs up/restores as one unit.

- **Driver decision at build time**: prefer Node's built-in `node:sqlite` if the box's
  Node runs it unflagged (verify on the host: `node -e "require('node:sqlite')"`);
  otherwise `better-sqlite3` (needs `build-essential` installed on the box for npm ci —
  one-time apt install, and the deploy script already reinstalls deps on manifest change).
  Both are synchronous APIs — matching how the scheduler already does sync writes, with
  transactions replacing multi-file write sequences.
- **Schema** (JSON payloads stay JSON in TEXT columns — no big-bang normalization):
  - `balances(address PK, entry_json)` — replaces credits.json
  - `workers(token PK, address, worker_json)` — replaces workers.json (indexes on address)
  - `perf(address PK, perf_json)` — replaces perf.json
  - `epochs(epoch PK, receipts_json, summary_json)` — replaces epoch-*.json
  - `revoked(sha PK, meta_json)` — replaces revoked.json
  - `kv(key PK, value)` — oracle state, free-tier day counters, runtime notes
- **Transactions on the two money paths**: (a) request authorization = read balance +
  free-tier counters, debit, record — one transaction; (b) epoch close = settle, write
  summary+receipts, bump repPaidJobs, persist perf — one transaction.
- **Migration on boot** (safe, reversible): if `KAI_STORE=sqlite` and the DB is missing
  but JSON files exist → import everything inside a single transaction, then rename the
  JSON files to `*.json.migrated` (kept, never deleted). Flag defaults to `json` until
  the cutover is decided — deploying the code changes NOTHING until the env flips.
- **Rollback**: set `KAI_STORE=json` and restart (the `.migrated` files are still there);
  plus an export tool (`scripts/db-export.js`) that dumps the DB back to the JSON shapes.
  The operator state-export endpoint gains the DB file in its bundle.
- **Soak**: run `sqlite` on the box only after the probe suite + an adversarial
  multi-agent review of the transaction boundaries, then watch a few epochs' settlements
  reconcile (earned/spent/claims identical to the JSON path) before calling it done.
- **Probes** (fail-old/pass-new, as always): crash-injection between the two halves of a
  money action must leave the DB consistent (JSON path demonstrably can't); migration
  fidelity (byte-equal balances before/after); rollback round-trip.

**Owner decisions before phase 1 ships**: none on economics — this is pure plumbing. The
one operational call: when to flip `KAI_STORE=sqlite` on the box (I'll bring the soak
evidence first). Building it is ~a day of work + review; say the word and it goes on the
queue.
