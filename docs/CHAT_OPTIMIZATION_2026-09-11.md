# Chat routing and efficiency review — 2026-09-11

Scope: main Chat, desktop KAI, their tool planners, private provider enrichment, local memory, connected-session lifecycle, cancellation and latency reporting. Baseline: Test commit `4d99fb3a4735da02bad7ed6eeff7a99994da9221`.

## What the report establishes

The screenshot's six executed calls were `memory_search`, `memory_save`, `memory_search`, `web_search`, `read_page`, `memory_search`. “16 of 50 tools” described the planner's offered catalog subset, not 50 services executing. Nevertheless, the six calls were unnecessary for the personal-memory question, and public namesakes cannot verify a user's family relationship.

`worker:job-done` originates in `core/lib/worker.js` after submitting a network earning result. It is independent of the conversational tool trace. Its timestamps alone cannot attribute chat or audio slowdown to GPU contention.

## Findings and changes

| Finding | Change |
| --- | --- |
| Main Chat entered the 24-step agent loop merely because the desktop bridge existed. | Shared local intent routing; personal recall and ordinary conversation bypass discovery/planning entirely. |
| Globe-on browser Chat searched for every message. | Ordinary conversation and personal recall do not search; current-information/lookup requests can use the web when enabled, subject to Core privacy. Explicit Research mode remains research; a disabled globe still disables automatic web lookup in main Chat. |
| Main and mascot used different task selection. | Shared routing/filtering, with contextual follow-ups, private connected tasks, app reads, desktop control and an explicit Agent escape hatch in main Chat. |
| Memory saving was offered when the user only asked to recall. | Hide save tools outside explicit remember requests; server-side approval for model-proposed legacy saves. |
| Every planner completion searched Brain and discarded the result. Main separately searched legacy memory. | Planning checks current private-model eligibility without retrieving Brain; final enrichment reads each applicable local store once. No cross-turn eligibility cache. |
| “daughters” did not match “daughter”. Legacy retrieval rebuilt document frequencies for every query. | Conservative family-term normalization and a cached lexical index invalidated on add/remove/clear. |
| Merely loading the tool catalog created an encrypted conversation session and a 900ms timer. | Begin a session on the first conversation action; poll only during in-flight connected work with a result panel. Continue background receipt polling only for running/waiting actions. Remove completed-turn cancellation listeners. |
| Main planner retried malformed output up to 24 times and allowed repeated discovery. | Two consecutive malformed outputs or failures stop the loop. Ordinary tool tasks have six planning passes, web five, memory writes two, connected/workflow tasks eighteen. Desktop observation tasks retain twenty-four. Argument keys are normalized for duplicate detection. |
| Long observations could hide the latest schema or returned action ID. | Bounded newest-first allocation; serialized object results instead of `[object Object]`. Latest partial/write status survives older research text. |
| Partial-sheet failure could produce the false statement “nothing was created or changed”. | Final response uses actual observations and distinguishes partial/unverified completion. |
| Main Chat started its latency clock only after planning and memory. Stop could be swallowed during research. | Start timing before preparation; propagate cancellation through research/recall and do not begin final inference after Stop. |

## Regression evidence

`core/test/chat-routing.test.js` runs the real main `send()` function, SSE parser, companion client and provider transport against an in-memory DOM/provider fixture, with desktop connection present and globe on. For the reported question it asserts:

- One final model completion, zero planning completions.
- One legacy-memory HTTP read and one private Brain-context IPC read.
- Zero tool-catalog requests, tool calls, web requests, memory writes or connected sessions.
- Remembered context reaches the final model request, private routing stays enabled, and the turn finishes normally.

These are measured request counts in a deterministic fixture, not a Windows Llama performance benchmark and not a claim about actual model accuracy or tokens/second. Further cases cover personal recall with missing information guidance, possessives, ordinary conversation, current information, account tasks, desktop tasks, follow-ups, failure limits, cancellation, lazy sessions and bounded observations. Existing tests retain the eight-action connected chain, fresh read-after-write, approvals, uncertain-write deduplication and screen-data isolation.

The initial full local run passed 811 tests; five browser tests could not start because this workspace lacks Chromium, and 49 platform/browser tests were skipped. New regression tests are run separately before the final suite and release CI. The Test release workflow installs Chromium and checks packaged Windows helpers/shared-profile behavior; a pushed commit is not proof of a released installer.

## Remaining performance and correctness checks

- Measure cold and warm time-to-first-reply on the user's actual Windows hardware and selected model, with earning on/off and voice on/off. No hardware-independent speed promise is justified.
- Foreground chat and earning can use the same runtime. Review queue admission/priorities using actual contention traces before changing earning behavior or cancelling accepted network jobs. This patch does not disable earning, alter the wallet/profile/node, or change scheduler services.
- Routing is a bounded deterministic intent policy, not a universal language-understanding replacement. Unusual phrasing, mixed requests, attachments and non-English action requests need a broader evaluation set. Main Chat's explicit Agent/Research modes remain available for deliberate multi-step tasks.
- Structured business lookup, provider schemas and spreadsheet write/read-back quality still require live connector acceptance testing. Keeping a long action budget does not prove a task completed.
- Existing minimize and voice-buffering behavior is preserved; audio underruns and CPU scheduling need packaged Windows playback traces. This revision does not replace a voice engine or add a CLI/browser automation dependency.
