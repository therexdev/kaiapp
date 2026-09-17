"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const http = require("http");

const {
  CliProviders,
  PROVIDERS,
  parseModelId,
  isCliModel,
  flattenMessages,
  childEnv,
  runCli,
  normalizeEffort,
  effortArgs,
  assertNoGrokTools,
  readGrokStream,
  looksTruncatedJson,
  prepareVendorHome,
  clearVendorHome,
  GROK_ALLOW_SEED,
  GROK_REMOVE_TOOLS,
  GROK_DENY_RULES,
} = require("../lib/code-cli-providers");
const { CodeAgent } = require("../lib/code-agent");
const { Gateway } = require("../lib/gateway");
const { pickModel } = require("../../cli/koinos-code.js");

/* A Grok streaming-json stream from a properly confined session: it announces an
 * empty toolset and makes no tool calls. Shaped from real `grok 1.0.34` output,
 * including the six-entry slash-command menu it announces alongside `tools` on
 * every single announcement — `commands` is NEVER empty in a healthy run, which
 * is why the guard allow-lists that menu instead of refusing on non-empty. */
const GROK_MENU = ["compact", "always-approve", "context", "session-info", "feedback", "goal"];
function grokStream(text, { tools = [], calls = [], commands = GROK_MENU } = {}) {
  const lines = [];
  if (tools !== null) lines.push(JSON.stringify({ type: "available_commands", tools, commands }));
  for (const c of calls) lines.push(JSON.stringify({ type: "tool_call", toolCallId: "call-1", toolName: c, kind: c, status: "pending", rawInput: {} }));
  for (const ch of String(text)) lines.push(JSON.stringify({ type: "text", data: ch }));
  lines.push(JSON.stringify({ type: "end", stopReason: "end_turn", usage: {} }));
  return lines.join("\n") + "\n";
}

function memSettings(initial = {}) {
  const store = { ...initial };
  return {
    get: (k, d) => (store[k] !== undefined ? store[k] : d),
    set: (k, v) => {
      store[k] = v;
    },
    _store: store,
  };
}

/** Fake child process: emits stdout/stderr then closes. */
function fakeSpawnFactory({ stdout = "", stderr = "", code = 0, delayMs = 5, onSpawn } = {}) {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.kill = (sig) => {
      child._killed = sig;
      setTimeout(() => child.emit("close", null), 1);
    };
    const rec = { cmd, args, opts, child };
    calls.push(rec);
    onSpawn?.(rec);
    setTimeout(() => {
      if (child._killed) return;
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    }, delayMs);
    return child;
  };
  return { spawnImpl, calls };
}

test("parseModelId: valid ids, rejects malformed and injection-like shapes", () => {
  assert.deepStrictEqual(parseModelId("cli:codex"), { id: "cli:codex", provider: "codex", model: "" });
  assert.deepStrictEqual(parseModelId("cli:claude:sonnet"), { id: "cli:claude:sonnet", provider: "claude", model: "sonnet" });
  assert.deepStrictEqual(parseModelId("cli:grok:grok-4"), { id: "cli:grok:grok-4", provider: "grok", model: "grok-4" });
  assert.strictEqual(parseModelId("dev-tiny"), null);
  assert.strictEqual(isCliModel("cli:codex"), true);
  assert.strictEqual(isCliModel("codex"), false);

  for (const bad of [
    "cli:",
    "cli:Codex",
    "cli:unknown",
    "cli:claude:-evil",
    "cli:claude: has space",
    "cli:claude:../../etc/passwd",
    "cli:claude;rm -rf /",
    "cli:claude:`id`",
    "cli:claude:$(reboot)",
    "cli:claude:\n--help",
  ]) {
    assert.throws(() => parseModelId(bad), /not a valid subscription model id/, bad);
  }
});

