"use strict";

const fs = require("fs");
const path = require("path");

/*
 * Custom slash commands for Koinos Code (task #76).
 *
 * A command is a MARKDOWN FILE in the project: `.koinos/commands/review.md`
 * becomes `/review`. Typing `/review src/app.js` expands the file, substitutes
 * the arguments, and runs the result as an ordinary task.
 *
 * They are PROMPT TEMPLATES AND NOTHING ELSE. A command cannot run a command,
 * grant a permission, or change what the agent is allowed to do — it only
 * decides what the agent is ASKED. That is deliberate and it is the whole
 * safety story: these files arrive inside repositories, and a repository you
 * cloned must never be able to execute anything by virtue of being opened.
 * (This is also why hooks were not built: a hook IS arbitrary execution
 * arriving in a clone.) Whatever a template asks for, every write still shows
 * its diff and every command still shows its exact line, and a human presses
 * the button.
 *
 * $ARGUMENTS is replaced with everything typed after the command name.
 * A leading `# Title` line, if present, is the description shown in the list.
 */

const DIR = path.join(".koinos", "commands");
const MAX_COMMANDS = 50;
const MAX_TEMPLATE_CHARS = 8000;
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/** Every command this project defines. Never throws: a project with no
 *  commands, or an unreadable folder, simply has none. */
function listCommands(root) {
  const dir = path.join(String(root || ""), DIR);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    if (out.length >= MAX_COMMANDS) break;
    if (!f.toLowerCase().endsWith(".md")) continue;
    const name = f.slice(0, -3);
    if (!NAME_RE.test(name)) continue; // a name that is not typeable is not a command
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, f), "utf8").slice(0, MAX_TEMPLATE_CHARS);
    } catch {
      continue;
    }
    const first = text.split("\n").find((l) => l.trim());
    const description = first && first.startsWith("#") ? first.replace(/^#+\s*/, "").trim() : "";
    out.push({ name: name.toLowerCase(), description, template: text });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Split "/review src/app.js" into its parts. Returns null when the text is
 *  not a command, which is the overwhelmingly common case. */
function parseInvocation(text) {
  const t = String(text || "");
  const m = t.match(/^\s*\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || "").trim() };
}

/**
 * Expand an invocation against the project's commands.
 * Returns { task } on success, or { error } naming what is available — an
 * unknown command should tell you the ones that exist, not just fail.
 */
function expand(root, text) {
  const call = parseInvocation(text);
  if (!call) return null;
  const commands = listCommands(root);
  const cmd = commands.find((c) => c.name === call.name);
  if (!cmd) {
    const known = commands.map((c) => `/${c.name}`).join(", ");
    return {
      error: known
        ? `No command called /${call.name} in this project. Available: ${known}`
        : `No command called /${call.name}. This project has no commands — add one as .koinos/commands/${call.name}.md`,
    };
  }
  let task = cmd.template;
  // $ARGUMENTS anywhere; if the template never mentions it, the arguments are
  // appended so typing them is never silently ignored.
  if (task.includes("$ARGUMENTS")) {
    task = task.split("$ARGUMENTS").join(call.args);
  } else if (call.args) {
    task = `${task.trimEnd()}\n\n${call.args}`;
  }
  return { task: task.trim(), name: cmd.name };
}

module.exports = { listCommands, parseInvocation, expand, DIR, MAX_COMMANDS };
