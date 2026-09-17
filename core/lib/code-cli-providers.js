"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

/*
 * Subscription-backed coding models for Koinos Code.
 *
 * The person already pays for ChatGPT (Codex), Claude (Claude Code) or Grok,
 * and each vendor ships a CLI that signs in with that subscription. This module
 * borrows ONLY the brain: it hands the CLI the CodeAgent conversation as one
 * prompt and takes back one reply. Koinos Code stays the hands — the reply goes
 * through parseAgentAction/salvageAction like any local model's, so every read
 * is jailed, every write is a diff card and every command is a card.
 *
 * What keeps the vendor CLI from being hands too:
 *   - it runs in a fresh, empty scratch directory, never the project. The
 *     project path is not in its argv, cwd or environment;
 *   - `spawn(argv, {shell:false})`, like git.js — no shell sees anything;
 *   - its own tools are switched off, by a different mechanism per vendor
 *     because the three CLIs do not agree on what "no tools" means:
 *       Claude Code: `--tools ""`. Its --help documents the empty string
 *         exactly — "Use \"\" to disable all tools" — so the empty value is a
 *         real instruction, not an absent flag;
 *       Grok Build: an empty string is NOT an empty allow-list and leaves every
 *         tool live. It gets a five-layer treatment — a scratch home carrying
 *         nothing but its sign-in credential, then flags, then a read-back of
 *         the toolset it actually built. See the long comment above
 *         GROK_ALLOW_SEED — do not simplify it back to `--tools ""`;
 *       Codex: no "no tools" flag at all, so it gets `--sandbox read-only`
 *         with `--cd scratch`. That stops every WRITE and its network, but
 *         Codex's read-only sandbox still permits reads elsewhere on the disk:
 *         --cd sets the working root, it is not a read jail. So for Codex the
 *         no-tools instruction in the prompt is the primary control and the
 *         sandbox is the backstop, which is the weakest of the three. Do not
 *         describe Codex as read-jailed to scratch;
 *   - a minimal environment: PATH, locale, temp and whatever that CLI needs to
 *     find the person's existing sign-in. Nothing here ever starts a login;
 *   - bounded stdout/stderr, a timeout, and Stop kills the process group.
 *
 * Model ids: `cli:codex`, `cli:claude`, `cli:grok`, optionally with a vendor
 * model suffix (`cli:claude:sonnet`). The suffix becomes ONE argv element after
 * `--model`, and is validated so it can never start with `-` or carry spaces.
 *
 * Privacy: these send prompt and file content to the vendor. Each provider is
 * off until the person enables it, and Local-Only refuses before any spawn.
 *
 * Flags were checked against installed CLIs' --help (codex exec, claude, grok),
 * and Grok's were additionally verified by running it — --help alone was
 * misleading there. Evidence is tabulated above GROK_ALLOW_SEED.
 */

const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;
const DEFAULT_MAX_STDOUT = 2 * 1024 * 1024;
const DEFAULT_MAX_STDERR = 64 * 1024;
const MAX_PROMPT_CHARS = 400 * 1000;
const KILL_GRACE_MS = 2000;

const MODEL_ID = /^cli:([a-z]+)(?::([A-Za-z0-9][A-Za-z0-9._-]{0,63}))?$/;
/** Shared thinking levels. Default ("") adds no vendor flag. Never pass raw strings. */
const EFFORT_LEVELS = new Set(["low", "medium", "high"]);

function normalizeEffort(raw) {
  const s = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!s || s === "default") return "";
  if (!EFFORT_LEVELS.has(s)) throw new Error(`thinking level must be default, low, medium, or high (got ${String(raw).slice(0, 40)})`);
  return s;
}

function effortArgs(provider, effort) {
  const e = normalizeEffort(effort);
  if (!e) return [];
  if (provider === "codex") return ["-c", `model_reasoning_effort=${e}`];
  if (provider === "claude") return ["--effort", e];
  if (provider === "grok") return ["--reasoning-effort", e];
  return [];
}

const tail = (s, n = 400) => {
  const t = String(s || "").trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
};

