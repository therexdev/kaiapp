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
const { buildAgentSystem, parseAgentAction, salvageAction, trimConvo } = require(path.join(__dirname, "..", "..", "ui", "agents"));

const DEFAULT_MAX_STEPS = 25;
const HARD_MAX_STEPS = 50;
const OBS_MAX_CHARS = 4000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TOKENS_PER_CALL = 900; // same as the CLI
const MAX_NUDGES = 2; // bounded: a model that will not stop must still finish

/*
 * Did the model TRY to call a tool, whether or not the attempt was usable?
 *
 * parseAgentAction returns null both for ordinary prose and for a tool call
 * naming something unavailable — and the loop treats null as "this is the
 * final answer". That meant a refused tool call was surfaced to the person as
 * raw JSON masquerading as an answer. Most visible in plan mode, where the
 * editing tools deliberately do not exist, but it was always wrong.
 *
 * This deliberately does NOT parse. It used to, and that was the bug behind
 * the v0.39.0 field report: the call that failed hardest — a whole HTML file
 * hand-escaped into a JSON string — is exactly the one JSON.parse rejects, so
 * the check said "not a tool call", no nudge fired, and the blob became the
 * answer. Shape is the question here; salvageAction handles meaning.
 */
const TOOL_KEY = /"(?:tool|name|action|mcp|tool_name|function)"\s*:/;

function looksLikeToolCall(text) {
  const t = String(text || "");
  const i = t.indexOf("{");
  return i >= 0 && TOOL_KEY.test(t.slice(i));
}

/*
 * "I have already written the HTML code for you and placed it in a file named
 * calculator.html." — said after writing nothing at all (v0.39.0 field
 * report). A model that failed to call write_file still narrates as though it
 * succeeded, and the claim then rides into the session history where the next
 * turn believes it.
 *
 * The run KNOWS whether anything was written. When nothing was and the answer
 * says otherwise, the answer is corrected before anyone reads it or the
 * transcript keeps it. All three signals must be present, so "I would create
 * two files" (a plan) and "the file already contains that" (an observation)
 * are left alone.
 */
const CLAIM_FIRST_PERSON = /\bI(?:'ve|'m| have| already)?\b/i;
const CLAIM_VERB = /\b(?:wrote|written|created|saved|placed|generated|added)\b/i;
const CLAIM_TARGET = /\bfiles?\b|\bfolder\b|\bdirectory\b|\.(?:html?|css|jsx?|tsx?|json|py|md|txt|sh|ya?ml|c|cpp|h|java|rb|go|rs|php|sql)\b/i;

function claimsAWrite(text) {
  const t = String(text || "");
  if (/\bwould\s+(?:write|create|save|add|generate)\b/i.test(t) && !CLAIM_VERB.test(t.replace(/\bwould\s+\w+/gi, ""))) return false;
  return CLAIM_FIRST_PERSON.test(t) && CLAIM_VERB.test(t) && CLAIM_TARGET.test(t);
}

/*
 * The OTHER way this feature looks broken, and the more common one: the model
 * never attempts a tool call at all. Asked to build a calculator it writes the
 * page into its reply inside a ```html fence and stops — so there is code on
 * the screen, "0 tool steps", and an empty folder. Field words: "why does it
 * keep giving me code in the chat instead of making actual folders and files?"
 *
 * salvageAction cannot help here — there is no call to salvage — and
 * looksLikeToolCall correctly says no. This is the third state the loop never
 * had a name for: not a tool call, not really an answer either.
 *
 * The nudge deliberately offers BOTH doors. "Explain how I would write a
 * calculator" is a legitimate question whose answer IS a code block, and
 * forcing a write there would create a file nobody asked for. So the model is
 * asked which one it meant, and the write it may then propose is still a card.
 */
const FENCE_BLOCK = /```[A-Za-z0-9+#.-]*[ \t]*\r?\n([\s\S]*?)```/g;
/*
 * What separates "here is the file you asked for" from an illustration. Both
 * thresholds are needed: `npm install` on two lines is advice, not a file, and
 * a single long line is usually a command. Two real lines AND some substance.
 */
