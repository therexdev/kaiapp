# Koinos AI — Operational Source of Truth

> **Status: CURRENT as of 2026-08-17 ~13:10Z. Scheduler `3713164` (PHASE 1 LIVE: epoch
> resume, persistent free tier, price pinning, strict close persistence gating settlement,
> boot settlement repair, charge-time spend durability, firstSeen backfill; INERT owner
> flags: `KAI_REPUTATION_ENFORCE=1` arms the anti-Sybil gate, `KAI_STORE=sqlite` cuts over
> the transactional ledger — 22-agent adversarial review, 14 findings fixed pre-deploy).
> App **v0.26.1 PUBLIC and SIGNED** (2026-08-17 16:17Z): VOICE INPUT shipped — push-to-talk
> mic → on-device whisper.cpp v1.9.2 (pinned engine 8 MB + base.en model 148 MB, opt-in
> setup, llama crash-guards reused, runner E2E-verified). Windows-first; ubuntu tarball
> binPath already discovered for Linux follow-up. Release NOTE: v0.26.0 tag is DEBRIS
> (create-release race shipped it linux-only; dist jobs now serialized in ci.yml —
> build-windows needs build-linux; owner can delete the v0.26.0 release in the web UI).
> Previously v0.25.11 (2026-08-17 13:00Z; first Azure-signed release —
> installer/portable/uninstaller/elevate all carry Authenticode, verified on the published
> asset). Feature state (shipped v0.25.9→.11): chat FAVORITES + rename; WEB SEARCH in chat
> (keyless DDG+Wikipedia, §7-gated: hard-403 in Local-Only, SSRF-guarded fetch) with a
> search→read→answer research agent + persistent citations + agent trace on network chats;
> VISION — gemma3-4b + pinned mmproj (sha256 8c0fb064…, runner-verified) with image attach
> (client-downscaled, content-parts on vision models only, clean refusals elsewhere, 👁
> picker marker, graceful text-only degradation); READ-ALOUD via OS voices; typing-dots
> loading animation + first-reply/tok-s meta; Linux/ARM engines (Pi) with RAM-gate parity.
> **WORKSPACE SPRINT (dev branch, unreleased)**: unified TOOL LAYER in Core (/core/tools —
> one registry + one policy point: egress tools refused in Local-Only, sensitive tools
> require confirmed:true server-side, HTTP 428 contract); MEMORY across chats (all-local
> TF-IDF store, 📌 Remember, auto-injection, Tools-view management); composer MODES
> Chat/Research/Agent — Research = multi-round LLM-in-the-loop (search→read→condense→gap
> check→re-search, ≤3 rounds ≤6 pages, notes fit 4k ctx), Agent = JSON-action ReAct loop
> over the registry (≤6 steps, per-call confirm dialogs, visible trace; sandboxed
> workspace file tools, NO bash by design); MCP CLIENT stdio+Streamable-HTTP
> (initialize/tools-list/tools-call, session ids, curated 3-entry catalog, one-click add,
> trusted/localSafe flags per server); EMAIL imapflow/mailparser/nodemailer (presets+app
> passwords, safeStorage-encrypted creds, inbox/read/summarize/draft via chat, send =
> human click ONLY, never an agent tool); CALENDAR CalDAV stdlib (REPORT+PUT, minimal
> VEVENT parse, presets). Suite 137 pass / 0 fail local. kai side: **SQLITE LEDGER LIVE** (ad421ae
> deployed 17:15Z; /api/health reports `store.mode=sqlite`, no `degraded`; bootCount 13→14,
> clean SIGTERM, 3 workers back in <16s, job counts and ageDays carried through the
> migration — proof the ledgers survived). Delivered by the repo-carried env channel
> (deploy/app.env; on-box env always wins; no secrets). **Oracle rehearsal COMMITTED at
> 4c31a1c on the kai dev branch, NOT yet deployed** — production push needs owner go
> (permission gate); on deploy, /scheduler/pricing walks anchor→live over epochs.** This is the living record of what is
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
- Code signing: **LIVE since v0.25.11** (2026-08-17) — Azure Trusted Signing, subject
  CN=Michael Milas (Bennington NE), Microsoft ID Verified chain. CI signs installer +
  portable + uninstaller + elevate helper on every `[release]`. Secrets:
  `AZURE_SIGNING_ACCOUNT` (portal resource name, hyphenated — NOT the profile name),
  `AZURE_SIGNING_PROFILE`, `AZURE_SIGNING_ENDPOINT` (region URI from the account's
  Overview), `AZURE_PUBLISHER_NAME`, + tenant/client-id/client-secret (secret VALUE, not
  ID). Signer role: "Artifact Signing Certificate Profile Signer" on the account. Certs
  rotate ~3 days server-side (normal; timestamped signatures outlive rotation).
  Debug trail: 403 at "Submitting digest" = account/profile/endpoint name mismatch or
  missing signer role; AADSTS7000215 = client-secret ID pasted instead of its value.
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
9. **§17 verification (`9af2a05` first pass, `99a7c1f` sprint-02)**: hidden challenges are
   GENERATED per seed — no fixed pool to hardcode; `KAI_CHALLENGE_RATE` (default 0.4);
   `dev-tiny` never challenged. Two enforcement postures, chosen by whether an honest model
   can legitimately fail:
   - **ENFORCED** (burns the receipt on fail): tier-1/2 per-class eval challenges (temp-0,
     easy by construction) and **token-inflation** — a report over 3× a UTF-8 BYTE budget
     (`24 + bytes`; unreachable by any real tokenizer, CJK/emoji included) earns strikes,
     then burns after 3 (`KAI_CLAMP_ENFORCE`, default on). Byte budget, NOT char: a char
     budget falsely clamped multilingual output.
   - **SHADOW** (records pass/fail, never burns — arm with `KAI_CLASS_ENFORCE=1` once field
     baselines prove honest pass rates): tier-3 **class discriminators** (multi-step tasks a
     small model fumbles) and **mystery chats** — protocol-funded audits disguised as
     consumer chats (`seedMysteryOnce`, `KAI_MYSTERY_RATE`/`_CAP_PER_EPOCH`). `give()` strips
     EVERY server field (`forWorker`/`preferWorker`/`challenge`/`challengeTier`) at dispatch,
     so a modified client can't distinguish an audit from paid work; prompts are diversified,
     not one regex.
   - **Anti-answer-bank**: `_passesChallenge` requires the answer to DOMINATE a normalized
     reply (bounded length), so dumping "…95 96 97…" no longer passes. Per-tier history
     (`perf.chal.t0..t3`) is the baseline for arming.
   - Server-measured `srvTokPerSec` is capped (`KAI_SRV_TPS_CAP`, 400) so a garbage-dumper
     can't fake speed to capture routing preference. Stranded mystery chats are GC'd like
     evals (they're `type:chat` — previously exempt, could jam seeding).
   - **CRITICAL fix**: non-numeric worker usage (`{}`/`"abc"`) became NaN in a receipt and
     threw `BigInt(NaN)` at settlement — crashing the process every epoch and freezing all
     earnings. All token counts now coerce to finite ints (`numOr`/`clampInt`) before any
     math. (Pre-existing bug; found by the sprint-02 adversarial review.)
   - **Residual (honest limits, before mainnet)**: a determined cheat can still re-register
     under a fresh free address to shed strikes/probation — real anti-Sybil needs staking or
     identity (see §7). The paid-path audit is a *deterrent that raises cost*, not a proof;
     cryptographic assurance needs redundant cross-checking or attestation. Arming the shadow
     tiers waits on watching `perf.chal` pass rates in the field.
10. **Adversarial review discipline (proven 2026-08-16)**: the sprint-02 honesty batch went
    through a 3-lens multi-agent review (money-path, adversarial worker, runtime) with each
    finding independently refuted before acceptance. It caught the NaN crash, the
    answer-bank evasion, and the class of false-positives that would have burned honest
    testers. The economics batch got its own money-path review, which caught the debt-hole
    (below) and corrected the owner's "Sybil-proof" premise. Big money-path changes get this
    before deploy — the probe proves the fix, the review finds what the probe didn't test.
11. **Economics: network bootstrap POOL + daily free tier (owner decision, deployed 2026-08-16)**:
    protocol-funded work is paid from ONE capped network-wide budget per epoch
    (`KAI_BOOTSTRAP_KAI_PER_DAY`, initial **1,500 KAI/day** = 15.625/15-min-epoch), divided
    pro-rata across the epoch's useful work; **paid chat value is never capped; unused budget
    stays in reserve (not minted); passive uptime earns zero.** Free tier is **daily** now
    (`KAI_FREE_TOKENS_PER_DAY` 25k/account + `..._GLOBAL` ~1M/day network ceiling), tracked by
    UTC day — fixed the 96× bug where 25k reset every 15-min epoch. Global-cap exhaustion
    pauses only public free inference (local + paid keep working). **Review fix — earnings
    debt hole**: because the pool divides by network demand, a worker's counted earnings can
    DROP mid-epoch as others submit receipts; consumption is therefore authorized only against
    the GUARANTEED floor (paid revenue, `_settleFor(mine,{poolSat:0,demandSat:1})`), which
    never shrinks — so earnings-backed spend can't over-commit into an uncollectable debt.
    Probes: `kai/scripts/probe-perf-routing.js` (pool caps total, divides by work, unused in
    reserve, daily reset, global ceiling, debt floor) + `probe-oracle.js` (price break-tests).
    **The pool bounds TOTAL emission (~50× tighter than the old per-worker cap) but NOT any
    actor's SHARE** — a scripted fake-worker fleet still captures the pool's distribution.
    That's the anti-Sybil work in §7.

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
- **The host restarts the process on its own (not just on deploy).** 2026-08-16 ~20:43Z the
  process went `i_0eceee22`→`i_b56be4e1` with a whole-site HTTP 000 blip the monitor caught,
  with NO deploy — a host recycle (budget hosting) or a crash. The roster survived and workers
  revived (persistence held), so it self-heals, but the CAUSE was a guess. Now instrumented:
  `lib/runtime-log.js` records every exit's reason (host `signal:SIGTERM` vs code
  `uncaughtException`+stack) and surfaces `{bootCount, lastExit}` on `/api/health`. **When
  diagnosing a restart, read `/api/health` runtime first** — it tells you host-vs-code before
  you theorize. Instance-id + bootAt changing across two `/network/status` samples = a restart.
  (Perf counters USED to reset with a restart — no longer: perf now persists to `perf.json`,
  restored on boot / written at epoch close, kai `95a7b5b`, so routing quality + reputation
  signals + token-inflation strikes survive deploys; a fresh instance-id with populated perf is
  now normal.) **RESOLVED**: three such unexplained host recycles in
  one evening drove the move off Hostinger to a self-managed Vultr VPS (2026-08-16, §9). The
  forensics stay useful — but on the new box a restart is `Restart=always` doing its job, and
  the exit reason on `/api/health` still distinguishes a clean systemd restart from a crash.
