# Koinos Code — design (task #60)

A coding agent in the terminal, in the mold of Claude Code, running entirely on
the Koinos AI stack: the model is whatever the local gateway serves — a local
GGUF, or the Koinos Network class when privacy mode allows it. No cloud vendor,
no per-token bill, and the same privacy rules as everything else in the app.

Reference point: https://github.com/anthropics/claude-code — that repository is
distribution and issue tracking, not forkable source, so Koinos Code is our own
build in its image, sized for the models we actually serve.

## Goals (v1)

- One file, zero dependencies, runs with the Node that ships inside the app
  (`ELECTRON_RUN_AS_NODE`) or any system Node ≥ 22.
- Works against the local OpenAI-compatible gateway: `/v1/models` to pick a
  default, `/v1/chat/completions` to think. `--url`, `--model`, `--key` to
  override; API keys respected when the user has created any.
- The agent loop and action grammar are REUSED, not reinvented:
  `ui/agents.js` is UMD precisely so Node can require it — `buildAgentSystem`
  (bounded tool menu + aliases small models can spell), `parseAgentAction`
  (forgiving JSON extraction), `trimConvo` (4k-context survival).
- Tools are the coding five, all jailed to the project directory:
  `list_files`, `read_file`, `search_files`, `write_file`, `run_cmd`.
- Permission model, in one sentence: **reads are free inside the project,
  writes show a diff and ask, commands always ask.**
  - `write_file` prints a unified diff of what would change and waits for y/N.
    `--yes` pre-approves edits for scripted use.
  - `run_cmd` asks EVERY time, `--yes` or not. Without a TTY it refuses unless
    `--allow-commands` was given explicitly (CI use). There is no flag that
    silences both gates at once.
  - Path jail: every path resolves inside the project dir or the tool refuses;
    refusals become observations the model can route around, not crashes.
- Two modes: one-shot (`koinos-code "add a --version flag"`) and interactive
  (no args → REPL that keeps the conversation, trimmed to fit small contexts).
- Honest trace: every tool call and its observation is printed as it happens,
  the same visibility rule as the app's agent mode.

## Non-goals (v1)

- No MCP, no memory, no web tools — the app has them; the CLI stays small
  until field use argues otherwise.
- No git integration beyond what `run_cmd` can do with the user's approval.
- No streaming tokens (answers are short; tool traffic dominates).

## Shape

```
cli/koinos-code.js     the whole program (~450 lines)
  parse args → probe gateway → pick model
  loop: completion → parseAgentAction
        ├─ {tool,args}   → confirm if needed → execute → observation
        ├─ {answer:true} → one closing completion for the final prose
        └─ prose/no JSON → that IS the final answer (small-model reality)
  one-shot: print answer, exit 0
  REPL:     next instruction becomes the next user turn
```

Budgets: `--max-steps` tool actions per task (default 25, ceiling 50);
observations truncated to 4000 chars; diffs capped at 160 lines; file reads
windowed (`from` arg) so a big file cannot blow the context.

## v2 (shipped 0.31.0)

- **KOINOS.md project context.** If the project root has a `KOINOS.md`, its
  text rides in the system prompt of EVERY task — re-read per task, so edits
  (by the person or by the agent itself) apply on the very next instruction.
  Bounded to 4000 chars with an honest truncation marker; a missing or empty
  file adds nothing.
- **`edit_file` — surgical edits.** `{path, find, replace}` replaces one
  exact occurrence. Zero matches → "not found … copy it exactly (whitespace
  matters)"; several matches → "ambiguous: occurs N times — include more
  surrounding lines"; both are observations the model routes around. The
  approved change goes through the SAME diff-and-ask gate as `write_file`
  (one shared `approveAndWrite` — every path to disk crosses one gate). The
  system prompt steers models to prefer it over whole-file rewrites.
- **Team handoff.** `--team <research|analyst|review>` (one-shot) and
  `/team [template] task…` (REPL) send a big THINKING job to the app's AI
  Teams over `/core/teams/run`, streaming the `[stage] detail` trace live.
  Honest boundary, stated in help and startup text: the team works in the
  APP's workspace, never in the project — it plans/researches/reviews; the
  agent loop applies changes. The analyst template runs sandboxed code, so
  it needs an upfront yes (TTY prompt, or `--allow-commands` headless);
  templates run without the Developer-tools switch, custom specs stay
  gated (unchanged gateway rule).

## Later phases

- v3: surfaced inside the app (Developer tools) as a terminal panel; ships in
  PATH via the installer.