const CODE_MIN_CHARS = 40;
const CODE_MIN_LINES = 2;

function answeredWithCode(text) {
  FENCE_BLOCK.lastIndex = 0; // the regex is global and therefore stateful
  let m;
  while ((m = FENCE_BLOCK.exec(String(text || "")))) {
    const body = String(m[1] || "").trim();
    const lines = body.split("\n").filter((l) => l.trim()).length;
    if (body.length >= CODE_MIN_CHARS && lines >= CODE_MIN_LINES) return true;
  }
  return false;
}

const NOT_WRITTEN =
  "\n\n_Nothing was written to disk — no file in this project was created or changed. " +
  "Any file named above does not exist yet._";

/** The answer as the person should see it: never a write that did not happen. */
function truthfulAnswer(answer, wrote) {
  const a = String(answer || "");
  return !wrote && claimsAWrite(a) ? a.trimEnd() + NOT_WRITTEN : a;
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

/*
 * SUBAGENTS (task #76).
 *
 * A `delegate` tool spawns a CHILD run of the same agent on the same project
 * with its own step budget, and hands its answer back as ONE observation. The
 * point is context, not privilege: a big sub-task (read this whole subsystem
 * and summarise what changes) can burn twenty steps in a child without filling
 * the parent's 4k window with the trace.
 *
 * The child is deliberately WEAKER than its parent, never stronger:
 *   - it inherits the SAME io, so every write it proposes is still a card the
 *     person answers in the parent's conversation. A subagent is not a way to
 *     get an unattended writer;
 *   - it gets no host/MCP tools — those are lent to a project by a person, and
 *     that consent does not silently extend to agents spawning agents;
 *   - it cannot delegate further (depth 1), which is what stops a fork bomb;
 *   - it has a smaller step budget than the parent, so N children cannot cost
 *     more than the parent's own ceiling.
 */
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const SUBAGENT_MAX_STEPS = 12;
const SUBAGENT_LIMIT = 3; // per parent run

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
  async run({ dir, task, model = "", maxSteps, history = [], mode = "act", plan = "", tools: allowTools = [], depth = 0, io: parentIo = null, parentRunId = null, onTrace = () => {} }) {
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

    // A child reuses its parent's io, so its approval cards belong to the
    // parent run: stopping the parent resolves them, and the person sees one
    // conversation rather than two.
    const io = parentIo || {
      showDiff: () => {}, // the diff travels INSIDE the approval card
      askEdit: (rel, diff) => this._ask(runId, { kind: "edit", path: rel, diff }, onTrace),
      askCommand: (cmd) => this._ask(runId, { kind: "command", cmd }, onTrace),
      note: (line) => onTrace({ type: "note", text: String(line).trim() }),
    };
    // No --yes, no --allow-commands in the app: every gate routes to a card.
    const planning = mode === "plan";
    /*
     * Delegation is offered only to a top-level ACTING run: a child cannot
     * spawn children (depth 1 stops a fork bomb), and planning is a reading
     * pass that should not be farming work out.
     */
    let spawned = 0;
    // Hoisted out of the loop: the delegate handler below reads it so a
    // helper's approved write is not later denied by the parent's answer.
    let wrote = false;
    const delegateTool =
      planning || depth > 0
        ? []
        : [
            {
              name: "delegate",
              description:
                "Hand a self-contained sub-task to a helper that works in this same project and reports back one answer. " +
                "Use for work that needs many steps of reading. The helper cannot delegate further.",
              params: { task: "what the helper should do" },
              handler: async ({ task: sub }) => {
                const t = String(sub || "").trim();
                if (!t) return "give the helper a task";
                if (spawned >= SUBAGENT_LIMIT) return `no more helpers available (limit ${SUBAGENT_LIMIT} per run)`;
                spawned++;
                onTrace({ type: "note", text: `delegating: ${t.slice(0, 120)}` });
                try {
                  const child = await this.run({
                    dir: root,
                    task: t,
                    model,
                    maxSteps: SUBAGENT_MAX_STEPS,
                    depth: depth + 1,
                    // The child answers through the PARENT's cards: a person is
                    // still the one approving every write it proposes.
                    io,
                    parentRunId: runId,
                    onTrace: (e) => onTrace({ ...e, from: "helper" }),
                  });
                  // A helper writes through the parent's own approval cards,
                  // so its approved write IS a write in this project.
                  if (child.wrote) wrote = true;
                  return child.answer ? `helper reported:\n${child.answer}` : `the helper finished without an answer (${child.reason})`;
                } catch (e) {
                  return `helper failed: ${e.message}`;
                }
              },
            },
          ];
    const tools = makeTools(root, {
      yes: false,
      allowCommands: false,
      io,
      readOnly: planning,
      extraTools: [
        // A child gets no host tools: lending a tool to a project is a
        // person's decision and does not extend to agents spawning agents.
        ...(depth > 0 ? [] : registryTools(this.registry, { allow: allowTools, io, runId, onTrace })),
        ...delegateTool,
      ],
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
        if (run.aborted) return { runId, answer: "", steps: step, reason: "stopped", wrote };
        const out = String((await this.chatFn({ model, messages: trimConvo(convo), maxTokens: MAX_TOKENS_PER_CALL })) ?? "");
        if (run.aborted) return { runId, answer: "", steps: step, reason: "stopped", wrote };
        // Strict first. Then salvage, which recovers the call a small model
        // could not escape — a whole file's content in a JSON string is the
        // case it gets wrong, and the case that matters most.
        const action = parseAgentAction(out, names) || salvageAction(out, names);
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
          /*
           * Code in the reply, nothing on disk, and no tool ever attempted.
           * Only while ACTING — a plan is prose by design — and only when this
           * run has written nothing, so a summary that quotes what it already
           * wrote is left alone.
           */
          if (!planning && !wrote && answeredWithCode(out) && nudges < MAX_NUDGES) {
            nudges++;
            onTrace({ type: "note", text: "(that code was not saved to any file)" });
            convo.push({ role: "assistant", content: out });
            convo.push({
              role: "user",
              content:
                "You wrote code in your reply, but nothing was saved — code in a reply does not create a file. " +
                'If that code belongs in this project, call write_file now: {"tool": "write_file", "args": ' +
                '{"path": "<file name>", "content": "<the whole file>"}}. ' +
                'If you were only explaining and no file was wanted, reply {"answer": true}.',
            });
            continue;
          }
          return { runId, answer: truthfulAnswer(out.trim(), wrote), steps: step, reason: planning ? "planned" : "answered", wrote };
        }
        if (action.answer) {
          convo.push({ role: "assistant", content: out });
          convo.push({ role: "user", content: "Give the final answer to the task now, as plain text." });
          const fin = String((await this.chatFn({ model, messages: trimConvo(convo), maxTokens: MAX_TOKENS_PER_CALL })) ?? "");
          return { runId, answer: truthfulAnswer(fin.trim(), wrote), steps: step, reason: planning ? "planned" : "answered", wrote };
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
        // makeTools' file tools answer "wrote <path> (N bytes)" and only ever
        // after an approval came back yes; a decline or a jail refusal reads
        // differently. A helper's write counts too — it wrote in this project.
        if (WRITE_TOOLS.has(action.tool) && /^wrote\s/.test(obs)) wrote = true;
        onTrace({ type: "obs", text: obs.split("\n")[0].slice(0, 200) });
        convo.push({ role: "assistant", content: out });
        convo.push({ role: "user", content: `Observation:\n${obs}\n\nContinue with the task. Use another tool, or reply {"answer": true} when done.` });
      }
      return { runId, answer: "", steps: budget, reason: "budget", wrote };
    } finally {
      this.stop(runId); // clears any orphaned approval cards
      this._runs.delete(runId);
    }
  }
}

module.exports = { CodeAgent, registryTools, looksLikeToolCall, answeredWithCode, claimsAWrite, truthfulAnswer, MAX_EXTRA_TOOLS, SUBAGENT_MAX_STEPS, SUBAGENT_LIMIT };
