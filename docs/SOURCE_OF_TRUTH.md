# Koinos AI — Operational Source of Truth

> **Status: CURRENT as of 2026-08-16 ~09:30Z (app v0.25.8, scheduler aa832ac).** This is the living record of what is
> BUILT, how it deploys, and the operational rules learned in the field. Spec authority
> remains *Koinos AI — Master Source of Truth* Part I (owner's `.docx`); `§` references
> point there. Planning history: `docs/V1_PLAN.md`, `docs/M2_PLAN.md`. When this doc and
> reality disagree, fix this doc.

## 1. What the product is

Koinos AI is a desktop app (Windows installer + portable, Linux AppImage) where AI runs
locally: one-click sha256-pinned models, private chat, and an earn-by-serving network —
flip **Earn** and your machine serves priced model classes for KAI (testnet). Consumers can
route chats to the **Koinos Network** (Auto or an exact class) with live word-by-word
streaming. Website + scheduler: **koinosai.com** (testers funnel: `koinosai.com/testers`).

## 2. Repos, branches, deploy & release mechanics

| Repo | Branch | What a push does |
|---|---|---|
| `therexdev/kai` (website + scheduler) | `claude/kai-production-website-fqx4pf` | **Deploys to koinosai.com on push.** Scheduler restarts; roster survives (workers.json) and nodes revive on their next poll (liveness fix). Batch scheduler pushes; each restart is safe but not free. |
| `therexdev/kaiapp` (desktop app) | `claude/kai-production-website-fqx4pf` | CI runs tests. **Installers build ONLY when the commit message starts with `[release]` or `[dist]`.** Publishes GitHub release + auto-update feeds (`latest.yml` / `latest-linux.yml`). Auto-updater checks at launch + every 4h. |

> **Branch note (2026-08-16):** active development moved to
> `claude/koinos-ai-takeover-co25fw` (both repos), branched from the production tips above.
> kaiapp CI runs on any `claude/**` branch, so app releases work from the new branch. The
> kai production host still deploys from `claude/kai-production-website-fqx4pf`; the owner
> approved (2026-08-16) pushing kai changes to that branch to deploy — develop on the
> takeover branch, then push the same commits to the production branch to ship.

- Version bumps: BOTH `package.json` and `core/package.json` (a test enforces the match).
- Code signing: **not yet** — Azure Trusted Signing org identity validation pending (Koinos
  AI, East US). CI is pre-wired: adding the `AZURE_SIGNING_ACCOUNT`/`PROFILE` (+ tenant/client
  secrets) makes the next `[release]` ship signed. Fallback option: SSL.com eSigner.
- No PRs — direct pushes to the branch above. Commits carry no model identifiers.

## 3. Architecture map

**kaiapp** — `core/` (Node service; HTTP gateway on `127.0.0.1:41100` serves BOTH the API
and `ui/` statics), `ui/` (vanilla JS/CSS, no framework), `electron/` (thin shell loading
`http://127.0.0.1:<port>/`; frameless titlebar only under Electron — plain browser works
for dev/screenshots).

- **Views**: Chat, Docs (writing surface + AI assist), Compare (blind 2-model), Models
  (catalog + custom GGUF import), Tasks (scheduled prompts), Network (live public network
  status), Local API (OpenAI-compatible), Earn. Two-box chat picker: source (This machine /
  Koinos Network) × model; personas; attachments; markdown rendering.
- **Model catalog** (`core/models/catalog.json`): 15 aliases, sha256-pinned GGUFs
  (bartowski HF repos), `minRamGb` per alias, `dev-tiny` = CI pipeline model. §27 immutable
  packages; §32 quarantine honored everywhere including custom imports (hashed, used
  in place, never uploaded).
- **Engine ladder** (`core/lib/runtime-manager.js`): cuda → vulkan → cpu, each rung
  self-tested before boot; heal ladder (re-extract, strip exotic ggml-cpu variants);
  **crash results cached per session** (a failed self-test never re-runs); once the ladder
  is dead, model switches **fast-switch** on the running Ollama fallback (~15ms, no
  teardown). Ollama is auto-provisioned (portable, pinned) on Windows; Linux requires
  system Ollama (preflight says so in plain language). `badBuilds` memory is scoped per
  app version (updates retry once).
- **Worker** (`core/lib/worker.js`): outbound-only (register → long-poll → submit);
  single-flight registration + in-flight poll recall; watchdog with frozen-clock (standby)
  detection; SSE streaming of generation deltas to the scheduler; all scheduler fetches use
  `connection: "close"` (pooled corpses killed nodes). Advertises **only** ready catalog
  aliases that are non-dev, non-custom, and RAM-fit (`minRamGb <= machine RAM`).

**kai** — Express site (views/, public/) + in-process scheduler mounted at **`/scheduler`**
(`lib/scheduler.js`), deploys as one process.

- **Scheduler state**: in-memory + `workers.json` persistence (roster survives deploys).
  15-min epochs; receipts → Merkle settlement on Koinos testnet (contract
  `149YvYQfj4MNaFecd7Rm3Z2rK6y2fkPYXz`: deposit/claim_value); §20 splits; §54 bootstrap
  cap; §51 per-IP free-tier ceiling; price oracle with smoothing/breakers.
- **Endpoints**: `/worker/register|next-job|result|heartbeat|chunk`,
  `/network/models` (public picker feed), `/network/status` (public, **addresses truncated
  server-side** `1H7Qva…FjvK`), `/consume` path with SSE relay, `/admin/api/network`
  (full detail, auth).

## 4. Network protocol truths (hard-won)

1. **Liveness = any authenticated contact.** `_auth()` must return the LIVE roster object —
   it once returned a spread copy, every `lastSeen` write evaporated, and every node
   "died" exactly 91s after registering no matter how active it was (the deepest layer of
   the presence saga). Poll, heartbeat, chunk all bump `lastSeen`. Window 90s;
   **busy-counts-as-live** (a mid-job worker with an unexpired lease stays live).
2. **One token per address** — re-registration replaces the roster entry **but carries the
   fairness counters over** (else flappy nodes monopolize seeds).
3. **Trust boundary**: the roster stores only classes in `MODEL_RATES` (register-time
   filter + boot-time sanitize of persisted rosters + RAM gate when the client reports
   `capabilities.ramGb`). Custom imports and dev builds never ride the network. The
   client filters too, but the server never trusts the client.
4. **Dispatch is pull-based and model-matched**: workers long-poll; first `_canServe`
   match wins. `legacy` workers (registered without a `models` field, pre-catalog) serve
   only `dev-tiny`; a modern worker with an EMPTY list serves nothing.
5. **Eval seeding is fair by construction** (tester feedback round): every ~45s (bounded
   by backpressure ≤3 queued+pending) one seed goes to the live worker with the FEWEST
   seeds this epoch; the target's models rotate round-robin; the job is **stamped
   `forWorker`** so a faster poller can't take it. Stamps are leases: they release when
   the target leaves the live window or the dispatch lease expires (with the seed credit
   handed back), and unservable aged evals are GC'd so strands can't jam the backpressure
   window. Counters reset at epoch close.
6. **Billing**: per-class token rates (`MODEL_RATES` ladder, `koinos-fast` $0.10/$0.40 per
   1M up to 32B $1.00/$4.00); chat jobs bill as the served class; evals settle as the
   default class under the bootstrap cap. Chat leases 300s (big classes legitimately take
   minutes); eval leases 60s.
7. **Streaming**: worker posts deltas to `/worker/chunk` (also a liveness signal);
   consumers get SSE with `servedModel` surfaced (the UI shows a route tag).
8. **Perf-fed routing (§51 phase 2, SHIPPED 2026-08-16, commit `aa832ac`)**: the scheduler
   measures every worker itself — `srvTokPerSec` (completion tokens over dispatch-to-result
   wall time) and outcomes `ok`/`to` (lease expiry)/`bad` (failed challenge) folded into a
   smoothed success rate `sr`. Chat jobs get a soft 4s reservation (`preferWorker`/
   `preferUntil`, `KAI_PREFER_WINDOW_MS`) for the best-measured capable worker, then open
   to everyone. Probation (≥4 outcomes, sr < 0.5): never preferred, excluded from "auto"
   class selection when healthy alternatives exist; still serves named classes and still
   receives eval seeds (the road back). Provider-reported `tokPerSec` is display-only —
   routing trusts only server measurements. Probe: `kai/scripts/probe-perf-routing.js`
   (11 assertions; the routing seven fail on pre-`aa832ac` code, the §17/lease four fail
   on pre-`9af2a05`). Eval leases honor the constructor `leaseMs` override now (default
   unchanged) so probes can exercise expiry. **Streaming refreshes the lease** (`9af2a05`):
   a chunk posted mid-job resets its lease clock — a slow honest machine deep in a long
   generation can't age into a timeout and drift onto probation; an absolute cap
   (`KAI_JOB_ABS_CAP_MS`, 15 min) stops chunk spam holding a job forever. One `_busySet()`
   definition serves stats, consume, seeding, reaping, and routing.
9. **§17 verification, first deepening (`9af2a05`, 2026-08-16)**: hidden challenges are
   GENERATED per seed (random-operand arithmetic, rotating capitals; multiplication and
   spelling for classes ≥12GB) — no fixed pool to hardcode; rate via `KAI_CHALLENGE_RATE`
   (default 0.4 ≈ the old 2-in-5 share); `dev-tiny` is never challenged. Token counts are
   CLAMPED to ~2 chars/token of the visible prompt/output before billing or `srvTokPerSec`
   read them (`scheduler:usage-clamped` events log offenders; not yet punished — watch the
   field first). Still open before open beta: challenges that discriminate the CLASS
   (catch a small model answering for a big one), and deciding when a clamp becomes a
   dishonesty verdict.

## 5. Operational rules — do not relearn these

- **Never run a blocking spawn in the worker process path.** The 0xC0000005 self-test
  ladder re-running on every model switch starved polls/heartbeats/watchdog while jobs
  kept serving — the node looked dead while answering chats. Session-cache crash results;
  fast-switch on the fallback.
- **A "flapping node" has had ~5 distinct causes**; check in order: scheduler deploy churn
  (roster wipe — now persisted), pooled-connection corpses (now `connection: close`),
  register storms (now single-flight + poll recall), event-loop starvation (now cached),
  liveness writes not sticking (now fixed). The monitors' exact timing signature
  identifies the layer (e.g. drop at register+91s = liveness bug).
- **Field debugging**: the app's Send feedback button ships core.log excerpts to the
  website admin; `runtime:*` event lines have repeatedly been the decisive evidence. Trust
  the user's pasted logs over theory — three wrong theories preceded the real
  presence-saga root causes.
- **Screenshots/dev**: the real UI runs in plain Chromium against
  `node core/server.js` (`KAI_CORE_DATA=<dir> KAI_CORE_PORT=41100`); seed content via the
  gateway API; a model becomes "ready" by placing the exact pinned bytes in
  `<data>/models/<filename>` (hash must match). Playwright-core +
  `executablePath: /opt/pw-browsers/chromium`.
- **Testing discipline**: every scheduler behavior change lands with a probe script that
  FAILS on the old code and PASSES on the new (run both via `git stash`), plus kaiapp
  regression tests (`core/test/`, `npm test` — 109 tests). Tests must use `koinos-ultra`
  or fakes, never trigger real multi-GB downloads (a 4.4GB test download once filled the
  disk).
- **Write/Bash tool traps**: literal NUL bytes in Write content corrupt files; heredocs
  with control chars get rejected — use python3 or Write. `Readable.toWeb` +
  `duplex: "half"` for >2GiB uploads (`readFileSync` caps at 2GiB); zip extraction runs
  in a worker thread (a 1.4GB sync extract froze the app at "100%").
- **Privacy lines**: full worker addresses are admin-only; public surfaces truncate
  server-side. Wallet WIF is revealed only while unlocked. Chats/docs/tasks are
  local-first and never leave the machine.
- **AGPL**: Odysseus features were re-implemented from scratch — never copy its code.
- **Release habit**: after every `[release]` push, arm a silent check (~12–18 min) that
  verifies the GitHub release + installer assets exist; report to the user only on
  failure.
- **The kaiapp scheduler mirror is STALE.** `kai/lib/scheduler.js` claims to be "mirrored
  from therexdev/kaiapp server/scheduler.js — keep in sync", but the sync stopped long ago:
  the kai copy carries months of evolution (roster persistence, multi-class dispatch, fair
  seeding, streaming, perf-fed routing) the kaiapp copy lacks, and kaiapp's `core/test`
  scheduler tests exercise the OLD copy. The kai copy is CANONICAL — scheduler changes land
  there with a probe script (`kai/scripts/`), not in kaiapp. Either resync the mirror (and
  its tests) deliberately someday, or retire it; don't trust the header comment.
- **Deploys cause a public unreachability window (minutes).** Shipping `aa832ac` the site
  TCP-timed out at 09:21 and STILL at 09:26 despite the new instance's first stats serve at
  09:21:59, then answered fine at 09:27. One or two failed probes right after a deploy are
  the rollover, not an outage — verify with a positive check a few minutes later before
  reverting. Workers ride it out (outbound-only + persisted roster; presence held).
- **Checking the live network from a sandboxed session**: some dev environments block
  egress to koinosai.com entirely (curl and WebFetch both 403). The kaiapp **Netcheck**
  workflow (`.github/workflows/netcheck.yml`) prints `/network/status` + `/network/models`
  from a GitHub runner: push a commit whose message contains `[netcheck]` (empty commit is
  fine), then read the job log. Manual `workflow_dispatch` exists but app-token dispatch is
  403 — the commit-message trigger is the reliable path. Beware: dispatching `ci.yml`
  manually builds Windows installers (`workflow_dispatch` satisfies its build gate).

## 6. Live state (2026-08-16, ~09:30Z)

- **Perf-fed routing deployed**: scheduler at `aa832ac` (instance `i_7fc31d63`, boot
  09:21:59Z), pushed to the production branch per the owner's approved deploy path. All 3
  workers survived the restart; server-measured fields live on /network/status —
  `srvTokPerSec` 4.13 (laptop `1H7Qva…`), 1.86 (`1EXvuu…`), 0.47 (`1AUgCZ…`), all `sr: 1`.
  Roster, fair seeding, and the 9 live classes intact post-deploy.

- **App v0.25.8** released and VERIFIED (09:04Z, GitHub API): full asset set — Setup exe,
  portable exe, AppImage, blockmap, `latest.yml` + `latest-linux.yml`; auto-update feed
  already being pulled (6 `latest.yml` downloads). v0.25.5 fast-switch, v0.25.6 trust
  boundary, v0.25.7 Network tab all published with full asset sets.
- **Scheduler** deployed through commit `6b40ddc` (fair seeding + server capability gate).
  Live instance `i_50e07d94` booted 08:22:43Z — a restart around release time; the roster
  survived it and all nodes revived (liveness fix holding).
- **Network** (probed live 09:04Z via Netcheck): 3 workers online, none busy, all seen
  ≤11s — `1AUgCZ…AXHo` (koinos-fast + qwen25-32b, 21 jobs, tok/s 0.83), `1H7Qva…FjvK`
  (8 classes — owner's laptop, 17 jobs, tok/s 0.59), `1EXvuu…Mj6E` (koinos-fast +
  koinos-balanced, 17 jobs, tok/s 0.71). 9 model classes live; queue 0, pending 0,
  recentOffline empty. Fair seeding visibly balanced: 6/5/5 seeds this epoch. Perf
  counters (`tokPerSec`, `cuRating`, jobs) are populating for every node — the §51
  phase-2 inputs are real data now.
- **Alpha announcement**: posted (Telegram-format post + 8 real screenshots delivered).
- **Earlier project phases** (contract deposit/claim_value, splits, oracle, budgets,
  royalties, kill switch, feedback pipeline, design pass, Odysseus tranches 1–3) are
  DONE — see the task ledger in `docs/V1_PLAN.md` §-mapping and the git history.

## 7. Open threads (next work, in rough priority)

1. **Azure Trusted Signing** — waiting on the owner's identity validation; then add the
   secrets and the next `[release]` ships signed. (Portal path: top search bar → "Trusted
   Signing accounts"; provider `Microsoft.CodeSigning` must be registered.)
2. ~~Perf-fed routing (§51 phase 2)~~ — SHIPPED 2026-08-16 (`aa832ac`, §4.8). Watch the
   field: preference behavior on real consumer chats, probation false-positives (a slow
   machine mid-model-load eating lease expiries), whether the 4s window needs tuning.
3. **Verification deepening (§17)** — first pass SHIPPED 2026-08-16 (`9af2a05`, §4.9:
   generated challenges + token clamp). Remaining before open beta: class-discriminating
   challenges (catch a small model answering for a big class) and promoting repeated token
   clamps to dishonesty verdicts once field baselines exist.
4. ~~Public stats page~~ — SHIPPED 2026-08-16: `koinosai.com/network` (public
   truncated-address feed, 10s refresh; nav + footer links; site contact is
   contact@koinosai.com).
5. Parked: async self-test (spawn vs spawnSync), Compare presets, deep-research surface,
   Microsoft Store distribution, kaiapp scheduler-mirror resync-or-retire (§5).

## 8. Working with the owner

Plain language (they are not an AI/infra specialist); lead with the outcome; prove fixes
with live evidence before claiming success (their own logs, monitor timestamps, live
endpoints); act rather than ask when the request is clear; never blame their machines
without proof — that pattern failed three times before the real root causes surfaced.
They test on two Windows machines (laptop: Core Ultra 7 255H + Arc 140T iGPU, 32GB —
llama builds crash there, Ollama fallback carries it; desktop: llama CPU rung works).
