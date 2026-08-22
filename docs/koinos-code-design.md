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

## v3a (shipped 0.32.0) — the panel

Koinos Code inside the app: a **Koinos Code** sub-tab under Developer Tools.
Not a terminal emulator — the same agent, hosted by Core, with the terminal's
[y/N] gates re-expressed as **approval cards**:

- `core/lib/code-agent.js` (CodeAgent) hosts the loop. Nothing re-implemented:
  tools/jail/diff/KOINOS.md come from `cli/koinos-code.js` via its injectable
  `io` (the CLI's TTY io stays the default; the panel injects one that emits
  `approval-request` events), grammar from `ui/agents.js`, completions via the
  loopback lane so runs inherit every routing/privacy rule.
- Permission policy is IDENTICAL to the terminal and there is NO `--yes`
  equivalent in the app: every write shows its diff in a card, every command
  shows its exact line, and the run PAUSES until the card is answered
  (`/core/code/approve`), times out (5 min → declined, run continues), or the
  run is stopped. Un-answered cards die with their run.
- Routes (all Developer-tools-gated): `POST /core/code/run` (SSE:
  start/tool/obs/approval-request/note + terminal done), `/core/code/approve`,
  `/core/code/stop`. A directory that doesn't exist is a terminal error on the
  stream; a filesystem root is refused as a certain typo.
- Trust model: four layers — Core binds loopback ONLY (no env changes that),
  `_sameSite` (a cross-site browser fetch fails on BOTH `sec-fetch-site` and
  `origin`), the dev switch (off by default), and a human answering every
  card. **Correction to the v0.32.0 commit message, which said this "adds
  reach, not privilege": that was imprecise.** Teams' `run_code` is sandboxed
  to the app workspace; this surface writes ANYWHERE the caller names and runs
  shell commands as the user. Same gate, much larger blast radius — so v0.33.1
  additionally refuses `/core/code/*` on any request carrying proxy headers
  (`x-forwarded-*`, `x-real-ip`, `forwarded`) unless KAI_CORE_TOKEN is set.
  Loopback-bound desktop users never hit that (nothing forwards); it closes
  the one shape that could reach here from off-machine — the headless operator
  who put a reverse proxy in front, where a stripped origin would otherwise
  land in `_sameSite`'s deliberate header-less trust.
- Test fixture note: `fake-llama-server` accepts FAKE_LLAMA_SCRIPT (a JSON
  array of replies, one per non-streaming completion) so agent-loop decisions
  are deterministic through the REAL stack — the HTTP and browser tests answer
  a live approval card mid-stream.

## v3b (shipped 0.33.0) — on the PATH

Windows installs get a real `koinos-code` command:

- `build/bin/koinos-code.cmd` ships to `$INSTDIR\resources\bin` (win-scoped
  extraResources) and drives the app's own Electron with ELECTRON_RUN_AS_NODE
  against the asar-UNPACKED CLI (`asarUnpack: cli/**, ui/agents.js` — a plain
  file path, no asar reader needed). The mechanics are proven on every
  platform by running the packaged Electron binary against the unpacked CLI.
- `build/installer.nsh` (nsis.include): customInstall appends
  `resources\bin` to the USER Path via PowerShell's
  [Environment]::SetEnvironmentVariable — which also broadcasts
  WM_SETTINGCHANGE, so new terminals see it with no reboot and no NSIS
  plugin; customUnInstall filters the entry back out. Guarded against
  duplicates on update installs; a PATH edit failure never aborts install.
  Known edge accepted for alpha: an apostrophe in the Windows username would
  break the quoted path and skip (only) the PATH step.
- Linux/AppImage deliberately unchanged: `npx koinos-code` stays the way in
  (an AppImage mounts read-only; PATH integration there is a different
  mechanism for a later day).

## v4 (shipped 0.35.0) — its own menu item, projects, sessions

The owner's ask: Koinos Code should be its own thing, with several projects and
GitHub, working the way Claude Code does. This is the first half.

- **Its own sidebar item and its own switch.** It used to ride on the
  Developer-tools switch; those answer different questions. Developer tools
  reveal multi-agent systems, a playground, pipelines and a benchmark. Koinos
  Code writes files where you point it and runs commands as you. Someone should
  be able to want one without the other. MIGRATION: `code.enabled` seeds itself
  from `dev.tools` the first time it is read, so anyone who enabled developer
  tools to get Koinos Code keeps it.
- **Projects** (`core/lib/code-projects.js`): add a folder, name it, switch
  between them, rename, forget. Bounded (50 projects). Validation is the
  agent's own: missing folder, a file, and a filesystem root are all refused in
  words. A folder that moved is FLAGGED in the list, never silently dropped —
  and forgetting a project never touches the folder.
