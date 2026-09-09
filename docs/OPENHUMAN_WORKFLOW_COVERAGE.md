# OpenHuman workflows → KAI coverage

Reviewed September 9, 2026 against OpenHuman commit `9404515cb21dbd645442e7be928b13f8aa405b0c` and its tinyflows reference commit `99f275351d4cae7445ceca08a2e266086fcb64e5`, plus the owner's six workflow/sidebar screenshots. The runtime and UI here are original KAI code. OpenHuman GPL source, branding and assets are not vendored into KAI.

The [OpenHuman workflow specification](https://github.com/tinyhumansai/openhuman/blob/9404515cb21dbd645442e7be928b13f8aa405b0c/gitbooks/features/workflows.md), actual canvas and embedded tinyflows implementation were compared separately from historical integration plans. A planned feature is not treated as evidence of a shipped upstream capability. See the [reference repository at the reviewed commit](https://github.com/tinyhumansai/openhuman/tree/9404515cb21dbd645442e7be928b13f8aa405b0c) and [tinyflows](https://github.com/tinyhumansai/tinyflows/tree/99f275351d4cae7445ceca08a2e266086fcb64e5).

## Feature comparison

| Reference concept | KAI implementation | Adaptation / limit |
| --- | --- | --- |
| Workflow library | Search, create, edit, duplicate, enable/disable, delete, import/export and last-run state | Definitions stay in the encrypted shared desktop profile |
| Visual flow builder | Draggable nodes, output/input ports, SVG edges, inspector, palette search, zoom/pan/Fit, auto layout, undo/redo, keyboard controls | Native KAI renderer; no bundled upstream canvas dependency |
| Copilot / manual modes | Local natural-language graph proposal, validation, explicit Apply, manual node editing | Local models only; proposal quality depends on model |
| Discoveries | Context-based suggestions, Build this, Dismiss, optional daily discovery | Explicit note/goal inclusion; never silently activates an automation |
| Starter templates | Briefing, goal review, digest to app, source-to-Brain, event triage, API parsing, agent answer, research brief, bounded loop | Choose actual accounts, local models and action inputs before enabling |
| Manual / cron | Text/JSON run input, required typed fields, recurring and one-time schedules, IANA zones | Desktop must be running; missed schedules coalesce |
| App event | Composio event type discovery, account-scoped upsert, signed server ingress, encrypted owner queue, desktop receipt/dispatch | Updated HTTPS KAI server and account sign-in required; preserve existing project webhook destinations |
| Change-based automation | Selected app-read and Brain-source watches | Polling baseline suppresses a spurious first run |
| Raw generic webhook | Not exposed | Reviewed upstream implementation also left its generic listener unwired; do not confuse this with real Composio delivery |
| Trigger + 14 action/logic kinds | Agent, App action, HTTP, Code, Sub-workflow, Memory, Condition, Switch, Merge, Split out, Transform, Output parser, Deduplicate, Loop | KAI additionally exposes Approval and Result nodes |
| Agent roles and tools | Local role/instructions, selected read tools, bounded multi-turn loop | System/shell/desktop-control tools are not granted through workflows; writes use reviewed nodes |
| Isolated expressions and code | Typed mappings and JSON-only JavaScript in QuickJS WASM | Python is not supported; no host I/O, shell, modules or network in scripts |
| Per-item execution | App/HTTP/agent/memory/sub-workflow nodes may execute once or for every item | Each changed item has its own approval and checkpoint |
| Branches and joins | Item routing, bounded parallel fan-out, merge barrier, append/position/key joins | Merge waits for untaken branches to be marked skipped |
| Bounded loops | Body-return path, conditions, iteration ceiling, Done exit | Limits prevent unbounded recursion/work |
| Nested flows | Saved definition snapshots, nested frames, child-model selection and nested pause/resume | Four levels; recursive workflow references rejected |
| Errors and retries | Stop, Continue or Error output; read/compute retries; detailed failure logs | No automatic write retry or compensating rollback |
| Memory operations | Search/recall/people/goals, reviewed remember/forget | KAI Brain replaces upstream memory-service scope/schema |
| Deduplication | Per-run or persisted per-workflow keys, event delivery IDs, overlap locks | Keys are recorded at Deduplicate; downstream failures do not roll them back |
| Run observability | Inputs/outputs, node/item timings, attempts, failure detail, cancel/reject/resume and canvas snapshot | No provider billing ledger or full token stream playback |
| Preview | Simulated capability outputs through the real graph with no app/Brain mutations | Configure representative sample data; does not test live provider authorization |
| Portability | KAI JSON and recognition of documented OpenHuman node/edge envelope | Imported references/config differences require manual review; not lossless interoperability |
| Tasks consolidation | Durable idempotent scheduled-prompt migration and removal of desktop Toolkit Tasks entry | Brain to-dos and headless Core compatibility remain |

## Validation and remaining work

The graph tests exercise real branch/merge execution, concurrent agents, repeated loop items, nested review after reload, per-item writes without replay, changed-connection approval invalidation, retry/error routing, persistent dedup, parsing, WASM isolation, time zones, invalid graphs, migration, source-change baseline, side-effect-free preview and daily discovery. Event tests cover account scope, preserved webhook destinations, durable queue receipts and secret separation. Server probes drive signed raw HTTP delivery and authenticated polling with synthetic provider data. Browser CI creates, connects, edits, saves and runs a graph through private IPC and captures layouts at 1280, 960 and 720 pixels. Packaging checks load the shipped WASM evaluator and scheduler dependencies.

A real provider OAuth/event round trip needs the owner's deployed server/project and connected account. Automated tests do not assert that a live Gmail/Slack/etc. authorization has completed. Other future work includes richer provider-specific idempotency receipts, notification badges/quiet hours, lossless cross-product import, optional additional code languages with equivalent isolation, and a broader general-agent orchestration system. These are separate from the implemented workflow graph engine.

Composio transport follows its primary [trigger API](https://docs.composio.dev/reference/api-reference/triggers), [webhook subscriptions](https://docs.composio.dev/reference/api-reference/webhook-subscriptions/getWebhookSubscriptions) and [event delivery verification](https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events). See [KAI Workflows](KAI_WORKFLOWS.md) for user-facing setup and behavior.
