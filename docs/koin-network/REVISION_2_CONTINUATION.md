# Revision 2 implementation continuation — 2026-10-18

Status: implementation checkpoint, not the complete Revision 2 product. No Windows test update published.

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

## Implemented source changes

- Backend verified-account mode reuses the existing account/email verification and device-link service; a free account does not need a payment wallet. Explicit daily USD budgets, model eligibility, concurrency and origin/global caps persist atomically with purchased-credit accounting. No default commercial entitlement is supplied.
- Free-first allocation, Free only, maximum-paid binding, exact mixed debits, cancellation and UTC reset are covered by local tests. Sponsored usage is recorded separately, never as a fake purchase. Its capped contract settlement and finalized reward inclusion are now implemented and locally tested; independent financial review and real earning acceptance remain pending.
- Purchase claims are keyed by both transaction and claimant; a false claimant cannot occupy the legitimate owner's purchase ID. Confirmed transactions have a unique index and exact finality attribution. The original purchase table remains intact.
- Providers now send signed, sequenced cumulative output over the actual inference SSE stream. The backend meters and persists verified prefixes before delivery; the desktop verifies and encrypts each prefix before rendering it. Stop/restart preserve delivered text and charge no further output. Buffered legacy inference remains separate.
- The desktop has a shared versioned credit store, Free only preference, partial-reply preservation, and a packaged-service activation path using the signed-in account. New files use `credit-account-v2`; earlier journals are not migrated or relabelled. Activation rejects reuse of old custody/reward addresses. The packaged manifest is deliberately unavailable until a valid service configuration exists. Automatic purchase/provider activation and complete old-account UI migration remain unfinished.
- The obsolete ticker price feed is disconnected from new USD purchases. The exact approved v4 market is pinned. The v4 archive adapter now reads canonical finalized histories from two pinned HTTPS providers, validates executable depth and time-weighted/deviation bounds, uses a configured fresh USDT/USD feed and a signed, fresh wrapped/native parity attestation. No live pricing policy or attestation is installed; existing balances do not require a quote.
- Removed sample KOIN purchase amounts and misleading fixed-value validation copy.
- Implemented the seven approved prototype layouts, mint/dark styling, expanded sidebar with recent chats/search/View all, compact Open KAI, shared credit summary and explicit older-account recovery. Existing Brain, Workflows, Agents, Compare and other screens retain their controls; moved navigation tests now use More.
- Added an authenticated read-only network overview with actual model/provider/waiting/delivered counts, anonymous provider labels, observed/expiry timestamps, duplicate connection suppression and stale status. Back to Earn does not change sharing. Expired qualification never becomes ONLINE.
- New purchase UI has no prefilled amount or invented KOIN price. Editing the amount discards an in-flight quote; repeat approval clicks cannot submit twice. Public purchase preview/approval now binds exact USD packs to a private verified signed quote and the existing native approval/journal. Local installation identity is reused without importing old credentials. Repeated approval, lost transport response, restart, cancellation and account revocation are tested with isolated fixtures. The packaged service remains unavailable pending reviewed deployment and commercial configuration; these tests are not live purchases.
- Credit sign-out clears the previous snapshot and rejects late session responses. First-use local setup has Back to choices; it does not auto-download. Provider setup still opens preserved setup controls, and automatic qualification renewal is unfinished.

## Verification

Backend: 345 KOIN tests passed with `node --test --test-concurrency=2 scripts/probe-koin-*.js`, including real loopback HTTP signup, verified free account, signed stream and cancellation. Desktop targeted tests cover encrypted recovery, wallet-free activation, old-address refusal, session/privacy revocation and shared balances. Chromium tests cover purchase-pending chat, Free only, incremental display and interrupted prefix retention. These use local services and fixture commercial policies, not live financial operations.

The initial desktop suite had 1,233 passes, 11 failures and 66 skips. Four chat/IPC regressions were fixed and their 33-test group passes. Five failures were the absent default browser path and pass with `/usr/bin/chromium`; two require missing Smart-Turn model assets. A full rerun with Chromium completed the Earn/Node browser assertions but retained Ethereum RPC retry handles; its process was terminated after 229 seconds so remaining tests could report. This is a failed full-suite validation, not a pass. `npm run live-senses:prepare` failed with `Could not prepare KAI Live Senses: fetch failed`. Final Chromium-enabled totals: 1,307 passed, 3 failed, 5 skipped (1,315 tests). Failures are the terminated Earn browser process and the two missing Smart-Turn asset checks. Targeted activation/privacy/migration tests also pass (5/5). `npm audit --audit-level=high` reports zero high/critical vulnerabilities (11 moderate). Backend declares Node 22; this executor runs Node 24.19.0. Windows release CI and packaged acceptance have not run.

