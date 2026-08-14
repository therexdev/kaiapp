# Koinos AI Core (kaiapp) — V1 Plan

> **Status: ACCEPTED** (2026-08-14) — owner signed off on the three open decisions:
> **M1 = local-first slice · Electron · llama.cpp (llama-server)**. Governed by *Koinos AI —
> Master Source of Truth* Part I (the `.docx` is authoritative); section references (§) below
> point there. Where this plan chooses an implementation detail the spec leaves open, it is
> marked **[working choice]** and stays subordinate to Part I.

## 1. What V1 must prove (§46, LOCKED)

1. A normal user can install Koinos AI.
2. The user can immediately run a useful local AI model/chat experience.
3. A compatible machine can begin AI earning with essentially one action.
4. A real decentralized inference job can be routed, completed, verified, and reliably settled in KAI.
5. A user can consume stronger/public network AI and pay through the KAI-linked economic layer.
6. A developer can self-host an OpenAI-compatible API, use local/private compute, and transparently overflow to decentralized compute.

Explicitly **out** of V1 (§47): DAO governance, decentralized schedulers, agent marketplace,
confidential GPU, distributed foundation training, "dozens of models or every GPU vendor",
decentralized model hosting, perfect fiat routing, one-click block production as a dependency —
and anything that slows proving the two core loops.

## 2. The structural insight that orders the milestones

§46's six items split cleanly by what they depend on:

| Items | Need | Exists today? |
|---|---|---|
| **1, 2, 6-local** (install, local chat, self-hosted local API) | Desktop app only — zero network/chain infrastructure | Buildable immediately |
| **3, 4, 5, 6-overflow** (earning, routed/verified/settled job, network consume) | Project-operated scheduler (§12), receipts/verification (§17), settlement pipeline (§20), KAI token + treasury (§25), MANA sponsorship (§21) | None of the server/chain side exists yet |

§6 requires local chat to be useful even with no network at all, and §48's first gate is an
*internal alpha* on tens of machines. So the local half is a complete, demonstrable product slice
on its own — and it is the half that de-risks the mainstream-onboarding promise (§5), which is
the hardest UX bet in the spec.

