# KAI Workflows

Workflows is the home for reusable routines in the desktop app. Build a graph yourself, start with a template, or describe a routine to KAI. The builder, schedules and run journal use the existing encrypted companion store and shared KAI profile.

## Start here

1. Open **Workflows → My workflows → New workflow**, or choose a template.
2. Select the starting node. Choose **On demand** for your first run.
3. Add nodes from the library. Drag their headers to move them; click an output dot, then the next node's input dot to connect them. The inspector also has a **Connect nodes** form.
4. Select each node to configure it. For app actions, choose a connected account and one of the actions you enabled in Connections. Agent nodes need an installed local model.
5. Use **Validate**, then **Save workflow**. Unfinished work can be kept with **Settings → Save as draft**.
6. Click **Run** and enter text or JSON. Open **Run history** to inspect inputs, outputs, timing, retries, failures and pending decisions. **View on canvas** displays the definition saved with that run.

**Auto arrange**, **Fit**, zoom, panning, undo/redo, node duplication and keyboard deletion help organize larger flows. Scroll pans the canvas; Ctrl+scroll zooms. Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z redoes. The inspector moves below the canvas in narrower windows.

## Build with KAI

The prompt at the top of My workflows opens Copilot. Explain the desired routine, choose a local model, then select **Suggest changes**. Review the proposal and its validation messages before **Apply to canvas**. This edits the draft; it does not save, enable or execute it. Small local models may produce incomplete graphs, so check the result and correct any missing configuration.

**Discover workflows** suggests routines from connected app names and, when selected, personal Brain notes and goals. Suggestions can be built or dismissed. Optional daily suggestions run while KAI is open and idle from workflow execution. They remain proposals. Disabling this setting cancels an active background suggestion request.

Private OpenAI/Anthropic keys remain available for attended chat. Workflow reasoning, Copilot and background discovery use installed local models without network overflow.

## Node library

| Node | Use |
| --- | --- |
| Trigger | Manual input, a schedule, app-data changes, Brain-source changes, or live Composio events |
| Agent | Local reasoning with an assistant/planner/researcher/writer/analyst role and selected read tools |
| App action | A selected operation on a connected app or custom API |
| HTTP request | A fixed public HTTPS destination, or an authenticated saved Custom API operation |
| Code | Isolated JavaScript transforming JSON data; return the result from the script |
| Sub-workflow | Run a saved child workflow using a version snapshot; inherit its own model and nested approvals |
| Brain memory | Search, recall, people, goals, remember or forget a selected personal note |
| Condition | Route each matching item to True and the others to False |
| Switch | Route a value to a named case or Default |
| Merge | Wait for incoming branches, then append, match by position, or match by key |
| Split out | Turn a list into individual items |
| Transform | Keep/drop existing fields and set new fields from values or expressions |
| Output parser | Parse JSON, CSV or text; check required output fields |
| Deduplicate | Keep new keys within this run or across this workflow's runs |
| Loop | Repeat the Body path with a finite limit, then follow Done |
| Approval | Pause for review and follow Approved or Rejected |
| Result | Record the result and optionally save an answer in Chat |

A loop body must connect back to its Loop node. Its items become the next iteration's input. Connect Done to the next stage. Uncontrolled cycles and recursive child workflows are rejected. Independent branches run with bounded concurrency; a merge waits for completed or skipped predecessors, including an untaken condition branch.

Agent nodes may request only their selected read tools, within the configured turn limit. Put changes in explicit App action or Brain nodes, where the exact action can be reviewed. Code nodes have no filesystem, environment variables, shell, network or host-module access. They support JavaScript, not Python.

## Data and expressions

Most text settings accept `{{input}}`, `{{previous}}`, `{{item.field}}` or `{{nodes.ID.field}}`. Prefix a setting with `=` for a typed JavaScript expression:

| Expression | Meaning |
| --- | --- |
| `=item.title` | The current item's title |
| `=item.json.items` | A list inside a parsed HTTP/app response |
| `=item.amount > 100` | A boolean condition |
| `=nodes.fetch.text` | Text from the earlier node named `fetch` |
| `=items.map(x => ({title: x.title}))` | Project the incoming list into a simpler list |

HTTP, app and agent results expose `text` and `json`. Native JSON input and transform results keep their own fields. Use **Run history** to see the actual shape before configuring a later node. Each node's advanced panel links to earlier node expressions.

