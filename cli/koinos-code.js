#!/usr/bin/env node
"use strict";

/*
 * Koinos Code (task #60) — a coding agent in the terminal, in the mold of
 * Claude Code, running entirely on the Koinos AI stack. The model is whatever
 * the local gateway serves (a local GGUF, or the network class when privacy
 * mode allows); the loop and action grammar are the app's own (ui/agents.js,
 * UMD precisely so Node can require it). Design: docs/koinos-code-design.md.
 *
 * Permission model, one sentence: reads are free inside the project, writes
 * show a diff and ask, commands always ask.
 *   --yes             pre-approves file edits (scripted use)
 *   --allow-commands  lets run_cmd execute without a prompt (CI use)
 * There is deliberately no flag that silences both gates at once.
 *
 * v2: KOINOS.md project notes feed the system prompt (re-read every task),
 * edit_file makes surgical replacements instead of full rewrites, and big
 * thinking jobs can be handed to the app's AI Teams (--team / the /team
 * REPL command) — the team works in the APP's workspace, not this project,
 * so it plans and reviews; this loop applies the changes.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { exec } = require("child_process");

const { buildAgentSystem, parseAgentAction, salvageAction, stripFence, trimConvo } = require(path.join(__dirname, "..", "ui", "agents"));

const PREAMBLE =
  "You are Koinos Code, a careful coding agent working inside the person's project directory. " +
  "Read the relevant files before changing them. Make the smallest change that accomplishes the task, " +
  "matching the project's existing style. Never invent file contents you have not read. " +
  "Prefer edit_file for small changes; use write_file only for new files or full rewrites.";

const CONTEXT_FILE = "KOINOS.md"; // project notes, read fresh every task
const CONTEXT_MAX_CHARS = 4000;
const TEAM_TEMPLATES = ["research", "analyst", "review"];
const OBS_MAX_CHARS = 4000; // what one observation may feed back into the context
const READ_WINDOW = 120; // lines per read_file call — big files are windowed
const SEARCH_MAX_HITS = 40;
const DIFF_MAX_LINES = 160;
const CMD_TIMEOUT_MS = 60000;

/* ----------------------------------------------------------- plumbing ---- */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s);
const print = (s) => process.stdout.write(s + "\n");

let rl = null;
function getRl() {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}
function closeRl() {
  if (rl) rl.close();
  rl = null;
}
function askYesNo(q) {
  return new Promise((res) => getRl().question(`${q} [y/N] `, (ans) => res(/^y(es)?$/i.test(ans.trim()))));
}

function usage() {
  print(
    [
      "koinos-code — a coding agent on your own Koinos AI (local model or network)",
      "",
      'usage: koinos-code [options] ["task…"]      one task, then exit',
      "       koinos-code [options]                 interactive session",
      "",
      "options:",
      "  --dir <path>        project directory (default: current directory)",
      "  --url <base>        Core gateway (default: $KAI_CODE_URL or http://127.0.0.1:41100)",
      "  --model <alias>     model to use (default: first model the gateway lists)",
      "  --key <secret>      API key, if you created keys in the app ($KAI_API_KEY)",
      "  -y, --yes           pre-approve file edits (commands still ask)",
      "  --allow-commands    let run_cmd execute without a prompt (for CI)",
      "  --max-steps <n>     tool-step budget per task (default 25, max 50)",
      "  --team <template>   hand the task to an AI Team instead of the agent loop",
      `                      (${TEAM_TEMPLATES.join(" | ")} — teams think in the app's`,
      "                      workspace; they don't edit this project)",
      "",
      "If the project has a KOINOS.md, its notes are given to the model every task.",
      'In the interactive session, "/team [template] task…" does the same handoff.',
    ].join("\n")
  );
}