/*
 * ---------------------------------------------------------------------------
 * Grok Build confinement, and why it looks like this.
 * ---------------------------------------------------------------------------
 *
 * Measured against the installed CLI, `grok 1.0.34 (3736acbc8658)`, on macOS.
 * Every probe ran in a fresh mktemp scratch dir with a prompt ordering Grok to
 * write a marker file there with its own tools. Results:
 *
 *   flags under test                              toolset Grok built   marker
 *   --tools "" (what this file used to ship)      all 25 tools         no *
 *   --tools "" + --always-approve                 all 25 tools         WRITTEN
 *   --disallowed-tools <every documented name>    run_terminal_command  WRITTEN
 *   --tools "koinos_no_such_tool"                 all 25 tools         WRITTEN
 *   --deny Bash/Edit/Write/... + --always-approve all 25 tools         no
 *   --tools todo_write                            todo_write,search_tool,
 *                                                 use_tool             no *
 *   --tools todo_write + --disallowed-tools ALL   []  (empty)          no
 *   ...the same, with --always-approve            []  (empty)          no
 *
 *   * saved only by the permission gate, not by tool removal: the model did
 *     emit a real tool call and Grok reported "User cancelled the execution".
 *     Under --tools todo_write it reached the MCP bridge, calling `use_tool`
 *     with {"tool_name":"Bash","tool_input":{"command":"printf 'OK' > ..."}}.
 *
 * Three things that review assumed are false in this build:
 *   1. `--tools ""` is NOT an empty allow-list. An empty value is treated as no
 *      allow-list at all and every built-in tool stays live.
 *   2. `--disallowed-tools` alone is NOT sufficient: naming
 *      `run_terminal_command` explicitly still left it in the toolset, and the
 *      vendor README's own tool-id table (`bash`, `run_terminal_cmd`, `task`)
 *      does not match the ids the CLI reports at runtime.
 *   3. An unrecognised name in either flag is silently ignored — no error, no
 *      non-zero exit. A typo therefore fails OPEN.
 *
 * A fourth only showed up once the read-back existed: the tool flags govern
 * BUILT-IN tools only, and MCP servers, hooks, plugins, skills, agents, rules
 * and memory are loaded from configuration — HOME for the Claude/Cursor MCP
 * files, and GROK_HOME for Grok's own. An empty HOME alone does NOT cover
 * GROK_HOME; see the comment on `vendorHome` in the grok spec for the measured
 * before/after.
 *
 * So confinement here is five independent layers, and the last one does not
 * trust the first four:
 *   0. a scratch HOME and a scratch GROK_HOME containing nothing but the
 *      sign-in credential, plus an isolated leader socket inside scratch so the
 *      child cannot attach to a leader daemon already running for the real
 *      profile;
 *   1. an allow-list naming one real tool, minus that same tool via the
 *      deny-list — the only combination that produced an empty toolset;
 *   2. `--deny` permission rules, which held even against `--always-approve`;
 *   3. `--permission-mode dontAsk`, which cancels calls at execution time;
 *   4. assertNoGrokTools(): read back the toolset Grok actually built and the
 *      calls it actually made, and refuse the reply unless both are empty.
 *
 * Layer 4 is the point, and it is the only POST-HOC one: it inspects a run that
 * has already finished, so it cannot prevent a side effect — it can only refuse
 * to hand back a reply the harness could not verify. Preventing side effects is
 * the job of layers 0-3, which all act before or during execution. Layers 0-3
 * also encode what 1.0.34 does today; a Grok update (auto_update defaults on,
 * hence GROK_DISABLE_AUTOUPDATER for the child) could change any of them, and
 * the failure mode would be silent. Layer 4 is a property of the run, not of a
 * version string, so a build whose tool-disable behaviour we cannot verify is
 * refused rather than trusted. This is deliberately fail-closed: a future Grok
 * that stops reporting its toolset stops working here until someone
 * re-verifies it.
 *
 * NOT used: `--sandbox`. Re-confirmed broken on this machine — every profile
 * exits 1 with "socket deny resolution failed: could not resolve runtime-socket
 * deny path /var/run/docker.sock: endpoint is a symlink ... Refusing to start
 * with its protections missing." Grok fails closed there, so it is unusable
 * rather than unsafe; do not add it back without fixing the docker.sock probe.
 */

/** A real tool id. `--tools` is ignored unless at least one name is valid, and
 *  an all-unknown list silently restores the full toolset. */
const GROK_ALLOW_SEED = "todo_write";

/* Removed after the allow-list is applied. GROK_ALLOW_SEED is first and is the
 * load-bearing entry — it is what empties the toolset. The rest are defence in
 * depth: runtime ids observed from `available_commands`, then the vendor
 * README's (differing) documented ids, then `Agent` for subagent spawning.
 * Unknown names are ignored by Grok, so listing both spellings is free. */
const GROK_REMOVE_TOOLS = [
  GROK_ALLOW_SEED,
  "run_terminal_command", "read_file", "search_replace", "list_dir", "grep", "write",
  "web_search", "web_fetch", "spawn_subagent", "search_tool", "use_tool", "workflow",
  "monitor", "scheduler_create", "scheduler_delete", "scheduler_list",
  "kill_command_or_subagent", "get_command_or_subagent_output",
  "image_gen", "image_edit", "image_to_video", "reference_to_video",
  "enter_plan_mode", "exit_plan_mode", "ask_user_question", "send_feedback",
  "bash", "run_terminal_cmd", "grep_search", "task", "kill_task", "get_task_output",
  "memory_search", "memory_get", "lsp",
  "Agent",
];

/** Permission-rule prefixes. Deny beats allow, and beat `--always-approve` in
 *  testing, so these hold even if a future build ignores the tool flags. */