App fields preserve typed numbers, booleans, arrays and objects. For a typed numeric/boolean field, enter a JSON value such as `10` or `true`, or an expression beginning with `=`. Run input can declare required fields and types in Trigger → Run input fields; KAI checks them before launching.

## Schedules and events

Schedules include hourly, every six hours, daily, weekly, a custom interval, a one-time ISO date, or a five-field cron expression. Daily, weekly and cron accept an IANA time zone, for example `America/New_York`. Leave it blank to use this computer's zone. Configure the Trigger, then enable automatic triggers in workflow Settings or the library switch.

**App changes** periodically runs a selected read action. **Brain source changes** compares a source's existing indexed data; configure source refresh separately in Brain. The first check establishes a baseline, and a later changed result starts a run. These watches work with the current connections service and do not need live event registration.

**App events** loads the selected Composio app's event types and settings. Enabling a valid workflow registers its trigger. Live delivery requires an updated KAI account server at a public HTTPS origin and a KAI account sign-in, including when you use your own Composio key. Managed and personal projects use the same delivery mechanism. The personal API key stays on the desktop; the server stores only the webhook signing secret and encrypted event queue. See the [server setup guide](https://github.com/therexdev/kai/blob/claude/kai-production-website-fqx4pf/docs/CONNECTIONS.md).

KAI preserves a Composio project's existing webhook destination. If it already delivers elsewhere, use an app-change watch or a dedicated project for KAI. Turning a workflow off stops KAI dispatch; provider subscriptions are retained because another workflow may share them. Remove unused provider subscriptions in the Composio dashboard. This release does not expose an arbitrary inbound webhook URL for user-defined payloads.

KAI must remain open, including in the tray. Schedules do not execute while the PC sleeps or KAI is closed. Missed schedules coalesce rather than replaying a burst. The event relay retains up to 100 unconsumed events per account/channel for 24 hours. Desktop delivery is checked approximately every 30 seconds. Signed delivery IDs and durable receipt checkpoints prevent the same event from creating the same workflow run twice. A paused run holds later events in the bounded queue. This is not an unlimited offline event archive.

## Review and recovery

Use **Preview** on a saved workflow to exercise its data flow with simulated agent/app/HTTP/memory/approval outputs. Set sample outputs in each node's advanced panel. Preview makes no capability calls or Brain changes; scripts and transforms still run inside the JSON isolate.

App writes, HTTP writes and Brain mutations pause for native review. Per-item writes require a decision for each item. Changing the connection or action invalidates a pending approval. Rejection can follow an Approval node's Rejected branch; rejecting a pending external write cancels that run.

Choose Stop, Continue with error data or Follow Error output for node failures. Read/compute operations can retry up to twice; writes are not automatically retried. Completed item checkpoints and nested approvals survive a restart. If KAI closes during an uncertain action, inspect its destination before starting another run; KAI does not blindly replay it.

Deduplicate remembers encountered keys at that node. A later node failure does not remove them; use a run-scoped deduplicator when you need every new run to reconsider the entire input. Provider-specific exactly-once writes and compensation/rollback are not promised.

Limits keep local execution bounded: 60 nodes, 160 edges, 100 items per node, 50 loop iterations, four levels of child workflows, 500 executed node items, two concurrent runs and 20 pending runs. Live events start at most 30 runs per hour based on retained recent run history. Run input is limited to 32 KB, individual node data to 200 KB. Large data should be filtered at its source. The journal retains recent runs and preserves pending runs.

## Moving from Tasks

The desktop Toolkit's scheduled Tasks entry moves into Workflows. Existing scheduled prompts are copied into the encrypted workflow store before their old timers are disabled. Names, prompts, schedule timing and links to previous chat answers are retained. Repeating the migration does not duplicate workflows. A task needing an unavailable local model is preserved as a paused draft so you can choose a replacement.

Brain's personal task board remains for goals and to-dos. Headless Core retains its legacy Tasks API for compatibility; migrated tasks cannot be re-enabled there. Existing simple workflow definitions and run history remain readable. Opening an old workflow in the canvas and saving upgrades that definition.

Export/import uses JSON. Imports remain disabled drafts. KAI recognizes the documented OpenHuman graph envelope, but connection IDs, agent references and differing node settings need review/remapping; it is not a lossless cross-product importer. The [coverage comparison](OPENHUMAN_WORKFLOW_COVERAGE.md) records the reference behavior and adaptations.
