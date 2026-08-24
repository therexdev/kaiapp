# Koinos AI — Operational Source of Truth

> **Status: CURRENT as of 2026-08-17 ~13:10Z. Scheduler `3713164` (PHASE 1 LIVE: epoch
> resume, persistent free tier, price pinning, strict close persistence gating settlement,
> boot settlement repair, charge-time spend durability, firstSeen backfill; INERT owner
> flags: `KAI_REPUTATION_ENFORCE=1` arms the anti-Sybil gate, `KAI_STORE=sqlite` cuts over
> the transactional ledger — 22-agent adversarial review, 14 findings fixed pre-deploy).
> App **v0.27.5 PUBLIC and SIGNED** (see the workspace-sprint block below for what v0.27.x
> added). v0.26.1 brought VOICE INPUT — push-to-talk
> mic → on-device whisper.cpp v1.9.2 (pinned engine 8 MB + base.en model 148 MB, opt-in
> setup, llama crash-guards reused, runner E2E-verified). Windows-first; ubuntu tarball
> binPath already discovered for Linux follow-up. Release NOTE: the v0.26.0 create-release
> RACE (both dist jobs raced to create the release; windows 422'd and it shipped linux-only)
> is FIXED — ci.yml serializes build-windows behind build-linux. The broken v0.26.0 release
> was deleted by the owner 2026-08-17.
> Previously v0.25.11 (2026-08-17 13:00Z; first Azure-signed release —
> installer/portable/uninstaller/elevate all carry Authenticode, verified on the published
> asset). Feature state (shipped v0.25.9→.11): chat FAVORITES + rename; WEB SEARCH in chat
> (keyless DDG+Wikipedia, §7-gated: hard-403 in Local-Only, SSRF-guarded fetch) with a
> search→read→answer research agent + persistent citations + agent trace on network chats;
> VISION — gemma3-4b + pinned mmproj (sha256 8c0fb064…, runner-verified) with image attach
> (client-downscaled, content-parts on vision models only, clean refusals elsewhere, 👁
> picker marker, graceful text-only degradation); READ-ALOUD via OS voices; typing-dots
> loading animation + first-reply/tok-s meta; Linux/ARM engines (Pi) with RAM-gate parity.
> **WORKSPACE SPRINT (SHIPPED v0.27.x)**: unified TOOL LAYER in Core (/core/tools —
> one registry + one policy point: egress tools refused in Local-Only, sensitive tools
> require confirmed:true server-side, HTTP 428 contract); MEMORY across chats (all-local
> TF-IDF store, 📌 Remember, auto-injection, Tools-view management); composer MODES
> Chat/Research/Agent — Research = multi-round LLM-in-the-loop (search→read→condense→gap
> check→re-search, ≤3 rounds ≤6 pages, notes fit 4k ctx), Agent = JSON-action ReAct loop
> over the registry (≤6 steps, per-call confirm dialogs, visible trace; sandboxed
> workspace file tools, NO bash by design). **Agent mode is 4k-HONEST and
> SMALL-MODEL-HONEST** (v0.27.4, from a tester running a 29-tool third-party server on
> koinos-balanced): the tool menu is BUDGETED (≤2200 chars, first-sentence descriptions,
> param prose degraded to bare names, per-question relevance subsetting with a built-in
> bias) because the unbudgeted menu measured ~3746 tokens and Core's OWN token gate 400'd
> every step — the loop then fell back to "answering without tools" with no visible cause;
> and tools are presented under SHORT ALIASES (`network_status`, collisions numbered)
> instead of registry names, because `mcp:<id>:<tool>` taught models to answer
> `{"mcp":"<id>:<tool>"}` — namespace as the KEY, no `tool` field, action parsed to null.
> parseAgentAction now reverse-maps aliases / normalised spellings / `mcp` / `function`
> shapes back to registry names, refuses genuinely ambiguous ones rather than guessing, and
> the transcript echoes aliases so the model is never re-taught the colon form. The
> conversation is trimmed to system+question+last 3 exchanges so a long loop cannot walk off
> the context either. Registry naming is UNCHANGED — namespacing is real and stays;
> aliasing lives at the prompt boundary only. n_ctx deliberately NOT raised: KV cache is the
> binding constraint on the low-RAM machines this targets. Proof:
> core/scripts/verify-agent-loop.js (real 29-tool MCP subprocess, real registry, real /core
> routes, model simulated with the same context gate and the same naming failure) — FAILS on
> 0.27.3, PASSES after, and runs on every push via the agentcheck CI job. MCP CLIENT stdio+Streamable-HTTP
> (initialize/tools-list/tools-call, session ids, curated 3-entry catalog, one-click add,
> trusted/localSafe flags per server; NODE RUNTIME auto-provisioned — official v24.19.0 LTS
> hash-pinned in the runtime catalog, downloaded on demand INSIDE the app (no system
> install/PATH/admin), system node preferred when present, npx resolved through npm's
> npx-cli via our binary; catalog packages VERIFIED on the npm registry and version-pinned
> — server-fetch was dropped, it is a PyPI package not npm); EMAIL imapflow/mailparser/nodemailer (presets+app
> passwords, safeStorage-encrypted creds, inbox/read/summarize/draft via chat, send =
> human click ONLY, never an agent tool); CALENDAR CalDAV stdlib (REPORT+PUT, minimal
> VEVENT parse, presets). Suite 153 pass / 0 fail / 4 skipped local. kai side: **SQLITE LEDGER LIVE** (ad421ae
> deployed 17:15Z; /api/health reports `store.mode=sqlite`, no `degraded`; bootCount 13→14,
> clean SIGTERM, 3 workers back in <16s, job counts and ageDays carried through the
> migration — proof the ledgers survived). Delivered by the repo-carried env channel
> (deploy/app.env; on-box env always wins; no secrets). **Oracle rehearsal DEPLOYED**
> (4c31a1c) — /scheduler/pricing walked anchor→live and has since been observed in
> `stale-hold` (both aggregators unreachable 2026-08-17 23:30Z, holding $0.008345 rather
> than snapping to the anchor: the designed behaviour, but the feeds need re-checking).** This is the living record of what is
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
(`lib/scheduler.js`) + accounts (`lib/accounts.js`) + the web app (`views/app.html`,
`views/app.js`, `lib/appdata.js`), all one process.

- **Koinos AI Web** (`/app`, shipped 2026-08-22): Chat, Docs, Tasks, Memory, Wallet.
  The shell lives in **`views/`, never `public/`** — `express.static(PUBLIC_DIR)` serves
  that whole tree ungated, so a gated page cannot exist inside it. One route serves it,
  gated by `accounts.accountOf` (resolve-don't-answer, so a signed-out browser gets a
  redirect to `/account?next=/app` rather than a JSON 401 it would render as text).
  `requireAccount` is built ON `accountOf`, so there is one definition of a valid session.
- **How the web app spends**: a **spend grant** — the wallet signs ONCE over
  `spend|address|accountId|cap|expiry|ts`, and the site may then draw up to that cap until
  that date. One live grant per wallet (a new one revokes the old). The cap is enforced
  **in SQL** (`spent_micro + ? <= max_micro` in the UPDATE's WHERE). Grants are created
  only from the DESKTOP app (Settings → Koinos AI account) because only that machine holds
  the key; the website can show and revoke, never create. Unlinking a wallet, and signing
  out everywhere, both revoke grants.
- **A grant is PERMISSION, not FUNDS.** The wallet still needs KAI capacity in the
  scheduler ledger (free allowance / deposits / epoch earnings). Both failures look
  identical from outside — "I authorised it and it still refuses" — so the gate copy, the
  Settings hint and the docs all say it explicitly.
- **The one hop the browser cannot make**: its session cookie is HttpOnly and must stay
  that way (that token now authorizes spending), but the scheduler's grant lane wants the
  token. `askNetwork()` in `server.js` reads the cookie server-side and passes it in
  process — ONE place, asserted by probe. The scheduler is called with a **synthetic
  request** (a `Readable` with `.url/.method/.headers`), and the real `res` goes straight
  through, which is what makes SSE streaming work with no proxying.
- **Tasks run with nobody signed in**, so the account is asserted on the request OBJECT as
  `req.trustedAccountId`. A request off a socket can never carry it — headers land on
  `req.headers`, the body is parsed separately. It widens WHO may ask, never WHAT may be
  spent (the grant is still re-checked). `accounts.accountById` exists only for this.
  `CapturingResponse` lets the runner reuse `scheduler.handle`, so scheduled and
  interactive runs are the same path.
- **Probes**: `probe-app.js` (43 — the key one tries five spellings of the shell through
  the static tree and requires every one to miss), `probe-app-features.js` (10 sections,
  with a fake provider that registers/polls/streams/signs), `probe-web-spend.js` (16).

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
- **The kaiapp scheduler mirror is RETIRED (decision 2026-08-21, v0.30.1).** The kai copy
  (`kai/lib/scheduler.js`) is CANONICAL — scheduler changes land there with a probe script
  (`kai/scripts/`), never in kaiapp. kaiapp `server/scheduler.js` stays as a deliberate
  TEST FIXTURE: it lets `core/test` run the shipped worker against an in-process scheduler.
  Change the fixture only when a worker test needs a protocol behavior it lacks; never port
  kai changes wholesale, never deploy it (it's excluded from the installer build anyway).
  Both files' headers now state this — the old "keep in sync" claim is gone. Real protocol
  compatibility is proven continuously by live workers + the netcheck workflow.
- **Deploys cause a public unreachability window (minutes).** Shipping `aa832ac` the site
  TCP-timed out at 09:21 and STILL at 09:26 despite the new instance's first stats serve at
  09:21:59, then answered fine at 09:27. One or two failed probes right after a deploy are
  the rollover, not an outage — verify with a positive check a few minutes later before
  reverting. Workers ride it out (outbound-only + persisted roster; presence held).
- **RESOLVED 2026-08-21 14:56Z — it was ordinary CHURN, and worker identity provably
  PERSISTS.** The suspect pair (`1E5cxC…jR7g`, `1H7T7D…C4gg`) was still on the roster four
  hours later and climbing — ageDays 0.02→0.19, perf 6→81 each — so no ~22h rotation. The
  clincher came unprompted: `1CkzKK…fs5u` REJOINED carrying 1.14 accrued ageDays and 112
  jobs, i.e. a worker that went offline and returned with its address and history intact.
  That is exactly what identity-cycling would have made impossible. Roster membership is
  fluid (`1H7Qva…FjvK`, 4.34 days, dropped in the same window) but IDENTITY is stable, so
  the §17 reputation inputs are trustworthy going into the `KAI_REPUTATION_ENFORCE` arming
  (~Sep 2). Rule for future checks: judge worker health PER ADDRESS across checks — a
  departure is not a fault, and a returning address carrying its old ageDays is the health
  signal to look for. Original observation and reasoning kept below for provenance.
- **WATCH (opened 2026-08-21 10:51Z, now RESOLVED above): paired worker identities cycling ~every 22h.** The
  roster lost `16wmrJ…1EYi` and `12Y8Ww…T8ii` (both ~0.77 ageDays, ~275 perf jobs) and
  gained `1E5cxC…jR7g` + `1H7T7D…C4gg` (both 0.02 ageDays, 6 jobs) in the SAME window —
  and that pair had itself appeared together ~22h earlier. Pairs appearing/vanishing
  together match the A40 operator's shape (two headless Core instances). The app is NOT at
  fault: `core/lib/wallet.js` persists the keystore at `<walletDir>/wallet.json` and reads
  it on boot, so a restart or auto-update keeps the address. A CHANGED address therefore
  means a new/ephemeral dataDir (fresh install, container without a persistent volume, a
  different KAI_DATA_DIR per run). Why it matters: ageDays and perf feed the §17 reputation
  weighting, so an operator who loses their dataDir silently resets their earning identity
  — and payouts get materially weighted once `KAI_REPUTATION_ENFORCE` arms (~Sep 2).
  NEXT STEP: the recurring netcheck now records the live addresses, so the following check
  tells CHURN (the new pair persists) from IDENTITY-CYCLING (it rotates again ~22h later).
  If it cycles, the fix is operator guidance on persisting the dataDir (plus surfacing the
  wallet address + dataDir at headless startup), NOT a change to wallet storage.
- **A fast deploy cadence starves the price oracle — PROVEN 2026-08-21, not a fault.**
  Four releases in 63 min (restarts 01:51:53 / 02:18:52 / 02:40:46 / 02:54:15Z) left the
  oracle reading `stale-hold` on EVERY netcheck, and after 02:33:53Z its price stopped
  refreshing at all (25.7 min stale by 02:59, tripping the `oracle fresh` assertion too).
  Each restart resets the in-memory refresh cycle; the refresh interval is ~15-30 min, so
  deploying every ~20 min means it never completes one. Confirmed by a CONTROLLED QUIET
  PERIOD: no deploys after 02:54:15, and at 03:43 the oracle was `live`, 4.2 min fresh,
  `median` populated again — DIGEST HEALTHY fails=0 warns=0, with no intervention at all.
  **So: stale-hold plus a recent restart is expected; diagnose it by leaving the box alone
  for 45 minutes and re-checking, NOT by touching the oracle or its env.** Escalate to the
  owner only if it is still frozen after a genuinely quiet 45 min — that rules out cadence
  and points at the upstream aggregators. Serving/billing is unaffected throughout: the
  held price stays inside floor/ceil, which is the breaker working as designed.
- **A docs deploy is verified by CONTENT, not by a status code (added 2026-08-21).** A stale
  checkout on the box serves every docs page with a cheerful 200, so the HTTP probes cannot
  see it. `scripts/health-digest.py` now asserts `docs deploy is current` by fetching
  `/docs/content/developer-tools.md` and grepping for a marker string (`DOCS_MARKER`, today
  `KAI_CORE_TOKEN`). It is a `check`, not a `warn` — a stale docs deploy FAILS the digest.
  **When a docs change matters enough to prove it landed, move the marker to a phrase unique
  to that change.** Same principle applies to any future "did it actually deploy?" question.
  **ORDER MATTERS, learned 2026-08-21 by getting it wrong:** move the marker AFTER the kai
  docs PR is merged and deployed, not before. Moving it first makes the very next check
  report `DIGEST FAIL` for an entirely legitimate reason — the marker is ahead of the box —
  which is indistinguishable at a glance from a real stale deploy.
  Also worth knowing: `health-digest.py` never exits non-zero, so `DIGEST FAIL` does NOT turn
  the workflow red. The digest LINE is the verdict; the green check mark only means the
  script ran. Deliberate (a transient blip should not train anyone to ignore red), but it
  means the digest has to actually be read.

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

00. **DECENTRALIZED INFERENCE — the driving focus, opened by the owner
   2026-08-24.** Full program in `docs/DECENTRALIZED-INFERENCE.md`; read that
   before touching any of it. The owner's framing: limiting hardware is what
   caps both sides of the network — the average PC owner has 8–16 GB and no
   real GPU, so we can only offer them small models and small earnings, and a
   network of small models loses every comparison to a frontier API. One answer
   fixes both: make many weak machines add up to one strong model.
   The physics, so nobody relearns it: **bandwidth is not the problem**
   (~16 KB per token per hop, ~2.6 Mbps at 20 tok/s) — **latency is**, because
   generation is sequential and every token traverses the whole model. Tensor
   parallelism over the internet is dead on arrival; do not reopen it.
   The opening is **speculative decoding**: draft k tokens on the user's own
   machine, verify all k in ONE network forward pass, pay the traversal once
   per k tokens instead of once per token. Our unfair advantage is that we
   already ship a working local model on Windows/Linux/arm64/Pi — every
   competitor in this space has a thin client and would have to build our app
   first.
   Phase 0 (latency map) is a SHADOW rollout, same discipline as the anti-Sybil
   fingerprint signal: collect, watch, and only then let it touch routing or
   payouts. The revenue path does not get speculative surgery.

0. ~~Account creation shut on production~~ — **OPENED by the owner 2026-08-22
   05:02Z.** Verified from OUTSIDE the box, which is the only proof that
   counts (the startup log says what the process thinks it has; `/auth/methods`
   says what a visitor actually gets):
   `STATE signin=email,google,passkey signup=email,google missing=nothing`,
   and the digest assertion flipped to `PASS account creation possible`.
   Both `SMTP_HOST` and the Google OAuth pair are set in `/opt/koinos/kai.env`;
   bootCount 35 = 34 plus the owner's one manual restart, clean SIGTERM.
   Kept here rather than deleted, because the finding behind it is permanent:
   **a passkey cannot CREATE an account** — WebAuthn registration attaches a
   key to a session that must already exist (`requireAccount` on
   `/auth/passkey/register/*`), so biometric is a way back in and never a way
   to start. Any future "sign-in is broken" report starts by reading
   `/auth/methods`, not by guessing.
   STILL UNVERIFIED, and only a human can do it: nobody has actually created
   an account end to end. Email codes need a real inbox to receive them and
   the Google consent screen has to be OUT of Testing or only listed accounts
   pass. Ask the owner to make one account both ways, then add a passkey to it.
   Loose end, unchecked because the digest has no assertion for it: waitlist
   signup notifications need `SMTP_TO` as well as `SMTP_HOST`. Sign-in works
   without it; those notification emails do not.

0a. **Koinos AI Web v1 — SHIPPED 2026-08-22 (kai PRs #21-#29, kaiapp v0.42.0).**
   Chat, Docs, Tasks, Memory, Wallet at koinosai.com/app. Live-verified from
   outside the box: `app HTTP 302 -> /account?next=/app`,
   `shell body not served anonymously (correct)`, `app/app.js HTTP 200`,
   `api/chats HTTP 401 {"ok":false,"error":"sign in first"}`,
   `robots.txt disallows /app`, digest `fails=0`.
   Not in v1, deliberately: Compare, Tools, Agent mode, Teams, voice, images,
   local models — each needs the caller's own hardware or the desktop tool
   layer. Web tasks get the model and nothing else (no tools, no search).
   **STILL UNVERIFIED, and only a human can do it**: nobody has completed the
   loop end to end — authorise a grant in the desktop app, open /app, send a
   message, watch KAI leave the wallet. Every piece is probe-covered against a
   fake provider; none of it has met a real one with a real person driving.
   Shipped after the five parts, same day: the account page now surfaces and
   revokes grants and sessions (#26); a model picker with prices, and the cost
   of each answer carried on the scheduler's final frame (#27); delete-my-data
   plus a browser-shaped balance refusal (#28); a responsive layout so the
   thing works on the phone its own pitch describes (#29).
   Still open, in priority order: a per-task spend ceiling below the grant cap;
   web-app usage history on the account page.

   **Two operational lessons from shipping it, both already fixed:**
   - `npm test` runs the suite's files IN PARALLEL. Adding two account tests
     that each derive a scrypt wallet starved a browser test in another file
     and blew its 15s inner timeout — CI went red, both build jobs are gated
     behind `test`, and v0.42.0 produced no installer until it was found. When
     a browser test fails on CI and passes locally, suspect contention before
     suspecting the feature.
   - `health-digest.py` NOW EXITS NON-ZERO on a FAIL. The old rule — "it never
     exits non-zero, the DIGEST line is the verdict" — was followed and still
     failed: a netcheck run went green with `DIGEST FAIL fails=1` inside it.
     A verdict nobody can see from outside is not a verdict. WARNs stay silent
     deliberately (the oracle holds stale for ~45 min after every restart).

0b. **v0.41.0 (2026-08-22): Settings, a Network icon, and one Koinos Node
   entry.** Field report opened with a real bug: *"Koinos Code and Developer
   Tools don't seem to pop up until I click the earn tab."* Correct — both nav
   items start `hidden`, and the only things that unhid them were `renderDev()`
   / `renderCodeSwitch()`, which ran **nowhere but inside `renderApi()`**. So
   the reveal was a SIDE EFFECT OF VISITING A VIEW: a feature the person had
   already switched on looked switched off until they wandered somewhere
   unrelated. Fixed by calling both at boot. **Standing rule: anything that
   decides what the sidebar CONTAINS runs on the way in, never as a byproduct
   of navigation.** The regression guard is a reload — switch both on, reload,
   assert they are there before anything is clicked; it fails on the old code.
   The restructure the owner asked for, same release:
   - **Settings** — a gear icon under the status pane, above Send feedback.
     Holds the Koinos AI account block and the Run Koinos Node switch (moved
     out of Earn) and the Developer tools and Koinos Code switches (moved out
     of Local API). They were scattered, so the only way to find a switch was
     to already know which unrelated page was hiding it.
   - **Network** — a second icon beside the gear; the full-width nav row is
     gone. Settings and Network are places you visit occasionally, and each was
     costing a scarce sidebar row next to Chat and Models.
   - **Koinos Node** — ONE entry, its seven screens on a rail inside the view,
     the Koinos Code shape. Seven top-level entries made an optional feature
     look like most of the app. The screens themselves did not move: the rail
     posts to the same embedded node app, so none of the node's own code
     changed. A structural test asserts every embedded view stays reachable
     from the rail, in both directions — a rail that lost one would strand it.
   Selection now keys off `[data-view]` rather than `.nav-item`, so the icons
   and the rows navigate and highlight through the same single path.
   - **v0.41.1**, two field reports from that screen, both invisible to every
     test we had because both are pure CSS REACHABILITY:
     1. *"when you scroll down on the settings page it scrolls the whole
        sidebar too."* A `.view` missing from the scrolling rule does not
        merely fail to scroll — it grows the PAGE, and the window scrolls with
        the sidebar attached. `#view-settings` shipped without it.
     2. *"make the toggle switch for koinos code justified to the right like
        the rest and separate it from the developer tools toggles with a
        line."* That block carried `class="switch-row"` — **a class this
        stylesheet has never defined.** No flex, no justification, no rule
        above it. It had been wrong since it was written in Local API; moving
        it into Settings only put it beside correct rows where the difference
        finally showed.
     Both are one failure mode — markup naming something that does not exist —
     so the guards are mechanical rather than per-case: every non-self-managing
     view must appear in a scrolling rule, and **every class the markup uses
     must be defined in the stylesheet**, with a short exempt list for the
     behavioural hooks scripts select on (`koinos-view`, `showpw`). That second
     guard immediately found two more real defects: `.mono` (the device-link
     pairing code was 24px with 4px tracking and NO monospace face — the one
     place proportional digits actually cost you, since you read it off one
     screen and type it into another) and `.cmp-pane-label`.
0c. **Cloud GPU — PARKED by the owner 2026-08-22 until BETA or just before.**
   *"Lets put this on hold until we officially move into beta or right before
   then. I think this needs some more thought before implementing."* **DO NOT
   ACT** until he reopens it — same posture as task #63. It resurfaces via
   `docs/beta-readiness.md` §5. The direction below is settled and is kept so
   it does not get re-explored from scratch; the VRAM gate fix already shipped
   (v0.41.2) and is NOT parked — it was a standing consumer-hardware bug.
   DIRECTION (settled, not started): **FIRST-PARTY SEED CAPACITY ONLY.**
   Owner's call after reading the exploration: *"the real goal is to get bigger
   models available on the network... If we offer that capability then people
   don't really need the capability of integrating cloud hosting to access them
   and they are not profitable earns so don't really make sense for standard
   miners to do."* **Koinos AI runs the big-model capacity ITSELF, as
   inventory.** The user-facing cloud-integration work is DECLINED, not
   deferred — if the network offers 70B, nobody needs to wire up a pod to reach
   one, and telling volunteers to rent hardware that loses money was never good
   advice. Three obligations this reframing creates, all in
   `docs/cloud-gpu-design.md` §6:
   1. **Seed workers MUST draw ZERO from the bootstrap pool.** Non-negotiable.
      `_networkSubsidyBudget` divides the pool across ALL honest receipts
      pro-rata, so a first-party worker earning subsidy takes a slice of the
      pot meant for VOLUNTEERS — the treasury paying itself while diluting
      every real machine. Mechanism: an operator allowlist (`KAI_SEED_ADDRS`)
      checked in `_subsidyValueSat`. Seed pods DO earn paid revenue (never from
      the pool) and serve free-tier traffic AT KOINOS AI'S CASH EXPENSE, which
      is the whole point. **Build this BEFORE any first-party pod touches
      production** — far easier than retrofitting after volunteers are diluted.
   2. **It must be VISIBLE that we run it.** "9 workers online" means something
      different if 3 are ours. Stats page separates community from seed
      capacity; seed workers are excluded from the anti-Sybil shadow
      calibration (our identical pods would poison the ~Sep 2 gate dataset).
   3. **The blocker is the CATALOG, not the hardware** — nothing above 32B
      exists to serve. A 70B needs a real URL + sha256 that cannot be
      fabricated. Rate-card entry is inert until advertised, so it lands first.
   **Cost reality: an always-on 70B is order $1,200-1,500/month and recovers a
   minority of that even at full utilisation.** It is a capability/marketing
   budget, approved as one. The structural problem is scale-to-zero: a worker
   that is not running is not in the roster, so nothing routes to it, so it
   never wakes. `PREFER_WINDOW_MS` + `/worker/warming` are the pieces to solve
   it; worth designing BEFORE renting anything always-on.
   **SHIPPED with the decision (v0.41.2): VRAM now counts in the advertise
   gate.** `fits()` compared `minRamGb` against `os.totalmem()` alone, so a
   24 GB 4090 beside 16 GB of DDR4 — an ordinary gaming PC — was refused the
   classes it serves FASTEST, while a RAM-rich CPU box was waved into classes
   it serves at a crawl. MAX of the two pools, not sum (summing claims a
   partial-offload split that only works when the overflow still fits in RAM —
   exactly the case that swaps). Also replaced a `reason.includes("GB RAM")`
   test with a `reasonCode`, since rewording the message is what this required.
   ORIGINAL EXPLORATION (evidence for the above) — Full analysis in `docs/cloud-gpu-design.md`. Owner asked
   how someone could rent a GPU to run bigger models AND serve them to the
   network. **The two halves are not the same product and only one is a good
   idea today:**
   - **Using a rented GPU yourself is a strong offer and mostly a missing
     SETTING.** Headless Core already runs (`node core/server.js`), CUDA
     already auto-provisions. What does not exist anywhere is a remote-Core or
     remote-model concept: the only non-local lane is `koinos-network` to the
     public scheduler. Recommended shape is a REMOTE MODEL alongside the local
     ones (RunPod's vLLM template already speaks OpenAI), because it puts the
     trust boundary in the model picker where a person makes the choice —
     rather than relocating Core, which would move chats, memory and Koinos
     Code's view of your source tree onto rented hardware all at once.
   - **Renting a GPU to SERVE the network loses money, by arithmetic, not by
     any missing feature.** Break-even on the top class ($4.00/1M output, 90%
     to compute) is `T = hourly cost / 0.0144` — about **28 tok/s sustained at
     100% utilisation** for a ~$0.40/hr card. That is roughly what a 32B Q4
     does flat out, so it needs the card generating every second it is rented.
     And the subsidy cannot rescue it BY DESIGN: the bootstrap pool is 1,500
     KAI/day NETWORK-WIDE ≈ **$13.45/day total** at the live oracle price,
     while one A40 costs $9.60/day. `scheduler.js` says it itself — "spinning
     up N machines does not raise total protocol expense, it only dilutes each
     machine's share". The anti-Sybil property is working; it also means honest
     cloud operators cannot be paid rent. **Do not market cloud hosting as an
     earning opportunity at current rates.**
   Three findings worth acting on regardless of the above:
   1. **The RAM gate is blind to the GPU.** `fits()` compares `minRamGb` to
      `os.totalmem()`, so a 48 GB A40 with modest system RAM is refused classes
      it would serve well, and a RAM-rich CPU box is waved into classes it
      serves at a crawl. Wrong on consumer hardware too, not just cloud.
   2. **Fingerprint vs cloud — decide BEFORE the gate arms (~Sep 2).** Every
      honest renter of the same pod template collides with every other honest
      renter they have never met; cloud hardware is fungible by definition.
      It is currently shadow-only and NOT in the reputation formula
      (`scheduler.js:767-793`). Recommendation: leave it out.
   3. **The catalog stops at 32B**, so "rent a GPU for bigger models" has no
      bigger models to run yet.
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
5b. **Public payout roster** — SHIPPED 2026-08-17 (kai `3b20c3f`):
   `GET /scheduler/network/roster` returns FULL, de-duplicated addresses of live providers for
   Free Koinos Node's community distribution (it pays them on chain, so a truncated address is
   useless). Liveness is shared with `/network/status` via `_liveWorkers()` so the two can never
   disagree. **This publishes every active provider's address — a deliberate owner decision
   2026-08-17, reversing the truncation stance for this surface only.** `/network/status` still
   truncates; do NOT "fix" the asymmetry. Probe: kai `scripts/probe-roster.js` (25 assertions,
   fails on old code); live probe in the kaiapp netcheck job. Verified live: count 3, 0 truncated,
   unique, `Cache-Control: no-store`, matching `workersOnline: 3`.
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
   recycles AND the ~6-min deploy blackout (systemd restart is now sub-second).
   ~~(a) re-establish auto-deploy~~ **DONE** — 1-min systemd timer polls the production branch
   (`deploy/deploy.sh`), verified live repeatedly since. ~~(b) durable ledgers~~ **DONE** —
   `KAI_STORE=sqlite` live since ad421ae, `/api/health` reports `store.mode=sqlite`, job counts
   and ageDays carried through the migration. Remaining: (c) decommission the dormant Hostinger
   app once Vultr has proven stable (keep the plan for email DNS).
8. Parked list — CLEARED in v0.30.1 (2026-08-21) except one owner-gated item:
   ~~async self-test~~ DONE (engine `selfTest` + ollama `locate` are async spawns; the
   blocking-spawn starvation can't recur — liveness test pins it); ~~Compare presets~~
   DONE (five preset chips: logic/code/instructions/summarize/creative); ~~deep-research
   surface~~ CLOSED as overtaken — research mode has its trace, citations render and
   persist on the message, and power users got Developer Tools; ~~scheduler-mirror
   resync-or-retire~~ DECIDED: retired as a mirror, kept as the worker-test fixture
   (headers on BOTH copies now say so — kaiapp `server/scheduler.js` is fixture-only,
   kai `lib/scheduler.js` is canonical; never port kai changes into the fixture
   wholesale). Remaining, owner-gated: Microsoft Store distribution (needs the owner's
   Partner Center account + code signing).
9. **Developer track (owner ask 2026-08-19: "toggle switch for developer tools… in the API
   section") — SHIPPED 2026-08-20** as three releases in one night:
   - **v0.28.9**: `dev.tools` switch in Local API (default OFF). With it on:
     `POST /core/teams/run` accepts full JSON team specs (`core/lib/teams.js
     normalizeSpec` — specs can only REMOVE stages / NARROW tools / LOWER budgets, role
     prompts APPEND to the built-ins so the planner/critic contracts survive), and
     `/core/bench` runs a fixed 10-case objective suite (`core/lib/bench.js`, mechanical
     checks only, report saved to `bench-last.json`). The switch reveals capability, never
     permission — `run_code` in a spec still needs its own upfront confirm.
   - **v0.29.0**: **Koinos Code** (task #60) — coding-agent CLI in the Claude Code mold on
     our stack: `cli/koinos-code.js`, zero deps, drives any project dir through `/v1/*`
     using ui/agents.js's grammar. Permission model in one sentence: reads free inside the
     project, writes show a diff and ask, commands always ask (`--yes` = edits only,
     `--allow-commands` = commands only, no both-flag). `docs/koinos-code-design.md`;
     scripted-gateway tests pin write flow / path jail / command gate / answer handshake.
   - **v0.29.1**: visual team-spec builder in the dev panel (form → writes the JSON; the
     JSON stays the source of truth).
   - Tester docs updated live same night (kai PR #6+#7, verified by netcheck curls:
     `docs kcode` + `docs devimg` HTTP 200): local-api.md documents the toggle/specs/bench,
     new koinos-code.md page. NOTE: the docs markdown renderer has NO table support —
     lists only (learned by rendering the options table as literal pipes; fixed in PR #7).
   - **v0.30.0 (owner ask 2026-08-20, task #64)**: Developer Tools moved OUT of Local API
     into its OWN sidebar view (node pattern — the switch stays in Local API, the content
     moved), sub-menu: Multi-agent / Playground / Pipelines / Benchmark. NEW ENGINE
     `core/lib/groupchat.js` — full AutoGen parity: named agents, one shared transcript,
     round_robin/selector/handoff floor control, humans as PAUSING agents (input-request
     over SSE, `/core/agents/input` resumes, timeout ends honestly), termination = end
     phrase / message cap / 120-call absolute ceiling; budgets HARD, specs only lower
     them; tools via the ONE registry, run_code still confirmed upfront. Saved defs CRUD
     at `/core/agents/defs` (validated on save). Docs page developer-tools.md (kai PR #9).
   - **UI audit (owner report 2026-08-20, task #65)**: workflow-driven screenshot audit
     found 9 root-caused defects — composer crushed at 1280px (viewport breakpoint ignored
     the sidebar; now wraps intrinsically), #privacy-pick clipped by a 200px cap meant for
     composer pickers, card-wide textarea rule silently restyling the Tasks form,
     #dev-question unstyled, small buttons not matching row heights, SIX views with no
     padding/scroll, select overflow, number-input mismatch. All fixed in v0.30.0.
   - **v0.30.1 (2026-08-21)**: parked-list clearance before Koinos Code v2 (§7 item 8):
     async engine self-test (spawn, event-loop liveness test in `core/test/ollama.test.js`),
     async ollama locate, Compare preset chips (`ui/app-extras.js` CMP_PRESETS),
     scheduler-mirror retirement recorded in both repos' headers.
   - **v0.31.0 (2026-08-21): Koinos Code v2** (design doc "v2" section): KOINOS.md
     project context (re-read EVERY task, 4000-char bound, honest truncation marker);
     `edit_file` surgical replace (exactly-once match or a routable refusal; shares ONE
     `approveAndWrite` gate with write_file — every disk write crosses the same diff+ask);
     team handoff `--team <research|analyst|review>` / REPL `/team` streaming
     `/core/teams/run` SSE (`[stage] detail` lines). Boundary stated everywhere: teams
     think in the APP's workspace, the agent loop edits the project. Analyst = run_code →
     upfront consent (TTY ask, `--allow-commands` headless); templates need NO dev switch,
     custom specs stay gated. Tests: 15 in koinos-code.test.js incl. a REAL-core `--team`
     e2e (model pinned to `dev-tiny` — first-listed alias would trigger a model download).
   - **v0.32.0 (2026-08-21): Koinos Code v3a — the panel** (design doc "v3a"): a Koinos
     Code sub-tab under Developer Tools hosting the SAME agent via `core/lib/code-agent.js`
     — CLI tools/jail/diff/KOINOS.md reused through the CLI's injectable `io`, [y/N] gates
     re-expressed as approval CARDS over SSE (`/core/code/run|approve|stop`, dev-gated; NO
     --yes equivalent in the app — every card is answered by a human, 5-min timeout =
     declined, cards die with their run; filesystem-root dirs refused). Fixture gained
     FAKE_LLAMA_SCRIPT (JSON array, one reply per non-streaming completion) so the HTTP
     and browser tests answer a REAL approval card mid-stream.
   - **v0.33.0 (2026-08-21): Koinos Code v3b — on the PATH** (design doc "v3b"): Windows
     installs get a real `koinos-code` command. `build/bin/koinos-code.cmd` ships to
     `resources\bin` (win extraResources), drives the app's own Electron with
     ELECTRON_RUN_AS_NODE against the asar-UNPACKED CLI (`asarUnpack: cli/**,
     ui/agents.js`); `build/installer.nsh` (nsis.include) adds/removes `resources\bin`
     on the USER Path via PowerShell SetEnvironmentVariable (broadcasts — new terminals
     see it, no reboot; duplicate-guarded for updates; a PATH failure never aborts
     install). Shim mechanics proven cross-platform (packaged Electron + unpacked CLI ran
     --help in CI-identical form); the .cmd + NSIS compile on the Windows CI build; the
     double-click PATH behavior is OWNER-VERIFIED-PENDING on his Windows machines. Linux
     stays `npx koinos-code` (AppImage is read-only — different mechanism someday).
     Koinos Code phases v1/v2/v3a/v3b are now ALL shipped; task #60 track closed.
   - **v0.33.1 (2026-08-21): code-surface hardening + a correction.** Self-review of the
     night's work found the v0.32.0 commit message wrong where it called the code agent
     "reach, not privilege": teams' `run_code` is workspace-sandboxed, the code agent
     writes ANYWHERE named and runs shell commands as the user. The gate is sound for
     desktop (loopback bind — no env changes it; `_sameSite` fails a cross-site fetch on
     BOTH sec-fetch-site and origin; dev switch off by default; a human answers every
     card), so this is defence-in-depth for ONE shape: the headless operator who puts a
     reverse proxy in front, where a stripped origin lands in `_sameSite`'s deliberate
     header-less trust. `/core/code/*` now refuses any request carrying `x-forwarded-*` /
     `x-real-ip` / `forwarded` unless KAI_CORE_TOKEN is set; the refusal names the way out.
     Fails-on-old test verified by reverting the gateway and re-running.
   - **v0.33.2 (2026-08-21): the dev-tools switch names Koinos Code.** The switch's own
     hint still described only "multi-agent systems, custom pipelines, and a model
     benchmark" — written before v0.32.0 put the code panel behind that same switch. The
     owner had to ask where Koinos Code lived; that question WAS the bug report. The hint
     now names all four surfaces. Same commit lands `docs/api-grounding-design.md`
     (open thread 11) — design only, nothing implemented.
   - **v0.34.0 (2026-08-21): API grounding — `koinos.ground` on
     /v1/chat/completions.** Optional block; absent it, behaviour is
     byte-identical. `sources` (URL allowlist over the caller's own material)
     and `web: true` (open web) are fields on ONE object and compose: own docs
     are read first, the web fills what is left, citations say which was which.
     Returned in the body (non-streaming) and in an `x-koinos-grounding`
     header (always, so streaming callers get them too).
     **Safety properties, all test-pinned:** grounding + `koinos-network` is
     REFUSED permanently (that request runs on a volunteer's machine — see
     open thread 11); Local-Only refuses before any egress; every fetch passes
     `isPublicHttpUrl`; an allowlist pattern may not carry a wildcard HOST
     (that would be open web wearing a restriction's clothes — refused with
     the honest alternative named); ONE search round with the user's question
     as the query verbatim, so a page just read can never shape the next query;
     NO tools in the loop, which is the containment that actually matters —
     the worst a hostile page achieves is a wrong answer; the reference is
     budgeted against the model's real context; and a grounded request never
     overflows to the network.
   - **v0.34.1 (2026-08-21): the `koinos` namespace is stripped
     unconditionally.** Found by re-reading the v0.34.0 diff, not by a test:
     the strip lived inside the grounding branch, so `{"koinos": {...}}` with
     no `ground` key parsed to null, skipped the branch, and rode on to the
     runtime — or was serialized and SIGNED into a network request bound for a
     stranger's machine. Now stripped as soon as it is parsed. General rule:
     a field in our own namespace stops at the gateway, whether or not the
     feature it belongs to ran.
   - **v0.35.0 (2026-08-21): Koinos Code is its OWN menu item, with projects
     and sessions.** Owner's ask: make it its own thing, several projects,
     GitHub, working the way Claude Code does. It has its OWN switch now
     (`code.enabled`), separate from `dev.tools` — the two answer different
     questions — and the switch SEEDS ITSELF from dev.tools on first read so
     nobody who had it loses it. `core/lib/code-projects.js` stores projects
     (add/rename/forget, bounded, agent-grade path validation, a moved folder
     is FLAGGED not dropped, forgetting never touches the folder) and sessions
     (turns persist; earlier turns ride into the next run as context marked
     "already done, do not redo", capped by BOTH turn count and characters).
     `/core/code/run` takes `projectId` + optional `sessionId`; a bare `dir`
     still works, so the CLI is untouched. New view `ui/code-view.js`.
   - **v0.36.0 (2026-08-21): Koinos Code connects to GitHub.** `core/lib/git.js`
     + `core/lib/github.js`. Clone → becomes a project; branch, status, commit,
     push, open a PR. **Security properties, all test-pinned:** NO SHELL ever
     (`spawn("git", argv, {shell:false})` — a branch name full of shell
     metacharacters is proven inert by a canary test); the token is never in
     argv (credential helper over stdin), never in `.git/config`, never in a
     response, scrubbed from all git output, stored 0600; repo refs are
     github.com-only https/`owner/name` (no ssh, no scp-style, no other hosts);
     `.`/`..` refused by name — they pass a character check and would escape
     `path.join(parent, repo)`, a real hole found by probing before wiring;
     every repo action names a PROJECT, never a request-supplied path.
   - **v0.37.0 (2026-08-22): Koinos Code workspace UI — and a real bug.**
     v0.35.0/v0.36.0 drove every action through `window.prompt()`, which **DOES
     NOT EXIST IN ELECTRON** (returns null, shows nothing) — so all nine
     Koinos Code buttons were dead in the packaged app while the Chromium test
     passed, because Playwright IS a browser. The guard is therefore STATIC:
     `core/test/electron-dialogs.test.js` greps `ui/*.js`. It immediately found
     a THIRD instance nobody had reported — the API-key budget button in
     app.js. **RULE: never use prompt() in ui/; alert()/confirm() are fine.**
     UI rebuilt as a workspace: projects rail + "New chat", a start screen with
     "Select a folder" (native `koinosShell.pickFolder` in the app, in-app
     browser in the served UI) and "Clone from GitHub" (creates the folder,
     clones, registers the project, opens it). New `/core/code/browse` lists
     DIRECTORIES ONLY — never file names.
   - **v0.38.0 (2026-08-22): plan mode + MCP tools in the coding agent.**
     Plan mode hands the loop list/read/search and NOTHING else — it cannot
     write because the tools do not exist, not because the model was asked
     nicely. The plan is a card; approving re-runs the task with the plan as
     context; a plan is not written to the session. Registry (MCP) tools are
     opt-in per project, capped at 8 (a 4k context cannot hold more and still
     hold the task), and a `sensitive` tool routes to the SAME approval card as
     a shell command. **Bug found in the process, never plan-specific:**
     `parseAgentAction` returns null for BOTH prose and a call naming an
     unavailable tool, and the loop treated null as the final answer — so a
     refused tool call was displayed as raw JSON pretending to be an answer.
     Now nudged (bounded to 2) with the real tool list.
   - **v0.39.0 (2026-08-22): slash commands + subagents.** `.koinos/commands/
     *.md` in the project → `/name`, `$ARGUMENTS` substituted, expanded in Core
     so UI/API match. **A command is a PROMPT TEMPLATE AND NOTHING ELSE** —
     these files arrive inside CLONED REPOS, so a command can never execute,
     grant, or widen anything; it only changes what is asked. (Same reason
     hooks stay unbuilt: a hook IS execution arriving in a clone.) Subagents:
     a `delegate` tool spawns a child on the same project returning ONE
     observation — child reuses the PARENT's approval cards, gets no host
     tools, cannot delegate further (depth 1 = fork-bomb stop), smaller budget,
     max 3 per run.
   - **v0.40.0 (2026-08-22): the agent said it wrote a file and did not.**
     Field report with a screenshot: asked for calculator.html, the run printed
     a `write_file` call as a chat bubble, said "done — 0 tool steps", showed
     NO approval card, and on the next turn insisted the file already existed.
     Root cause, and it is a class of bug not a typo: **a small model cannot
     hand-escape a whole HTML page into a JSON string.** Fences, raw newlines
     and the page's own `class="…"` quotes make the call unparseable, so
     `extractJson` → null, the loop read null as "this is the final answer",
     and the raw blob was surfaced as prose. Worse, the v0.38.0 nudge that
     exists for exactly this case ALSO called `JSON.parse` — so it agreed the
     call was not a call and stayed silent.
     Three fixes, one per failure:
     1. `salvageAction` (ui/agents.js) recovers a tool call by SHAPE when the
        grammar fails: find the tool name, read known argument keys in order,
        take the long value to the closing quote. Heuristics are acceptable
        HERE and nowhere else **because a salvaged write goes through the same
        approval card with the same full diff** — a garbled salvage is a
        garbled diff the person declines. It can never write unattended what a
        clean parse could not. Refuses to guess: unknown tool, or no tool name,
        returns null so the nudge fires instead. (v0.40.1: when a long value
        has no cleanly-closing quote — prose ran on past the call — the tail is
        cut at the LAST quote rather than swallowing the rest of the sentence.)
     2. `looksLikeToolCall` no longer parses — shape only. That is the whole
        point of a fallback check.
     3. `truthfulAnswer`: the run tracks whether any write tool actually
        succeeded (a helper's counts). An answer that claims a write when
        nothing reached disk gets a correction appended, so the lie never
        enters the session history for the next turn to believe.
     Also: markdown fences are stripped from `content`/`find`/`replace` in the
     file tools (a `.md` target keeps its fence — a fenced block is legitimate
     content there), the clone destination now opens the SAME native OS window
     as "Select a folder" (and where that window exists the typed-path row is
     not offered at all), and Koinos Code has **its own model box**, pinned per
     project and remembered. **Local models only, unlike Chat, on purpose:**
     the coding agent reads your project's files into every prompt, so routing
     it to volunteer machines would put private source on other people's
     computers as a side effect of picking a faster box. A pin whose model was
     later deleted is ignored with a note rather than bricking the project.
   - **v0.40.2 (2026-08-22): the SECOND cause of "it gave me code instead of
     files", and the more common one.** Owner, right after v0.40.1 shipped:
     *"Why does it keep giving me code in the chat instead of making actual
     folders and files?"* Probed rather than assumed — and it is a DIFFERENT
     bug from v0.40.0. There the model attempted a tool call that could not be
     parsed; here **it never attempts one at all**: asked to build a page it
     writes the page into its reply in a ```` ```html ```` fence and stops.
     `salvageAction` has nothing to salvage, `looksLikeToolCall` correctly says
     no, and the loop returns the code as the answer with 0 steps. A third
     state the loop had no name for: not a tool call, not really an answer.
     Two fixes:
     1. **The brief now says it outright** — "writing code in your reply does
        NOT create a file; nothing reaches the person's disk unless you call
        write_file or edit_file." The model was never refusing; it does not
        connect "produce this file" with "call a tool", so the PREAMBLE
        connects it. Cheapest fix available and it works at the source.
     2. `answeredWithCode` + a bounded nudge (act mode only, and only when the
        run has written nothing, so a summary quoting work already done is left
        alone). **The nudge offers BOTH doors on purpose:** "show me what a
        fetch wrapper looks like" is a real question whose answer IS a code
        block, and forcing a write there would invent a file nobody asked for.
        The model is asked which it meant; any write it then proposes is still
        a card. Thresholds tuned so `npm install` on two lines is advice, not a
        file: ≥2 non-empty lines AND ≥40 chars.
     **Known gap, not a bug:** there is no tool that creates an EMPTY folder.
     `write_file` mkdir's parents, so `src/components/Button.jsx` works and the
     folders appear; a bare "make me a folder called src" cannot be done. Not
     adding a tool for it — the menu is bounded and a 4k context pays for every
     entry — unless someone actually wants it.
10. **Moderation/AUP — owner-DEFERRED 2026-08-20**: owner agrees with the A40 reporter's
    finding but explicitly wants it on the future plan ("easier to understand the
    implications... with more nodes and network usage"). Design in kaiapp
    docs/moderation-aup-design.md. Do NOT implement until the owner re-opens it.

11. **API grounding — SHIPPED v0.34.0 (owner said go 2026-08-21).** (`docs/api-grounding-design.md`,
    2026-08-21). Owner asked whether the API can reach the internet for grounded answers,
    so support-bot builders don't have to build retrieval on their own side.
    **The safety half is decided and is NOT a sequencing question:** a request carrying
    model `koinos-network` is PROXIED to a volunteer operator's machine (gateway.js
    ~1189/`_proxy` ~1295). Asking a node to fetch a URL would make every operator an open
    egress proxy — SSRF onto their home LAN, abuse attributed to their IP, bandwidth they
    never agreed to spend, and results nobody can verify (a dishonest node can invent the
    page it claims to have read; §17 challenges score inference, not fetch honesty).
    **Node-side fetching is refused permanently, not deferred.** The half worth building
    lives on the CALLER'S OWN Core, where trust already exists and so do the parts
    (`/core/search`, `/core/fetch`, the `isPublicHttpUrl` guard, the tool registry, the
    agent loop): an optional `koinos.ground` block on `/v1/chat/completions`, absent =
    byte-identical behavior. Local models only, privacy switch first, allowlisted sources,
    fetched text framed as reference material never as instructions, citations always
    returned. Built as designed — both shapes together, per the owner's call
    that live data (news, weather) matters as much as static docs.
    **The node-side refusal above is permanent and is NOT a backlog item.**
    Residual risk accepted and documented rather than hidden: with `web: true`
    an end user's question steers what the caller's machine fetches from the
    public internet. That is inherent to open-web grounding everywhere; it is
    capped, off by default, and feeds a tool-less loop.

12. **Koinos Code vs Claude Code — what parity does and does not mean.**
    Shipped: own menu item, many projects, sessions that remember, approval
    gates on every write and command, a terminal CLI, GitHub (clone → project,
    branch/commit/push/PR), a folder picker and clone-to-start flow, PLAN MODE,
    MCP tools inside the agent, CUSTOM SLASH COMMANDS, and SUBAGENTS (v0.37.0–
    v0.39.0), a per-project MODEL PICKER (v0.40.0). NOT shipped: **background tasks** (detached runs whose approval
    cards survive a reload — real plumbing, worth doing when someone wants to
    walk away) and **hooks — deliberately declined, not deferred**: hooks are
    arbitrary shell commands fired automatically, and a `.koinos/hooks.json`
    would arrive inside a CLONED REPOSITORY, so opening a stranger's repo could
    execute their commands. That is a supply-chain hole, not a feature. The
    safe version of the same outcome is named scripts in KOINOS.md the agent
    may PROPOSE, arriving as an ordinary command approval card. It also runs on whatever the local gateway
    serves, so a small model behaves differently from a frontier one — that is
    the product's whole point, but it is a real difference in capability, not
    just in branding. Both of the "next two" named here are now shipped
    (v0.38.0). The standing lesson from v0.40.0: with a 4B model the ACTION
    GRAMMAR is the weakest link in this whole feature — not the tools, not the
    permissions. Assume malformed output is the normal case and recover from
    it; never let an unreadable tool call become an answer.

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