test("provider argv: verified flags, shell:false, scratch cwd, no project path leak", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "kai-proj-secret-"));
  const secret = path.join(project, "secret.txt");
  fs.writeFileSync(secret, "TOPSECRET");

  for (const provider of ["codex", "claude", "grok"]) {
    const { spawnImpl, calls } = fakeSpawnFactory({
      stdout:
        provider === "claude"
          ? JSON.stringify({ result: '{"answer": true}' })
          : provider === "grok"
            ? grokStream('{"answer": true}')
            : '{"answer": true}',
    });
    const settings = memSettings();
    settings.set("code.cliProviders", { [provider]: true });
    const fakeBin = path.join(os.tmpdir(), `fake-${provider}-bin`);
    fs.writeFileSync(fakeBin, "#!/bin/sh\n");
    fs.chmodSync(fakeBin, 0o755);
    const cp = new CliProviders({
      settings,
      privacyMode: () => "local-first",
      bins: { [provider]: fakeBin },
      spawnImpl,
      env: { PATH: "/usr/bin", HOME: os.homedir(), LANG: "C" },
    });
    await cp.chat({ model: `cli:${provider}`, messages: [{ role: "user", content: "ping" }] });
    assert.strictEqual(calls.length, 1, provider);
    const { cmd, args, opts } = calls[0];
    assert.strictEqual(cmd, fakeBin);
    assert.strictEqual(opts.shell, false, `${provider} must spawn with shell:false`);
    assert.ok(opts.cwd && opts.cwd.includes("koinos-code-cli-"), `${provider} cwd is scratch`);
    assert.notStrictEqual(opts.cwd, project);
    const blob = JSON.stringify({ cmd, args, opts });
    assert.ok(!blob.includes(project), `${provider} must not disclose project path: ${blob.slice(0, 200)}`);
    assert.ok(!blob.includes(secret), `${provider} must not disclose project files in argv`);
    assert.ok(!("PWD" in opts.env), `${provider} env must not carry PWD`);
    assert.ok(!("OLDPWD" in opts.env), `${provider} env must not carry OLDPWD`);
    assert.ok(!("INIT_CWD" in opts.env), `${provider} env must not carry INIT_CWD`);

    if (provider === "codex") {
      assert.ok(args.includes("exec"));
      assert.ok(args.includes("--sandbox") && args.includes("read-only"));
      assert.ok(args.includes("--ignore-user-config"));
      assert.ok(args.includes("--ephemeral"));
      assert.ok(args.includes("--cd"));
      assert.ok(args.includes("-"));
    }
    if (provider === "claude") {
      assert.ok(args.includes("--print"));
      assert.ok(args.includes("--tools") && args.includes(""));
      assert.ok(args.includes("--safe-mode"));
      // Defence in depth, verified compatible with --print and subscription auth.
      assert.ok(args.includes("--restricted"), "--restricted also drops the code-running built-ins and ignores settings files");
      assert.ok(args.includes("--strict-mcp-config"));
      assert.ok(args.includes("--permission-prompts") && args.includes("none"));
      assert.ok(!args.includes("--bare"), "--bare would break subscription auth");
    }
    if (provider === "grok") {
      /*
       * Pinned exactly, because `--tools ""` was measured NOT to be an empty
       * allow-list in grok 1.0.34: it leaves all 25 built-ins live. The only
       * combination that emptied the toolset was a real seed name in --tools
       * removed again by --disallowed-tools. See the evidence table in
       * docs/koinos-code-design.md.
       */
      const at = (flag) => args[args.indexOf(flag) + 1];
      assert.strictEqual(args.indexOf("--tools") >= 0, true);
      assert.strictEqual(at("--tools"), GROK_ALLOW_SEED, "--tools must name a REAL tool or grok ignores the allow-list");
      assert.notStrictEqual(at("--tools"), "", '--tools "" fails open on grok — never ship it');
      const removed = at("--disallowed-tools").split(",");
      assert.ok(removed.includes(GROK_ALLOW_SEED), "the allow-list seed must be removed again, or the toolset is not empty");
      for (const t of ["run_terminal_command", "read_file", "search_replace", "write", "use_tool", "search_tool", "Agent"]) {
        assert.ok(removed.includes(t), `--disallowed-tools must name ${t}`);
      }
      // Deny rules held even against --always-approve, so they are a real layer.
      for (const rule of GROK_DENY_RULES) {
        assert.ok(args.some((a, i) => a === "--deny" && args[i + 1] === rule), `--deny ${rule}`);
      }
      assert.strictEqual(at("--permission-mode"), "dontAsk");
      // The toolset read-back only exists in this format. Do not relax to plain.
      assert.strictEqual(at("--output-format"), "streaming-json");
      assert.ok(args.includes("--prompt-file"));
      assert.ok(!args.includes("--sandbox"), "grok's macOS sandbox refuses to start over /var/run/docker.sock");
      assert.ok(!args.includes("--always-approve"));
      assert.ok(args.includes("--max-turns") && args.includes("1"));
      assert.ok(args.includes("--disable-web-search"));
      assert.ok(args.includes("--no-subagents") && args.includes("--no-plan"));
      // The leader socket must be inside scratch: the default is
      // `$GROK_HOME/leader.sock`, and attaching to a leader already running for
      // the real profile would undo the scratch home.
      assert.strictEqual(at("--leader-socket"), path.join(opts.cwd, "leader.sock"));
      // MCP tools, hooks, plugins, skills, rules and memory come from HOME *and*
      // from GROK_HOME, so BOTH are scratch. GROK_HOME pointing at the real
      // ~/.grok is exactly the hole this replaced.
      assert.strictEqual(opts.env.HOME, path.join(opts.cwd, "home"));
      assert.strictEqual(opts.env.GROK_HOME, path.join(opts.cwd, "grok-home"));
      assert.notStrictEqual(opts.env.GROK_HOME, path.join(os.homedir(), ".grok"));
      assert.ok(opts.env.GROK_HOME.startsWith(opts.cwd + path.sep), "the vendor home must live inside the scratch tree");
      assert.strictEqual(opts.env.GROK_CLAUDE_MCPS_ENABLED, "0");
      assert.strictEqual(opts.env.GROK_CURSOR_MCPS_ENABLED, "0");
      // A harness run must not swap the binary out from under the confinement.
      assert.strictEqual(opts.env.GROK_DISABLE_AUTOUPDATER, "1");
    }
  }
});

/*
 * Grok's tool-disable flags were measured against the installed CLI rather than
 * trusted, and two of the three documented mechanisms failed OPEN. These tests
 * pin the invariant that survived: whatever the flags do, a reply is only
 * accepted from a session that provably had no tools.
 */
test("grok fail-closed: a reply is refused unless the session provably had no tools", () => {
  // The confined shape: empty toolset, no calls. This is the only one accepted.
  assert.strictEqual(readGrokStream(grokStream("hello")), "hello");

  // A live built-in means the flags did not do what 1.0.34 measured them doing.
  assert.throws(
    () => readGrokStream(grokStream("hi", { tools: ["run_terminal_command", "write"] })),
    /kept 2 of its own tool|Refusing the reply/
  );

  // MCP tools come from the person's machine config, not a version change, and
  // get their own message — but are refused just as hard.
  assert.throws(
    () => readGrokStream(grokStream("hi", { tools: ["github__create_or_update_file"] })),
    /MCP tool\(s\) from machine configuration/
  );

  // No announcement at all: cannot verify, so do not trust.
  assert.throws(() => readGrokStream('{"type":"text","data":"hi"}'), /did not report the tools it was given/);
  assert.throws(() => readGrokStream(""), /did not report the tools it was given/);

  // Grok announces its toolset more than once per session; MCP servers connect
  // late and show up only in a later announcement. Every one must be empty.
  const late =
    JSON.stringify({ type: "available_commands", tools: [] }) + "\n" +
    JSON.stringify({ type: "text", data: "hi" }) + "\n" +
    JSON.stringify({ type: "available_commands", tools: ["playwright__browser_run_code_unsafe"] }) + "\n";
  assert.throws(() => readGrokStream(late), /Refusing the reply/);

  // A tool call that was DENIED still proves the tool was in the model's hands.
  assert.throws(
    () => readGrokStream(grokStream("hi", { calls: ["use_tool"] })),
    /tried to use its own tools \(use_tool\)/
  );

  // A truncated trailing line must not lose an otherwise-valid run.
  assert.strictEqual(readGrokStream(grokStream("ok") + '{"type":"te'), "ok");
});

