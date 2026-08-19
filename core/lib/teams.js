"use strict";

const { buildAgentSystem, parseAgentAction, trimConvo } = require("../../ui/agents");

/*
 * AI Teams (task #58, phase A) — role pipelines over the machinery that
 * already exists: the tool registry (#38), the agent-action grammar the solo
 * loop speaks (ui/agents.js, UMD for exactly this reason), and whatever chat
 * backend the caller injects. The runner lives in CORE, not the renderer:
 * headless API users and the Pi get teams without a window, and the UI just
 * renders the trace.
 *
 * Design lines (docs/ai-teams-design.md):
 *  - A team is a LINEAR pipeline of typed stages. No free-form agent
 *    society, no unbounded chatter: plan -> work xN -> write -> critique ->
 *    one revision. Predictable, budgeted, explainable.
 *  - Teams add ZERO new permissions. Every tool call goes through
 *    registry.call with the same egress/sensitive policy as everywhere
 *    else. Sensitive tools (run_code) execute only when the caller granted
 *    allowSensitive UPFRONT — an explicit human yes recorded in the trace;
 *    without it the refusal becomes an observation the model can adapt to.
 *  - Hard budgets everywhere: sub-tasks, actions per work stage, revisions,
 *    total model calls. A team can never loop forever.
 */

const MAX_SUBTASKS = 4;
const MAX_ACTIONS_PER_WORK = 4;
const MAX_MODEL_CALLS = 24; // absolute ceiling per run, all stages combined
const MAX_NOTE_CHARS = 2500; // what a work stage may hand forward
const MAX_STAGE_TOKENS = 700;

const TEMPLATES = [
  {
    id: "research",
    label: "Research team",
    blurb: "Planner splits the question, researchers search and read, a writer synthesizes, a critic checks it.",
    tools: ["web_search", "read_page", "write_file", "read_file", "list_files"],
    stages: ["plan", "work", "write", "critique", "revise"],
    workGoal: "Research this sub-question using the tools. Gather concrete facts with their sources.",
  },
  {
    id: "analyst",
    label: "Analyst (with code)",
    blurb: "Planner scopes the job, a coder computes with sandboxed scripts over workspace files, an explainer reports.",
    tools: ["run_code", "write_file", "read_file", "list_files"],
    stages: ["plan", "work", "write"],
    workGoal:
      "Accomplish this sub-task by writing and running code with the run_code tool. " +
      "Print results you need to see; iterate if a run errors.",
  },
  {
    id: "review",
    label: "Write & review",
    blurb: "A drafter writes, a critic pushes back, a reviser applies the critique. No tools, pure quality loop.",
    tools: [],
    stages: ["write", "critique", "revise"],
  },
];

class TeamRunner {
  /**
   * chatFn({ model, messages, maxTokens }) -> Promise<string> — one
   * completion, however the host routes it (local engine, network class).
   * registry — the unified tool layer; may be null for tool-less templates.
   */
  constructor({ chatFn, registry = null, onEvent = () => {} }) {
    this.chatFn = chatFn;
    this.registry = registry;
    this.onEvent = onEvent;
  }

  templates() {
    return TEMPLATES.map(({ id, label, blurb, tools, stages }) => ({ id, label, blurb, tools, stages }));
  }