const GROK_DENY_RULES = ["Bash", "Edit", "Write", "Read", "Grep", "WebFetch", "MCPTool"];

const GROK_VERIFIED_VERSION = "1.0.34";

/*
 * The interactive slash-command menu that grok 1.0.34 announces in the SAME
 * `available_commands` event as `tools`, measured from a confined run (scratch
 * GROK_HOME, empty toolset): exactly these six, on every announcement. They are
 * the client's own menu entries, not model-callable tools, so refusing whenever
 * `commands` is non-empty would refuse every healthy run. Anything OUTSIDE this
 * set is therefore treated as a live tool — which is what catches a build that
 * moves its toolset into `commands`, or grows a new callable surface there.
 * The scratch GROK_HOME is what makes this list deterministic: with no
 * config.toml, plugins or skills loaded, nothing on the person's machine can
 * add an entry to it.
 */
const GROK_ANNOUNCED_COMMANDS = new Set(["compact", "always-approve", "context", "session-info", "feedback", "goal"]);

/** A name out of an announcement entry, whether Grok sends bare strings (1.0.34)
 *  or objects. An unrecognised shape yields a non-empty string on purpose: an
 *  entry we cannot name is still an entry, and must still refuse. */
function grokEntryName(entry) {
  if (entry && typeof entry === "object") {
    for (const k of ["name", "id", "title", "tool", "toolName"]) {
      if (typeof entry[k] === "string" && entry[k].trim()) return entry[k].trim();
    }
    try {
      return JSON.stringify(entry).slice(0, 60);
    } catch {
      return "[unreadable entry]";
    }
  }
  return String(entry == null ? "" : entry).trim();
}

/**
 * Layer 4: verify, do not assume. Post-hoc by nature — see the layer list above.
 *
 * Grok's streaming-json stream states the toolset it built (`available_commands`)
 * and every tool call it made (`tool_call`). Both must be empty. Anything else
 * means the flags above did not do what 1.0.34 measured them doing, so the
 * reply is refused instead of returned — a call that was merely *denied* still
 * counts as a failure, because it proves the tool was in the model's hands.
 *
 * The check is POSITIVE about shape, not merely about presence. An
 * `available_commands` event that exists but has no `tools` array — dropped,
 * renamed, or sent as an object/string/null — is a build whose toolset was
 * never read, which is indistinguishable from a build that had tools and did
 * not say so. That refuses too.
 */
function assertNoGrokTools(events) {
  const announced = events.filter((e) => e && e.type === "available_commands");
  const shaped = announced.filter((e) => Array.isArray(e.tools));
  if (!announced.length || shaped.length !== announced.length) {
    throw new Error(
      "Grok Build did not report the tools it was given in a shape Koinos AI can read" +
        (announced.length ? " — its `tools` field was not a list" : "") +
        ", so it cannot confirm its file and shell tools were removed. " +
        `Confinement here is verified against grok ${GROK_VERIFIED_VERSION}; this build behaves differently. Refusing the reply.`
    );
  }
  const live = [];
  const note = (name) => {
    if (name && !live.includes(name)) live.push(name);
  };
  for (const e of announced) {
    for (const t of e.tools) note(grokEntryName(t));
    // The sibling menu, checked against the measured set rather than trusted.
    if (Array.isArray(e.commands)) {
      for (const c of e.commands) {
        const name = grokEntryName(c);
        if (name && !GROK_ANNOUNCED_COMMANDS.has(name)) note(name);
      }
    }
  }
  if (live.length) {
    const shown = live.slice(0, 6).join(", ") + (live.length > 6 ? ", …" : "");
    // An MCP tool name is `<server>__<tool>`. Those come from a vendor home or
    // machine config rather than from a Grok version change, so the thing the
    // person can act on is different — say which one it is.
    const mcp = live.filter((t) => t.includes("__"));
    throw new Error(
      mcp.length === live.length
        ? `Grok Build loaded ${live.length} MCP tool(s) from machine configuration (${shown}), so it is not the tool-free brain Koinos Code requires — those run with your credentials. ` +
          `Koinos AI gives Grok a scratch home holding nothing but the sign-in credential to prevent this; something re-added them. Refusing the reply.`
        : `Grok Build kept ${live.length} of its own tool(s) despite being told to drop all of them (${shown}). ` +
          `Confinement here is verified against grok ${GROK_VERIFIED_VERSION}; this build behaves differently. Refusing the reply.`
    );
  }
  const calls = events.filter((e) => e && e.type === "tool_call");
  if (calls.length) {
    const names = [...new Set(calls.map((c) => String(c.toolName || c.kind || "?")))];
    throw new Error(
      `Grok Build tried to use its own tools (${names.slice(0, 6).join(", ")}) in a session that was supposed to have none. Refusing the reply.`
    );
  }
}