GitHub connector repository access succeeds, although CLI `gh` authentication is invalid. No release was requested because the implementation and validation are incomplete. Implementation branches are pushed separately from `test` and production.

## Remaining implementation and release gates

- Separate PNG mockups remain unavailable. The approved interactive prototype has now been inspected and its seven layouts implemented; further Windows acceptance remains pending.
- Complete automatic customer/provider activation and purchase UI, including existing account migration and multiple linked-wallet handling. Earlier KOIN recovery must remain accessible without presenting it as USD credits.
- Independent review and live acceptance of capped sponsored usage settlement and provider work accounting; operator review and configuration of v4 pricing, USDT/USD feed and the explicit parity attestation. The archive adapter and exact USD pack conversion are implemented, but have not been accepted against live archive providers.
- Guided provider setup, qualification proof renewal and recovery. The existing live qualification expired October 16; this code does not renew it.
- Research/Agents/Teams integration and run budgets. These are not enabled by the streaming Chat changes.
- Complete browser/Windows integration, release CI and artifact verification, real two-computer earning acceptance and delayed payout observation.

## Decisions and operator handoffs

USD model tariffs, the daily free USD budget comparable to historical 25,000 AI tokens/day, and Master allocation remain unchosen. Three closed reward days versus seven telemetry days remains unresolved. No sample figure has become an entitlement.

Fresh contract deployment, credentials, seed/funding, transfers and live financial operations require a separate authorized operator handoff. Production services, the old 0.1 KOIN obligation, old signed journals, and unresolved reward epoch 20742 remain untouched. Source/test-build authorization does not authorize these operations.

## Prototype-backed UI validation continuation

Backend overview/readiness checks pass, and the full backend suite is now 345/345. Targeted browser checks cover first-use Back, free entry, shared balances, purchase-pending usage, unavailable quotes, edited in-flight quotes, repeat approval/cancel, incremental replies and interruptions, older KOIN recovery, provider expiry, stale network, Back to Earn and mobile Buy credits. Agents and Brain/Workflows/Compare regression browsers pass after adapting navigation to More. All these are local or fixture tests, not two-computer or payout acceptance.

Seven implementation screenshots are in `/workspace/kai-revision2-assets/implemented-*.png`; the source prototype and rendered reference screenshots are in that same executor directory. Paths are not a guarantee of cross-executor availability. No new entitlement, live quote, qualification, payout, deployment or production mutation is implied by a screenshot.

Full prototype-backed regression run: 1,301 passed, 11 failed, 5 skipped (1,317 tests); outdated layout/navigation assertions were corrected. The Earn child retained remote DNS requests after its assertions completed and was terminated, so this is not a passing full run. An offline-DNS run (external DNS fails immediately, loopback fixtures preserved) completed naturally with 1,308 passed, 5 failed, 5 skipped (1,318 tests). Three remaining sidebar/onboarding assertions were corrected and their targeted browser group now passes 3/3. Two failures require the unavailable pinned Smart-Turn model. A final offline rerun is pending. The price cache now aborts owned background discovery on shutdown; this does not implement the purchase oracle or eliminate all external DNS behavior elsewhere.

Draft PR: https://github.com/therexdev/kaiapp/pull/11. CI run for source f02540b64f6ec72ebe8375c63b851ecc5fd9ddda: https://github.com/therexdev/kaiapp/actions/runs/39101783310 (in progress at checkpoint). No Windows release or test-channel publication.

## Public purchase and v4 continuation

Desktop source `d661671d3bdc75aac0ccf7bd605c3e7184a6657c` passed CI: https://github.com/therexdev/kaiapp/actions/runs/39101944191 (1,318 tests: 1,316 pass, zero failures, two skips). Artifact `companion-visual-checks`, ID 12127126541, SHA-256 `81ce3625819c2ef55288cad27b5088d6ef0607cec90a98fdd46d2353687c6870`. Installer jobs were skipped: this is not a Windows release. The corresponding final local offline run had 1,311 pass, two missing Smart-Turn asset failures and five skips.