/*
 * Adversarial shapes for the read-back itself. Every one of these is a stream
 * that the previous guard ACCEPTED: it only checked that an `available_commands`
 * event existed, and read `e.tools` with `Array.isArray(...) ? ... : []`, so any
 * build that dropped, renamed or re-typed that field read as "no tools" and
 * handed the reply back. Existence is not verification.
 */
test("grok fail-closed: an unreadable toolset shape is refused, not read as empty", () => {
  const ann = (o) => JSON.stringify({ type: "available_commands", ...o });
  const body = '\n{"type":"text","data":"hi"}\n{"type":"end","stopReason":"end_turn"}\n';
  const schemaFail = /in a shape Koinos AI can read|did not report the tools it was given/;

  // `tools` missing entirely — the field was dropped or is not sent yet.
  assert.throws(() => readGrokStream(ann({ commands: GROK_MENU }) + body), schemaFail, "missing tools property");
  // `tools` re-typed. An object of {name: spec} is a plausible future shape and
  // is exactly what `Array.isArray(...) ? ... : []` silently read as empty.
  assert.throws(() => readGrokStream(ann({ tools: { read_file: {} }, commands: GROK_MENU }) + body), schemaFail, "tools as object");
  assert.throws(() => readGrokStream(ann({ tools: "read_file,write" }) + body), schemaFail, "tools as string");
  assert.throws(() => readGrokStream(ann({ tools: null }) + body), schemaFail, "tools as null");
  assert.throws(() => readGrokStream(ann({ tools: 0 }) + body), schemaFail, "tools as number");
  // `tools` renamed: the toolset moved to another key. Nothing named `tools` is
  // an array any more, so the run is unverifiable.
  assert.throws(() => readGrokStream(ann({ availableTools: ["read_file"], commands: GROK_MENU }) + body), schemaFail, "tools renamed");
  // One good announcement does not excuse a later unreadable one: MCP servers
  // connect late, and a late announcement is where they would show up.
  assert.throws(
    () => readGrokStream(ann({ tools: [], commands: GROK_MENU }) + "\n" + ann({ tools: { late: {} } }) + body),
    schemaFail,
    "a later unshaped announcement"
  );
  // The shape that must still work: a real, positively-shaped empty array.
  assert.strictEqual(readGrokStream(ann({ tools: [], commands: GROK_MENU }) + body), "hi");
});

test("grok fail-closed: the sibling `commands` field is inspected too", () => {
  const ann = (o) => JSON.stringify({ type: "available_commands", ...o });
  const body = '\n{"type":"text","data":"hi"}\n{"type":"end","stopReason":"end_turn"}\n';

  // The measured menu is non-empty on EVERY announcement of a healthy 1.0.34
  // run, so "refuse when commands is non-empty" would refuse every real reply.
  // It is allow-listed by exact name instead.
  assert.strictEqual(readGrokStream(ann({ tools: [], commands: GROK_MENU }) + body), "hi");

  // A build that moves its toolset into `commands` while leaving `tools` an
  // empty array is the case the allow-list exists to catch.
  assert.throws(
    () => readGrokStream(ann({ tools: [], commands: [...GROK_MENU, "run_terminal_command"] }) + body),
    /run_terminal_command/,
    "non-empty commands with empty tools"
  );
  assert.throws(
    () => readGrokStream(ann({ tools: [], commands: ["github__create_or_update_file"] }) + body),
    /MCP tool\(s\)/,
    "an MCP tool announced under commands"
  );
  // Object entries are named, not stringified into noise, and still refuse.
  assert.throws(() => readGrokStream(ann({ tools: [{ name: "write" }], commands: GROK_MENU }) + body), /write/, "object-shaped tool entry");
  // An entry whose shape we cannot name is still an entry.
  assert.throws(() => readGrokStream(ann({ tools: [{ weird: 1 }], commands: GROK_MENU }) + body), /Refusing the reply/, "unnameable tool entry");
});

/*
 * Parser strictness. assertNoGrokTools can only refuse a `tool_call` it can
 * SEE, so a line that fails to parse may BE the event that would have refused
 * the reply. The old parser swallowed every parse failure anywhere in the
 * stream, which made a single corrupt line enough to hide a tool call.
 */
test("grok fail-closed: malformed mid-stream JSON refuses; only a truncated final line is tolerated", () => {
  const ok = grokStream("hello");
  assert.strictEqual(readGrokStream(ok), "hello");

  const head = JSON.stringify({ type: "available_commands", tools: [], commands: GROK_MENU });
  const tailEnd = '{"type":"text","data":"hi"}\n{"type":"end","stopReason":"end_turn"}\n';

  // Malformed in the middle — including a line that would have been a tool_call.
  assert.throws(() => readGrokStream(head + '\n{"type":"tool_call","toolName":\n' + tailEnd), /unreadable mid-stream line/, "broken mid-stream object");
  assert.throws(() => readGrokStream(head + "\nnot json at all\n" + tailEnd), /unreadable mid-stream line/, "non-JSON mid-stream line");
  assert.throws(() => readGrokStream(head + '\n{"type":"text",,}\n' + tailEnd), /unreadable mid-stream line/, "malformed but closed object");
  // ...and trailing blank lines must not disguise a mid-stream failure as final.
  assert.throws(() => readGrokStream(head + "\n{bad\n" + tailEnd + "\n\n"), /unreadable mid-stream line/, "broken line before the end");

  // A genuinely cut-off tail is what a stdout cap or a killed process produces,
  // and it must not lose an otherwise-verified run.
  assert.strictEqual(readGrokStream(ok + '{"type":"te'), "hello");
  assert.strictEqual(readGrokStream(ok + '{"type":"text","data":"x'), "hello");
  assert.strictEqual(readGrokStream(ok + '{"type":"text","data":{"a":[1,'), "hello");

  // A FINAL line that is malformed rather than truncated is still refused: it
  // closed its own structure, so nothing was cut off — it was corrupt.
  assert.throws(() => readGrokStream(ok + '{"type":,}'), /unreadable final line/, "malformed, not truncated, final line");
  assert.throws(() => readGrokStream(ok + "garbage"), /unreadable final line/, "non-JSON final line");
  assert.throws(() => readGrokStream(ok + '{"a":1}}'), /unreadable final line/, "over-closed final line");

  // The classifier itself, stated directly.
  assert.strictEqual(looksTruncatedJson('{"type":"te'), true);
  assert.strictEqual(looksTruncatedJson('{"a":[1,2'), true);
  assert.strictEqual(looksTruncatedJson('{"a":"b\\\\'), true);
  assert.strictEqual(looksTruncatedJson('{"type":,}'), false);
  assert.strictEqual(looksTruncatedJson("garbage"), false);
  assert.strictEqual(looksTruncatedJson('{"a":1}}'), false);

  // And a truncated tail can never RESCUE a stream that already failed.
  assert.throws(() => readGrokStream(grokStream("hi", { tools: ["read_file"] }) + '{"type":"te'), /Refusing the reply/);
});