/**
 * True when `line` is a JSON object that was simply cut off: still inside a
 * string, or with structure left open, at end of input. A line that closes its
 * structure and is STILL unparseable is MALFORMED, not truncated, and is never
 * tolerated — that is the shape that could hide a `tool_call`.
 */
function looksTruncatedJson(line) {
  if (line[0] !== "{") return false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (const ch of line) {
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    if (depth < 0) return false; // closed more than it opened: malformed
  }
  return inStr || esc || depth > 0;
}

/**
 * Parse Grok's NDJSON, enforce the no-tools invariant, return the reply text.
 *
 * Parsing is strict on purpose. assertNoGrokTools can only refuse a `tool_call`
 * it can see, so an unreadable line is not cosmetic: it may BE the event that
 * would have refused this reply. Exactly one line may fail to parse — the final
 * non-empty one, and only when it is genuinely cut off mid-object, which is what
 * a stdout cap or a killed process actually produces. Everything else refuses.
 */
function readGrokStream(stdout) {
  const lines = String(stdout || "").split("\n");
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) {
      last = i;
      break;
    }
  }
  const events = [];
  for (let i = 0; i <= last; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      if (i === last && looksTruncatedJson(s)) continue; // a cut-off tail, not a lost event
      throw new Error(
        `Grok Build produced an unreadable ${i === last ? "final" : "mid-stream"} line, so Koinos AI cannot confirm ` +
          "which tools it built or used in this session. Refusing the reply."
      );
    }
    events.push(ev);
  }
  assertNoGrokTools(events); // before any text is handed back
  const text = events
    .filter((e) => e && e.type === "text" && typeof e.data === "string")
    .map((e) => e.data)
    .join("");
  if (text.trim()) return text;
  const stop = events.find((e) => e && e.type === "end");
  if (stop && stop.stopReason && stop.stopReason !== "end_turn") {
    throw new Error(`Grok Build ended without a reply (${String(stop.stopReason).slice(0, 40)}).`);
  }
  return text;
}