function parseArgs(argv) {
  const opts = {
    dir: process.cwd(),
    url: process.env.KAI_CODE_URL || "http://127.0.0.1:41100",
    model: "",
    key: process.env.KAI_API_KEY || "",
    yes: false,
    allowCommands: false,
    maxSteps: 25,
    team: "",
    task: "",
    help: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") opts.dir = argv[++i];
    else if (a === "--url") opts.url = argv[++i];
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--key") opts.key = argv[++i];
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--allow-commands") opts.allowCommands = true;
    else if (a === "--team") opts.team = String(argv[++i] || "").trim();
    else if (a === "--max-steps") opts.maxSteps = Math.max(1, Math.min(50, Number(argv[++i]) || 25));
    else if (a === "--help" || a === "-h") opts.help = true;
    else rest.push(a);
  }
  opts.task = rest.join(" ").trim();
  opts.dir = path.resolve(String(opts.dir || "."));
  return opts;
}

/** Resolve p inside root, or null when it escapes — the jail every tool uses. */
function jailed(root, p) {
  const abs = path.resolve(root, String(p || ""));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/** KOINOS.md project notes for the system prompt, or "". Read fresh every
 *  task so an edit mid-session (by the person OR by the agent itself) takes
 *  effect on the very next task. Size-bounded: a huge file must not eat the
 *  model's working context. */
function projectContext(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, CONTEXT_FILE), "utf8").trim();
  } catch {
    return "";
  }
  if (!text) return "";
  const clipped =
    text.length > CONTEXT_MAX_CHARS ? `${text.slice(0, CONTEXT_MAX_CHARS)}\n⋯ (${CONTEXT_FILE} truncated at ${CONTEXT_MAX_CHARS} chars)` : text;
  return `\n\nProject notes from ${CONTEXT_FILE} (the project's own instructions — follow them):\n${clipped}`;
}

/** Minimal unified-ish diff: changed lines with 2 lines of context. */
function unifiedDiff(oldText, newText, cap = DIFF_MAX_LINES) {
  const a = String(oldText).split("\n");
  const b = String(newText).split("\n");
  if (a.length > 400 || b.length > 400) {
    // LCS on huge files is not worth the memory; summarize honestly instead.
    return `(large change: ${a.length} -> ${b.length} lines — diff omitted, review the file after)`;
  }
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push([" ", a[i]]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push(["-", a[i++]]);
    } else {
      ops.push(["+", b[j++]]);
    }
  }
  while (i < m) ops.push(["-", a[i++]]);
  while (j < n) ops.push(["+", b[j++]]);
  const keep = new Set();
  ops.forEach((op, k) => {
    if (op[0] === " ") return;
    for (let d = -2; d <= 2; d++) keep.add(k + d);
  });
  const out = [];
  let last = -2;
  for (let k = 0; k < ops.length; k++) {
    if (!keep.has(k)) continue;
    if (k > last + 1) out.push("  ⋯");
    out.push(`${ops[k][0]} ${ops[k][1]}`);
    last = k;
  }
  if (!out.length) return "(no changes)";
  if (out.length > cap) return out.slice(0, cap).concat([`  ⋯ (${out.length - cap} more diff lines)`]).join("\n");
  return out.join("\n");
}

function paintDiff(diff) {
  if (!useColor) return diff;
  return diff
    .split("\n")
    .map((l) => (l.startsWith("+") ? green(l) : l.startsWith("-") ? red(l) : dim(l)))
    .join("\n");
}

/* -------------------------------------------------------------- tools ---- */

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", ".runs", "__pycache__"]);

function isTextFile(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, "r");
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    return !buf.subarray(0, n).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function walkFiles(root, dir, acc, depth = 0) {
  if (depth > 8 || acc.length > 500) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".env.example") continue;
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) walkFiles(root, path.join(dir, e.name), acc, depth + 1);
    } else if (e.isFile()) {
      acc.push(path.relative(root, path.join(dir, e.name)));
      if (acc.length > 500) return;
    }
  }
}

/** The terminal's asking surface — the default io. Another host (the app's
 *  Koinos Code panel) injects its own io to route the SAME policy through
 *  approval cards instead of [y/N] prompts; the policy itself never moves. */