- **Checking the live network from a sandboxed session**: some dev environments block
  egress to koinosai.com entirely (curl and WebFetch both 403). The kaiapp **Netcheck**
  workflow (`.github/workflows/netcheck.yml`) prints `/network/status` + `/network/models`
  from a GitHub runner: push a commit whose message contains `[netcheck]` (empty commit is
  fine), then read the job log. Manual `workflow_dispatch` exists but app-token dispatch is
  403 — the commit-message trigger is the reliable path. Beware: dispatching `ci.yml`
  manually builds Windows installers (`workflow_dispatch` satisfies its build gate).

## 6. Live state (2026-08-16, ~14:47Z)

- **Scheduler at `9af2a05`** (instance `i_238755bb`, boot 14:40:43Z): perf-fed routing +
  §17 first deepening + streaming lease guard, all live. All 3 workers survived both of
  today's deploys; one was mid-job (`busy: true`) at the check — busy-state path working.
  Generated challenges are flowing and honest machines are passing them (`sr: 1` across the
  roster). The measured-vs-reported gap is visibly real: `1AUgCZ…` self-reports 11.87 tok/s
  but measures 6.85 — routing uses the measured number.
- **koinosai.com/network is live** (HTTP 200): the public stats page, nav+footer linked.
  Site contact is contact@koinosai.com everywhere.