test("grok fail-closed: chat() refuses the reply, so an unconfined run reaches nobody", async () => {
  const menu = JSON.stringify(GROK_MENU);
  for (const [label, stdout] of [
    ["live built-in", grokStream("I read your files.", { tools: ["read_file"] })],
    ["live MCP tool", grokStream("Done.", { tools: ["github__push_files"] })],
    ["a tool call", grokStream("Done.", { calls: ["run_terminal_command"] })],
    ["no announcement", '{"type":"text","data":"Done."}'],
    ["tools property missing", `{"type":"available_commands","commands":${menu}}\n{"type":"text","data":"Done."}`],
    ["tools not an array", `{"type":"available_commands","tools":{"write":{}},"commands":${menu}}\n{"type":"text","data":"Done."}`],
    ["tools renamed", `{"type":"available_commands","availableTools":["write"],"commands":${menu}}\n{"type":"text","data":"Done."}`],
    ["a tool hidden in commands", `{"type":"available_commands","tools":[],"commands":["write"]}\n{"type":"text","data":"Done."}`],
    ["malformed mid-stream line", `{"type":"available_commands","tools":[],"commands":${menu}}\n{oops\n{"type":"text","data":"Done."}`],
  ]) {
    const { spawnImpl } = fakeSpawnFactory({ stdout });
    const cp = new CliProviders({
      settings: memSettings({ "code.cliProviders": { grok: true } }),
      privacyMode: () => "local-first",
      bins: { grok: "/bin/true" },
      spawnImpl,
    });
    await assert.rejects(
      () => cp.chat({ model: "cli:grok", messages: [{ role: "user", content: "x" }] }),
      /Refusing the reply/,
      label
    );
  }
});

test("grok confinement constants stay fail-closed", () => {
  // `--tools ""` restored the full toolset in 1.0.34. An empty seed, or a seed
  // that is not a real tool name, silently disables the allow-list entirely.
  assert.ok(GROK_ALLOW_SEED && GROK_ALLOW_SEED.trim(), "the allow-list seed must be a real, non-empty tool name");
  // Removing the seed again is what makes the toolset empty rather than {seed}.
  assert.ok(GROK_REMOVE_TOOLS.includes(GROK_ALLOW_SEED));
  assert.ok(GROK_DENY_RULES.includes("Bash") && GROK_DENY_RULES.includes("Write") && GROK_DENY_RULES.includes("MCPTool"));
  // No argv element may be an empty string: that is the shape that fooled us.
  const argv = PROVIDERS.grok.args({ scratch: "/tmp/scratch", model: "", effort: "" });
  assert.ok(!argv.includes(""), "an empty argv value is exactly the ambiguity this harness must not rely on");
});

test("grok scratch HOME and scratch GROK_HOME leave no name pointing at the real profile", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/Users/someone",
    XDG_CONFIG_HOME: "/Users/someone/.config",
    GROK_HOME: "/Users/someone/.grok",
    LANG: "C",
  };
  const env = childEnv(PROVIDERS.grok, "/opt/grok/bin/grok", source, {
    scratchHome: "/tmp/scratch/home",
    vendorHome: "/tmp/scratch/grok-home",
    platform: "linux",
  });
  // HOME is where ~/.claude.json, ~/.cursor/mcp.json and friends are found.
  assert.strictEqual(env.HOME, "/tmp/scratch/home");
  assert.notStrictEqual(env.HOME, source.HOME);
  /*
   * ...and GROK_HOME is a SECOND profile root. Pointing it at the real ~/.grok
   * is what this replaced: measured with `grok inspect`, the real one reports
   * `Skills (25)` and `Config Sources → User: ~/.grok/config.toml`; a scratch
   * one holding only auth.json reports `Skills (0)` and `User: (none)`.
   */
  assert.strictEqual(env.GROK_HOME, "/tmp/scratch/grok-home");
  assert.notStrictEqual(env.GROK_HOME, source.GROK_HOME);
  assert.ok(!Object.values(env).includes(source.HOME), "no variable may still name the real home");
  // Anything else that would walk back into the real profile goes.
  assert.ok(!("XDG_CONFIG_HOME" in env), "XDG_CONFIG_HOME would point back at the real home");
  assert.strictEqual(env.GROK_CLAUDE_MCPS_ENABLED, "0");
  assert.strictEqual(env.GROK_SUBAGENTS, "0");
  assert.strictEqual(env.GROK_DISABLE_AUTOUPDATER, "1");

  // Fail-closed: with no vendor home prepared, the variable is REMOVED rather
  // than left pointing at the real profile. The child then looks under the
  // scratch HOME, finds nothing, and exits "Not signed in".
  const noVendor = childEnv(PROVIDERS.grok, "/opt/grok/bin/grok", source, { scratchHome: "/tmp/scratch/home", platform: "linux" });
  assert.ok(!("GROK_HOME" in noVendor), "an unprepared vendor home must not fall back to the real one");

  // The other harnesses must NOT get a scratch home: they authenticate from it.
  const claudeEnv = childEnv(PROVIDERS.claude, "/opt/claude", source, { scratchHome: "/tmp/scratch/home", platform: "linux" });
  assert.strictEqual(claudeEnv.HOME, source.HOME);
});