function ttyIo(opts) {
  const interactive = Boolean(process.stdin.isTTY);
  return {
    showDiff(rel, diff) {
      print(`\n--- ${rel} ---`);
      print(paintDiff(diff));
    },
    async askEdit(rel) {
      if (opts.yes) return { approved: true };
      if (!interactive) {
        return { approved: false, reason: "edit declined: no terminal to ask on — the person must pass --yes to pre-approve edits" };
      }
      return { approved: await askYesNo(`apply this edit to ${rel}?`), reason: "the user declined this edit" };
    },
    async askCommand(cmd) {
      if (opts.allowCommands) return { approved: true };
      if (!interactive) {
        return { approved: false, reason: "command declined: no terminal to ask on — the person must pass --allow-commands to allow commands" };
      }
      return { approved: await askYesNo(`run: ${cmd} ?`), reason: "the user declined this command" };
    },
    note(line) {
      print(dim(line));
    },
  };
}

function makeTools(root, opts) {
  const io = opts.io || ttyIo(opts);
  // The one write gate both writing tools share: show the diff, ask, then
  // write. Every path to disk goes through here.
  async function approveAndWrite(abs, rel, old, next) {
    const diff = unifiedDiff(old, next);
    io.showDiff(rel, diff);
    const verdict = await io.askEdit(rel, diff);
    if (!verdict.approved) return verdict.reason || "the user declined this edit";
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, next);
    io.note(`  wrote ${rel}`);
    return `wrote ${rel} (${Buffer.byteLength(next)} bytes)`;
  }
  const READ_ONLY = new Set(["list_files", "read_file", "search_files"]);
  const all = [
    {
      name: "list_files",
      description: "List the project's files as relative paths.",
      params: { dir: "optional sub-directory" },
      handler: ({ dir }) => {
        const start = jailed(root, dir || ".");
        if (!start) return "refused: path escapes the project directory";
        const acc = [];
        walkFiles(root, start, acc);
        if (!acc.length) return "(no files)";
        return acc.slice(0, 500).join("\n") + (acc.length > 500 ? "\n⋯ (more files not shown)" : "");
      },
    },
    {
      name: "read_file",
      description: "Read a text file with line numbers. Long files are windowed; pass from (a line number) to continue.",
      params: { path: "file path", from: "start line, optional" },
      handler: ({ path: p, from }) => {
        const abs = jailed(root, p);
        if (!abs) return "refused: path escapes the project directory";
        let text;
        try {
          text = fs.readFileSync(abs, "utf8");
        } catch (e) {
          return `cannot read ${p}: ${e.code || e.message}`;
        }
        const lines = text.split("\n");
        const start = Math.max(1, Number(from) || 1);
        const slice = lines.slice(start - 1, start - 1 + READ_WINDOW);
        const body = slice.map((l, k) => `${start + k}\t${l}`).join("\n");
        const end = start - 1 + slice.length;
        const tail = end < lines.length ? `\n⋯ (lines ${start}–${end} of ${lines.length} — pass from: ${end + 1} for more)` : "";
        return body + tail;
      },
    },
    {
      name: "search_files",
      description: "Find lines containing a text, case-insensitive, across the project's text files.",
      params: { query: "text to find" },
      handler: ({ query }) => {
        const q = String(query || "").toLowerCase();
        if (!q) return "give a query";
        const files = [];
        walkFiles(root, root, files);
        const hits = [];
        for (const rel of files) {
          const abs = path.join(root, rel);
          let st;
          try {
            st = fs.statSync(abs);
          } catch {
            continue;
          }
          if (st.size > 512 * 1024 || !isTextFile(abs)) continue;
          const lines = fs.readFileSync(abs, "utf8").split("\n");
          for (let k = 0; k < lines.length && hits.length < SEARCH_MAX_HITS; k++) {
            if (lines[k].toLowerCase().includes(q)) hits.push(`${rel}:${k + 1}: ${lines[k].trim().slice(0, 160)}`);
          }
          if (hits.length >= SEARCH_MAX_HITS) break;
        }
        return hits.length ? hits.join("\n") : "(no matches)";
      },
    },
    {
      name: "edit_file",
      description: "Surgical edit: replace one exact text occurrence in a file. Prefer this over write_file for small changes.",
      params: { path: "file path", find: "exact existing text (must occur exactly once)", replace: "replacement text" },
      handler: async ({ path: p, find, replace }) => {
        const abs = jailed(root, p);
        if (!abs) return "refused: path escapes the project directory";
        let old;
        try {
          old = fs.readFileSync(abs, "utf8");
        } catch (e) {
          return `cannot read ${p}: ${e.code || e.message} — edit_file only changes existing files; use write_file to create one`;
        }
        const needle = stripFence(String(find ?? ""));
        if (!needle) return "give find: the exact text to replace";
        const first = old.indexOf(needle);
        if (first === -1) {
          return `not found: that exact text does not occur in ${p} — read the file and copy it exactly (whitespace matters)`;
        }
        if (old.indexOf(needle, first + 1) !== -1) {
          const count = old.split(needle).length - 1;
          return `ambiguous: that text occurs ${count} times in ${p} — include more surrounding lines in find so it matches exactly once`;
        }
        const next = old.slice(0, first) + stripFence(String(replace ?? "")) + old.slice(first + needle.length);
        if (next === old) return "no change: the replacement equals the existing text";
        return approveAndWrite(abs, p, old, next);
      },
    },
    {
      name: "write_file",
      description: "Create a file, or replace one whole. The person sees a diff and approves first.",
      params: { path: "file path", content: "full new file content" },
      handler: async ({ path: p, content }) => {
        const abs = jailed(root, p);
        if (!abs) return "refused: path escapes the project directory";
        // A model asked for a file's content very often hands back the
        // markdown fence it would use in chat. Left in, ```html lands as the
        // first line OF THE FILE. Markdown files keep theirs — a fenced block
        // is legitimate content there.
        const next = /\.(?:md|markdown|mdx)$/i.test(String(p || "")) ? String(content ?? "") : stripFence(String(content ?? ""));
        let old = "";
        try {
          old = fs.readFileSync(abs, "utf8");
        } catch {
          /* new file */
        }
        if (old === next) return `no change: ${p} already has that content`;
        return approveAndWrite(abs, p, old, next);
      },
    },
    {
      name: "run_cmd",
      description: "Run one shell command in the project directory. The person approves every command.",
      params: { cmd: "the command" },
      handler: async ({ cmd }) => {
        const command = String(cmd || "").trim();
        if (!command) return "give a command";
        const verdict = await io.askCommand(command);
        if (!verdict.approved) return verdict.reason || "the user declined this command";
        return await new Promise((res) => {
          exec(command, { cwd: root, timeout: CMD_TIMEOUT_MS, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
            const code = err ? (err.killed ? "timeout" : err.code ?? 1) : 0;
            res(`exit ${code}\n${String(stdout).slice(0, 2000)}${stderr ? `\nstderr:\n${String(stderr).slice(0, 1000)}` : ""}`);
          });
        });
      },
    },
  ];
  /*
   * PLAN MODE (opts.readOnly): the agent may look but not touch — the three
   * reading tools only, so a planning pass cannot edit a file or run a command
   * even if the model tries. That is enforced by the tool list not existing,
   * not by asking the model nicely.
   *
   * opts.extraTools appends host-provided tools (the app passes MCP tools this
   * way). They are dropped in plan mode too, since a plan should be formed
   * from the project, and an MCP tool may well have side effects.
   */
  const base = opts.readOnly ? all.filter((t) => READ_ONLY.has(t.name)) : all;
  const extra = opts.readOnly ? [] : opts.extraTools || [];
  return [...base, ...extra];
}

