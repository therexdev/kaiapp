# OpenHuman concepts in KAI: detailed coverage

Reviewed September 9, 2026, against the supplied Brain/Connections screenshots, the current public OpenHuman source, and its historical Subconscious documentation. This is an original implementation in KAI. No GPL OpenHuman code or UI assets were copied. The public Composio catalog metadata is separately MIT licensed and includes its notice.

## Connections

Both KAI-managed and personal Composio now browse the **same 1,516-toolkit catalog snapshot**, regardless of key readiness, account sign-in or the first upstream page. It contains all integrations in the user's supplied OAuth list. The catalog has eight stable categories, search across the whole snapshot, connection-type filters, 72-card paging, deduplicated slugs and compact named logo cards. Metadata comes from [Composio's public toolkit catalog](https://github.com/ComposioHQ/composio/blob/next/docs/public/data/toolkits.json); regenerate with `node scripts/build-connection-catalog.js /path/to/toolkits.json`.

The snapshot contains 206 toolkits advertising OAuth2. **1,516 is the total toolkit count, not a promise of 1,516 one-click OAuth connections.** Some toolkits require API credentials, custom OAuth configuration, service-account setup, or no account. Authentication and available actions are checked by the selected project at connection time. The same catalog does not transfer connected accounts or auth configs between projects. [Composio toolkit API](https://docs.composio.dev/reference/api-reference/toolkits/getToolkits), [managed authentication](https://github.com/ComposioHQ/composio/blob/next/docs/content/toolkits/managed-auth.mdx).

KAI retains hosted connection links, per-account action selection, typed collection forms, separate conversation/background permissions, pinned verified reads, reviewed writes, and encrypted personal keys. Managed requests use the server's key and the signed-in KAI user's identity. **No new server environment variable or deployment is required for this catalog/UI revision.** Existing managed hosting uses `COMPOSIO_API_KEY` and `KAI_COMPOSIO_ENABLED=true`; the service must be restarted after environment changes. The desktop also needs KAI account sign-in and an online privacy mode.

## Brain concepts and implementation

| OpenHuman concept | KAI implementation in this revision | Remaining difference |
| --- | --- | --- |
| Canonical ingestion and provenance | Files, selected chats, folders, API reads and public web/feed/GitHub sources become bounded text sections with source IDs, hashes and dates | No binary PDF/DOCX/OCR ingestion or automatic import of external coding-agent histories |
| Chunking and deduplication | Stable section IDs, content hashes, unchanged-section preservation, replacement on source refresh | Character chunks rather than semantic boundaries; bounded source snapshots rather than unlimited append-only ingestion |
| Source/topic/global memory | Source and topic index, source excerpt summaries, optional local-model global summaries, original-text drill-down | No recursively sealed multi-level summary tree or separate vector store |
| Scoring and retrieval | Word/tag matching, pins, recency/importance hints, source/topic/time filters | No semantic embeddings or model-calibrated importance/confidence |
| Knowledge graph | Interactive source-to-topic graph, with every topic backed by indexed sections | No extracted person/entity relationship ontology or graph editing |
| Goals and personal tasks | Active/paused/done goals, priorities; task board with goal links, dates and status | No per-conversation budgeted goal graph or automatic goal completion |
| Memory diffs | Encrypted before/after text, bounded history, review markers and checkpoints | Checkpoints are review markers, not Git snapshots or rollback backups |
| Obsidian/wiki ownership | Fresh Markdown vault export with source/topic links and manifest | No live bidirectional vault sync or automatic reconciliation of hand edits |
| Auto-fetch | Per-source opt-in periodic reads, errors, last/next sync and unchanged-content detection | No native Composio webhook subscriptions, provider cursor ingestion or OS filesystem event listener; selected folders are polled |
| Metrics | Memory/source/topic counts, character count, last update, 28-day memory activity | No embedding/storage-tier latency dashboard |
| Forgetting | Source removal purges its indexed/derived/history data | Unrelated manual copies or workflow outputs are independent records |

## Subconscious → Awareness

OpenHuman's [historical Subconscious specification](https://github.com/tinyhumansai/openhuman/blob/78292e6dcb6738b921745bace0000c7096a1a726/gitbooks/features/subconscious.md) describes heartbeats, situation reports, user/system checks, skip/act/escalate decisions, local evaluation and morning briefings. The supplied screenshot adds Off/Simple/Aggressive and event-driven queue status. Current upstream refactoring removed that GitBook page; [the remaining engine configuration](https://github.com/tinyhumansai/openhuman/blob/9404515cb21dbd645442e7be928b13f8aa405b0c/src/openhuman/config/schema/subconscious.rs) also explicitly marks one alternate engine as unimplemented. This review distinguishes documented concepts from tested upstream behavior.

| Concept | KAI behavior | Remaining difference |
| --- | --- | --- |
| Three autonomy levels | Off, Observe, Assist; persisted explicit source/note/goal selection | Assist proposes tasks and follows reviewed workflows; it does not grant arbitrary background tool writes |
| Heartbeat and change triggers | Configurable 5–1,440 minute interval, selected-content fingerprints, checks every 30 seconds | Changes are local snapshots, not native integration event streams |
| Situation report | Selected memory, active goals, source errors, custom checks and a context budget | No desktop screenshots, ambient microphone, broad filesystem or process surveillance |
| Quiet background learning | Deterministic source summaries and local-model global summaries/insights update the encrypted store | Promoting a model suggestion into a fact/task requires review |
| Skip/act/escalate | Typed skip/review results; pending insights; exact native review before remember/task mutations; reviewed workflow dispatch | No automatic execution of model-proposed external actions |
| User tasks | Named, bounded background checks with enable/pause/remove | Configured in the UI rather than executing instructions from a workspace HEARTBEAT.md |
| Morning briefing | Daily Highlights / Action items / Mentions / FYI, grounded in selected content, explicit quiet-day text | Provider calendar/events appear only if deliberately collected; no automatic account-wide scan |
| Durable orchestration | Persisted queue/results, one worker, fingerprints, limits, three-attempt retry, restart recovery, stop and stale-result invalidation | No self-spawning agent swarm or parallel deep-reasoner worker tree |
| Delegation | Start a previously reviewed workflow with explicit input; its step results and approvals remain visible | No arbitrary generated code execution, shell tasks, or new tool grants |
| Local/private reasoning | Installed local model only, private Electron IPC, no network overflow or private-provider background billing | No separate reflex/core model cascade or external Medulla/agentmemory service |

## Further work worth doing

The requested full OpenHuman scope remains larger than this revision. These items are documented as unfinished, rather than represented by non-working toggles:

1. **Semantic memory:** selected local embedding model, measured retrieval quality, semantic chunking, entity resolution, recursively summarized source/topic trees and topic-wide forgetting.
2. **Richer sources:** text extraction from PDF/DOCX, cursor-based app ingestion, connection event subscriptions and per-source retry/backoff dashboards.
3. **Advanced orchestration:** parallel bounded workers, dependency graphs, per-goal budgets, separate fast/deep local models and auditable context compression. Preserve per-request model mutation approvals.
4. **Vault round trips:** manifest-based import, conflict-aware reconciliation of user edits and full revision restoration.
5. **Workflow builder:** loops/subflows/parallel branches, visual node canvas, reusable typed outputs and richer trigger configuration.
6. **Companion continuity:** opt-in per-conversation source collections, validated long-term goal reflection, incremental conversation summaries and carefully scoped proactive notifications.

These extend the broader [companion product inventory](KAI_COMPANION_ROADMAP.md), which also covers desktop presence, voice, meetings, channels, MCP, skills, documents, teams and shared compute. The Koinos node, wallet, shared profile and Test updater identity remain the existing systems.

## Primary research references

- [OpenHuman memory architecture](https://github.com/tinyhumansai/openhuman/blob/9404515cb21dbd645442e7be928b13f8aa405b0c/gitbooks/features/obsidian-wiki/memory-tree.md)
- [Sources](https://github.com/tinyhumansai/openhuman/blob/9404515cb21dbd645442e7be928b13f8aa405b0c/gitbooks/features/obsidian-wiki/sources.md), [auto-fetch](https://github.com/tinyhumansai/openhuman/blob/9404515cb21dbd645442e7be928b13f8aa405b0c/gitbooks/features/obsidian-wiki/auto-fetch.md)
- [Scoring](https://github.com/tinyhumansai/openhuman/blob/9404515cb21dbd645442e7be928b13f8aa405b0c/gitbooks/features/obsidian-wiki/scoring.md), [retrieval](https://github.com/tinyhumansai/openhuman/blob/9404515cb21dbd645442e7be928b13f8aa405b0c/gitbooks/features/obsidian-wiki/retrieval.md), [memory diffs](https://github.com/tinyhumansai/openhuman/blob/9404515cb21dbd645442e7be928b13f8aa405b0c/gitbooks/features/obsidian-wiki/memory-diff.md)
- [Goals and todos](https://github.com/tinyhumansai/openhuman/blob/9404515cb21dbd645442e7be928b13f8aa405b0c/gitbooks/features/goals-and-todos.md), [orchestration](https://github.com/tinyhumansai/openhuman/blob/9404515cb21dbd645442e7be928b13f8aa405b0c/gitbooks/features/orchestration.md)
- [TinyHumans product direction](https://tinyhumans.ai/)