/*
 * Windows names the home directory four more ways, and two of them (APPDATA,
 * LOCALAPPDATA) are absolute paths into the real profile in their own right —
 * deleting HOME-shaped variables alone would leave the profile reachable. They
 * are routed INTO scratch instead. Parameterized so this is covered on a
 * POSIX CI machine, without changing what POSIX does.
 */
test("childEnv: Windows home variables are routed into scratch, not merely dropped", () => {
  const source = {
    PATH: "C:\\Windows\\System32",
    HOME: "C:\\Users\\Someone",
    USERPROFILE: "C:\\Users\\Someone",
    APPDATA: "C:\\Users\\Someone\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\Someone\\AppData\\Local",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\Someone",
    GROK_HOME: "C:\\Users\\Someone\\.grok",
  };
  const scratchHome = "C:\\Temp\\koinos-code-cli-ab12\\home";
  const env = childEnv(PROVIDERS.grok, null, source, {
    scratchHome,
    vendorHome: "C:\\Temp\\koinos-code-cli-ab12\\grok-home",
    platform: "win32",
  });
  assert.strictEqual(env.HOME, scratchHome);
  assert.strictEqual(env.USERPROFILE, scratchHome);
  assert.strictEqual(env.APPDATA, "C:\\Temp\\koinos-code-cli-ab12\\home\\AppData\\Roaming");
  assert.strictEqual(env.LOCALAPPDATA, "C:\\Temp\\koinos-code-cli-ab12\\home\\AppData\\Local");
  // HOMEDRIVE + HOMEPATH concatenate to a home path, so they must concatenate
  // to the SCRATCH one, not to a leftover of the real profile.
  assert.strictEqual(env.HOMEDRIVE + env.HOMEPATH, scratchHome);
  assert.strictEqual(env.GROK_HOME, "C:\\Temp\\koinos-code-cli-ab12\\grok-home");
  for (const [k, v] of Object.entries(env)) {
    assert.ok(!String(v).startsWith("C:\\Users\\Someone"), `${k} still names the real Windows profile: ${v}`);
  }

  // POSIX is unchanged: those variables have no meaning there and are dropped.
  const posix = childEnv(PROVIDERS.grok, null, source, { scratchHome: "/tmp/s/home", vendorHome: "/tmp/s/grok-home", platform: "linux" });
  for (const k of ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH"]) {
    assert.ok(!(k in posix), `${k} must not survive into a POSIX child`);
  }
  assert.strictEqual(posix.HOME, "/tmp/s/home");
});

/*
 * The credential copy. Only the sign-in file crosses into the scratch vendor
 * home — not config.toml, requirements.toml, managed_config.toml, hooks,
 * plugins, skills, agents, MCP definitions, rules or memory, all of which came
 * along for free while GROK_HOME pointed at the real ~/.grok.
 */
test("prepareVendorHome copies only the credential, at 0600, and clearVendorHome removes it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koinos-vendor-test-"));
  try {
    const real = path.join(root, "dot-grok");
    fs.mkdirSync(path.join(real, "hooks"), { recursive: true });
    fs.mkdirSync(path.join(real, "installed-plugins"), { recursive: true });
    fs.mkdirSync(path.join(real, "skills"), { recursive: true });
    fs.writeFileSync(path.join(real, "auth.json"), '{"token":"secret-value"}');
    fs.writeFileSync(path.join(real, "config.toml"), "[mcp_servers.github]\ncommand='x'\n");
    fs.writeFileSync(path.join(real, "requirements.toml"), "x=1\n");
    fs.writeFileSync(path.join(real, "managed_config.toml"), "x=1\n");
    fs.writeFileSync(path.join(real, "hooks", "pre.sh"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(real, "installed-plugins", "registry.json"), "{}");
    fs.writeFileSync(path.join(real, "skills", "thing.md"), "skill");

    const scratch = fs.mkdtempSync(path.join(root, "scratch-"));
    const dir = prepareVendorHome(PROVIDERS.grok, { HOME: root, GROK_HOME: real }, scratch);

    assert.deepStrictEqual(fs.readdirSync(dir), ["auth.json"], "nothing but the credential may be copied");
    assert.strictEqual(fs.readFileSync(path.join(dir, "auth.json"), "utf8"), '{"token":"secret-value"}');
    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(path.join(dir, "auth.json")).mode & 0o777, 0o600, "the copied token must not be group/world readable");
      assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
    }

    clearVendorHome(PROVIDERS.grok, dir);
    assert.strictEqual(fs.existsSync(path.join(dir, "auth.json")), false, "the copied credential must not outlive the run");
    // Idempotent: the `finally` path runs even when the scratch tree is gone.
    clearVendorHome(PROVIDERS.grok, dir);

    // A profile with no credential is not an error here: the CLI's own
    // "Not signed in" exit (measured: exit 1 in under a second, no login
    // prompt) is a better message than anything this could invent.
    const bare = fs.mkdtempSync(path.join(root, "scratch2-"));
    const emptyDir = prepareVendorHome(PROVIDERS.grok, { HOME: root, GROK_HOME: path.join(root, "nope") }, bare);
    assert.deepStrictEqual(fs.readdirSync(emptyDir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("chat() leaves no copied credential behind, even when the run fails", async () => {
  const realGrok = fs.mkdtempSync(path.join(os.tmpdir(), "koinos-realgrok-"));
  fs.writeFileSync(path.join(realGrok, "auth.json"), '{"token":"t"}');
  const seen = [];
  try {
    for (const stdout of [grokStream("fine"), grokStream("bad", { tools: ["read_file"] })]) {
      const { spawnImpl } = fakeSpawnFactory({
        stdout,
        onSpawn: (rec) => seen.push(rec.opts.env.GROK_HOME),
      });
      const cp = new CliProviders({
        settings: memSettings({ "code.cliProviders": { grok: true } }),
        privacyMode: () => "local-first",
        bins: { grok: "/bin/true" },
        spawnImpl,
        env: { PATH: "/usr/bin", HOME: os.homedir(), GROK_HOME: realGrok, LANG: "C" },
      });
      await cp.chat({ model: "cli:grok", messages: [{ role: "user", content: "x" }] }).catch(() => {});
    }
    assert.strictEqual(seen.length, 2);
    for (const dir of seen) {
      assert.ok(dir && dir !== realGrok, "the child must never be handed the real vendor home");
      assert.strictEqual(fs.existsSync(path.join(dir, "auth.json")), false, "the copied credential must be gone");
      assert.strictEqual(fs.existsSync(dir), false, "and so must the whole scratch tree");
    }
    // The real profile is untouched by any of this.
    assert.strictEqual(fs.readFileSync(path.join(realGrok, "auth.json"), "utf8"), '{"token":"t"}');
  } finally {
    fs.rmSync(realGrok, { recursive: true, force: true });
  }
});

test("Local-Only refuses before any spawn", async () => {
  let spawned = 0;
  const { spawnImpl } = fakeSpawnFactory({ onSpawn: () => { spawned++; } });
  const settings = memSettings({ "code.cliProviders": { claude: true } });
  const cp = new CliProviders({
    settings,
    privacyMode: () => "local-only",
    bins: { claude: "/usr/bin/true" },
    spawnImpl,
  });
  assert.match(cp.unavailable("cli:claude"), /Local-Only/);
  await assert.rejects(() => cp.chat({ model: "cli:claude", messages: [{ role: "user", content: "x" }] }), /Local-Only/);
  assert.strictEqual(spawned, 0, "must not spawn under Local-Only");
});

test("opt-in and missing install refuse before spawn; list reports status", () => {
  const settings = memSettings();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cli-home-"));
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), '{"token":"x"}');
  const cp = new CliProviders({
    settings,
    privacyMode: () => "network",
    bins: { codex: "/usr/bin/true", claude: null, grok: null },
    env: { HOME: home, PATH: "" },
    spawnImpl: () => {
      throw new Error("should not spawn");
    },
  });
  // Override findBin via bins: claude/grok falsy means not installed once enabled.
  cp.bins = { codex: "/usr/bin/true" };
  assert.match(cp.unavailable("cli:codex"), /not enabled/);
  const listed = cp.setEnabled("codex", true);
  assert.strictEqual(listed.find((p) => p.provider === "codex").enabled, true);
  assert.strictEqual(listed.find((p) => p.provider === "codex").installed, true);
  assert.strictEqual(listed.find((p) => p.provider === "codex").loggedIn, true);
  assert.strictEqual(cp.unavailable("cli:codex"), null);
  assert.match(cp.unavailable("cli:claude"), /not enabled|not installed/);
});