/* ------------------------------------------------------------ gateway ---- */

async function gw(opts, pathname, body) {
  const headers = { "content-type": "application/json" };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  let r;
  try {
    r = await fetch(opts.url.replace(/\/$/, "") + pathname, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`cannot reach the Koinos AI gateway at ${opts.url} — is the app (or \`npm run core\`) running?`);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || j?.error || `gateway answered ${r.status} for ${pathname}`);
  return j;
}

async function pickModel(opts) {
  if (opts.model) return opts.model;
  const j = await gw(opts, "/v1/models");
  const ids = (j.data || []).map((d) => d.id);
  if (!ids.length) throw new Error("the gateway lists no models — download one in the Koinos AI app first");
  return ids[0];
}

async function complete(opts, messages) {
  const j = await gw(opts, "/v1/chat/completions", { model: opts.model, messages, stream: false, max_tokens: 900 });
  return String(j?.choices?.[0]?.message?.content ?? "");
}

/* ------------------------------------------------------- team handoff ---- */

/** Hand one big thinking job to the app's AI Teams (/core/teams/run) and
 *  stream its trace. The team works in the APP's workspace, never in this
 *  project — it plans, researches, reviews; the agent loop applies changes. */
async function runTeam(opts, template, question, { interactive = false } = {}) {
  const t = String(template || "").trim().toLowerCase() || "review";
  if (!TEAM_TEMPLATES.includes(t)) {
    throw new Error(`unknown team template "${t}" — pick one of: ${TEAM_TEMPLATES.join(", ")}`);
  }
  const q = String(question || "").trim();
  if (!q) throw new Error("give the team a task");
  // The analyst team computes by RUNNING CODE (sandboxed, in the app's
  // workspace). Same consent rule as everywhere: an explicit yes up front.
  let allowSensitive = false;
  if (t === "analyst") {
    if (opts.allowCommands) allowSensitive = true;
    else if (interactive) allowSensitive = await askYesNo("the analyst team runs sandboxed code in the app's workspace — allow?");
    if (!allowSensitive) {
      throw new Error(
        interactive
          ? "the analyst team needs that approval — task cancelled"
          : "the analyst team runs code: pass --allow-commands to approve without a terminal"
      );
    }
  }
  print(dim(`→ ${t} team (in the app's workspace — it thinks, this loop edits)`));
  const headers = { "content-type": "application/json" };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  let r;
  try {
    r = await fetch(opts.url.replace(/\/$/, "") + "/core/teams/run", {
      method: "POST",
      headers,
      body: JSON.stringify({ template: t, question: q, model: opts.model, allowSensitive }),
    });
  } catch {
    throw new Error(`cannot reach the Koinos AI gateway at ${opts.url} — is the app (or \`npm run core\`) running?`);
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j?.error?.message || j?.error || `gateway answered ${r.status} for /core/teams/run`);
  }
  let result = null;
  let buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!data) continue;
      let ev;
      try {
        ev = JSON.parse(data.slice(6));
      } catch {
        continue;
      }
      if (ev.trace) print(dim(`  [${ev.trace.stage}] ${String(ev.trace.detail ?? "").replace(/\s+/g, " ").slice(0, 160)}`));
      if (ev.done) result = ev;
    }
  }
  if (!result) throw new Error("the team stream ended without a result");
  if (result.error) throw new Error(result.error);
  print(dim(`  team done — ${result.modelCalls} model calls`));
  return String(result.answer ?? "").trim();
}

