# KAI connected companion: next implementation plan

**Implementation update:** [Connected chat guide](KAI_CONNECTED_CHAT.md) records this Test revision's shared action service, conversation controls, instant chains, receipts and connector guidance, plus explicit verification limits. Live-provider acceptance gates and later continuity/proactive work remain open.

Status: proposed implementation sequence; documentation only. September 10, 2026.
Audited Test commit: `6839c1546bc99b54ab8fdf878a9bae7a22a42eab` (Test 0.54.2-test.60.1).

**Expanded release scope:** [Major connector audit and instant workflows](KAI_CONNECTOR_ACTION_AUDIT.md) adds Sheets/folders, messaging and bounded productivity profiles to this milestone. Its additional release gates are required alongside the original three journeys below.

## Product goal

Main chat and desktop KAI become the everyday entry point for Brain, connected apps, research and workflows. A user describes an outcome; KAI retrieves relevant context, finds permitted capabilities, resolves missing details, performs reviewed actions and returns verifiable results. The workspaces remain places to inspect, configure and edit that work.

The next milestone is complete only when the three owner examples below and the additional connector-audit release gates work from both typed main chat and spoken desktop KAI. Users should not need to understand Agent mode, Composio action names, JSON schemas or workflow IDs.

## What is already connected, and what is missing

This audit follows the executable paths, rather than treating the original roadmap's historical status tables as current feature claims.

| Area | Current Test behavior | Next gap to close |
| --- | --- | --- |
| Main chat | `ui/app.js` provides companion tools to the Research/Agent runtime; ordinary Chat does not run that agent phase | Automatically route actionable requests through the same private action service while preserving ordinary conversation |
| Desktop KAI | `ui/mascot.js` wraps its tool runtime with `KaiCompanionClient.toolJSON` | Share intent handling, execution records and results with main chat, so voice and text have equivalent capabilities |
| Brain | `electron/companion-hub.js` exposes `brain_search`, `brain_goals`, approved `brain_remember`; automatic recall augments final replies | Retrieve scoped context during planning, resolve preferences and references, expose source freshness and corrections |
| Connections | Enabled accounts with `allowAgent` expose selected operations, including typed Composio inputs; each model call requests native approval | Discover relevant permitted actions on demand; resolve accounts and app objects; provide readable previews and normalized receipts |
| Workflows | Chat can save a disabled draft with `workflow_propose`; run/cancel/resume exist in management IPC | Add private chat tools to find, inspect, start, monitor and cancel saved workflows; management APIs are not automatically model tools |
| Research + private context | Public tools can run before private tools. `ui/companion-client.js` blocks ordinary Core/web/MCP calls after a private tool has been used | Support mixed research and private work through isolated contexts and explicit destination-bound payloads; retain the protection until its replacement is verified |
| Reliable execution | Workflow journals/checkpoints and permission checks already exist | Durable conversation action records, provider object receipts and safe recovery across multi-service actions |

Connecting an app alone does not authorize every action. Current Composio connections start with no selected operations and agent/write/background access off. A listed toolkit also does not establish that its provider supports the required operation or token scopes. Calendar and document actions may be reachable today in Agent mode with suitable selected operations, but this audit does not certify those end-to-end experiences.

## Acceptance journeys

### 1. “Add a dentist appointment tomorrow at 8am to my Google Calendar.”

1. Resolve tomorrow from the user's configured time zone and the current date at request time. Show the full date and zone in the action preview; never silently infer Omaha as the user's time zone from a separate research request.
2. Find the connected Google account and calendar. Use an explicitly saved default; ask only if multiple accounts/calendars remain ambiguous. If disconnected or missing scopes/actions, show the exact setup step and resume the request afterward.
3. Resolve the event title, duration and optional location from the request or an approved preference. Ask for a missing duration if no default exists. Do not invent a dentist identity or appointment booking with the practice.
4. Preview the exact event and destination for native approval. A calendar entry does not book a visit with the dentist.
5. Create once, capture the provider event ID, verify the returned event or read it back, and return its link plus date/time. A timeout after submission is an uncertain outcome, never permission to create another event automatically.

Also test follow-up edits (“move that to 9”), cancellation/deletion with review, DST ambiguity, multiple calendars, revoked access and Stop while awaiting approval.

### 2. “Run my morning briefing workflow.”