test("cancellation aborts an in-flight CLI call", async () => {
  const { spawnImpl, calls } = fakeSpawnFactory({ delayMs: 5000, stdout: "late" });
  const settings = memSettings({ "code.cliProviders": { claude: true } });
  const cp = new CliProviders({
    settings,
    privacyMode: () => "local-first",
    bins: { claude: "/usr/bin/true" },
    spawnImpl,
    timeoutMs: 30000,
  });
  const ac = new AbortController();
  const p = cp.chat({ model: "cli:claude", messages: [{ role: "user", content: "x" }], signal: ac.signal });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(calls.length, 1);
  ac.abort();
  await assert.rejects(p, (e) => e.name === "AbortError");
  assert.ok(calls[0].child._killed, "child was signalled");
});

test("output and timeout caps reject without hanging", async () => {
  {
    const { spawnImpl } = fakeSpawnFactory({ stdout: "x".repeat(200) });
    await assert.rejects(
      () =>
        runCli({
          command: "/usr/bin/true",
          args: [],
          cwd: os.tmpdir(),
          env: {},
          timeoutMs: 5000,
          maxStdout: 50,
          maxStderr: 100,
          spawnImpl,
        }),
      /output exceeded/
    );
  }
  {
    const { spawnImpl } = fakeSpawnFactory({ delayMs: 5000 });
    await assert.rejects(
      () =>
        runCli({
          command: "/usr/bin/true",
          args: [],
          cwd: os.tmpdir(),
          env: {},
          timeoutMs: 30,
          maxStdout: 1000,
          maxStderr: 1000,
          spawnImpl,
        }),
      /timed out/
    );
  }
});

test("provider output parsing: Claude JSON, Codex last-message file, Grok verified streaming-json", async () => {
  // Claude
  {
    const { spawnImpl } = fakeSpawnFactory({
      stdout: JSON.stringify({ result: "FROM_CLAUDE", is_error: false }),
    });
    const cp = new CliProviders({
      settings: memSettings({ "code.cliProviders": { claude: true } }),
      privacyMode: () => "local-first",
      bins: { claude: "/bin/true" },
      spawnImpl,
    });
    assert.strictEqual(await cp.chat({ model: "cli:claude", messages: [{ role: "user", content: "x" }] }), "FROM_CLAUDE");
  }
  {
    const { spawnImpl } = fakeSpawnFactory({ stdout: "not-json" });
    const cp = new CliProviders({
      settings: memSettings({ "code.cliProviders": { claude: true } }),
      privacyMode: () => "local-first",
      bins: { claude: "/bin/true" },
      spawnImpl,
    });
    await assert.rejects(() => cp.chat({ model: "cli:claude", messages: [{ role: "user", content: "x" }] }), /unreadable output/);
  }
  // Codex reads last-message.txt from scratch
  {
    const { spawnImpl } = fakeSpawnFactory({
      stdout: "ignored-stdout",
      onSpawn: ({ args }) => {
        const i = args.indexOf("--output-last-message");
        const file = args[i + 1];
        fs.writeFileSync(file, "FROM_CODEX_FILE");
      },
    });
    const cp = new CliProviders({
      settings: memSettings({ "code.cliProviders": { codex: true } }),
      privacyMode: () => "local-first",
      bins: { codex: "/bin/true" },
      spawnImpl,
    });
    assert.strictEqual(await cp.chat({ model: "cli:codex", messages: [{ role: "user", content: "x" }] }), "FROM_CODEX_FILE");
  }
  // Grok streaming-json, with an empty toolset announced
  {
    const { spawnImpl } = fakeSpawnFactory({ stdout: grokStream("  FROM_GROK  \n") });
    const cp = new CliProviders({
      settings: memSettings({ "code.cliProviders": { grok: true } }),
      privacyMode: () => "local-first",
      bins: { grok: "/bin/true" },
      spawnImpl,
    });
    assert.strictEqual(await cp.chat({ model: "cli:grok", messages: [{ role: "user", content: "x" }] }), "FROM_GROK");
  }
});