/* --------------------------------------------------------- agent loop ---- */

async function runTask(opts, tools, convo, task) {
  const names = tools.map((t) => t.name);
  // A fresh system prompt per task keeps the tool menu tuned to the question
  // — and re-reads KOINOS.md, so edited project notes apply immediately.
  convo[0] = {
    role: "system",
    content: `${PREAMBLE}${projectContext(opts.dir)}\n\n${buildAgentSystem(tools, { question: task, allNames: names })}`,
  };
  convo.push({ role: "user", content: task });
  for (let step = 0; step < opts.maxSteps; step++) {
    const out = await complete(opts, trimConvo(convo));
    // Strict parse first; salvage a tool call whose JSON does not parse
    // (a model hand-escaping a whole HTML file gets it wrong every time).
    const action = parseAgentAction(out, names) || salvageAction(out, names);
    if (!action) {
      // No parsable action: with small models that IS the final answer.
      convo.push({ role: "assistant", content: out });
      return out.trim();
    }
    if (action.answer) {
      convo.push({ role: "assistant", content: out });
      convo.push({ role: "user", content: "Give the final answer to the task now, as plain text." });
      const fin = await complete(opts, trimConvo(convo));
      convo.push({ role: "assistant", content: fin });
      return fin.trim();
    }
    const tool = tools.find((t) => t.name === action.tool);
    print(dim(`» ${action.tool} ${JSON.stringify(action.args).slice(0, 140)}`));
    let obs;
    try {
      obs = String(await tool.handler(action.args || {}));
    } catch (e) {
      obs = `tool error: ${e.message}`;
    }
    obs = obs.slice(0, OBS_MAX_CHARS);
    print(dim(`  ${obs.split("\n")[0].slice(0, 160)}`));
    convo.push({ role: "assistant", content: out });
    convo.push({ role: "user", content: `Observation:\n${obs}\n\nContinue with the task. Use another tool, or reply {"answer": true} when done.` });
  }
  return "(step budget exhausted — the task may be incomplete)";
}

