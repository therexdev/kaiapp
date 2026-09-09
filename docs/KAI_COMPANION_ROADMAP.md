# KAI companion: OpenHuman review and implementation roadmap

Reviewed September 9, 2026. KAI baseline: `02efdb8` on `test` (Test 0.54.2-test.44.1).
Reference snapshot: [OpenHuman `0a2aeb00`](https://github.com/tinyhumansai/openhuman/tree/0a2aeb00c8413b824e3ffdb16da6bdd83e0dda39). Also reviewed the 18 screenshots supplied with this request and [TinyHumans](https://tinyhumans.ai/).

## Product direction

KAI's primary purpose is a full AI companion: someone the user can speak to, who understands their projects and preferences, works across their tools, follows through on routines, and remains under their control. The earning node and Koinos network support that product; the companion should be useful without requiring the user to think about network infrastructure.

The strongest OpenHuman ideas to adopt are persistent user-owned context, visible reusable workflows, connections that feed both memory and action, and a clear distinction between a proposed action and a completed action. KAI already has the desktop character, voice conversations, local inference, private provider chat, app tools, MCP, scheduled prompts, documents, teams, and computer controls. The new implementation connects those capabilities with three first-class workspaces.

This is an original KAI implementation informed by product behavior and published documentation. It does not vendor OpenHuman, tinyflows, tinyagents, source code, UI assets, or branding. OpenHuman identifies its repository as GPL-3.0; any future direct code reuse should be assessed separately before adopting it into this MIT repository.

## Implemented in this Test revision

| Area | Delivered behavior | Boundary / current limitation |
| --- | --- | --- |
| Brain workspace | Category tree, searchable notes, source labels, tags, pinned notes, editing, deletion | A navigable category tree; not an inferred entity relationship graph |
| Persistent context | Encrypted desktop Brain store; relevant notes and active goals augment final chat and companion replies | Local models and configured private desktop providers only; no automatic Brain recall into worker models |
| Goals | Goal title, details, active/paused/done states, normal/high priority | Does not yet have per-thread task dependency boards or automatic progress scoring |
| Sources | Explicit file import and selected GET operations from saved API connections | TXT/MD/CSV/JSON up to 200 KB per import/response; pagination is configured manually |
| Ingestion | Bounded chunks, source identity, content-hash deduplication, replacement on change, source removal deletes indexed chunks | Deterministic text retrieval; no embeddings, LLM compression, or summary-tree sealing |
| Sync | Manual sync, opt-in 20-minute refresh, timestamps, error state, recent history | Desktop must be open; connection must allow background reads |
| User ownership | Native Markdown Brain export and import of existing KAI remembered facts | Export is a plaintext snapshot; not a live Obsidian vault or bidirectional sync |
| Workflow builder | Ordered visual step editor, reorder/remove, templates, local-model draft generation | Sequential flow with conditional stopping; not a freeform node-and-edge canvas |
| Workflow steps | Brain search, local reasoning, API operation, text condition, approval, save memory, output | No arbitrary code nodes, loops, parallel fan-out, subflows, or external agent execution |
| Triggers | Manual input, hourly, every six hours, daily, weekly | Local computer time; no webhook listener or integration event stream yet |
| Durable runs | Saved workflow snapshot, input/output, per-step checkpoints, run history, cancel, paused approval and resume | Uncertain interrupted actions cannot auto-replay; inspect destination then start a new run |
| Workflow suggestions | Ask KAI in agent mode to propose a disabled draft; describe a routine in the builder | User reviews and saves before running; draft tools cannot enable schedules |
| Connections | Searchable Composio catalog, bundled platform logos, hosted sign-in, personal/server-managed keys, multiple accounts, selected actions, typed Brain collection, and custom APIs | Server service requires admin activation; real provider authorization requires a project key |
| API capabilities | Bearer/header/no-auth, fixed operations, path placeholders, JSON request bodies, test results, edit/remove | HTTPS remote API; HTTP only for localhost; redirects refused; response caps |
| Connection permissions | Enable/disable, expose to KAI, allow background GET, native one-time approvals for model calls/writes | GET background permission is a user grant; only configure actual read operations as GET |
| Private agent tools | Brain search, goals, approved remembering, workflow draft proposal, configured API calls in agent chat and desktop KAI | After private observations, the planner cannot pass data to ordinary Core/web/MCP tools in the same turn |
| Existing integrations | Direct links to provider settings, local models, MCP/email/calendar tools, legacy scheduled prompts | Existing systems retained; their credentials and permissions are not migrated |
| Release safety | Same Test channel, shared profile/lock/node, per-version profile backup, no new runtime dependency | Installs to Test; no live-branch promotion in this change |

## Full feature inventory and fit for KAI

The reference capabilities below are documented by OpenHuman, not independently verified end-to-end against a connected OpenHuman account. Several supplied screenshots show empty or loading states and a connections timeout. Those images inform navigation and intent, not proof of working service connections.

### Brain and personal context

Reference: [memory architecture](https://github.com/tinyhumansai/openhuman/blob/0a2aeb00c8413b824e3ffdb16da6bdd83e0dda39/gitbooks/features/obsidian-wiki/memory-tree.md), [source registry](https://github.com/tinyhumansai/openhuman/blob/0a2aeb00c8413b824e3ffdb16da6bdd83e0dda39/gitbooks/features/obsidian-wiki/sources.md), [auto-fetch](https://github.com/tinyhumansai/openhuman/blob/0a2aeb00c8413b824e3ffdb16da6bdd83e0dda39/gitbooks/features/obsidian-wiki/auto-fetch.md).

| Capability to adopt | KAI value | Status / next work |
| --- | --- | --- |
| Local persistent memory | Continuity across conversations and restarts | First version implemented |
| Source/topic/global memory trees | Answer what happened, who matters, and why a fact is known | Next: source/topic summaries backed by exact chunks, with explicit drill-down |
| People/project entities and relationships | Understand Mike's parallel projects without blending them | Next: editable entity records and evidence-backed relationships |
| Memory scoring and relevance | Keep useful context in a small model's context window | Current lexical overlap/pins; next: recency, relevance, confidence and decay |
| Local semantic retrieval | Find meaning even when wording differs | Next: opt-in local embeddings and evaluation against exact keyword retrieval |
| Summary compression | Fit larger project histories into local models | Next: local bounded summarization with provenance and reversible source links |
| Inspect/edit/delete/forget | User can correct KAI instead of arguing with hidden memory | Notes and source deletion implemented; next: topic-wide forgetting and derived-summary invalidation |
| Source scoping | Separate clients, personal life, projects and tools | Next: project collections and per-conversation scopes, defaulting to narrow context |
| Connected source refresh | Companion can know what changed since yesterday | First version implemented; next: cursor-based incremental sync and rate-limit-aware retry |
| Coding-session import | Retain development decisions and failed attempts | Future: explicit selected session imports; no automatic scan of coding-agent histories |
| Folder/document ingestion | Make existing documents useful to the companion | Text import now; next: user-picked folders, DOCX/PDF parsing and bounded file watchers |
| Wiki/Obsidian export | Human-readable, portable personal knowledge | Markdown snapshot now; next: optional vault with conflict-aware edits and source links |
| Memory diff and sync inspection | See exactly what KAI learned or replaced | Sync history now; next: additions/removals preview and rollback for derived material |
| Background reflection | Suggest useful connections, stale goals and next steps | Next: opt-in idle local reflection that produces proposals, never unreviewed external actions |
| Context-budget control | Long-term memory should not break small local models | Bounded current recall; next: model-aware budget allocation and retrieval diagnostics |

### Goals, follow-through, and orchestration

Reference: [goals and todos](https://github.com/tinyhumansai/openhuman/blob/0a2aeb00c8413b824e3ffdb16da6bdd83e0dda39/gitbooks/features/goals-and-todos.md), [orchestration](https://github.com/tinyhumansai/openhuman/blob/0a2aeb00c8413b824e3ffdb16da6bdd83e0dda39/gitbooks/features/orchestration.md).

| Capability to adopt | KAI value | Status / next work |
| --- | --- | --- |
| Long-term goals and priorities | Keep KAI's suggestions aligned with what matters | Implemented basic goals and reply context |
| Conversation-specific goals/todos | Track unresolved work in each discussion | Next: persistent task cards linked to chat IDs and project scopes |
| Task board and milestones | Make work visible outside the transcript | Next: compact actionable board with owners, dependencies, due dates and evidence |
| Fast triage plus deeper reasoning | Respond naturally while difficult work continues | Existing voice/chat responsiveness; next: explicit foreground/background job states |
| Specialist agents and delegation | Research, writing, coding and checking can cooperate | Existing developer teams; next: companion-accessible task delegation with project scope and budgets |
| Durable agent checkpoints | Resume long work without rebuilding all context | Workflow checkpoints now; next: checkpoint general agent plans and observations |
| Stuck-agent recovery | Explain blockers and offer a concrete next step | Current bounded loops; next: root-cause records and controlled retries without replaying writes |
| Per-run observability | Show what KAI actually did and what it cost | Workflow step outputs now; next: token/time/cost ledger, tool receipts and replay inspection |
| Agent-to-agent communication | Coordinate local/owned agents across devices | Later: authenticated scoped sessions; separate personal data from public compute tasks |
| Workload-aware model routing | Use fast local models for simple work and stronger private models when wanted | Existing model choice; later: user-owned routing rules, per-task caps, no silent network disclosure |

### Workflows and automation

Reference: [workflow specification](https://github.com/tinyhumansai/openhuman/blob/0a2aeb00c8413b824e3ffdb16da6bdd83e0dda39/gitbooks/features/workflows.md).

| Capability to adopt | KAI value | Status / next work |
| --- | --- | --- |
| Natural-language workflow creation | User describes the job instead of programming it | Local draft generator and KAI draft tool implemented |
| Review before enable | A suggestion never becomes an active automation by itself | Implemented |
| Visual ordered steps | Make inputs, actions and outputs understandable | Implemented ordered builder and run inspector |
| Schedule/manual triggers | Morning briefs, project checks, recurring digests | Implemented common intervals |
| Webhook and integration event triggers | React to real changes instead of polling everything | Next: outbound event subscriptions or explicitly configured local ingress with authentication |
| Branch/switch/transform/parser nodes | Handle realistic conditional work and structured data | Text-match stop now; next: typed branches and deterministic safe transforms |
| Loops and parallel branches | Process lists and divide larger jobs | Later: bounded iteration, concurrency limits, join semantics, per-run spending caps |
| Nested workflows | Reuse a trusted step sequence | Later, after workflow schema versioning and permission inheritance are established |
| Sandbox code nodes | Allow advanced deterministic processing | Later: reuse established sandbox; no host-shell execution in companion workflows |
| Approvals and resumable pauses | Keep the user in charge of meaningful changes | Implemented persisted pauses with native one-time review |
| Deduplication and idempotency | Prevent duplicate messages or repeated writes | Per-workflow overlap lock now; next: provider-specific idempotency keys and event deduplication |
| Discovery and reusable library | Suggest repeated work worth automating | Starter templates now; next: opt-in repetition detection with disabled proposals |
| Export/import | Move routines between installations and version them | Implemented JSON; imported routines stay drafts |
| Notification center | Make waiting approvals and failures hard to miss | Run history now; next: badge/tray notices and a companion summary, with quiet hours |

### Connections, channels, and tools

Reference: [integrations](https://github.com/tinyhumansai/openhuman/blob/0a2aeb00c8413b824e3ffdb16da6bdd83e0dda39/gitbooks/features/integrations/README.md), [local/BYOK routing](https://github.com/tinyhumansai/openhuman/blob/0a2aeb00c8413b824e3ffdb16da6bdd83e0dda39/gitbooks/features/model-routing/local-and-byok-models.md), [product README](https://github.com/tinyhumansai/openhuman/blob/0a2aeb00c8413b824e3ffdb16da6bdd83e0dda39/README.md).

| Capability to adopt | KAI value | Status / next work |
| --- | --- | --- |
| Self-managed service API credentials | User owns access and service billing | Implemented direct token/API-key path and personal Composio project key |
| Searchable app catalog and guided connections | Make everyday integrations approachable | Implemented platform cards/logos, live search/categories, browser sign-in, account status and multi-account management |
| Optional server-managed Composio | Offer the same experience without a user project key | Implemented authenticated KAI server service and encrypted admin setting; off until a key is configured |
| Select actions and collect data | Control which connected information reaches Brain | Implemented action selection, typed fields, read-only source ingestion and optional recurring refresh |
| Self-managed OAuth client support | Connect services that require delegated OAuth access | Composio-hosted OAuth implemented for personal and server-managed projects; direct provider-specific PKCE remains future work |
| Google/Microsoft calendars and mail | Daily planning, correspondence, reminders | Existing email/CalDAV tools; next: richer native service adapters through the new connection framework |
| GitHub, Notion, Slack | Read project context and perform approved actions | Composio sign-in and typed action inputs now implemented, with custom REST profiles retained; next: incremental data pagination adapters |
| MCP server library | Extend KAI with existing tool ecosystems | Existing KAI MCP retained; next: bring inventory into Connections and support encrypted HTTP auth |
| Skill library | Reusable behavioral instructions for specialist tasks | Existing agent definitions retained; later: signed/versioned skill packages with inspectable permissions |
| Messaging channels | Reach KAI from Telegram, Discord or other devices | Later: explicitly paired channels and per-channel identity/scope; no default message ingestion |
| Email send/receive | Turn conversation into practical work | Existing email tools; next: drafting and thread-aware context with send approval |
| Meeting participation | Join calls, capture notes, extract decisions | Later: explicit per-meeting invitation/recording controls, transcript provenance, retention settings |
| Desktop/browser action | Turn intent into visible computer actions | Existing private task-scoped KAI computer control preserved |
| Search, scraping, research | Gather evidence for answers and workflows | Existing research tools; next: workflow-aware read-only research steps with citations |
| Image/video generation | Creative companion outputs | Existing image work where configured; later: user-key media adapters and output library |
| More LLM providers/custom endpoints | Broader model choice without managed subscriptions | OpenAI/Anthropic/local remain; next: private OpenAI-compatible endpoints, endpoint verification and provider-specific model discovery |
| Connection health, rate limits and diagnostics | Make integrations supportable without exposing secrets | Test result, last success, HTTP status, redacted response now; next: backoff, pagination and targeted setup diagnostics |

### Companion experience and Koinos fit

| Idea | Decision for KAI |
| --- | --- |
| Persistent personality and warm interaction | Keep KAI's existing identity, voice options and animation; let memory improve continuity without inventing emotions or knowledge |
| Proactive check-ins | High-value next feature, opt-in with quiet hours and specific reasons; grounded in goals and observable events |
| Personalization and themes | Retain KAI's existing visual direction; refine the new workspaces before adding a theme studio |
| Mobile companion | Later: authenticated pairing and encrypted sync; no shared keys in public API or blockchain storage |
| Private/local-only mode | Preserve existing routing controls; block new API calls in Local-Only and abort them when privacy changes |
| Wallet and network awareness | Existing wallet/node views and read tools stay intact; companion memory and workflows cannot sign or move funds |
| Managed subscription/broker | Not part of this request. Use user-managed APIs and existing KAI model/network economics |
| Referral rewards/trading actions | Low priority for the companion goal; avoid coupling the new Brain/workflows to token incentives |
| Public agent marketplace/confidential compute | Later network roadmap; not a prerequisite for useful personal companion features |

## Recommended delivery order

1. **Current Test: usable foundations.** Brain CRUD, goals, text/API sources, sync, encrypted storage, visible workflows, durable runs, connection operations, companion retrieval and private tool use.
2. **Companion quality.** Friendly connection setup forms, more service adapters, richer file support, selected project scopes, per-thread todos, notification badges, read-only background reflection, and evidence-backed summaries. Success criterion: KAI can give a reliable daily project brief and remember corrections without the user repeating context.
3. **Reliable automation.** Provider pagination/events, typed conditional branches, idempotency keys, robust retries for reads, schedule timezone choice, run budgets and richer action receipts. Success criterion: repeated workflows produce the expected result over restarts and partial service failures, without duplicate writes.
4. **Proactive companion.** User-configured check-ins, goals/milestones, specialist delegation, channel pairing and mobile companion. Success criterion: useful timely assistance without noise or unintended action.
5. **Advanced orchestration.** Bounded parallel/loop/subflow execution, private agent-to-agent coordination, workload routing and optional larger knowledge stores. Gate this on measured reliability and actual user needs.

## Implementation and verification notes

- New desktop modules: `electron/companion-store.js`, `companion-connections.js`, `companion-workflows.js`, `companion-hub.js`.
- UI: `ui/companion-hub.js`, `styles.css`, `companion-client.js`; main/mascot provider and tool integration uses the existing chat transports.
- Persisted data: encrypted `companion-hub.json` in the existing Core profile. The existing Test profile backup includes this JSON automatically. It stores notes, goals, sources, credentials, workflow definitions and run journals.
- Desktop management IPC only accepts the main app's exact trusted document/main frame. Companion read/tools IPC also accepts the exact mascot document. No public Core/worker route exposes the new capabilities.
- Source snapshots and API results are untrusted data. Private tools cannot set model routing, approval grants, scripts, arbitrary file paths or credentials.
- Workflows use an installed local model and the existing `kai_private_desktop` overflow opt-out. They never borrow private provider keys for unattended reasoning.
- Tests cover encrypted persistence/locked-store refusal, source deduplication, removal, request confinement, response limits, Local-Only refusal, approvals, revision changes, source sync, run checkpoints, restart interruption, schedule overlap, cancellation, private tool eligibility and IPC provenance.
- A browser integration test drives actual hub services through a fixture bridge: Brain creation, goals, connection creation/test, workflow run/approval, reload, and layouts at 1280/960/720 pixels. CI saves screenshots in its visual-check artifact.
- Real service credentials must still be configured and tested in the installed app. Fixture tests verify the transport and permissions; they do not certify every user's token scopes, service account, local network, or model quality.

See [KAI Companion Quick Start](KAI_COMPANION_QUICKSTART.md) for setup and concrete examples.

## Connections follow-up — September 9, 2026

The owner clarified that self-management includes using a personal Composio project key, alongside an optional server-managed project. This replaces the first release's custom API form as the default connection experience. The implementation is original KAI code against [Composio v3.1](https://docs.composio.dev/reference/api-reference/tools); OpenHuman's [Composio settings flow](https://github.com/tinyhumansai/openhuman/blob/df4aaf6610149ff0389e83fec04723ef67458994/app/src/components/settings/panels/ComposioPanel.tsx) was a behavioral reference. No GPL source was copied.

Still future work: curated per-platform collection presets, cursor-based incremental data sync, provider scope change previews, project migration tools, and connection quota controls per KAI account. Existing source imports remain bounded snapshots; catalog/action pagination is implemented separately. Server and desktop contract tests use synthetic accounts; a real OAuth/provider authorization remains to be checked after the operator supplies a project key.