test("subscription brain reply flows through CodeAgent into an approval card", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cli-agent-"));
  const replies = [
    '{"tool": "write_file", "args": {"path": "hi.txt", "content": "from subscription\\n"}}',
    '{"answer": true}',
    "Wrote hi.txt via the card.",
  ];
  const settings = memSettings({ "code.cliProviders": { claude: true } });
  const cp = new CliProviders({
    settings,
    privacyMode: () => "local-first",
    bins: { claude: "/bin/true" },
    spawnImpl: (cmd, args, opts) => {
      const next = replies.shift() || "done";
      return fakeSpawnFactory({
        stdout: JSON.stringify({ result: next }),
      }).spawnImpl(cmd, args, opts);
    },
  });
  const agent = new CodeAgent({
    chatFn: (req) => cp.chat(req),
  });
  let card = null;
  const r = await agent.run({
    dir,
    task: "create hi.txt",
    model: "cli:claude",
    onTrace: (e) => {
      if (e.type === "approval-request") {
        card = e;
        assert.strictEqual(e.kind, "edit");
        assert.strictEqual(e.path, "hi.txt");
        assert.match(e.diff, /\+ from subscription/);
        agent.provideApproval(e.approvalId, true);
      }
    },
  });
  assert.ok(card, "approval card was shown");
  assert.strictEqual(r.reason, "answered");
  assert.strictEqual(fs.readFileSync(path.join(dir, "hi.txt"), "utf8"), "from subscription\n");
  assert.match(r.answer, /Wrote hi\.txt/);
});

test("gateway _codeDefaultModel / _codeModelUsable precedence helpers", () => {
  const aliases = [
    { alias: "missing-one", status: "absent" },
    { alias: "ready-a", status: "ready" },
    { alias: "ready-b", status: "ready" },
  ];
  const gw = new Gateway({
    port: 0,
    keys: { required: () => false },
    models: { aliases: () => aliases, resolveAlias: (a) => ({ alias: a }) },
    runtime: {
      status: () => ({ activeAlias: "ready-b", runtime: { running: true } }),
    },
    code: {
      cliProviders: {
        unavailable: (id) => (id === "cli:claude" ? null : "nope"),
      },
    },
  });
  assert.strictEqual(gw._codeDefaultModel(), "ready-b", "live running ready wins");
  assert.strictEqual(gw._codeModelUsable("ready-a"), true);
  assert.strictEqual(gw._codeModelUsable("missing-one"), false);
  assert.strictEqual(gw._codeModelUsable("cli:claude"), true);
  assert.strictEqual(gw._codeModelUsable("cli:codex"), false);

  gw.runtime = { status: () => ({ activeAlias: "ready-b", runtime: { running: false } }) };
  assert.strictEqual(gw._codeDefaultModel(), "ready-a", "first ready when nothing is running");
});

test("gateway HTTP: cli:* rejected from chat and /v1/models; providers + code run accept", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cli-http-"));
  fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const { createCore } = require("../server");
  const core = await createCore({
    dataDir,
    port: 0,
    llamaBin: path.join(__dirname, "fixtures", "fake-llama-server"),
    onEvent: () => {},
  });
  const base = `http://127.0.0.1:${await core.start()}`;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cli-proj-"));
  try {
    // Refuse from public and control-plane chat.
    for (const route of ["/v1/chat/completions", "/core/chat/completions"]) {
      const r = await fetch(`${base}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "cli:claude", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.strictEqual(r.status, 403, route);
      const j = await r.json();
      assert.strictEqual(j.error.type, "code_only");
    }
    const models = await (await fetch(`${base}/v1/models`)).json();
    assert.ok(!models.data.some((m) => String(m.id).startsWith("cli:")), "cli:* not in /v1/models");

    await fetch(`${base}/core/code-switch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    // Local-Only: enabling is allowed, but a run with cli:* is refused before spawn.
    const providers = await (await fetch(`${base}/core/code/providers`)).json();
    assert.ok(providers.ok);
    assert.strictEqual(providers.privacyMode, "local-only");
    assert.ok(providers.providers.some((p) => p.id === "cli:codex"));

    await fetch(`${base}/core/code/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "claude", enabled: true }),
    });
    // Inject a fake that would spawn if Local-Only did not refuse first.
    let spawned = 0;
    core.gateway.code.cliProviders.bins = { claude: "/bin/true" };
    core.gateway.code.cliProviders.spawnImpl = () => {
      spawned++;
      throw new Error("should not spawn");
    };
    const denied = await fetch(`${base}/core/code/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: project, task: "x", model: "cli:claude" }),
    });
    assert.strictEqual(denied.status, 400);
    assert.match((await denied.json()).error, /Local-Only/);
    assert.strictEqual(spawned, 0);

    // Malformed cli id on the run route.
    const bad = await fetch(`${base}/core/code/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: project, task: "x", model: "cli:claude;rm" }),
    });
    assert.strictEqual(bad.status, 400);
    assert.match((await bad.json()).error, /not a valid subscription model id/);
  } finally {
    await core.stop();
  }
});

test("gateway model precedence: usable pin, stale pin falls back, live default", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cli-prec-"));
  fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const script = path.join(dataDir, "script.json");
  fs.writeFileSync(script, JSON.stringify(["ok"]));
  process.env.FAKE_LLAMA_SCRIPT = script;
  process.env.FAKE_LLAMA_RECORD = path.join(dataDir, "requests.jsonl");
  const { createCore } = require("../server");
  const core = await createCore({
    dataDir,
    port: 0,
    llamaBin: path.join(__dirname, "fixtures", "fake-llama-server"),
    onEvent: () => {},
  });
  const base = `http://127.0.0.1:${await core.start()}`;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cli-p2-"));
  try {
    await fetch(`${base}/core/code-switch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const made = await (
      await fetch(`${base}/core/code/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir: project }),
      })
    ).json();
    const id = made.project.id;

    // Pin a ready model — used when the request omits model.
    await fetch(`${base}/core/code/projects/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "dev-tiny" }),
    });
    fs.writeFileSync(process.env.FAKE_LLAMA_RECORD, "");
    const resp = await fetch(`${base}/core/code/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: id, task: "say hi" }),
    });
    const text = await resp.text();
    assert.ok(/"done"\s*:\s*true/.test(text) || text.includes('"done":true'), text.slice(0, 300));
    const asked = fs
      .readFileSync(process.env.FAKE_LLAMA_RECORD, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.ok(asked.length, "pinned ready model reached the engine");

    // Stale pin falls back with a note.
    await fetch(`${base}/core/code/projects/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gone-forever" }),
    });
    const after = await fetch(`${base}/core/code/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: id, task: "say hi" }),
    });
    const afterText = await after.text();
    assert.match(afterText, /gone-forever is not installed/);
    assert.match(afterText, /"done"\s*:\s*true/);
    assert.ok(!/"error"\s*:\s*"/.test(afterText) || /"done":true/.test(afterText));

    assert.ok(core.gateway._codeDefaultModel());
    assert.strictEqual(core.gateway._codeModelUsable("dev-tiny"), true);
    assert.strictEqual(core.gateway._codeModelUsable("gone-forever"), false);
  } finally {
    delete process.env.FAKE_LLAMA_SCRIPT;
    delete process.env.FAKE_LLAMA_RECORD;
    await core.stop();
  }
});