1. Find saved workflows by name, description and aliases within the user's scope. Resolve duplicate names visibly; inspect the selected saved revision and required inputs.
2. Show what will run and collect missing inputs. A disabled schedule is distinct from an unavailable draft: manually running a saved workflow must not enable its schedule; an unreviewed draft must go through review first.
3. Start a durable run using the existing engine and its approval rules. Return a run card immediately, then update status and results in the originating conversation.
4. Support “how is it doing?”, “stop it”, and opening the exact run in the builder. Handle failed or uncertain steps without replaying completed writes.
5. Support “make this a workflow” using a disabled proposal, a readable graph preview and the existing builder validation. Enabling schedules remains a separately reviewed change.

### 3. “Find dentists in Omaha, NE and create a Google Doc on my Drive with their information.”

1. Research public sources for dentist/practice names, public business addresses, phone numbers, websites and services when supported by evidence. Include source links and retrieval dates; label unavailable facts instead of filling gaps. This is a factual directory, not a claim that a practice is best or accepting patients.
2. Deduplicate practices and build a readable document with citations. Agree a bounded result count through an established default or one short clarification if needed.
3. Resolve the Google account, document title and destination folder from the request or approved defaults. Preview the material and destination before external writes.
4. Execute create, insert/format and folder placement using verified available Google Docs/Drive capabilities. Persist the document ID as soon as creation succeeds. Keep provider write approvals bound to exact inputs; do not introduce a blanket permission to finish arbitrary later steps.
5. Verify the document content and destination, then return a clickable link and a concise result summary. If creation succeeds but filling or moving fails, link the partial document and offer targeted recovery; do not create a replacement silently.

Also test research after a Brain lookup, “use my usual folder”, follow-up document edits, rate limits, partial failure, cancellation, malicious instructions in retrieved pages and a disconnected Google account.

## Shared architecture

Implement one private Electron conversation action service used by both chat surfaces. Reuse the existing connection services, workflow engine, Brain services, provider transport and native approval bridge. Do not build separate executors for voice, main chat and workflows.

The action lifecycle is: intent → scoped context/capability discovery → resolve inputs → preview → native review → execute → verify → receipt. Read-only work may omit mutation stages only within existing grants. Represent clarification, denied, cancelled, failed and uncertain states explicitly.

Proposed contracts (names to finalize during implementation):

- Capability discovery returns bounded relevant tools, required inputs, account identity, required permissions and read/write classification. Search all supported catalog metadata, but execution stays limited to connected, explicitly permitted operations. Missing access opens targeted setup without exposing keys in chat.
- Workflow tools provide find, inspect, start, status, cancel and draft proposal. Starting binds a saved revision and validated inputs; status reads a specific durable run. Resuming an approval cannot grant permission through model text.
- Action records persist conversation ID, request ID, workflow/run IDs where relevant, account and connection revision, input digest, approval state, timestamps, provider IDs/links and verified/partial/uncertain outcomes. Store minimum necessary data encrypted; redact credentials and bound retention.
- Brain context includes source identity, freshness, scope and confidence limitations. Distinguish remembered preferences from current provider state; reread calendar or document state where correctness depends on it. Save durable new preferences only with review.
- Result cards show destination, action, status, output links, source citations and useful next actions. Voice reads a short result; the card retains details without repeatedly resizing KAI's status bubble. Do not say “done” when only a job or approval has started.

### Privacy and execution boundaries

Do not remove the current private-data barrier as a shortcut. Public research runs in a context containing only the user-authorized public query and public observations. Private Brain/account content remains in the desktop coordinator. If research requires disclosing private information, show the exact query/destination and require an explicit grant before using a suitably isolated private transport; never forward the private planner transcript to Core or workers. Treat returned pages/documents/tool outputs as data, never as permission or instructions.

External mutations remain per-request native approvals with exact destination and inputs. Revalidate account/project binding, connection revision, scopes, operation version, privacy mode and cancellation immediately before dispatch. Decline/Stop ends the attempt. Use provider-supported idempotency where available; otherwise reconcile by recorded provider IDs or leave an uncertain outcome for review. Do not claim a cross-service transaction or guaranteed exactly-once delivery.

Local models and attended private providers use the existing desktop routing. Unattended workflows/Awareness continue to use installed local models; no private provider key borrowing, public worker access or silent network fallback. Local-Only blocks external research and app calls. Credentials stay in their existing encrypted desktop/server stores.

## Roadmap work promoted into this milestone

