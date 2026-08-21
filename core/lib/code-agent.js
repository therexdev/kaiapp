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

class CodeAgent {
  /** chatFn({model, messages, maxTokens}) -> Promise<string> — the host's
   *  loopback lane, so runs inherit every routing/privacy rule. */
  constructor({ chatFn, onEvent = () => {}, approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS }) {
    this.chatFn = chatFn;
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
  async run({ dir, task, model = "", maxSteps, onTrace = () => {} }) {
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
    const tools = makeTools(root, { yes: false, allowCommands: false, io });
    const names = tools.map((t) => t.name);

    try {
      onTrace({ type: "start", runId });
      const convo = [
        { role: "system", content: `${PREAMBLE}${projectContext(root)}\n\n${buildAgentSystem(tools, { question: q, allNames: names })}` },
        { role: "user", content: q },
      ];
      for (let step = 0; step < budget; step++) {
        if (run.aborted) return { runId, answer: "", steps: step, reason: "stopped" };
        const out = String((await this.chatFn({ model, messages: trimConvo(convo), maxTokens: MAX_TOKENS_PER_CALL })) ?? "");
        if (run.aborted) return { runId, answer: "", steps: step, reason: "stopped" };
        const action = parseAgentAction(out, names);
        if (!action) {
          // No parsable action: with small models that IS the final answer.
          return { runId, answer: out.trim(), steps: step, reason: "answered" };
        }
        if (action.answer) {
          convo.push({ role: "assistant", content: out });
          convo.push({ role: "user", content: "Give the final answer to the task now, as plain text." });
          const fin = String((await this.chatFn({ model, messages: trimConvo(convo), maxTokens: MAX_TOKENS_PER_CALL })) ?? "");
          return { runId, answer: fin.trim(), steps: step, reason: "answered" };
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

module.exports = { CodeAgent };