test("terminal pickModel: explicit, live ready, first ready; rejects cli:*", async () => {
  await assert.rejects(
    () => pickModel({ model: "cli:codex", url: "http://127.0.0.1:9" }),
    /subscription models/
  );
  assert.strictEqual(await pickModel({ model: "my-explicit", url: "http://127.0.0.1:9" }), "my-explicit");

  const srv = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/core/models") {
      res.end(
        JSON.stringify({
          aliases: [
            { alias: "ready-a", status: "ready" },
            { alias: "ready-b", status: "ready" },
            { alias: "missing", status: "absent" },
          ],
          runtime: { activeAlias: "ready-b", runtime: { running: true } },
        })
      );
      return;
    }
    res.end(JSON.stringify({ data: [{ id: "v1-first" }] }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.strictEqual(await pickModel({ model: "", url: base }), "ready-b");
  } finally {
    srv.close();
  }

  const srv2 = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/core/models") {
      res.end(
        JSON.stringify({
          aliases: [
            { alias: "ready-a", status: "ready" },
            { alias: "ready-b", status: "ready" },
          ],
          runtime: { activeAlias: "ready-b", runtime: { running: false } },
        })
      );
      return;
    }
    res.end("{}");
  });
  await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
  try {
    assert.strictEqual(await pickModel({ model: "", url: `http://127.0.0.1:${srv2.address().port}` }), "ready-a");
  } finally {
    srv2.close();
  }
});

test("thinking effort: whitelist only; Default adds no flags; vendor flags are exact", async () => {
  assert.strictEqual(normalizeEffort(""), "");
  assert.strictEqual(normalizeEffort("default"), "");
  assert.strictEqual(normalizeEffort("medium"), "medium");
  assert.throws(() => normalizeEffort("xhigh"), /thinking level/);
  assert.throws(() => normalizeEffort("medium;rm -rf /"), /thinking level/);
  assert.throws(() => normalizeEffort("--help"), /thinking level/);
  assert.deepStrictEqual(effortArgs("codex", ""), []);
  assert.deepStrictEqual(effortArgs("codex", "high"), ["-c", "model_reasoning_effort=high"]);
  assert.deepStrictEqual(effortArgs("claude", "low"), ["--effort", "low"]);
  assert.deepStrictEqual(effortArgs("grok", "medium"), ["--reasoning-effort", "medium"]);

  for (const [provider, needle] of [
    ["codex", "model_reasoning_effort=high"],
    ["claude", "--effort"],
    ["grok", "--reasoning-effort"],
  ]) {
    const { spawnImpl, calls } = fakeSpawnFactory({
      stdout:
        provider === "claude" ? JSON.stringify({ result: "ok" }) : provider === "grok" ? grokStream("ok") : "ok",
    });
    const settings = memSettings({ "code.cliProviders": { [provider]: true } });
    const cp = new CliProviders({
      settings,
      privacyMode: () => "local-first",
      bins: { [provider]: "/bin/true" },
      spawnImpl,
    });
    await cp.chat({ model: `cli:${provider}`, messages: [{ role: "user", content: "x" }], effort: "high" });
    const args = calls[0].args;
    if (provider === "codex") assert.ok(args.includes(needle));
    else {
      assert.ok(args.includes(needle));
      assert.ok(args.includes("high"));
    }
    // Default effort must not inject a flag.
    calls.length = 0;
    await cp.chat({ model: `cli:${provider}`, messages: [{ role: "user", content: "x" }], effort: "" });
    assert.ok(!calls[0].args.includes(needle));
    assert.ok(!calls[0].args.includes("model_reasoning_effort=high"));
  }
});

test("flattenMessages and childEnv stay free of project metadata keys", () => {
  const text = flattenMessages([
    { role: "system", content: "tools…" },
    { role: "user", content: "edit foo.js" },
  ]);
  assert.match(text, /NO tools/);
  assert.match(text, /edit foo\.js/);
  const long = flattenMessages([{ role: "user", content: "x".repeat(500000) }]);
  assert.match(long, /^You are the reasoning model behind Koinos Code/);
  assert.match(long, /NO tools/);
  assert.match(long, /earlier context truncated/);
  assert.match(long, /=== YOUR NEXT MESSAGE ===\n$/);
  assert.ok(long.length <= 400000);
  const env = childEnv(PROVIDERS.claude, "/opt/claude", {
    PATH: "/bin",
    HOME: "/home/u",
    PWD: "/leaked/project",
    OLDPWD: "/leaked/old",
    INIT_CWD: "/leaked/init",
    SECRET: "nope",
  });
  assert.strictEqual(env.PWD, undefined);
  assert.strictEqual(env.OLDPWD, undefined);
  assert.strictEqual(env.INIT_CWD, undefined);
  assert.strictEqual(env.SECRET, undefined);
  assert.ok(env.PATH.includes("/opt"));
});
