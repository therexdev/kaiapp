# Multi-agent runtime — full AutoGen parity (task #64)

The owner's ask, verbatim shape: Developer Tools becomes its OWN sidebar item
(revealed like the node mode), with a sub-menu on the page; the simple team
templates stay for everyone, and under Developer Tools lives "the FULL
functionality of AutoGen, capabilities and flexibility to create your own
complex multi agents."

## What "AutoGen parity" means here

AutoGen's power is CONVERSATION between named agents, not a fixed pipeline.
The pieces that matter, mapped to our stack:

| AutoGen concept            | Ours                                            |
| -------------------------- | ----------------------------------------------- |
| AssistantAgent             | agent: { name, systemPrompt, tools[], human:false } |
| UserProxyAgent (human)     | agent: { name, human:true } — the run PAUSES and asks the person |
| RoundRobinGroupChat        | mode: "round_robin"                             |
| SelectorGroupChat          | mode: "selector" — a model call picks the next speaker |
| Swarm / handoffs           | mode: "handoff" — the speaker keeps the floor until it hands off by name |
| Termination conditions     | termination: { maxMessages, textMention, maxModelCalls } |
| Per-agent tools            | registry.call, same egress/sensitive policy as everywhere |
| AutoGen Studio             | the Builder tab (visual → JSON, JSON is source of truth) |
| AutoGen Bench              | the Benchmark tab (/core/bench, already shipped) |
| Magentic-One orchestrator  | expressible as a selector team whose selector prompt is the orchestrator; a dedicated planner-ledger mode is future work |

## The runner (core/lib/groupchat.js)

One shared TRANSCRIPT of `{ name, content }` messages. A loop:

1. Pick the next speaker (mode above). Selector burns one model call with a
   constrained "reply with ONE name" prompt; garbage falls back to round-robin
   order so a weak model degrades to fairness, never to a crash.
2. If the speaker is HUMAN: emit an `input-request` trace event and wait.
   The gateway holds the SSE stream open; the reply arrives via
   `POST /core/agents/input`. No reply within `inputTimeoutMs` (default 5 min)
   ends the conversation honestly — a run can never hang forever on a person.
3. Otherwise the agent speaks: its system prompt + the trimmed transcript.
   It may use ITS OWN tools first (the same JSON-action grammar as the solo
   agent and teams, ≤ `maxToolActionsPerTurn` per turn). Sensitive tools run
   only under the same upfront consent flag as teams.
4. Append the message. Check termination. Repeat.

### Budgets are HARD, always

Developer flexibility raises the ceilings; it never removes them:
maxMessages ≤ 60, maxModelCalls ≤ 120 (absolute — selector calls and tool
turns included), tool actions per turn ≤ 6, transcript trimmed to fit small
contexts, message length bounded. A spec can only lower these. Termination is
mandatory: specs with no explicit condition get the defaults, and the ceiling
backstops everything. A group chat can never loop forever — same law as teams.

### Zero new permissions

Every tool call goes through the ONE registry with the same egress/sensitive
policy. `human` agents add no capability — they are a pause, not a power.

## API (all developer-gated except where noted)

- `GET  /core/agents/defs` — saved team definitions (dataDir/agent-teams.json)
- `POST /core/agents/defs` — save {id?, spec}; server assigns id when absent
- `DELETE /core/agents/defs/:id`
- `POST /core/agents/run` — SSE: `{trace}` per event (message, tool,
  input-request, termination), terminal `{done, transcript, modelCalls}` /
  `{done, error}`. Body: `{ spec | defId, task, model, allowSensitive }`.
- `POST /core/agents/input` — `{ runId, inputId, text }` answers a pending
  input-request. 404 for unknown/expired requests.

## UI — the Developer Tools view

Sidebar gains `Developer Tools` (hidden until the switch in Local API is on —
the switch stays where it was; what moves is the CONTENT). The view has a
sub-menu, node-style:

- **Multi-agent** — the AutoGen track: agent cards (name, role prompt, tools,
  human flag), team mode, termination fields; save/load named definitions;
  the JSON spec below, always the source of truth.
- **Playground** — run a definition: per-agent conversation bubbles with
  names, live tool lines, an input box that appears when a human agent is
  asked to speak, Stop.
- **Pipelines** — the simple track that already shipped (template-style
  custom specs), moved here verbatim from Local API.
- **Benchmark** — the objective suite, moved here verbatim.

## Testing

Scripted-model unit tests pin: round-robin order; selector parse + fallback;
handoff keeps/moves the floor; each termination condition; the absolute
ceiling; per-turn tool bound; consent gate; HITL pause → provideInput resumes;
HITL timeout ends honestly. Gateway tests pin defs CRUD, the SSE input-request
round trip, and the developer gate. A browser test drives the real view:
tabs, a two-agent round-robin run to completion, named bubbles.
