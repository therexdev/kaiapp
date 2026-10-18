# Revision 2 implementation continuation — 2026-10-18

Status: source implementation under final validation. Commercial activation and real earning acceptance remain blocked; a source push or fixture test is not a completed product launch. Windows publication evidence is recorded separately when verified.

## Source lineage

- Desktop: current remote `test`, `084bf3b7cb988ed406b563442c1575cd1ccf7e2e` (Test 190.1).
- Backend: current remote `codex/koin-mainnet-pilot`, `fc67f72d7e712b5cc79691da5f042d8f56240777`.
- Both working branches: `codex/revision2-implementation`. The historical saved desktop `work` checkout was clean. The parked plugin branch was not used.

## Approved Library inputs

Exact metadata was resolved and all 23 PDF pages were read through Library. Binary materialization failed on the original attempt and the single bounded consumer-local retry. Subsequently, the parent provided the supported `library_read(mode=full)` route for the prototype. Its 110 lines were reconstructed locally: 82,830 bytes, SHA-256 `46e7a2b1af02f99724b86ef5d0ecae4604aeaed2a94e887ca25d0556713ccaf7`. All seven prototype screens were rendered through localhost Chromium and visually inspected before implementing the layouts. The separate PNG mockups remain unavailable; no additional binary retry was made.

| Filename | Library ID | Version |
| --- | --- | --- |
| KAI-Product-Implementation-Plan.pdf | libfile_8a6f4fa359c48191b95ebc79e2f4ec4d | 1 |
| KAI-Experience-Prototype.html | libfile_c1f8e57bd7e081919a0842eef452c05c | 1 |
| Network.png | libfile_90f75b8106b48191a36389399ba0aed7 | 0 |
| Chat.png | libfile_44010e02d50881919598bf3c31aba6f3 | 1 |
| Provider.png | libfile_4779aa4681bc81918ad277405b27c8f9 | 1 |
| Credits.png | libfile_baa39fa1577481919e0bc89979f960cb | 1 |
| Buy-credits.png | libfile_5da6368d7440819180ba32e98485a457 | 1 |
| First-use.png | libfile_cbf764055390819183133b29332fdde9 | 1 |
| Recovery.png | libfile_d5221110d8b0819181d3d4255bb29a26 | 1 |

The PDF content ID is `file_00000000116881f99e859eba561288c8`; the prototype content ID is `file_00000000d044820caea2fd76c81e583b`. The PDF metadata confirms the October 18 04:17 UTC revision.

## Implemented source

- Seven prototype-backed screens, expanded sidebar with recent chats/search/View all, compact Open KAI, shared credits and explicit old-account recovery. Existing chats, Brain, files, workflows, settings, models and local/private routes remain in place.
- Verified-account free entry does not require KOIN or an operator invitation. Free-first and Free only share the purchased-credit ledger. Explicit budgets and model tariffs are required; the historical 25,000-token allowance is not bypassed or relabelled as USD credits.
- Real signed incremental replies are metered and durably saved before delivery. Stop charges only verified delivered text; empty failures are free. Encrypted partial replies recover after restart without charging twice.
- Public purchases bind the exact USD pack, selected linked wallet, native KOIN amount, deployment and Master destination to a verified quote. Durable native approval journals make repeated/uncertain submission idempotent. Existing credits remain usable during another purchase's confirmation. Old signed journals and nonce obligations remain separate.
- The approved Uniswap v4 pool uses finalized reorg-aware history, two independent archive sources, time-weighted/depth/deviation bounds, fresh USDT/USD and explicit signed wrapped/native parity. No v3 observe(), sample live price, spot fallback or assumed parity is used. Missing safe quotes pause purchases only.
- Capped sponsored settlements record free and purchased USD usage separately while feeding verified total work into the fixed reward pool. Contract ceilings and backend admission both enforce explicit budgets. Intermediate earlier paid-only sponsorship records require recovery review rather than silent rewriting.
- Guided provider checks, explicit model download/cancel, saved On/Off, restart/reconnect and deployment-pinned workers. Automatic qualification uses a reviewed benchmark policy, durable signed results and expiry/renewal. It cannot invent benchmark criteria or renew October 16 evidence merely from ONLINE presence. Public earnings use account authorization and retain unresolved payout states.
- Secondary Network displays real models/providers/waiting requests/activity with timestamps and stale expiry. Back to Earn does not stop sharing.
- Research, Agents and Teams require a supported service capability and an explicit total run ceiling before starting. Every network model call uses the same free/paid accounting, immutable model and paid-continuation preference. Concurrent holds, retries, streaming partial usage, Stop and restart are bounded by that ceiling. Useful encrypted intermediate results remain recoverable, including after changing selected linked wallet. Existing local tool permissions and private model routes remain intact.

## Validation and evidence

All checks use isolated fixtures/local services unless explicitly stated. They do not prove live purchases, real two-computer qualification, delayed payout or independent financial acceptance.

