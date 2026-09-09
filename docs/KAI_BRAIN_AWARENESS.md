# Brain and Awareness

KAI's Brain keeps the memories, sources and priorities you choose to share. **Awareness** is its optional background reader: it checks selected context, builds summaries, notices useful changes and suggests next steps. The workspaces now use a left navigation rail like Koinos Node.

## Start with one source

1. Open **Brain → Sources**. Import a text file, select a folder or conversation, add a public page/feed/repository, or collect selected data from **Connections**.
2. Sync it and open **Explore memory** to read the indexed material. Folder and conversation sources remember the exact scope you chose. New conversations are never silently added.
3. Open **Awareness**, choose **Observe**, select that source, and save. Choose an installed local chat model for reasoning, or keep **Source excerpts only** for a lightweight digest.
4. Choose **Run now**, then open **Orchestration** to see the queue and result. **Overview** collects the daily briefing and suggestions.
5. Use **Assist** when you want suggestions for tasks and next steps. Review the exact text before remembering it or making it a task. A reviewed workflow can handle follow-through using its existing permissions.

Awareness runs while the desktop app is open, including in the tray. It starts off. Background reasoning uses only installed local models; private OpenAI/Anthropic keys remain for attended chat. Each check can use CPU/GPU resources. The default limit is six checks an hour, including manual checks and retries. Stop cancels current/queued work; choose Off and save to pause future checks.

## Workspace guide

| Section | What you can do |
| --- | --- |
| Overview | Read a daily briefing, review suggestions, see memory activity, enable/disable reply recall and export your Brain |
| Memory graph | Explore source/topic relationships; filter by source, topic, text and update date; open exact evidence |
| Memories | Add/edit personal facts, preferences, people and project notes; pin useful material; inspect imported sections |
| Goals & tasks | Maintain priorities and a To do / In progress / Done board, link tasks to goals and set due dates |
| Sources | Add explicitly selected sources, refresh them and pause individual schedules |
| Sync & changes | Compare before/after memory text, mark a review checkpoint and clear retained history |
| Awareness | Choose Off/Observe/Assist, context scope, model, interval, change triggers, hourly budget and custom checks |
| Orchestration | Inspect durable queued/running/completed/failed jobs, retry or stop checks, and start a reviewed workflow |

Topics and relevance scores are computed from words, tags, pins and recency. They are navigation aids, not verified relationships or confidence scores. Source summaries preserve links to original notes. A local model can produce a global summary and suggestions from a bounded subset of recent selected content. The evidence list records that subset. Older or omitted text must not be assumed to have been reviewed.

## Sources and limits

| Source | Scope and refresh |
| --- | --- |
| Imported file | TXT, MD, CSV or JSON up to 200 KB; re-import the same name to update |
| Local folder | Native folder picker; default MD/TXT, optional CSV/JSON; up to 100 files/200 KB, optional four-level recursion; hidden folders, symlinks and common credential filenames excluded |
| KAI conversations | Up to 30 selected threads and 200 KB; user and assistant text only, excluding system messages and image data |
| Public website | HTTPS text, without account credentials; download cap 2 MB and indexed content cap 200 KB |
| RSS / Atom | Up to 50 entries from a public HTTPS feed; refreshed snapshots with deduplication |
| Public GitHub | Repository description and 30 open issues; use an authenticated connected source for private repositories or broader data |
| Connected app/custom API | Selected verified read operation and saved variables; existing account permissions and 200 KB result cap apply |

Source schedules default to 20 minutes and run only while KAI is open. Folder/chat/web/feed/GitHub intervals can be set when creating the source. Awareness has its own independent interval and watches the saved source content. Failed syncs preserve the last successful memory. Public URL requests reject private destinations and private redirects. Local-Only pauses all online source/connection traffic; local folder, conversation and local model analysis continue.

## History, ownership and execution

The existing encrypted companion store is extended without changing its version or moving the shared KAI profile. It holds up to 3,000 memory sections, 100 sources, 200 recent changes, 100 background jobs, 200 insights, 300 personal tasks, 30 review checkpoints and 200 activity entries, within the existing 24 MiB encrypted-store cap. Checkpoints mark reviewed content; they are not rollback snapshots. Clear history deletes retained revisions without deleting current memories.

Forgetting a source removes its indexed sections, retained changes, derived summaries, dependent suggestions, reviewed suggestions saved as memories/tasks, and background results. Independently copied text in ordinary notes or workflow outputs remains independently owned material.

**Export Markdown** creates a fresh timestamped folder with source pages, topic links, individual memories, goals, tasks and a manifest. Open it as an Obsidian vault or use a Markdown editor. Exports are plaintext and never overwrite a previous export or hand-edited vault. There is no automatic bidirectional vault sync.

Awareness uses one worker, content fingerprints, bounded queues and a configurable hourly budget. Unfinished read jobs recover after restart; errors retry at most three times. Scope changes and stopping abort in-flight analysis, and source changes during inference invalidate stale results. No model-proposed app write executes from a background check. Remember/task actions require exact native review; external actions use existing workflow checkpoints and approval gates. The pipeline does not expose Brain or personal keys to Core workers or network APIs.

See [feature coverage and remaining work](OPENHUMAN_BRAIN_COVERAGE.md) for the precise comparison with OpenHuman.