Backend v4 source `b71ed2a647a58e5fed1e5cebb7e0d7006b530cd2` passed all 357 KOIN tests. The subsequent USD-pack endpoint/conversion changes passed the full 359-test backend suite, plus public HTTP walletless rejection checks. Operator trust boundaries and unchosen pricing policy are documented in backend `V4_PURCHASE_PRICING.md`.

Public purchase continuation adds single-use signed quote caching, exact ceiling conversion, preserved older signing leases, native payment review, saved-transaction retry, read-only confirmation and a cross-journal unresolved-transaction guard. The new purchase and account tests pass 17/17; existing payment/browser regressions pass 25/25. A new full desktop offline run is in progress at this checkpoint. These changes are newer than the successful CI commit above. No Windows publication or production changes have occurred.

## Capped sponsorship continuation

Public purchase commit `b1be208338b8838ec2c7f7e4b38843955d5f45c3` passed CI run 525: https://github.com/therexdev/kaiapp/actions/runs/39103333837. Its visual artifact is 12126924631, SHA-256 `50ca925e9f7761dc1d1e7ecce84e8cfea6099748801881af72d947f971abc971`. All installer/provenance jobs were skipped, so no Windows release exists. The local full run finished with 1,319 passes, two missing Smart-Turn asset failures and five skips (1,326 total).

The subsequent sponsor implementation records free and purchased portions independently in one USD usage receipt, enforces explicit account/day and network/day contract ceilings, and permits finalized sponsored work to share the existing fixed reward pool. New free admission requires fresh verified ceilings and positive uncommitted reward funding; existing credits remain usable during a sponsorship outage. Old KOIN data and old signed payment hashes remain unchanged, including across ABI expansion. Zero ceilings disable sponsorship. No budget is invented.

Local checks: 375 backend/cutover tests, 38 AssemblyScript contract tests and 12 built-WASM entry-point tests pass. Built prepaid USD WASM SHA-256: `e87d504fa312b8a5c6d3a45f31d191cbc2577d3fa91c6d5750d0f2a80c7ea24d`. No contracts were deployed or funded. Independent purchase/sponsor/payout review, farming scenarios, provider quality/renewal, advanced modes, commercial decisions and real acceptance are still release gates. Earlier mixed free/paid records already settled under the intermediate paid-only implementation require explicit recovery; they are not silently rewritten or counted as fully settled sponsorship.

## Guided provider and qualification continuation

Capped sponsor desktop source `3e6626dab607c1cec457300a8ce52088945aadc7` passed CI run 526: https://github.com/therexdev/kaiapp/actions/runs/39104120612. This remains a source validation, not Windows test publication.

The next continuation adds public-account provider setup independent of older invitation controls: memory/model checks, explicit approved-model download, cancel, saved On/Off, restart/reconnect and a deployment-pinned worker. Qualification checks use local managed inference with signed results, without customer charges or work-reward receipts. Failed/expired qualification never becomes ONLINE just because the worker connects. Backend renewal needs explicit reviewed benchmark criteria; none are invented or installed. The earlier 7/10 evaluation artifact and approved quality/latency bar remain missing.

Local provider controller/worker checks pass 11/11, the prototype-backed Chromium journey passes (free entry, quote cancellation, stale network, Back to Earn and sharing), and backend checks pass 368/368. A wider desktop regression run is in progress. These tests use fixtures and local HTTP, not real benchmark acceptance, live payments or a Windows installer. Multiple linked-wallet handling and Research/Agents/Teams total run budgets remain implementation work; commercial decisions, independent financial review and real earning acceptance remain release gates.

Guided-provider source is remote-verified at `a494fec40746123bef626b568724497e3e3eeaf0`; corresponding backend source is `e98c8333e9575f3acf830fb1c8c97d339f808081`. App CI run 527 is https://github.com/therexdev/kaiapp/actions/runs/39105149119 (in progress at this checkpoint). The full local desktop regression completed naturally: 1,331 tests, 1,324 pass, two missing pinned Smart-Turn asset failures, five skips. No Windows installer was published.

Multiple-wallet continuation selects only this device's loaded wallet when several wallets are linked. Requests explicitly bind that selection, and the server checks account membership; no first-wallet guess, combining or transfer occurs. A device with no selected linked wallet retains account-level free usage. Selection changes invalidate pending authorization. Earlier account-bound replies remain recoverable without debiting the newly selected wallet. Targeted desktop tests pass 23/23 and the backend plus cutover suite passes 380/380, including actual HTTP account selection, unchanged free allowance and separate purchased balances. Research/Agents/Teams billing remains unfinished.