  /**
   * Run one team. Returns { answer, trace, modelCalls }.
   * onTrace(entry) fires per step for live streaming.
   */
  async run({ template, question, model, allowSensitive = false, onTrace = () => {} }) {
    const spec = TEMPLATES.find((t) => t.id === String(template || ""));
    if (!spec) throw new Error(`unknown team template: ${template}`);
    const q = String(question || "").trim();
    if (!q) throw new Error("the team needs a question or task");

    const state = { calls: 0, trace: [] };
    const emit = (entry) => {
      const e = { at: Date.now(), ...entry };
      state.trace.push(e);
      try { onTrace(e); } catch { /* a broken listener must not kill the run */ }
    };
    const ask = async (role, messages) => {
      if (state.calls >= MAX_MODEL_CALLS) throw new Error("team budget exhausted (model calls)");
      state.calls += 1;
      const content = String((await this.chatFn({ model, messages, maxTokens: MAX_STAGE_TOKENS })) ?? "");
      emit({ stage: role, type: "model", detail: content.slice(0, 400) });
      return content;
    };

    emit({ stage: "team", type: "note", detail: `${spec.label} on: ${q.slice(0, 200)}${allowSensitive ? " (sensitive tools pre-approved by the user)" : ""}` });

    // ---- plan ----
    let subtasks = [q];
    if (spec.stages.includes("plan")) {
      const planOut = await ask("planner", [
        {
          role: "system",
          content:
            `You are the planner of a small team. Break the user's task into at most ${MAX_SUBTASKS} concrete, ` +
            "independent sub-tasks. Reply with ONLY a numbered list, one sub-task per line, nothing else.",
        },
        { role: "user", content: q },
      ]);
      const lines = planOut
        .split("\n")
        .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
        .filter((l) => l.length > 3);
      if (lines.length) subtasks = lines.slice(0, MAX_SUBTASKS);
      emit({ stage: "planner", type: "note", detail: `plan: ${subtasks.length} sub-task(s)` });
    }

    // ---- work (tool-using ReAct per sub-task) ----
    const notes = [];
    if (spec.stages.includes("work")) {
      for (const [i, sub] of subtasks.entries()) {
        const note = await this._workStage({ spec, sub, model, allowSensitive, ask, emit, index: i });
        notes.push(`Sub-task ${i + 1}: ${sub}\n${note}`);
      }
    }

    // ---- write ----
    const context = notes.length ? `Team notes:\n\n${notes.join("\n\n")}` : "";
    let draft = await ask("writer", [
      {
        role: "system",
        content:
          "You are the team's writer. Produce the final answer to the user's task" +
          (notes.length ? " USING ONLY the team notes provided — cite nothing the notes do not support." : ".") +
          " Be complete but not padded.",
      },
      { role: "user", content: `${q}${context ? `\n\n${context}` : ""}` },
    ]);

    // ---- critique + one revision ----
    if (spec.stages.includes("critique")) {
      const critique = await ask("critic", [
        {
          role: "system",
          content:
            "You are the team's critic. Review the draft against the task" +
            (notes.length ? " and the team notes" : "") +
            '. If it is accurate and complete reply with exactly "PASS". Otherwise list the concrete problems, briefly.',
        },
        { role: "user", content: `Task: ${q}\n\nDraft:\n${draft}${context ? `\n\n${context}` : ""}` },
      ]);
      if (!/^\s*PASS\b/i.test(critique) && spec.stages.includes("revise")) {
        emit({ stage: "critic", type: "note", detail: "revision requested" });
        draft = await ask("reviser", [
          {
            role: "system",
            content: "You are the team's reviser. Rewrite the draft to fix the critic's points. Output only the revised answer.",
          },
          { role: "user", content: `Task: ${q}\n\nDraft:\n${draft}\n\nCritique:\n${critique}${context ? `\n\n${context}` : ""}` },
        ]);
      } else {
        emit({ stage: "critic", type: "note", detail: "PASS" });
      }
    }

    emit({ stage: "team", type: "note", detail: `done in ${state.calls} model call(s)` });
    return { answer: draft, trace: state.trace, modelCalls: state.calls };
  }

  /** One bounded ReAct loop: the same JSON-action grammar as the solo agent. */
  async _workStage({ spec, sub, model, allowSensitive, ask, emit, index }) {
    const role = `worker${index + 1}`;
    const available = (this.registry ? this.registry.list() : []).filter((t) => spec.tools.includes(t.name));
    if (!available.length) return "(no tools available — nothing gathered)";
    const names = available.map((t) => t.name);
    const system =
      `${spec.workGoal || "Work on this sub-task with the tools."}\n\n` +
      buildAgentSystem(available, { question: sub, allNames: names });
    let convo = [
      { role: "system", content: system },
      { role: "user", content: sub },
    ];
    const findings = [];
    for (let step = 0; step < MAX_ACTIONS_PER_WORK; step++) {
      const out = await ask(role, trimConvo(convo));
      const action = parseAgentAction(out, names);
      if (!action || action.answer) break;
      let observation;
      try {
        observation = await this.registry.call(action.tool, action.args, { confirmed: allowSensitive });
      } catch (e) {
        // A sensitive tool without upfront consent lands here too — the
        // refusal is data the model can route around, not a crash.
        observation = `tool error: ${e.message}`;
      }
      emit({ stage: role, type: "tool", detail: `${action.tool} -> ${String(observation).slice(0, 200)}` });
      findings.push(`[${action.tool}] ${observation}`);
      convo.push({ role: "assistant", content: out });
      convo.push({ role: "user", content: `Observation:\n${observation}\n\nContinue, or reply {"answer": true} when done.` });
    }
    // Condense what this worker learned into a bounded note.
    const summary = await ask(role, [
      {
        role: "system",
        content: "Summarize what you established for this sub-task in a few dense sentences. Facts and sources only.",
      },
      { role: "user", content: `Sub-task: ${sub}\n\nRaw findings:\n${findings.join("\n").slice(0, 6000) || "(none)"}` },
    ]);
    return summary.slice(0, MAX_NOTE_CHARS);
  }
}

module.exports = { TeamRunner, TEMPLATES };