/* ---------------------------------------------------------------- main ---- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  if (!fs.existsSync(opts.dir) || !fs.statSync(opts.dir).isDirectory()) {
    throw new Error(`project directory does not exist: ${opts.dir}`);
  }
  opts.model = await pickModel(opts);
  print(dim(`Koinos Code — ${opts.model} via ${opts.url}`));
  print(dim(`project: ${opts.dir}`));
  if (projectContext(opts.dir)) print(dim(`context: ${CONTEXT_FILE} found — its notes ride along on every task`));
  const tools = makeTools(opts.dir, opts);
  const convo = [{ role: "system", content: "" }];
  const interactive = Boolean(process.stdin.isTTY);

  if (opts.team && !opts.task) throw new Error("--team needs a task, e.g. koinos-code --team review \"plan the refactor of …\"");
  if (opts.task) {
    const answer = opts.team
      ? await runTeam(opts, opts.team, opts.task, { interactive })
      : await runTask(opts, tools, convo, opts.task);
    print(`\n${answer}`);
    closeRl();
    return;
  }

  print(dim('Interactive session — type a task, "/team [template] task…" for a big thinking job, or "exit".'));
  for (;;) {
    const line = await new Promise((res) => getRl().question("koinos-code> ", res));
    const t = String(line).trim();
    if (!t) continue;
    if (/^(exit|quit)$/i.test(t)) break;
    try {
      if (/^\/team\b/i.test(t)) {
        const restStr = t.replace(/^\/team\s*/i, "");
        const m = restStr.match(/^(\w+)\s+([\s\S]+)$/);
        let template = "review";
        let q = restStr;
        if (m && TEAM_TEMPLATES.includes(m[1].toLowerCase())) {
          template = m[1].toLowerCase();
          q = m[2];
        }
        if (!q.trim()) {
          print(`usage: /team [${TEAM_TEMPLATES.join("|")}] task…`);
          continue;
        }
        const answer = await runTeam(opts, template, q.trim(), { interactive: true });
        print(`\n${answer}\n`);
        continue;
      }
      const answer = await runTask(opts, tools, convo, t);
      print(`\n${answer}\n`);
    } catch (e) {
      print(`error: ${e.message}`);
    }
  }
  closeRl();
}

module.exports = { parseArgs, jailed, unifiedDiff, makeTools, projectContext, runTeam, PREAMBLE };

if (require.main === module) {
  main().catch((e) => {
    console.error(`koinos-code: ${e.message}`);
    process.exit(1);
  });
}
