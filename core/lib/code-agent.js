"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/*
 * Koinos Code in the app (task #60, v3): the SAME coding agent the CLI runs,
 * hosted by Core so the Developer Tools panel (and headless API users) can
 * drive a project directory with approval cards instead of [y/N] prompts.
 *
 * Nothing is re-implemented: the tools, the path jail, the diff, and the
 * KOINOS.md context come from cli/koinos-code.js via its injectable io; the
 * action grammar is ui/agents.js like everywhere else. The permission policy
 * is IDENTICAL to the terminal — every write shows its diff and waits for an
 * explicit yes, every command asks — only the asking channel changes: an
 * approval-request event over SSE, answered by POST /core/code/approve.
 * There is no --yes here at all: in the app, a human answers every card.
 */

const { makeTools, projectContext, PREAMBLE } = require(path.join(__dirname, "..", "..", "cli", "koinos-code.js"));
const { buildAgentSystem, parseAgentAction, trimConvo } = require(path.join(__dirname, "..", "..", "ui", "agents"));

const DEFAULT_MAX_STEPS = 25;
const HARD_MAX_STEPS = 50;
const OBS_MAX_CHARS = 4000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TOKENS_PER_CALL = 900; // same as the CLI
const MAX_NUDGES = 2; // bounded: a model that will not stop must still finish

/*
 * Did the model TRY to call a tool that is not in its hands?
 *
 * parseAgentAction returns null both for ordinary prose and for a tool call
 * naming something unavailable — and the loop treats null as "this is the
 * final answer". That meant a refused tool call was surfaced to the person as
 * raw JSON masquerading as an answer. Most visible in plan mode, where the
 * editing tools deliberately do not exist, but it was always wrong.
 */
function looksLikeToolCall(text) {
  const t = String(text || "");
  const i = t.indexOf("{");
  if (i < 0) return false;
  const j = t.lastIndexOf("}");
  if (j <= i) return false;
  try {
    const o = JSON.parse(t.slice(i, j + 1));
    return Boolean(o && typeof o === "object" && (o.tool || o.name || o.action || o.mcp || o.tool_name || o.function));
  } catch {
    return false;
  }
}

/*
 * MCP (and every other registry tool) inside the coding agent.
 *
 * Nothing is re-implemented: `ToolRegistry` already holds MCP servers, memory,
 * email, calendar and the built-ins, already knows each tool's `egress` and
 * `sensitive` flags, and already refuses egress tools in Local-Only. This just
 * adapts its entries into the shape the coding loop's tool list uses.
 *
 * TWO RULES, both load-bearing:
 *   1. A `sensitive` tool routes to the SAME approval card as run_cmd. The
 *      coding agent must not become a way around a gate the rest of the app
 *      enforces.
 *   2. The list is BOUNDED and opt-in per project. A 4k local context cannot
 *      hold thirty tool definitions and still have room for the task — handing
 *      it everything would make the agent worse, not better.
 */
const MAX_EXTRA_TOOLS = 8;

function registryTools(registry, { allow = [], io, runId, onTrace }) {
  if (!registry || !allow.length) return [];
  let available = [];
  try {
    available = registry.list(); // already filtered by privacy mode
  } catch {
    return [];
  }
  const wanted = new Set(allow.map(String));
  return available
    .filter((t) => wanted.has(t.name))
    .slice(0, MAX_EXTRA_TOOLS)
    .map((t) => ({
      name: t.name,
      description: t.description || t.name,
      params: t.params || {},
      handler: async (args) => {
        // A sensitive tool asks, exactly like a shell command does.
        if (t.sensitive) {
          const verdict = await io.askCommand(`${t.name} ${JSON.stringify(args || {}).slice(0, 300)}`);
          if (!verdict.approved) return verdict.reason || "the user declined this tool call";
        }
        try {
          return await registry.call(t.name, args || {}, { confirmed: true });
        } catch (e) {
          // A refusal is an observation the model can route around, never a crash.
          return `tool error: ${e.message}`;
        }
      },
    }));
}

class CodeAgent {
  /** chatFn({model, messages, maxTokens}) -> Promise<string> — the host's
   *  loopback lane, so runs inherit every routing/privacy rule. */
  constructor({ chatFn, registry = null, onEvent = () => {}, approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS }) {
    this.chatFn = chatFn;
    this.registry = registry; // unified tool registry (MCP + built-ins), optional
    this.onEvent = onEvent;
    this.approvalTimeoutMs = approvalTimeoutMs;
    this._pending = new Map(); // approvalId -> { resolve, timer, runId }
    this._runs = new Map(); // runId -> { aborted }
  }

  /** Answer a pending approval card. Returns false for unknown/expired ids. */
  provideApproval(approvalId, approved) {
    const p = this._pending.get(String(approvalId || ""));
    if (!p) return false;
    this._pending.delete(String(approvalId));
    clearTimeout(p.timer);
    p.resolve({ approved: approved === true, reason: "the user declined this in the app" });
    return true;
  }

  /** Stop a run (the panel's Stop button). A run blocked on an approval
   *  resolves that card as declined immediately. */
  stop(runId) {
    const r = this._runs.get(String(runId || ""));
    if (!r) return false;
    r.aborted = true;
    for (const [id, p] of this._pending) {
      if (p.runId === runId) {
        this._pending.delete(id);
        clearTimeout(p.timer);
        p.resolve({ approved: false, reason: "the run was stopped" });
      }
    }
    return true;
  }

  _ask(runId, detail, onTrace) {
    const run = this._runs.get(runId);
    if (!run || run.aborted) return Promise.resolve({ approved: false, reason: "the run was stopped" });
    const approvalId = crypto.randomBytes(8).toString("hex");
    return new Promise((resolve) => {
      // Deliberately NOT unref'd — same law as the group-chat human turns: a
      // run waiting on a person must keep the process alive; the timeout
      // bounds the wait, never the event loop.
      const timer = setTimeout(() => {
        this._pending.delete(approvalId);
        resolve({ approved: false, reason: `approval timed out — nobody answered in ${Math.round(this.approvalTimeoutMs / 60000)} minutes` });
      }, this.approvalTimeoutMs);
      this._pending.set(approvalId, { resolve, timer, runId });
      onTrace({ type: "approval-request", approvalId, runId, ...detail });
    });
  }

  /**
   * Run one task against a project directory. onTrace(entry) streams live:
   *   {type:"start", runId}
   *   {type:"tool", name, args}                     — an action begins
   *   {type:"obs", text}                            — its observation (first line)
   *   {type:"approval-request", approvalId, kind:"edit", path, diff}
   *   {type:"approval-request", approvalId, kind:"command", cmd}
   *   {type:"note", text}
   * Returns {runId, answer, steps, reason} — reason "answered" | "stopped" |
   * "budget" (step budget exhausted).
   */
  async run({ dir, task, model = "", maxSteps, history = [], mode = "act", plan = "", tools: allowTools = [], onTrace = () => {} }) {
    const q = String(task || "").trim();
    if (!q) throw new Error("give the agent a task");
    const root = path.resolve(String(dir || ""));
    let st;
    try {
      st = fs.statSync(root);
    } catch {
      throw new Error(`project directory does not exist: ${root}`);
    }
    if (!st.isDirectory()) throw new Error(`not a directory: ${root}`);
    // A filesystem root is almost certainly a typo — and "the whole disk as
    // one project" is never what anyone means. Refuse with words.
    if (path.parse(root).root === root) throw new Error("refusing to use a filesystem root as the project directory — pick the project folder itself");

    const runId = crypto.randomBytes(8).toString("hex");
    const run = { aborted: false };
    this._runs.set(runId, run);
    const budget = Math.max(1, Math.min(HARD_MAX_STEPS, Number(maxSteps) || DEFAULT_MAX_STEPS));

    const io = {
      showDiff: () => {}, // the diff travels INSIDE the approval card
      askEdit: (rel, diff) => this._ask(runId, { kind: "edit", path: rel, diff }, onTrace),
      askCommand: (cmd) => this._ask(runId, { kind: "command", cmd }, onTrace),
      note: (line) => onTrace({ type: "note", text: String(line).trim() }),
    };
    // No --yes, no --allow-commands in the app: every gate routes to a card.
    const planning = mode === "plan";
    const tools = makeTools(root, {
      yes: false,
      allowCommands: false,
      io,
      readOnly: planning,
      extraTools: registryTools(this.registry, { allow: allowTools, io, runId, onTrace }),
    });
    const names = tools.map((t) => t.name);

    try {
      onTrace({ type: "start", runId });
      /*
       * Prior turns of the SESSION ride ahead of the task, which is what makes
       * this a continuing thread instead of a series of strangers: "now do the
       * same for the other file" only means something if the agent saw the
       * first one. The caller bounds the history (count and characters) before
       * it gets here, so a long thread can never crowd out the actual task.
       * Framed as context, not as instructions to re-execute.
       */
      const prior = (Array.isArray(history) ? history : [])
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
        .map((m) => ({ role: m.role, content: String(m.content) }));
      /*
       * Plan mode changes what the agent is FOR, so it changes the brief. It
       * reads, then writes a plan — it cannot edit or run anything, because
       * those tools were never put in its hands.
       */
      const brief = planning
        ? "\n\nYOU ARE PLANNING. Read what you need, then answer with a short numbered plan of the " +
          "changes you would make — files and what changes in each. Do NOT write code in the plan. " +
          "You have no tools to edit files or run commands in this mode; do not claim to have made changes."
        : plan
          ? `\n\nTHE APPROVED PLAN — follow it, and say so if reality turns out to differ:\n${String(plan).slice(0, 4000)}`
          : "";
      const convo = [
        { role: "system", content: `${PREAMBLE}${projectContext(root)}${brief}\n\n${buildAgentSystem(tools, { question: q, allNames: names })}` },
      ];
      if (prior.length) {
        convo.push({
          role: "system",
          content:
            "EARLIER IN THIS SESSION (context only — already done, do not redo):\n" +
            prior.map((m) => `${m.role === "user" ? "You were asked" : "You answered"}: ${m.content}`).join("\n"),
        });
      }
      convo.push({ role: "user", content: q });
      let nudges = 0;
      for (let step = 0; step < budget; step++) {
        if (run.aborted) return { runId, answer: "", steps: step, reason: "stopped" };
        const out = String((await this.chatFn({ model, messages: trimConvo(convo), maxTokens: MAX_TOKENS_PER_CALL })) ?? "");
        if (run.aborted) return { runId, answer: "", steps: step, reason: "stopped" };
        const action = parseAgentAction(out, names);
        if (!action) {
          /*
           * No parsable action. With small models that usually IS the final
           * answer — but not when the model was clearly reaching for a tool it
           * does not have. Returning that raw JSON as the answer is how a
           * refused write ended up displayed as "the plan". Tell it what it
           * actually has and let it try again, bounded so it always finishes.
           */
          if (looksLikeToolCall(out) && nudges < MAX_NUDGES) {
            nudges++;
            onTrace({ type: "note", text: planning ? "(that tool is not available while planning)" : "(that tool is not available)" });
            convo.push({ role: "assistant", content: out });
            convo.push({
              role: "user",
              content: planning
                ? `You have no tools to change anything while planning — only ${names.join(", ")}. ` +
                  "Write the plan as plain numbered text instead."
                : `That tool is not available. The tools you have are: ${names.join(", ")}. ` +
                  'Use one of those, or reply {"answer": true} if you are done.',
            });
            continue;
          }
          return { runId, answer: out.trim(), steps: step, reason: planning ? "planned" : "answered" };
        }
        if (action.answer) {
          convo.push({ role: "assistant", content: out });
          convo.push({ role: "user", content: "Give the final answer to the task now, as plain text." });
          const fin = String((await this.chatFn({ model, messages: trimConvo(convo), maxTokens: MAX_TOKENS_PER_CALL })) ?? "");
          return { runId, answer: fin.trim(), steps: step, reason: planning ? "planned" : "answered" };
        }
        const tool = tools.find((t) => t.name === action.tool);
        onTrace({ type: "tool", name: action.tool, args: JSON.stringify(action.args || {}).slice(0, 200) });
        let obs;
        try {
          obs = String(await tool.handler(action.args || {}));
        } catch (e) {
          obs = `tool error: ${e.message}`;
        }
        obs = obs.slice(0, OBS_MAX_CHARS);
        onTrace({ type: "obs", text: obs.split("\n")[0].slice(0, 200) });
        convo.push({ role: "assistant", content: out });
        convo.push({ role: "user", content: `Observation:\n${obs}\n\nContinue with the task. Use another tool, or reply {"answer": true} when done.` });
      }
      return { runId, answer: "", steps: budget, reason: "budget" };
    } finally {
      this.stop(runId); // clears any orphaned approval cards
      this._runs.delete(runId);
    }
  }
}

module.exports = { CodeAgent, registryTools, MAX_EXTRA_TOOLS };
