# Revision 2 implementation continuation — 2026-10-18

Status: implementation checkpoint, not the complete Revision 2 product. No Windows test update published.

## Source lineage

- Desktop: current remote `test`, `084bf3b7cb988ed406b563442c1575cd1ccf7e2e` (Test 190.1).
- Backend: current remote `codex/koin-mainnet-pilot`, `fc67f72d7e712b5cc79691da5f042d8f56240777`.
- Both working branches: `codex/revision2-implementation`. The historical saved desktop `work` checkout was clean. The parked plugin branch was not used.

## Approved Library inputs

Exact metadata was resolved. PDF text (all 23 pages) was read through Library. No file bytes were successfully materialized, and no mockup or rendered prototype was visually inspected. Each file failed initial supported transfer and the one bounded retry to a consumer-local destination (`download failed`). Do not treat the UI as visually implemented or validated.

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

## Implemented source changes

- Backend verified-account mode reuses the existing account/email verification and device-link service; a free account does not need a payment wallet. Explicit daily USD budgets, model eligibility, concurrency and origin/global caps persist atomically with purchased-credit accounting. No default commercial entitlement is supplied.
- Free-first allocation, Free only, maximum-paid binding, exact mixed debits, cancellation and UTC reset are covered by local tests. Sponsored usage is recorded separately, never as a fake purchase. **Its contract settlement and reward inclusion are still unfinished.**
- Purchase claims are keyed by both transaction and claimant; a false claimant cannot occupy the legitimate owner's purchase ID. Confirmed transactions have a unique index and exact finality attribution. The original purchase table remains intact.
- Providers now send signed, sequenced cumulative output over the actual inference SSE stream. The backend meters and persists verified prefixes before delivery; the desktop verifies and encrypts each prefix before rendering it. Stop/restart preserve delivered text and charge no further output. Buffered legacy inference remains separate.
- The desktop has a shared versioned credit store, Free only preference, partial-reply preservation, and a packaged-service activation path using the signed-in account. New files use `credit-account-v2`; earlier journals are not migrated or relabelled. Activation rejects reuse of old custody/reward addresses. The packaged manifest is deliberately unavailable until a valid service configuration exists. Automatic purchase/provider activation and complete old-account UI migration remain unfinished.
- The obsolete ticker price feed is disconnected from new USD purchases. The exact approved v4 market is pinned. The actual v4 observation/quote adapter is still unfinished; existing balances do not require a price quote.
- Removed sample KOIN purchase amounts and misleading fixed-value validation copy.

## Verification

Backend: 344 KOIN tests passed with `node --test --test-concurrency=2 scripts/probe-koin-*.js`, including real loopback HTTP signup, verified free account, signed stream and cancellation. Desktop targeted tests cover encrypted recovery, wallet-free activation, old-address refusal, session/privacy revocation and shared balances. Chromium tests cover purchase-pending chat, Free only, incremental display and interrupted prefix retention. These use local services and fixture commercial policies, not live financial operations.

The initial desktop suite had 1,233 passes, 11 failures and 66 skips. Four chat/IPC regressions were fixed and their 33-test group passes. Five failures were the absent default browser path and pass with `/usr/bin/chromium`; two require missing Smart-Turn model assets. A full rerun with Chromium completed the Earn/Node browser assertions but retained Ethereum RPC retry handles; its process was terminated after 229 seconds so remaining tests could report. This is a failed full-suite validation, not a pass. `npm run live-senses:prepare` failed with `Could not prepare KAI Live Senses: fetch failed`. Final Chromium-enabled totals: 1,307 passed, 3 failed, 5 skipped (1,315 tests). Failures are the terminated Earn browser process and the two missing Smart-Turn asset checks. Targeted activation/privacy/migration tests also pass (5/5). `npm audit --audit-level=high` reports zero high/critical vulnerabilities (11 moderate). Backend declares Node 22; this executor runs Node 24.19.0. Windows release CI and packaged acceptance have not run.

GitHub connector repository access succeeds, although CLI `gh` authentication is invalid. No release was requested because the implementation and validation are incomplete. Implementation branches are pushed separately from `test` and production.

## Remaining implementation and release gates

- Actual mockup/prototype inspection, all seven approved layouts, sidebar/recent chats, network secondary page with stale timestamps and Back to Earn.
- Complete automatic customer/provider activation and purchase UI, including existing account migration and multiple linked-wallet handling. Earlier KOIN recovery must remain accessible without presenting it as USD credits.
- Sponsored usage contract settlement and inclusion in provider work accounting; real v4 reorg-aware, time-weighted/depth/deviation pricing, fresh USDT/USD and explicit native/wrapped parity; exact USD purchase packs.
- Guided provider setup, qualification proof renewal and recovery. The existing live qualification expired October 16; this code does not renew it.
- Research/Agents/Teams integration and run budgets. These are not enabled by the streaming Chat changes.
- Complete browser/Windows integration, release CI and artifact verification, real two-computer earning acceptance and delayed payout observation.

## Decisions and operator handoffs

USD model tariffs, the daily free USD budget comparable to historical 25,000 AI tokens/day, and Master allocation remain unchosen. Three closed reward days versus seven telemetry days remains unresolved. No sample figure has become an entitlement.

Fresh contract deployment, credentials, seed/funding, transfers and live financial operations require a separate authorized operator handoff. Production services, the old 0.1 KOIN obligation, old signed journals, and unresolved reward epoch 20742 remain untouched. Source/test-build authorization does not authorize these operations.