| Existing roadmap concept | Contribution to connected chat | Priority |
| --- | --- | --- |
| Private agent tools and companion retrieval | Shared action routing and scoped Brain planning in both surfaces | P0 foundation |
| Native calendar/mail adapters and typed app actions | Google Calendar, Docs and Drive first; email drafting/sending and other providers follow the same contracts | P1 Google journeys |
| Workflow suggestions, durable checkpoints, stuck-agent recovery | Chat workflow control, visible progress and targeted recovery | P1 workflow journey |
| Search/research with citations | Research-to-document pipeline with isolated public research | P1 document journey |
| Per-run observability and idempotency receipts | Verifiable outputs, partial results, duplicate prevention and resumable work | P0 foundation; P1 provider validation |
| Source scoping, context budgets, conversation goals/todos | Project-aware retrieval, follow-up references and visible unresolved work | P2 continuity |
| Incremental source sync, freshness and diagnostics | Distinguish stale memory from current connected data; recover expired permissions | P2 continuity |
| Awareness, proactive check-ins and quiet hours | Offer grounded suggestions in chat; user can launch the referenced reviewed workflow | P3 proactive follow-through |
| Delegation, workload routing and per-goal budgets | Larger jobs using the same durable action and permission model | Later; not a prerequisite for the three journeys |

Semantic embeddings, rich PDF/DOCX ingestion, editable entity graphs, vault round trips, paired messaging/mobile channels and additional code languages remain valuable separate backlog items. They do not block this milestone. Existing personal Brain tasks remain useful for goals and follow-up; do not recreate the deprecated Toolkit scheduled-task system.

## Delivery sequence and gates

1. **P0 — Shared conversation actions.** Audit both runtime entry points and tool loop budgets; implement intent routing, bounded discovery, encrypted action records, context separation, approvals and result cards. Keep manual Agent/Research controls available. Gate: the same request resolves to the same permitted action from main chat and mascot, including refusal/Stop behavior and privacy regression tests.
2. **P1a — Google Calendar.** Verify actual project tool metadata/scopes; implement account/calendar/date resolution and normalized event receipts. Gate: the calendar journey succeeds on a deliberately configured test account, with no duplicate event after timeout/retry or stale approval. Clean up created test objects only with authorization.
3. **P1b — Saved workflows from chat.** Expose bounded lifecycle tools and live run cards; preserve builder revisions and approvals. Gate: manual run, missing input, duplicate name, draft review, Stop, restart and partial-failure scenarios succeed from both surfaces.
4. **P1c — Research to Google Docs/Drive.** Add isolated research, evidence assembly, typed document operations and staged recovery. Gate: the Omaha directory is factual and linked, saved to the chosen account/folder, and retries never silently recreate a partially completed document.
5. **P1d — Instant workflows and connector profiles.** Implement the [connector audit](KAI_CONNECTOR_ACTION_AUDIT.md): dependent folder/Sheet creation, messaging with recipient resolution, combined file-plus-message runs and bounded Gmail/Teams/Notion/GitHub/Todoist/OneDrive/Excel profiles. Reuse the shared action service and engine; validate all additional release gates before calling the expanded milestone complete. P1d follows P1c and precedes P2/P3.
6. **P2 — Continuity.** Add approved destination/time-zone preferences, per-conversation scope, follow-up object references and goal-linked open work. Gate: “move that”, “update the document” and “use my usual calendar” resolve accurately across conversation reloads without mixing accounts or projects.
7. **P3 — Awareness follow-through.** Surface deduplicated relevant suggestions with reasons, quiet hours, dismissal and links to evidence/runs. Gate: a suggestion can become a reviewed action without granting unattended writes or making unsupported completion claims.

P0 through P1d are the next release objective; land and verify each stage in Test, then demonstrate the original three journeys and the additional connector gates together before calling the milestone complete. P2/P3 extend the same architecture after the core journeys are dependable. Validate focused service and IPC contracts, both real UI paths and packaged Test behavior; fixture success must be reported separately from real provider-account validation. No production calendar events, documents or messages should be created merely to validate this plan.

## Source map

- [Companion roadmap](KAI_COMPANION_ROADMAP.md): original inventory and future concepts.
- [Brain coverage](OPENHUMAN_BRAIN_COVERAGE.md): current Brain/Awareness scope and remaining gaps.
- [Workflow coverage](OPENHUMAN_WORKFLOW_COVERAGE.md) and [workflow guide](KAI_WORKFLOWS.md): engine, builder and Tasks migration.
- `electron/companion-hub.js`: private model tools versus management IPC.
- `ui/companion-client.js`: final-reply recall, tool composition and private-observation barrier.
- `ui/app.js`, `ui/mascot.js`, `ui/mascot-tools.js`: different current chat entry paths.
- `electron/companion-composio.js`, `electron/companion-connections.js`: account permissions and prepared actions.

This plan consolidates already researched OpenHuman concepts into KAI's own architecture. It does not assert new upstream feature parity or represent the proposed chat capabilities as already implemented.
