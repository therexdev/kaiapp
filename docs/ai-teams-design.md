# AI Teams + Developer Tools (task #58)

Owner direction (2026-08-19/20): take microsoft/autogen's *capabilities*,
not its framework — users get the benefits "without knowing too much",
while developers using the self-hosted API get the technical surface with
full freedom. Two tracks, one engine.

## Why not embed AutoGen itself

AutoGen is a Python framework. Embedding it means shipping a Python
runtime, its dependency tree, and its security surface inside a consumer
app — and every valuable behavior it provides (agents in roles talking to
each other, critique loops, code execution, tool use, orchestration) maps
onto machinery Core already has: the agent loop (#41), the unified tool
layer (#38), memory (#39), MCP (#42), and now the `run_code` sandbox
(e317847). We implement the patterns natively, in JS, with our policy
gates intact.

## What already shipped

- **`run_code`** (e317847): sandboxed Node script execution as a registry
  tool — Node permission model (fs jailed to the agent workspace, no child
  processes), network patched out, resource caps, code shown + confirmed
  before every run. This is the AutoGen "code executor" equivalent and the
  Magentic-One capability core (web browsing = existing `web_search` +
  `read_page`; file handling = existing workspace tools; code execution =
  `run_code`).

## Track 1 — simple: AI Teams (no configuration)

One picker in the chat composer: **Team**. Each template is a named
pipeline of ROLES over the existing agent loop — no new model machinery,
just staged prompts with the tool registry and a shared workspace:

- **Research team**: Planner (breaks the question into sub-questions) →
  Researcher ×N (web_search/read_page per sub-question, notes to
  workspace) → Writer (synthesizes) → Critic (checks claims against
  notes; one revision round).
- **Analyst**: Planner → Coder (run_code over workspace files/data) →
  Explainer (plain-language result). The run-fail-fix loop lives in the
  Coder stage.
- **Write & review**: Drafter → Critic → Reviser (two rounds max).

Rules that keep it honest and bounded:
- Every stage is a visible trace entry (same UI as agent mode today);
  every tool call goes through the SAME policy layer (sensitive tools
  confirm, egress tools obey privacy mode). Teams add zero new
  permissions.
- Hard budgets: max stages, max tool calls per stage, max total tokens —
  a team can never loop forever or silently burn the free tier.
- Model routing: each role can bind to "local" or a network class
  (koinos-fast/-smart). Default: local for planning/critique, network
  smart-class offered (not forced) for the Coder/Writer step — the "rent
  the network's brains for the hard step, pay in KAI" story.

## Track 2 — developer: the API toggle

A **Developer tools** toggle in the API section of Settings. Off by
default; flipping it exposes, on the same local gateway the app already
serves:

1. **Teams API** — `POST /core/teams/run` with a JSON team spec (roles,
   prompts, model bindings, tool allowlist, budgets); `GET
   /core/teams/templates` returns the built-ins as specs, so the simple
   templates ARE the documentation. SSE stream of the trace. This is the
   AgentChat-equivalent: everything the picker does, scriptable.
2. **run_code API** — already reachable via `/core/tools/call` once the
   toggle is on; documented with the sandbox contract. Headless consumers
   (Pi, servers) confirm sensitive calls with an explicit `confirmed:true`
   + a per-session unlock, mirroring the UI consent.
3. **Bench (AgentBench-equivalent)** — `POST /core/bench/run` with a task
   suite (JSON: prompts + expected checks), runs a team/model against it,
   returns pass rates and per-task traces. Ships with a starter suite
   (math, extraction, file transform, research-with-citation). This slots
   into the existing bench.yml CI hook later so team regressions are
   caught like scheduler regressions.
4. **Studio-equivalent** (later, phase C): the Teams view grows an
   editor — drag roles, pick models/tools per role, save as a custom
   template (a JSON spec under the hood, exportable/importable). The
   simple track and the developer track meet here: a template built
   visually is a spec the API can run.

## Phasing

- **A (next build)**: Core-side team runner (`core/lib/teams.js`) —
  role pipeline over the registry + chat runtime, budgets, SSE trace;
  three built-in templates; Team picker in the composer. Tests: template
  runs against the fake llama server, budget enforcement, policy-gate
  passthrough (sensitive tool inside a team still demands confirmation).
- **B**: Developer toggle + `/core/teams` + `/core/bench` APIs + docs
  page. Bench starter suite.
- **C**: visual template editor; custom template store; bench in CI.

The team runner lives in CORE (not the renderer) even though today's solo
agent loop is renderer-side: headless API users and the Pi need teams
without a window. The renderer keeps rendering the trace; Core owns the
loop. The solo agent loop stays as-is until teams prove the Core-side
pattern, then it migrates too.