- 9 model classes live; roster and fair seeding intact.

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

1. ~~Azure Trusted Signing~~ — **SHIPPED 2026-08-17, v0.25.11 signed** (see §2 for the
   secret layout and the 403/AADSTS debug trail). Watch the field: SmartScreen reputation
   still accrues per-file over downloads; signed ≠ instant zero warnings on day one.
2. ~~Perf-fed routing (§51 phase 2)~~ — SHIPPED 2026-08-16 (`aa832ac`, §4.8). Watch the
   field: preference behavior on real consumer chats, probation false-positives (a slow
   machine mid-model-load eating lease expiries), whether the 4s window needs tuning.
3. **Verification (§17)** — SHIPPED through `99a7c1f` (§4.9). Remaining: **arm the shadow
   tiers** once `perf.chal` field baselines prove honest pass rates (early field data
   2026-08-16: enforced t1/t2 at 100%, shadow t0 mystery already caught an honest worker
   missing 1 of 3 at temp 0.7 — exactly why t0/t3 are shadow, not enforced).
4. **Anti-Sybil / provider trust model (THE pre-mainnet integrity gate, owner-designed
   2026-08-16)** — the bootstrap pool bounds total emission but not distribution; a scripted
   fake fleet captures the pool's share. Direction DECIDED: **reputation-weighted first,
   optional bonded staking layered at mainnet.** Owner's binding principles:
   - **Reputation is non-transferable** and built from real signals: successful useful jobs,
     verification-challenge history, random audits, reliability, benchmark consistency,
     network age, real paid-demand served. 10,000 wallets = 10,000 *untrusted* identities.
   - Reputation governs **eligibility / verification intensity / exposure to scarce
     protocol-funded reward**, NOT payment multipliers. **Identical completed useful work has
     the same base value** — faster hardware earns more only by completing more work. New
     machines get higher audit rates + limited subsidy exposure, not lower pay for equal work.
   - **Staking is optional, never required to start earning** ("you shouldn't have to buy KAI
     to earn KAI"), added at mainnet for higher-assurance tiers/workloads; **staking earns no
     passive yield** — it's economic accountability, not a faucet.
   - **Slashing is narrow**: only provable fraud (forged receipts, fake computation, challenge
     manipulation, protocol attack) past an evidence threshold. Ordinary operational failure
     (outage, Windows update, driver crash) = job fails, no pay, reputation dent — never a slash.
   - Defense in depth: reputation + device/benchmark fingerprints + challenge history +
     paid-demand history + network age + optional bond + rate limits + anomaly detection, all
     under the 1,500 KAI/day ceiling. Design + sim: `docs/anti-sybil-reputation-weighting.md`
     + `tools/sybil-sim.js`. Key finding: a plain reputation *multiplier* barely dents a 4:1
     fleet (share still ∝ volume); the load-bearing idea is a reputation **eligibility GATE** —
     below `R_GATE` a node earns full PAY but ZERO pool draw (paid revenue never gated,
     equal-work-equal-pay preserved). Gated sim cuts a fresh compute-backed fleet's capture
     ~80%→~22–30%, holds a fresh fleet attacking an established network at 0% for ~2 weeks.
     **SHADOW MEASUREMENT SHIPPED 2026-08-17 (kai `1cb1959`)**: the scheduler now computes
     per-worker reputation (durable `firstSeen` age + `repPaidJobs` paid-demand, plus perf
     sr/challenge history), surfaces it in stats detail + records `reputationShadow` per epoch —
     but does NOT touch settlement/routing/pay (proven by `probe-reputation.js` + adversarial
     review + the full econ suite). Enforcement is still OFF (no `KAI_REPUTATION_ENFORCE` wired).
     **OWNER DECISIONS OPEN before arming the GATE** (doc §9): gate hardness `R_GATE`, signal
     weights, shadow length, fingerprint binding. Two review fixes already applied to the shadow
     build (firstSeen type-hardening; paid-demand counts only genuinely-paid chats, not free-tier).
5. ~~Public stats page~~ — SHIPPED 2026-08-16: `koinosai.com/network`.
6. **Economics (owner decisions MADE + deployed 2026-08-16, §4.11)**: bootstrap pool 1,500
   KAI/day, daily free tier + 1M/day global ceiling — LIVE. Still owner-gated: `KAI_TREASURY_ADDR`
   to activate splits (§F8); oracle live-source — **runbook ready** (`docs/oracle-rehearsal.md`),
   owner runs one env block on the box then watches `/pricing`. **Price source (owner decision
   2026-08-17): the on-chain vKOIN/USDT market** — vKOIN token `0xa50ad3…b937b1a` (Uniswap-v4,
   the deepest real KOIN market), read via TWO independent aggregators of the same token
   (DexScreener `pairs.0.priceUsd` + GeckoTerminal `data.attributes.price_usd`) for median-of-two.
   **Validated live: both agree ~$0.0087 — vs CoinGecko's `koinos.usd` ~$0.042 (~5× off/stale)**,
   which is why we moved off CoinGecko to the on-chain read. Thin market (~$14.5k liq) → the
   oracle's breakers (median, ±10%/epoch, floor/ceil, stale-hold) matter; all covered by
   `probe-oracle.js`. `docs/economics-sprint-02.md` is the record.
7. **Ops hardening (mainnet)** — SHIPPED: rotating state backups + operator export; `kai`
   scheduled monitor (issue/email on real failure); restart forensics on `/api/health` (§5).
   **Migrated koinosai.com to a self-managed Vultr VPS (§9)** — this fixed the mystery host
   recycles AND the ~6-min deploy blackout (systemd restart is now sub-second). Remaining:
   (a) re-establish an auto-deploy on the new box (branch push no longer ships — §9 "DEPLOY
   MODEL CHANGED"); (b) move JSON ledgers to something with real durability; (c) decommission
   the dormant Hostinger app once Vultr has proven stable (keep the plan for email DNS).
8. Parked: async self-test (spawn vs spawnSync), Compare presets, deep-research surface,
   Microsoft Store distribution, kaiapp scheduler-mirror resync-or-retire (§5).

## 8. Working with the owner

Plain language (they are not an AI/infra specialist); lead with the outcome; prove fixes
with live evidence before claiming success (their own logs, monitor timestamps, live
endpoints); act rather than ask when the request is clear; never blame their machines
without proof — that pattern failed three times before the real root causes surfaced.
They test on two Windows machines (laptop: Core Ultra 7 255H + Arc 140T iGPU, 32GB —
llama builds crash there, Ollama fallback carries it; desktop: llama CPU rung works).

## 9. Production hosting — Vultr VPS (migrated 2026-08-16 ~23:30Z)

koinosai.com no longer runs on Hostinger. After three unexplained host recycles in one
evening (§5), the site moved to a **self-managed Vultr VPS** we control end to end.

- **Server**: Vultr, Ubuntu 24.04, `root@45.76.255.224`. `ufw` on.
- **App**: `/opt/koinos/kai`, checked out on the production branch
  `claude/kai-production-website-fqx4pf`. Runs as the unprivileged `koinos` user.
- **Process supervision**: `systemd` unit `koinos.service` — `Restart=always`,
  `EnvironmentFile=/opt/koinos/kai.env`. This is the keep-alive that Hostinger never gave
  us: a crash or reboot brings the process straight back. `systemctl status koinos`,
  `journalctl -u koinos -f` for logs.
- **Env** (`/opt/koinos/kai.env`, root-owned, secrets live ONLY on the box — never in chat
  or git): `PORT=3000`, `STATE_ROOT=/var/lib/koinos`,
  `SCHEDULER_DATA=/var/lib/koinos/scheduler`, plus `SESSION_SECRET`, `ADMIN_EMAIL`,
  `ADMIN_PASSWORD`, `KAI_OPERATOR_SECRET`, `KAI_OPERATOR_WIF` (on-chain settlement is
  ENABLED — WIF validated at boot), `KAI_TREASURY_ADDR` (verify whether a real value is set
  before assuming splits §F8 are active).
- **TLS / reverse proxy**: **Caddy** fronts the app — `/etc/caddy/Caddyfile` serves
  `koinosai.com, www.koinosai.com { reverse_proxy localhost:3000 }` with automatic
  Let's Encrypt HTTPS. Origin fingerprint on any response is `via: 1.1 Caddy` (proof a
  request is hitting the new box, not the old CDN path).
- **DNS** (managed in Hostinger's zone; Namecheap nameservers point at Hostinger): apex `@`
  and `www` are now **A records → 45.76.255.224** (were an ALIAS/CNAME to Hostinger's CDN).
  **Email records were left untouched** — MX `mx1/mx2.hostinger.com`, SPF TXT, and the
  `autodiscover`/`autoconfig` CNAMEs still run mail through Hostinger. TTLs are 300s.
- **Ledger migration**: at cutover the live state was pulled from the old app via
  `GET /admin/api/state-export` (operator-secret gated, always-fresh gzip bundle) and
  restored into `/var/lib/koinos/scheduler` with the service stopped, then `chown -R
  koinos:koinos`. `runtime.json` was deliberately EXCLUDED so the new box keeps its own boot
  forensics. Worker balances/receipts carried over; workers reconnected on their own.
- **Cutover verified** (external GitHub-runner netcheck, 23:31Z): all endpoints HTTP 200 in
  ~0.2–0.4s, `via: 1.1 Caddy`, `/api/health` `ok:true` with a clean `signal:SIGTERM` last
  exit (the migration stop, not a crash), 3 workers online serving 9 model classes, queue
  empty, challenges passing.

### DEPLOY MODEL CHANGED — read before shipping to the live site

Pushing to `claude/kai-production-website-fqx4pf` **no longer auto-deploys.** That worked
only because Hostinger had a git integration watching the branch. On the Vultr box the live
code is a plain checkout, so a push updates GitHub but NOT the running site. Until a proper
pipeline exists, deploying a scheduler/website change is a manual step on the box:

```
cd /opt/koinos/kai && git pull && systemctl restart koinos
```

(`Restart=always` + a fast Node boot make this a sub-second blackout, far better than
Hostinger's ~6-min rollover.) The `[netcheck]` workflow and the `kai` scheduled monitor both
hit koinosai.com **by name**, so they now watch the new box automatically with no change.
**Follow-ups**: (a) stand up a simple auto-deploy (git webhook or a pull-on-interval /
`systemd` timer) so branch pushes ship again; (b) once traffic has been stable on Vultr for a
while, decommission the dormant Hostinger app — but KEEP the Hostinger plan, it still serves
the domain's email DNS.
