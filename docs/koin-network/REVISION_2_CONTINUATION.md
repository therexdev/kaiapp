# Revision 2 implementation continuation — 2026-10-18

Status: blocked, partial preparation only. No Windows test update published.

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

## Completed source changes

- Desktop purchase-validation copy removes the false fixed KOIN-to-credit example.
- Backend runtime no longer selects the superseded two-ticker USD purchase oracle. A purchase-only guard reports unavailable; explicit fixture pricing is confined to isolated rehearsal. The exact approved v4 market is pinned in source. This is a guard, not an implemented exchange adapter.
- Existing balances, custody journals, contracts, qualifications and production services were not modified.

## Verification and limitations

Local verification: all 328 backend KOIN regression tests passed (including the new purchase-price guard); 10 targeted desktop prepaid-chat, prepaid-purchase and provider-status tests passed. Backend command: `node --test --test-concurrency=2 scripts/probe-koin*.js`. Syntax and diff-whitespace checks passed. Tests used Node 24.19.0; backend requests Node 22.x, so this is not the release-CI environment. Desktop tests resolved koilib using the backend dependency directory. No browser, installed Windows, real two-computer, delayed payout or full-suite acceptance is claimed.

`gh auth status` reports the provided GH_TOKEN invalid. CI/release API verification is pending authenticated access. Git fetch/read access succeeded independently. No release was requested because the product is incomplete.

## Remaining implementation

All seven screens and their interaction checks; verified-account bootstrap without a payment wallet; durable daily free grants and sponsorship; atomic free-first/paid metering with Free only; account migration/activation preserving legacy units and signed journals; authenticated real streaming, Stop and partial-answer restart recovery; guided provider setup and automatic qualification renewal; stale network states and Back to Earn; Research/Agents/Teams metering and run budgets; the actual v4 oracle and exact USD-pack purchase protocol; whole-app regression, browser/Windows build verification and publication.

The current source still buffers prepaid answers, ties prepaid auth to one wallet and contains purchased/spent-only accounting. This branch must not be presented as the completed redesign.

## Decisions and operator handoffs

No commercial policy was invented: USD model tariffs, a free budget comparable to the historical 25,000 AI tokens/day, and Master allocation remain unchosen. Three closed reward days versus seven telemetry days remains unresolved. Qualification evidence expired October 16; tests do not renew live eligibility. Old reward epoch 20742 and the 0.1 KOIN obligation remain untouched.

Fresh contract deployment, credentials, seed/funding, transfers and live financial operations require a separate authorized operator handoff. Source/test-build authorization does not authorize these actions.