- **Sessions**: each project keeps threads, each thread keeps its turns, and a
  run's earlier turns ride into the next run's prompt as context ("already
  done, do not redo"). That is what makes "now do the same in the tests" mean
  something. Bounded on every axis — sessions per project, turns per session,
  characters per turn, and the history handed to a run is capped by BOTH turn
  count and characters so an old thread cannot crowd out the actual task.
- `POST /core/code/run` takes `projectId` + optional `sessionId`; a bare `dir`
  still works exactly as before, so the CLI and any existing script are
  untouched. The session id streams out ahead of the work so the UI can attach.
- `ui/code-view.js` — projects rail, sessions rail, transcript, task box. The
  permission model is unchanged and must stay that way: every write is a card
  with its diff, every command a card with the exact line.

Bugs caught building it, both worth keeping:
- `path.resolve("")` returns the process's working directory, so an empty
  project path silently became the app's install folder. Now the RAW input is
  checked before resolving.
- Refreshing the session list after a run cleared and rebuilt the transcript,
  so the answer visibly flashed away — and would have been lost outright if the
  reload failed. List refresh and transcript replay are now separate.

## v5 (shipped 0.36.0) — GitHub

Connect an account, clone a repo into a project, and publish work back:
branch, status, commit, push, open a pull request. `core/lib/git.js` runs git;
`core/lib/github.js` holds the account and the API.

THE TOKEN is treated as what it is — a credential for someone's account:
stored on that machine only at mode 0600; NEVER in a command line (argv is
readable by other processes, so `https://TOKEN@github.com/...` leaks) — git
receives it over stdin through a credential helper; never written into
`.git/config`, which keeps the clean remote; never returned by any endpoint
(status reports the login and the last four characters); scrubbed out of every
line of git output before it is returned or logged; and sent to exactly one
host, api.github.com.

NO SHELL, ANYWHERE. Every invocation is `spawn("git", argv, {shell:false})`.
A branch named `x; touch /tmp/PWNED #` is a rejected branch name and nothing
else — there is a test that asserts the canary file never appears.

REPO REFERENCES are github.com only, https or bare `owner/name`. No ssh, no
scp-style `git@host:path`, no other hosts — a clone must never be pointable at
an internal service. `.` and `..` are refused by name: they pass a character
check and are catastrophic in `path.join(parent, repo)`, which is exactly the
hole the first probe of this module found.

EVERY REPO ACTION NAMES A PROJECT, never a path from the request, so the
surface cannot be aimed at an arbitrary folder. Publishing is always a
deliberate act: the agent proposes edits through its approval cards, and
commit / push / pull request each happen because a person asked for that
specific thing.

## v6 (shipped 0.37.0) — the workspace UI, and a bug worth remembering

**window.prompt() does not exist in Electron.** It returns null without showing
anything. v0.35.0/v0.36.0 drove all nine Koinos Code actions through it, so
every button was dead in the packaged app — while the Chromium test passed,
because Playwright IS a browser and no behavioural test can reproduce a missing
browser API. The guard is therefore static (`electron-dialogs.test.js` greps
`ui/*.js`), and it immediately found a third instance in app.js that nobody had
reported. **Rule: never prompt() in ui/. alert()/confirm() are fine.**

The UI became a workspace: projects rail + New chat; a start screen offering
"Select a folder" (native picker in the app, in-app browser in the served UI)
and "Clone from GitHub" (creates the folder, clones, registers, opens it);
a real composer; inline forms everywhere. `/core/code/browse` lists DIRECTORIES
ONLY, so it cannot enumerate documents.

## v7 (shipped 0.38.0) — plan mode + MCP tools

Plan mode is enforced by ABSENCE: the loop is handed list/read/search and
nothing else, so it cannot write even if the model tries. The plan arrives as a
card; approving re-runs the task with the plan as context. A plan is a proposal,
not a session turn.

Registry tools (MCP, memory, email, calendar, built-ins) can be lent to a
project: opt-in, capped at 8 because a 4k context cannot hold more and still
hold the task, and a `sensitive` tool routes to the SAME approval card as a
shell command — the coding agent must never be a way around a gate the rest of
the app enforces.

Bug caught here and never plan-specific: `parseAgentAction` returns null for
BOTH prose and a tool call naming something unavailable, and the loop treated
null as "this is the final answer" — so a refused tool call was shown to the
person as raw JSON pretending to be an answer. Now the loop recognises the
attempt, states the real tool list, and lets it retry, bounded to two nudges.

## v8 (shipped 0.39.0) — slash commands + subagents

Commands are `.koinos/commands/*.md`; `/name` expands with `$ARGUMENTS` and runs
as an ordinary task. **They are prompt templates and nothing else, and that is
the point rather than a limitation** — these files arrive inside cloned
repositories, so a command must never be able to execute, grant, or widen
anything. It changes what is asked; every downstream write and command is still
a card.

Subagents: `delegate` spawns a child on the same project and returns ONE
observation, for context rather than privilege. The child reuses the parent's
io (its writes are the parent's cards), gets no host tools, cannot delegate
further, has a smaller budget, and is capped at 3 per run.

## What "exactly like Claude Code" does and does not mean here

Worth stating plainly rather than implying parity that does not exist. Koinos
Code now matches the shape: its own place in the app, many projects, sessions
that remember, a coding agent with approval gates, a terminal CLI, and GitHub.
As of v0.39.0 it also has subagents, custom slash commands, MCP tools inside
the coding agent, and plan mode. Two things remain different, and both are
deliberate:

**Background tasks are not built.** A run that outlives its connection needs
its trace buffered and its approval cards to survive a reload — they currently
die with their run. That is real plumbing, worth doing when someone actually
wants to walk away mid-run.

**Hooks are declined, not deferred.** Hooks are arbitrary shell commands fired
automatically at lifecycle points. Everything here runs the other way:
`spawn(argv, {shell:false})`, a canary test proving no shell sees a branch
name, a human answering every write and command. And a `.koinos/hooks.json`
would arrive INSIDE A CLONED REPOSITORY — so cloning a stranger's repo could
execute their commands before anyone read a line of it. That is a supply-chain
hole, not a feature. The safe version of the same outcome: named scripts in
KOINOS.md that the agent may PROPOSE, arriving as an ordinary command approval
card.

The last real difference is the model. Koinos Code runs on whatever the local
gateway serves — the whole point of the product, and a genuine difference in
capability from a frontier model, which is exactly why plan mode matters here
more than it would elsewhere.