**[working choice]** Alpha settlement runs on **Koinos harbinger testnet** first, mainnet at a
readiness gate (§48: gates, not calendar dates). This proves §46.4 end-to-end without a public
token event, consistent with §26 ("no token sale before a working product"). Caveat from
Koinos-Node: there is no reliable *public* harbinger RPC — the project runs its own harbinger
node (Koinos-Node's `node-template/harbinger/` + NodeManager make this nearly free) or uses a
keyed RPC provider.

## 3. Milestones

### M1 — Local Core (§46: 1, 2, 6-local) — no blockchain code at all
- **Core service** (plain Node process, no UI): health/status endpoint, module registry — the §4
  skeleton every later module plugs into. Runs as a background service so closing the UI doesn't
  stop the local API (§4).
- **Hardware detection** (§5.1): OS/CPU/RAM/GPU/VRAM/driver probe → capability report.
- **Runtime manager** (§6): supervises a local inference runtime as a child process; runtime
  abstraction from day one (runtime = versioned, swappable component; §6 marks selection
  VALIDATION). **[working choice pending Q3]**: llama.cpp `llama-server` (prebuilt CUDA binaries
  for Windows+NVIDIA per §5's initial target; it natively speaks OpenAI chat/completions with
  streaming, so the gateway proxies + polices rather than reimplementing inference HTTP).
- **Model manager** (§6/§27): download a recommended default model package; hash-verified,
  versioned package identity; capability aliases (**Koinos Fast/Smart/Code**) not filenames;
  storage caps + advanced override. Built on the resumable-download/orchestrator pattern from
  Koinos-Node (see §5 of this plan).
- **Local OpenAI-compatible API gateway** (§8): `GET /v1/models`, `POST /v1/chat/completions`
  (+streaming) in front of the runtime; scoped API keys that are never wallet keys; per-project
  budgets/limits scaffolding (enforced locally; network budgets arrive M3).
- **Desktop chat UI** (Electron client of Core): chat with the local model; model/alias picker;
  onboarding flow per §5 (no wallet, no seed phrase, no KAI anywhere in M1).
- **Windows installer** (§5): NSIS via electron-builder (Koinos-Node's pipeline), bundling
  runtime + first-run model download. §51 items exercised: installer/driver/model automation,
  storage management.
- **Acceptance:** fresh Windows+NVIDIA machine → install → chat locally ≤ 10 minutes with no
  configuration; `curl` against the local endpoint streams a completion; works fully offline
  after model download.

### M2 — Accounts + Earn alpha (§46: 3, 4)
- **Wallet/account service**: Koinos-Node `WalletService` + keystore reused (same encrypted
  format). Mainstream auth evolution (passkeys/VEIVE, §22) tracked as VALIDATION — alpha uses
  the proven password keystore; **no seed-phrase-first onboarding** surfaces in the consumer
  flow (§5).
- **Benchmark + eligibility** (§5.5–5.8): measure the machine, map to eligible workload classes,
  apply safe defaults (Balanced/Max/Low-Power, §10; battery/thermal guards).
- **One-click Start Earning** (§5.7): outbound authenticated worker connection to the
  project-operated scheduler (§12); worker executes **approved workload profiles only** (§31 —
  no arbitrary customer code); protocol-funded useful jobs (benchmark/eval/verification)
  disclosed as bootstrap demand (§16).
- **Receipts → verification → settlement**: job receipts + hidden-challenge verification
  (§17 minimal layer); epoch aggregation → Merkle batch commitment → provider claim (§20) in
  KAI on harbinger; claims are MANA-sponsored via the reused relayer (§21). Provider UI shows
  KAI earned / estimated value / GPU time — never CU (§14).
- **Server-side workstream** (separate from the desktop repo): minimal scheduler + receipt
  store + settlement batcher; KAI token + settlement contracts on harbinger. §13's V1
  simplification applies — proxy traffic through project infrastructure; no inbound ports on
  providers.
- **Acceptance:** §46.3 and §46.4 demonstrated end-to-end on harbinger across ≥2 real machines.

### M3 — Network consume + overflow (§46: 5, 6-network)
- Routing & policy engine (§7): privacy policy → spending authorization → capability → quality →
  cost, in that order; privacy modes Local-Only / Local-First / Network (per §29 classes);
  fallback can never silently violate policy.
- Spend path: AI Credits abstraction over KAI (§23) for consumers; developer overflow with
  per-request/day/month budgets, alerts, hard stops (§8).
- **Acceptance:** a request that exceeds local capability overflows to the network within policy
  and settles; a Local-Only request provably never leaves the machine.

### M4 — Alpha hardening (§48 internal-alpha gate)
- Auto-update (reuse beta/stable channel pattern), health/telemetry manager, worker sandbox
  tightening (§31), signed builds (§45), earning pause honored immediately, storage/bandwidth
  caps, kill switches for a compromised runtime/model package (§32).
- **Gate:** tens of machines, installer/model/routing/streaming/settlement/update paths all
  exercised (§48).

## 4. Architecture (§4-conformant)

```
┌────────────────────────────┐     ┌──────────────────────────────┐
│  Desktop UI (Electron)     │     │  Koinos AI Server (§9, later)│
│  – chat, earn, settings    │     │  – headless CLI/container    │
└──────────────┬─────────────┘     └──────────────┬───────────────┘
               │  local RPC (same channel table as Koinos-Node IPC)
┌──────────────▼──────────────────────────────────▼───────────────┐
│                      KOINOS AI CORE  (Node service)             │
│  runtime mgr → llama-server child   model mgr   API gateway     │
│  routing/policy   worker client   wallet svc   health/update    │
│  optional modules (Era II): NodeManager, block producer, …      │
└─────────────────────────────────────────────────────────────────┘
```

- The UI is a *client* of Core (§4). Koinos-Node's `main.js` pattern — service objects + a
  uniform `{ok,data}|{ok,error}` handler table behind an allowlisted preload bridge — ports
  directly; the handler table just also binds to a localhost transport so the headless server
  (§9) and CLI reuse Core unchanged.
- Keys never enter the renderer or the inference runtime (§22/§34); wallet stays in Core.
- Repo layout **[working choice]**: `kaiapp` = `core/` + `desktop/` + `docs/`; the scheduler/
  settlement backend is server infrastructure and lives in its own (private) repo when M2 starts.

## 5. Koinos-Node reuse map (surveyed at v0.4.1, commit `c290095`)

Verified by reading the code — LOC are actual. "Clean" = no Electron imports; depends only on
Node stdlib + koilib/ethers (+ a thin `settings.get()`/`onEvent` interface).

| Module (path in koinos-node) | LOC | What it is | Reuse into kaiapp | When |
|---|---|---|---|---|
| `electron/lib/wallet.js` | 189 | `WalletService`: encrypted keystore, create/import/unlock/lock/reveal/remove, atomic writes, keys confined to main process | **Copy as-is** (clean) | M2 |
| `electron/lib/keystore.js` | 79 | scrypt + AES-256-GCM versioned keystore format | **Copy as-is**; keep format identical so keys are portable between the two apps | M2 |
| `electron/lib/chain.js` | 350 | `ChainService`: balances/mana, KCS-4 allowance handling, contract resolution w/ fallback, burn/transfer with mana preflights, sync status, history | **Copy with light trim** (drop PoB-specific paths until Era II); clean | M2 |
| `onramp-endpoint/api/sponsor.js` + `lib/validate-sponsored-tx.cjs` | 105+ | §21 MANA sponsorship, already to spec: allowlisted ops, rc ceiling, payer/payee rules, payee-signature check, per-payee+IP rate limits | **Redeploy pattern as the Koinos-AI sponsor**; extend `ALLOWED_OPS` for claim/settlement ops | M2 |
| `electron/lib/constants.js` | 146 | `NETWORKS` incl. **harbinger testnet**, vendored ABIs, defaults | Copy; add KAI/settlement contract entries | M2 |
| `electron/lib/route-c-orchestrator.js` (pattern) | 381 | Persisted state-machine orchestrator: one tx/state, balance-delta reads, resume, transient-retry, interval driver gated on unlock | **Pattern reuse** for model downloads (M1), benchmark runs (M2), settlement claims (M2) | M1 |
| `electron/lib/rewards.js` (pattern) | 367 | Timer-tick engine with config/state per network | Pattern for the earnings/claim engine | M2 |
| `electron/main.js` + `preload.js` | 786+ | Hardened shell (contextIsolation/sandbox/no nodeIntegration), allowlisted channel bridge, `{ok,data}` wrapper, single-instance, electron-updater w/ semver-prerelease beta channel, smoke-test + demo hooks | **Skeleton reuse** — same patterns, new channel table; updater config copied | M1 |
| `electron/lib/node-manager.js` | 596 | docker-compose node lifecycle, quick-sync (checksummed resumable restore), producer key reading | **Defer — Era II optional module** (§39); import nearly unchanged then | Era II |
| `electron/lib/setup.js` + `setup-plan.js` | 495 | WSL+Docker guided setup | **Defer — Era II** (M1 needs no Docker: llama.cpp is a plain child process — keeps §5 install friction low) | Era II |
| Bridge/funding stack (`eth*.js`, `koindx.js`, `usdt/vkoin-send.js`, orchestrators) | ~1,400 | Coinbase onramp → Route B/C → KOIN, quotes, recovery | **Defer to M3+** — §23 payment router direction; consumer KAI path needs design first (§23 VALIDATION) | M3+ |
| `test/` (23 files, `node --test`) | ~1,600 | Framework-free unit tests over every lib | Copy the approach + relevant tests travel with copied modules | M1 |
| `.github/workflows/release.yml` | — | Tag-triggered installers, beta/stable channels | Copy for kaiapp releases | M1/M4 |
| `cloud/experiments/shared-core/` | — | Validated spike: one shared Koinos core, many independent producers (~3MB marginal/user) | Note for a future hosted node offering; not on the AI-core path | — |

**Net:** the entire §4 "Account/Wallet Policy Service" plus §21 sponsorship and the Era-II node
modules already exist in production quality. What is genuinely new in kaiapp: runtime manager,
model manager, API gateway, chat UI, routing engine, worker client — plus the server-side
scheduler/verification/settlement and the KAI/settlement contracts.

## 6. Validation queue items this plan exercises (§51)

M1: V1 runtime + launch-model selection (record quality/licensing/memory/throughput as we go);
Windows installer/driver/runtime/model automation; updater/rollback; model storage management.
M2: scheduler prototype (discovery, leases, streaming, cancellation, failover); MANA sponsorship
load/abuse; CU benchmark suite for the first workload class; worker sandbox threat model.
M3: payment/credits path; reference-price mechanism inputs (§15, SIMULATION — surfaced to the
economics track, not decided in code).

## 7. Risks / honest unknowns

- **Runtime licensing & model choice** (§51): llama.cpp is MIT, but the *model* license drives
  what ships as default — selection is a real M1 task, not a footnote.
- **Harbinger RPC availability**: mitigated by running our own testnet node (tooling exists).
- **VEIVE/passkey auth** (§22): VALIDATION; alpha uses password keystore. The consumer-visible
  onboarding must still avoid seed-phrase-first framing (§5).
- **Verification economics** (§17/§52): M2 ships the minimal layer (receipts + hidden challenges);
  rates/costs go to the simulation queue rather than being invented here.
- **Positioning** (§50): all UI copy follows the guardrails — "Earn with your computer", never
  "crypto mining"; no privacy overclaims for Verified Network (host can access plaintext, §29).

## 8. M1 progress (2026-08-14)

**Built and tested** (16 passing tests, zero runtime dependencies): Core service entrypoint
(`core/server.js`), hardware detection with graceful GPU-absent fallback, model manager
(sha256-pinned catalog, resumable Range downloads, fail-closed on unpinned hashes),
llama.cpp runtime adapter (child-process supervision, health-wait, crash reporting),
runtime manager (single-flight model loads, GPU offload only when detection approves),
OpenAI-compatible gateway (models + streaming chat/completions raw-proxy, `/core/*` control
plane, keys-optional-then-required auth), scoped API keys hashed at rest. Integration test
drives the full chain through a real spawned fake-`llama-server` child.

**Desktop shell + UI shipped** (second increment, 17 passing tests): the gateway now serves
the UI itself (`ui/` — plain web app, no framework), so the Electron shell (`electron/main.js`)
is a thin sandboxed window onto `http://127.0.0.1:<port>` and the same UI runs in any browser
for dev/headless (§9). Screens: §5 onboarding (hardware summary → one-click verified model
download with live progress → chat), streaming chat with stop/abort, Local API panel (SDK
snippet, key create/revoke with show-once secrets), Earn tab stubbed "soon" (M2). The UI chats
over a control-plane lane (`/core/chat/completions`) so creating an external API key locks
`/v1` without ever locking the app's own chat out. Verified end-to-end in real Chromium via
`playwright-core`: onboarding → download (progress observed) → streamed reply → key lockdown.

**Runtime auto-provisioning + CI shipped** (third increment, 22 passing tests): the llama.cpp
engine is now fetched per-platform exactly like a model package — versioned catalog
(`core/runtimes/catalog.json`), sha256-pinned, fail-closed, resumable — via a shared
`lib/download.js` and a zero-dependency zip extractor (`lib/zip.js`: store+deflate, unix modes
preserved, zip-slip refused, zip64/encryption fail loudly). Onboarding's one click now covers
model **and** engine ("Downloading engine…" progress in the UI); `KAI_LLAMA_BIN` still forces a
local binary and skips provisioning. GitHub Actions CI runs the full suite (browser test
included) on every push and builds the NSIS installer + portable exe (Windows) and AppImage
(Linux) on tags/dispatch via electron-builder.

**Real end-to-end PASSED on Windows (2026-08-14, CI run 3 of Pin & Verify):** the workflow
pinned every artifact (llama.cpp b10423 win-cpu 18.5 MB, win-cuda 250.8 MB + cudart 391.4 MB,
SmolLM2-135M-Instruct Q8 144.8 MB from bartowski's GGUF repo) and then, from a bare runner,
the shipping code path provisioned engine + model, booted llama-server, and streamed a real
completion through the gateway — the model answered: *"I'm a helpful AI assistant named
SmolLM, trained by Hugging Face."* CI committed the verified pins back (`82439cc`). Trigger
anytime with a `[pin-verify]` commit or workflow dispatch. Two upstream facts learned and
encoded: llama.cpp publishes no Linux release binaries (Linux devs use `KAI_LLAMA_BIN`), and
CUDA builds need the cudart companion archive (now an `extras` entry).

**First §51 benchmarks recorded** (`docs/benchmarks/cpu-win32-2026-08-14.md`, CI Benchmark
workflow — re-run anytime with a `[bench]` commit or dispatch): on a 4-thread CPU runner,
SmolLM2-135M Q8 hit 128 tok/s, Qwen2.5-0.5B Q4 43.5, **Llama-3.2-1B Q4 33.1**, SmolLM2-1.7B
Q4 23.5 — all above comfortable reading speed, with Llama-3.2-1B producing clean correct code
and coherent chat. Working recommendation for owner review: **Llama-3.2-1B-class as "Koinos
Fast" on the CPU tier** (quality per token clearly ahead of the sub-1B models at a still-fluid
speed); "Smart"/"Code" aliases need the GPU tier — run the same harness on real GPU hardware
before deciding. Candidate hashes are pinned in `core/bench/candidates.json`.

**Remaining M1 items:** auto-update wiring (electron-updater channels), app icons/branding,
first-run polish, GPU-tier benchmarks on real hardware, and a `v0.1.0` tag to produce the
first Windows installer artifact.

## 9. Decisions (resolved 2026-08-14)

1. **M1 scope: local-first slice only.** Installer → local chat → local OpenAI-compatible API;
   earning follows in M2 against the project-hosted scheduler.
2. **Desktop stack: Electron.** Direct reuse of the Koinos-Node modules, shell patterns,
   updater channels, CI, and test approach.
3. **V1 runtime: llama.cpp (`llama-server`)** supervised by Core as a child process, behind the
   §6 runtime abstraction (selection stays VALIDATION — benchmarks recorded as we go).