const PROVIDERS = {
  codex: {
    label: "Codex",
    plan: "ChatGPT subscription",
    vendor: "OpenAI",
    bin: "codex",
    login: "codex login",
    envKeys: ["CODEX_HOME"],
    // Codex has no "disable all tools" flag. read-only stops writes and its
    // network; --cd sets the working root but does NOT jail reads to it.
    args: ({ scratch, model, effort }) => [
      "exec",
      "--sandbox", "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--color", "never",
      "--cd", scratch,
      "--output-last-message", path.join(scratch, "last-message.txt"),
      ...effortArgs("codex", effort),
      ...(model ? ["--model", model] : []),
      "-", // prompt on stdin — never in a process list
    ],
    authFile: (env) => path.join(env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex"), "auth.json"),
    read: ({ stdout, scratch, maxStdout }) => {
      try {
        const buf = fs.readFileSync(path.join(scratch, "last-message.txt"));
        return buf.subarray(0, maxStdout).toString("utf8");
      } catch {
        return stdout;
      }
    },
  },
  claude: {
    label: "Claude Code",
    plan: "Anthropic subscription",
    vendor: "Anthropic",
    bin: "claude",
    login: "claude (then /login)",
    envKeys: ["CLAUDE_CONFIG_DIR"],
    // --bare would skip keychain/OAuth and break subscription sign-in.
    args: ({ model, effort }) => [
      "--print",
      "--output-format", "json",
      "--tools", "", // documented: Use "" to disable all tools
      "--permission-mode", "dontAsk",
      "--permission-prompts", "none",
      "--safe-mode",
      "--strict-mcp-config",
      // Defence in depth, and verified compatible with this invocation: its
      // --help says it removes the command/code-running built-ins and WebFetch
      // "unless --tools names them" (ours names none), ignores user, project
      // and local settings files, confines the file tools to the working
      // directories, and refuses bypassPermissions. Measured against the
      // installed CLI: the same --print run returns a normal reply with and
      // without it, so it does not disturb subscription sign-in.
      "--restricted",
      "--disable-slash-commands",
      "--no-session-persistence",
      ...effortArgs("claude", effort),
      ...(model ? ["--model", model] : []),
    ],
    authFile: (env) => {
      if (env.CLAUDE_CONFIG_DIR) return path.join(env.CLAUDE_CONFIG_DIR, ".credentials.json");
      return path.join(env.HOME || os.homedir(), ".claude.json");
    },
    read: ({ stdout }) => {
      let j;
      try {
        j = JSON.parse(stdout);
      } catch {
        throw new Error(`Claude Code returned unreadable output: ${tail(stdout, 200)}`);
      }
      if (j.is_error) throw new Error(`Claude Code: ${tail(j.result || j.subtype || "error", 400)}`);
      return String(j.result ?? "");
    },
  },
  grok: {
    label: "Grok Build",
    plan: "Grok subscription",
    vendor: "xAI",
    bin: "grok",
    login: "grok login",
    envKeys: ["GROK_HOME"],
    promptFile: "prompt.txt",
    /*
     * Layer 0, and the one that actually empties the configuration surface.
     *
     * Grok's tool flags only govern its BUILT-IN tools. MCP tools are merged in
     * from configuration — on the development machine that silently added 54 of
     * them, including `github__create_or_update_file` and
     * `playwright__browser_run_code_unsafe`, i.e. write access to their repos.
     * No Grok flag removes those (Claude Code has --strict-mcp-config; Grok has
     * no equivalent). They come from `~/.claude.json`, `~/.cursor/mcp.json` and
     * `<cwd>/.mcp.json` — all resolved through HOME — and from GROK_HOME's own
     * `config.toml` / `requirements.toml` / `managed_config.toml`.
     *
     * So Grok gets BOTH a scratch HOME and a scratch GROK_HOME. Pointing
     * GROK_HOME at the real `~/.grok` is what this used to do, and a scratch
     * HOME did NOT cover it: `grok inspect` under the real GROK_HOME reports
     * `Skills (25)` and `Config Sources → User: ~/.grok/config.toml`, while the
     * same run under a scratch GROK_HOME holding only `auth.json` reports
     * `Skills (0)` and `Config Sources → User: (none)`. Hooks, plugins,
     * skills, agents, rules, memory and MCP definitions all live under
     * GROK_HOME and all came with it.
     *
     * Only the credential is carried across, by name, at 0600 — the README
     * grok ships documents `~/.grok/auth.json` as where `grok login` stores
     * tokens. Verified: with just that file copied, a real run authenticates
     * and answers normally while every toolset announcement is `[]`. With the
     * file absent the child exits 1 in under a second with "Not signed in"
     * rather than starting a login.
     */
    scratchHome: true,
    vendorHome: {
      env: "GROK_HOME",
      dir: "grok-home",
      // A GROK_HOME the person set themselves is still where their credential
      // is; it is read FROM, never handed to the child.
      real: (source) => source.GROK_HOME || path.join(source.HOME || os.homedir(), ".grok"),
      credentials: ["auth.json"],
    },
    /* These names are read out of the installed binary rather than taken on
     * faith: each appears in the vendor README that grok 1.0.34 embeds and
     * writes to `$GROK_HOME/README.md` (e.g. "| `compat.claude.mcps` | … Also
     * GROK_CLAUDE_MCPS_ENABLED. |", "`GROK_SUBAGENTS` | Enable (`1`) or disable
     * (`0`) subagents", "| `cli.auto_update` | … Also GROK_DISABLE_AUTOUPDATER
     * to suppress. |"). They are belt-and-braces on top of the scratch home and
     * the tool flags, not the mechanism anything here depends on. */
    forceEnv: {
      GROK_CLAUDE_MCPS_ENABLED: "0", // stop scanning Claude's MCP config
      GROK_CURSOR_MCPS_ENABLED: "0", // stop scanning Cursor's MCP config
      GROK_SUBAGENTS: "0",
      GROK_LSP_TOOLS: "0",
      GROK_WEB_FETCH: "0",
      GROK_MEMORY: "0",
      // A harness run must not be the thing that swaps the binary underneath
      // the confinement this file measured. Grok's `cli.auto_update` defaults
      // ON; this suppresses it for the child only, and never updates anything.
      GROK_DISABLE_AUTOUPDATER: "1",
    },
    args: ({ scratch, model, effort }) => [
      "--prompt-file", path.join(scratch, "prompt.txt"),
      // streaming-json is not cosmetic: it is the only output format that
      // reports the toolset Grok actually built, which is what assertNoGrokTools
      // verifies below. Do not move this back to `plain`.
      "--output-format", "streaming-json",
      "--cwd", scratch,
      // The leader socket, inside scratch. Without this the child connects to
      // `$GROK_HOME/leader.sock`, and a leader daemon already running for the
      // person's real profile would be a way back into the configuration the
      // scratch home exists to remove. A path outside `~/.grok/leader-*.sock`
      // is documented as not auto-discovered, which is exactly what is wanted.
      "--leader-socket", path.join(scratch, "leader.sock"),
      "--max-turns", "1",
      // Layer 3. Empirically the gate that actually cancels a call: with the
      // full toolset live it refused a use_tool -> Bash bridge ("User cancelled
      // the execution for tool `use_tool`").
      "--permission-mode", "dontAsk",
      "--no-subagents",
      "--no-plan",
      "--disable-web-search",
      // Layers 1a + 1b, and they only work together. `--tools` must name at
      // least one REAL tool or Grok treats the allow-list as absent; then
      // `--disallowed-tools` (documented to run after `--tools`) removes that
      // seed too, leaving an empty toolset.
      "--tools", GROK_ALLOW_SEED,
      "--disallowed-tools", GROK_REMOVE_TOOLS.join(","),
      // Layer 2. Permission rules are a separate mechanism from tool removal
      // and survive even `--always-approve`.
      ...GROK_DENY_RULES.flatMap((rule) => ["--deny", rule]),
      ...effortArgs("grok", effort),
      ...(model ? ["--model", model] : []),
    ],
    authFile: (env) => path.join(env.GROK_HOME || path.join(env.HOME || os.homedir(), ".grok"), "auth.json"),
    read: ({ stdout }) => readGrokStream(stdout),
  },
};

/** Parse a `cli:` model id. null for anything that is not one; throws for a
 *  `cli:` id that is malformed or names an unknown provider. */
function parseModelId(id) {
  const s = String(id || "");
  if (!s.startsWith("cli:")) return null;
  const m = MODEL_ID.exec(s);
  if (!m || !PROVIDERS[m[1]]) throw new Error(`not a valid subscription model id: ${s.slice(0, 80)}`);
  return { id: s, provider: m[1], model: m[2] || "" };
}

const isCliModel = (id) => String(id || "").startsWith("cli:");

function loggedIn(spec, source = process.env) {
  try {
    const file = typeof spec.authFile === "function" ? spec.authFile(source) : null;
    if (!file) return false;
    return fs.existsSync(file) && fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

/* Environment: allow-listed, never inherited. PWD/OLDPWD/INIT_CWD and friends
 * are deliberately absent — they are how a working directory leaks. */
const BASE_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  "TMPDIR", "TMP", "TEMP",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "SystemRoot", "SYSTEMROOT", "PATHEXT",
];

function childEnv(spec, bin, source = process.env, { scratchHome = "", vendorHome = "", platform = process.platform } = {}) {
  const env = {};
  for (const k of [...BASE_ENV_KEYS, ...(spec.envKeys || [])]) {
    if (source[k] !== undefined) env[k] = String(source[k]);
  }
  if (bin && path.isAbsolute(bin)) {
    env.PATH = [path.dirname(bin), env.PATH].filter(Boolean).join(path.delimiter);
  }
  /*
   * A scratch HOME, for a CLI whose tool surface is assembled from whatever it
   * finds under the person's home directory — plus a scratch home for the
   * VENDOR's own state dir, which is a second, separate profile root.
   *
   * Every name for "the person's home" is re-pointed, not merely unset. On
   * Windows APPDATA and LOCALAPPDATA are absolute paths into the real profile
   * in their own right, so deleting HOME-shaped variables there would leave the
   * profile reachable under another name; they are routed into the scratch tree
   * instead. On POSIX the same variables have no meaning and are dropped.
   */
  if (spec.scratchHome && scratchHome) {
    env.HOME = scratchHome;
    for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"]) {
      delete env[k];
    }
    if (platform === "win32") {
      env.USERPROFILE = scratchHome;
      env.APPDATA = path.win32.join(scratchHome, "AppData", "Roaming");
      env.LOCALAPPDATA = path.win32.join(scratchHome, "AppData", "Local");
      const root = path.win32.parse(scratchHome).root; // "C:\\"
      if (root) {
        env.HOMEDRIVE = root.replace(/[\\/]+$/, "");
        env.HOMEPATH = scratchHome.slice(root.length - 1);
      } else {
        delete env.HOMEDRIVE;
        delete env.HOMEPATH;
      }
    } else {
      for (const k of ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH"]) {
        delete env[k];
      }
    }
    /*
     * The vendor's own state dir. It never points at the real profile: that is
     * what used to load the person's config.toml, requirements.toml,
     * managed_config.toml, hooks, plugins, skills, agents, rules, memory and
     * MCP definitions into the run. With no scratch dir prepared the variable
     * is removed rather than left over, so the child falls back to a path under
     * the scratch HOME — empty, and therefore fail-closed at "Not signed in".
     */
    if (spec.vendorHome) {
      if (vendorHome) env[spec.vendorHome.env] = vendorHome;
      else delete env[spec.vendorHome.env];
    }
  }
  Object.assign(env, spec.forceEnv || {});
  env.NO_COLOR = "1";
  return env;
}

/**
 * Build the vendor's scratch state dir and copy ONLY the sign-in credential
 * into it, by name, at 0600 under a 0700 directory.
 *
 * Nothing else is copied: no config.toml, requirements.toml,
 * managed_config.toml, hooks, plugins, skills, agents, MCP definitions, rules
 * or memory. A missing credential is not fatal here — the vendor CLI's own
 * "not signed in" exit is a better message than anything this could invent, and
 * it arrives in under a second without starting a login.
 *
 * Errors deliberately carry no path: the only interesting thing in this
 * directory is a live subscription token.
 */
function prepareVendorHome(spec, source, scratch) {
  const vh = spec.vendorHome;
  if (!vh) return "";
  const dir = path.join(scratch, vh.dir);
  try {
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    const from = vh.real(source);
    for (const name of vh.credentials) {
      let buf;
      try {
        buf = fs.readFileSync(path.join(from, name));
      } catch {
        continue; // not signed in, or stored elsewhere: let the CLI say so
      }
      fs.writeFileSync(path.join(dir, name), buf, { mode: 0o600 });
    }
  } catch {
    throw new Error(`${spec.label}: Koinos AI could not prepare an isolated vendor home for this run.`);
  }
  return dir;
}

/** Remove the copied credential by name first, so a failure to tear down the
 *  rest of the scratch tree can never leave a live token behind. */
function clearVendorHome(spec, vendorHome) {
  if (!spec.vendorHome || !vendorHome) return;
  for (const name of spec.vendorHome.credentials) {
    try {
      fs.rmSync(path.join(vendorHome, name), { force: true });
    } catch {
      /* already gone */
    }
  }
}

/** Find a CLI on PATH (plus the usual per-user install folders). Windows looks
 *  for .exe only: a .cmd shim cannot run without a shell, and there is none. */
function findBin(name, source = process.env) {
  const home = os.homedir();
  const dirs = [
    ...String(source.PATH || "").split(path.delimiter),
    path.join(home, ".local", "bin"),
    path.join(home, `.${name}`, "bin"),
    path.join(home, ".grok", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ].filter(Boolean);
  const exts = process.platform === "win32" ? [".exe"] : [""];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, name + e);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/**
 * Spawn one CLI call and collect its output, bounded on every axis.
 * `command` may be an array ([interpreter, script]) so tests can use fakes.
 * Resolves {stdout, stderr, code}; rejects on overflow, timeout or abort.
 */
function runCli({ command, args, stdin = "", cwd, env, timeoutMs, maxStdout, maxStderr, signal, spawnImpl = spawn }) {
  const [cmd, ...pre] = Array.isArray(command) ? command : [command];
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const group = process.platform !== "win32";
    const child = spawnImpl(cmd, [...pre, ...args], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: group,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    let settled = false;
    let killTimer = null;
    const kill = () => {
      const hit = (sig) => {
        try {
          if (group && child.pid) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            /* already gone */
          }
        }
      };
      hit("SIGTERM");
      killTimer = setTimeout(() => hit("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      fn(value);
    };
    const fail = (e) => {
      if (settled) return;
      kill();
      finish(reject, e);
    };
    const onAbort = () => fail(abortError());
    const timer = setTimeout(() => fail(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    timer.unref?.();
    signal?.addEventListener?.("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => {
      out = Buffer.concat([out, d]);
      if (out.length > maxStdout) fail(new Error(`output exceeded ${maxStdout} bytes`));
    });
    child.stderr.on("data", (d) => {
      err = Buffer.concat([err, d]);
      if (err.length > maxStderr) err = err.subarray(err.length - maxStderr);
    });
    child.on("error", (e) => finish(reject, e));
    child.on("close", (code) => {
      clearTimeout(killTimer);
      finish(resolve, { stdout: out.toString("utf8"), stderr: err.toString("utf8"), code });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

function abortError() {
  const e = new Error("stopped");
  e.name = "AbortError";
  return e;
}

/** The CodeAgent conversation, flattened into one prompt for a single reply. */
function flattenMessages(messages) {
  const head =
    "You are the reasoning model behind Koinos Code, a coding agent running on the person's computer.\n" +
    "In this session you have NO tools, files, shell or network of your own — do not try to use any, and do not " +
    "claim to have read or changed anything yourself. Koinos Code acts for you: to read, search, edit or run " +
    "something, reply with exactly one tool call in the JSON format the SYSTEM section describes, and its result " +
    "will come back in the next prompt. Reply with ONLY your next message.";
  const label = { system: "SYSTEM", user: "USER", assistant: "ASSISTANT (your earlier reply)" };
  const body = (Array.isArray(messages) ? messages : [])
    .map((m) => `=== ${label[m?.role] || "USER"} ===\n${typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "")}`)
    .join("\n\n");
  const trailer = "\n\n=== YOUR NEXT MESSAGE ===\n";
  const room = Math.max(0, MAX_PROMPT_CHARS - head.length - trailer.length - 32);
  const clipped = body.length > room ? `[earlier context truncated]\n${body.slice(-room)}` : body;
  return `${head}\n\n${clipped}${trailer}`;
}

class CliProviders {
  /**
   * settings: {get(key, dflt), set(key, value)} — enablement persists there.
   * privacyMode(): "local-only" | "local-first" | "network".
   * bins: {codex: "/path" | [interp, script]} overrides discovery (tests).
   */
  constructor({ settings, privacyMode = () => "local-only", bins = {}, spawnImpl = spawn, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, maxStdout = DEFAULT_MAX_STDOUT, maxStderr = DEFAULT_MAX_STDERR } = {}) {
    this.settings = settings;
    this.privacyMode = privacyMode;
    this.bins = bins;
    this.spawnImpl = spawnImpl;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.maxStdout = maxStdout;
    this.maxStderr = maxStderr;
  }

  _enabled() {
    const v = this.settings?.get("code.cliProviders", {});
    return v && typeof v === "object" ? v : {};
  }

  _bin(provider) {
    return this.bins[provider] || findBin(PROVIDERS[provider].bin, this.env);
  }

  list() {
    const on = this._enabled();
    return Object.entries(PROVIDERS).map(([provider, s]) => ({
      id: `cli:${provider}`,
      provider,
      label: s.label,
      plan: s.plan,
      vendor: s.vendor,
      login: s.login,
      enabled: on[provider] === true,
      installed: !!this._bin(provider),
      loggedIn: loggedIn(s, this.env),
    }));
  }

  setEnabled(provider, enabled) {
    if (!PROVIDERS[provider]) throw new Error(`unknown subscription provider: ${String(provider).slice(0, 40)}`);
    this.settings.set("code.cliProviders", { ...this._enabled(), [provider]: enabled === true });
    return this.list();
  }

  /** Why this id cannot run right now, or null when it can. Checked in order:
   *  shape, privacy, the person's opt-in, and the CLI being present. */
  unavailable(id) {
    let p;
    try {
      p = parseModelId(id);
    } catch (e) {
      return e.message;
    }
    if (!p) return "not a subscription model";
    const s = PROVIDERS[p.provider];
    if (this.privacyMode() === "local-only") {
      return `Privacy mode is Local-Only: ${s.label} would send your project's code to ${s.vendor}, so it is disabled on this machine.`;
    }
    if (this._enabled()[p.provider] !== true) return `${s.label} is not enabled for Koinos Code (Subscriptions…).`;
    if (!this._bin(p.provider)) return `${s.label} is not installed — the \`${s.bin}\` command was not found.`;
    return null;
  }

  /** One completion. Same contract as the loopback chatFn: returns the text. */
  async chat({ model, messages, signal, effort = "" }) {
    const why = this.unavailable(model);
    if (why) throw new Error(why); // every refusal lands before a spawn
    const p = parseModelId(model);
    const spec = PROVIDERS[p.provider];
    const bin = this._bin(p.provider);
    const level = normalizeEffort(effort);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "koinos-code-cli-"));
    let scratchHome = "";
    let vendorHome = "";
    try {
      const prompt = flattenMessages(messages);
      if (spec.promptFile) fs.writeFileSync(path.join(scratch, spec.promptFile), prompt, { mode: 0o600 });
      // An empty home under the scratch tree, so it is torn down in `finally`
      // with everything else. It sits inside the cwd, which is harmless: the
      // cwd is itself a fresh empty directory and the CLI has no tool to read
      // either of them.
      if (spec.scratchHome) {
        scratchHome = path.join(scratch, "home");
        fs.mkdirSync(scratchHome, { mode: 0o700, recursive: true });
        // ...and a vendor state dir holding nothing but the sign-in credential.
        vendorHome = prepareVendorHome(spec, this.env, scratch);
      }
      let r;
      try {
        r = await runCli({
          command: bin,
          args: spec.args({ scratch, model: p.model, effort: level }),
          stdin: spec.promptFile ? "" : prompt,
          cwd: scratch,
          env: childEnv(spec, Array.isArray(bin) ? bin[0] : bin, this.env, { scratchHome, vendorHome }),
          timeoutMs: this.timeoutMs,
          maxStdout: this.maxStdout,
          maxStderr: this.maxStderr,
          signal,
          spawnImpl: this.spawnImpl,
        });
      } catch (e) {
        if (e.name === "AbortError") throw e;
        throw new Error(`${spec.label} ${e.code === "ENOENT" ? "is not installed" : e.message}`);
      }
      if (r.code !== 0) {
        throw new Error(
          `${spec.label} failed (exit ${r.code}): ${tail(r.stderr || r.stdout) || "no output"}. ` +
            `If you are not signed in, run \`${spec.login}\` in a terminal — Koinos AI never signs in for you.`
        );
      }
      const text = String(spec.read({ stdout: r.stdout, scratch, maxStdout: this.maxStdout }) || "").trim();
      if (!text) throw new Error(`${spec.label} returned an empty reply`);
      return text;
    } finally {
      clearVendorHome(spec, vendorHome);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

module.exports = {
  CliProviders,
  PROVIDERS,
  parseModelId,
  isCliModel,
  flattenMessages,
  childEnv,
  prepareVendorHome,
  clearVendorHome,
  runCli,
  findBin,
  loggedIn,
  normalizeEffort,
  effortArgs,
  EFFORT_LEVELS,
  assertNoGrokTools,
  readGrokStream,
  looksTruncatedJson,
  GROK_ANNOUNCED_COMMANDS,
  GROK_ALLOW_SEED,
  GROK_REMOVE_TOOLS,
  GROK_DENY_RULES,
  GROK_VERIFIED_VERSION,
};