The desktop full run before the final earnings regression addition completed with 1,331 passed, zero failed, five skipped (1,336 tests). Chromium is `/usr/bin/chromium`; external background DNS was failed fast while loopback fixtures remained available. The pinned Smart-Turn model was restored from its exact catalog revision and SHA-256 verified; its real inference checks pass. Final counts are appended after completion.

Backend probes exercise actual loopback account signup, public streaming, multiple-wallet membership, total run admission, provider polling/qualification and signed results. Capped contracts passed 38 AssemblyScript tests and 12 built-WASM probes. Build support never deployed a contract. The executor uses Node 24.19; CI uses declared Node 22. No dedicated lint/type script exists; changed JavaScript receives syntax checking and `git diff --check`.

Browser journeys cover first-use Back, free entry, shared balances, pending purchases, unavailable/edited quotes, repeat approval/cancel, delivered partial replies, old-account recovery, provider expiry, stale network and Back to Earn. Advanced-mode checks cover pre-start capability gating, budget Cancel, all model calls under one run, Stop, saved intermediate results and preserved local/developer workflows.

Prototype/reference and implementation screenshots are in `/workspace/kai-revision2-assets/`; these paths do not guarantee access from another executor. Draft PR: https://github.com/therexdev/kaiapp/pull/11. Source `4f00b5408e30da05a67e1b8a5a16139c5988c6a4` passed CI 528: https://github.com/therexdev/kaiapp/actions/runs/39105356006. That run produced visual checks only, not Windows installers.

## Activation decisions and operator handoff

The packaged service manifest remains honestly unavailable. There is no safe production configuration to install: USD model tariffs, the comparable daily free USD budget and Master allocation remain unchosen. V4 depth/deviation/history limits, USDT feed and parity evidence need review/configuration. The earlier 7/10 benchmark artifact and approved quality/latency criteria are absent; no benchmark bar is silently lowered.

Fresh contract addresses, deployment, credentials, 10,000 KOIN reward seed, funding/transfers and production service changes are outside this task's authorization. Mainnet purchase destination remains `15CM9Qr4GKREDgqnyXJ8tckPj2biERTM1T`. Existing accounts, old custody/prepaid-v1 balances, the old 0.1 KOIN obligation and unresolved epoch 20742 are preserved; no reset or retry was performed.

Independent purchase/sponsorship/payout-abuse review, real two-computer earning acceptance and delayed payout observation remain required before activation. Three closed reward days versus seven telemetry days remains unresolved. A test installer can expose the redesign and honest unavailable states; it cannot establish an activated free-credit or earning service without these decisions and authorized operations. Plugin extraction remains parked.

## Final local validation

Final desktop run: 1,337 tests, 1,332 passed, zero failed, five skipped, 190.8 seconds (`/tmp/kai-revision2-final-desktop.log`). Backend plus cutover preparation: 385 tests passed, zero failed (`/tmp/kai-revision2-final-backend.log`), remote source `6b95d3b4e5bfccfe3477bb5f5ebb4cd56277b135`. Changed JavaScript syntax checks and whitespace checks pass. Desktop audit has zero high/critical findings and 11 moderate dependency findings; backend audit reports zero vulnerabilities. No commercial policy or live service was activated by these checks.

## Internal review follow-up

Test 191.1 was published and its downloaded Setup bytes, checksums, signatures and feed verified against source `b016618837df701f536e5403099794870144659d` and run https://github.com/therexdev/kaiapp/actions/runs/39106826546. Subsequent internal review reproduced a desktop registration bug when the original purchase wins over a Mana correction. The fix prefers the verified finality transaction ID and is being validated for a replacement Test release. No transaction was signed or broadcast by the regression.

The matching backend follow-up also addresses durable fair purchase scheduling, account-wide self-work exclusion, settlement/epoch liveness, settlement-day sponsorship headroom and heartbeat-order fairness. These corrections do not activate the service or replace independent financial review. Unknown historical ownership/finality evidence remains review-gated, and cross-account collusion is not claimed solved.

Follow-up local validation: 1,339 desktop tests, 1,334 passed, zero failed, five skipped. The targeted purchase/Mana/fairness group passed 33 tests. The backend review suite passed 398 tests on Node 22; no production changes or live transfers were performed. Replacement Test release evidence is reported separately after exact-source verification.

Further bounded review reproduced purchase winner discovery during sync (rather than before it) and provider evidence pruning after a long outage. Sync now reconciles before registration; availability retains evidence needed by unclosed intervals. Matching backend changes add durable settlement retry fairness and server-verified finalized-purchase recovery at a full pending cap. No nonce fence, expired-quote permission, signed root or historical obligation is relaxed. These fixes require a replacement Test build; Test 192.1 predates them. Publication evidence will be reported separately after verification.

Bounded recovery follow-up validation: desktop 1,342 total tests, 1,337 passed, zero failed, five skipped; backend 401 passed, zero failed/skipped on Node 22, source ba82f8a59b1543f54d43e2ae1071288589de1e68. No production deployment or financial action occurred.
