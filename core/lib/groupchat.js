"use strict";

const crypto = require("crypto");
const { buildAgentSystem, parseAgentAction, trimConvo } = require("../../ui/agents");

/*
 * Multi-agent group chats (task #64) — the full-AutoGen track of Developer
 * Tools. Named agents share ONE transcript and take turns; the turn order is
 * the team's mode (round_robin / selector / handoff); humans are agents too —
 * selecting one PAUSES the run until the person answers or a timeout ends it
 * honestly. Design: docs/agents-runtime-design.md.
 *
 * The law carried over from teams.js: budgets are HARD and a spec can only
 * lower them; tools go through the ONE registry with the same
 * egress/sensitive policy; a group chat can never loop forever.
 */

const MAX_AGENTS = 8;
const MAX_MESSAGES = 60; // transcript entries, task included
const MAX_MODEL_CALLS = 120; // absolute — selector + tool turns included
const MAX_TOOL_ACTIONS_PER_TURN = 6;
const MAX_PROMPT_CHARS = 4000; // per-agent system prompt
const MAX_MESSAGE_CHARS = 6000; // one agent's turn, bounded before it lands
const MAX_TURN_TOKENS = 700;
const TRANSCRIPT_KEEP = 14; // recent messages shown to a speaker (plus task)
const DEFAULT_INPUT_TIMEOUT_MS = 5 * 60 * 1000;
const MODES = ["round_robin", "selector", "handoff"];

function clamp(v, ceiling, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(ceiling, Math.floor(n)));
}

/** Validate a raw group spec into a runnable one. Throws with the exact rule
 *  that failed — a developer surface owes precise errors. */
function normalizeGroupSpec(raw, knownTools = null) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("group spec must be a JSON object");
  if (!Array.isArray(raw.agents) || raw.agents.length < 2) throw new Error("a group chat needs at least 2 agents");
  if (raw.agents.length > MAX_AGENTS) throw new Error(`at most ${MAX_AGENTS} agents per group`);
  const seen = new Set();
  const agents = raw.agents.map((a, i) => {
    if (!a || typeof a !== "object") throw new Error(`agent ${i + 1} must be an object`);
    const name = String(a.name || "").trim();
    if (!/^[A-Za-z][\w-]{0,23}$/.test(name)) {
      throw new Error(`agent ${i + 1} needs a name (letters/digits/_/-, starts with a letter, max 24 chars)`);
    }
    if (seen.has(name.toLowerCase())) throw new Error(`duplicate agent name "${name}"`);
    seen.add(name.toLowerCase());
    const human = a.human === true;
    const tools = (Array.isArray(a.tools) ? a.tools : []).map(String);
    if (human && tools.length) throw new Error(`human agent "${name}" cannot hold tools`);
    if (knownTools) {
      for (const t of tools) {
        if (!knownTools.includes(t)) throw new Error(`agent "${name}": unknown tool "${t}" — this machine has: ${knownTools.join(", ") || "(none)"}`);
      }
    }
    return {
      name,
      human,
      tools,
      systemPrompt: String(a.systemPrompt || (human ? "" : `You are ${name}.`)).slice(0, MAX_PROMPT_CHARS),
    };
  });
  if (agents.every((a) => a.human)) throw new Error("at least one agent must be a model — an all-human group is a chat room, not a team");
  const mode = String(raw.mode || "round_robin");
  if (!MODES.includes(mode)) throw new Error(`unknown mode "${mode}" — valid: ${MODES.join(", ")}`);
  const t = raw.termination && typeof raw.termination === "object" ? raw.termination : {};
  return {
    label: String(raw.label || "Group chat").slice(0, 80),
    agents,
    mode,
    selectorPrompt: String(raw.selectorPrompt || "").slice(0, MAX_PROMPT_CHARS),
    maxToolActionsPerTurn: clamp(raw.maxToolActionsPerTurn, MAX_TOOL_ACTIONS_PER_TURN, MAX_TOOL_ACTIONS_PER_TURN),
    termination: {
      maxMessages: clamp(t.maxMessages, MAX_MESSAGES, MAX_MESSAGES),
      maxModelCalls: clamp(t.maxModelCalls, MAX_MODEL_CALLS, MAX_MODEL_CALLS),
      // Optional: a message containing this text ends the conversation.
      textMention: t.textMention === undefined || t.textMention === null ? "TERMINATE" : String(t.textMention).slice(0, 80) || null,
    },
    inputTimeoutMs: clamp(raw.inputTimeoutMs, 30 * 60 * 1000, DEFAULT_INPUT_TIMEOUT_MS),
  };
}

class GroupChatRunner {
  /** chatFn — same contract as TeamRunner's. registry — the unified tool
   *  layer (null = tool-less agents only). */
  constructor({ chatFn, registry = null, onEvent = () => {} }) {
    this.chatFn = chatFn;
    this.registry = registry;
    this.onEvent = onEvent;
    this._pendingInputs = new Map(); // inputId -> { resolve, timer, runId }
    this._runs = new Map(); // runId -> { abort }
  }

  /** Answer a pending human turn. Returns false for unknown/expired ids. */
  provideInput(inputId, text) {
    const p = this._pendingInputs.get(String(inputId || ""));
    if (!p) return false;
    this._pendingInputs.delete(String(inputId));
    clearTimeout(p.timer);
    p.resolve({ text: String(text ?? "").slice(0, MAX_MESSAGE_CHARS), timedOut: false });
    return true;
  }

  /** Stop a running conversation (the playground's Stop button). */
  stop(runId) {
    const r = this._runs.get(String(runId || ""));
    if (!r) return false;
    r.aborted = true;
    // A run blocked on a human resolves immediately as stopped.
    for (const [id, p] of this._pendingInputs) {
      if (p.runId === runId) {
        this._pendingInputs.delete(id);
        clearTimeout(p.timer);
        p.resolve({ text: "", timedOut: true });
      }
    }
    return true;
  }

  /**
   * Run one conversation. onTrace(entry) streams live; entries:
   *   {type:"message", name, content} — a turn landed on the transcript
   *   {type:"tool", name, detail}     — a tool call inside a turn
   *   {type:"input-request", inputId, name} — a human agent must speak
   *   {type:"note", detail}           — termination reason etc.
   * Returns { runId, transcript, modelCalls, reason }.
   */
  async run({ spec: rawSpec, task, model, allowSensitive = false, onTrace = () => {} }) {
    const spec = normalizeGroupSpec(rawSpec, this.registry ? this.registry.list().map((t) => t.name) : null);
    const q = String(task || "").trim();
    if (!q) throw new Error("the group needs a task");
    const runId = crypto.randomBytes(8).toString("hex");
    const run = { aborted: false };
    this._runs.set(runId, run);

    const transcript = [{ name: "task", content: q.slice(0, MAX_MESSAGE_CHARS) }];
    let calls = 0;
    const emit = (entry) => {
      try { onTrace({ at: Date.now(), ...entry }); } catch { /* a broken listener must not kill the run */ }
    };
    const ask = async (messages) => {
      if (calls >= spec.termination.maxModelCalls) throw new Error("ceiling");
      calls += 1;
      return String((await this.chatFn({ model, messages, maxTokens: MAX_TURN_TOKENS })) ?? "");
    };
    // What a speaker sees: the task always, then the recent tail. Names are
    // folded into content because the engine only knows user/assistant.
    const view = () => {
      const tail = transcript.slice(1).slice(-TRANSCRIPT_KEEP);
      return [transcript[0], ...tail].map((m) => `${m.name}: ${m.content}`).join("\n\n");
    };

    const modelAgents = spec.agents.filter((a) => !a.human);
    let idx = 0; // round-robin cursor over ALL agents
    let floor = null; // handoff mode: who currently holds the floor
    let reason = null;
    // The first event names the run, so a client can Stop it before any
    // turn lands — without this the id only arrives with the result.
    emit({ type: "start", runId, label: spec.label });

    try {
      while (!reason) {
        if (run.aborted) { reason = "stopped"; break; }
        if (transcript.length - 1 >= spec.termination.maxMessages) { reason = "message limit reached"; break; }

        // ---- pick the next speaker ----
        let speaker;
        if (spec.mode === "handoff" && floor) {
          speaker = floor;
        } else if (spec.mode === "selector" && transcript.length > 1) {
          // One constrained call; garbage degrades to round-robin fairness.
          let picked = null;
          try {
            const out = await ask([
              {
                role: "system",
                content:
                  (spec.selectorPrompt || "You moderate a team conversation. Read it and decide who should speak next.") +
                  `\n\nAgents: ${spec.agents.map((a) => a.name).join(", ")}.` +
                  "\nReply with ONLY one agent name, nothing else.",
              },
              { role: "user", content: view() },
            ]);
            const m = out.trim().match(/[A-Za-z][\w-]*/);
            picked = spec.agents.find((a) => m && a.name.toLowerCase() === m[0].toLowerCase()) || null;
          } catch (e) {
            if (e.message === "ceiling") { reason = "model-call ceiling reached"; break; }
            throw e;
          }
          speaker = picked || spec.agents[idx % spec.agents.length];
        } else {
          speaker = spec.agents[idx % spec.agents.length];
        }
        idx += 1;

        // ---- human turn: pause for the person ----
        if (speaker.human) {
          const inputId = crypto.randomBytes(8).toString("hex");
          emit({ type: "input-request", inputId, name: speaker.name, runId });
          const answer = await new Promise((resolve) => {
            // Deliberately NOT unref'd: a run waiting on a person must keep
            // the process alive — the timeout bounds it, never the event loop.
            const timer = setTimeout(() => {
              this._pendingInputs.delete(inputId);
              resolve({ text: "", timedOut: true });
            }, spec.inputTimeoutMs);
            this._pendingInputs.set(inputId, { resolve, timer, runId });
          });
          if (run.aborted) { reason = "stopped"; break; }
          if (answer.timedOut) { reason = `no reply from ${speaker.name} — input timed out`; break; }
          transcript.push({ name: speaker.name, content: answer.text });
          emit({ type: "message", name: speaker.name, content: answer.text });
          if (spec.mode === "handoff") floor = null; // a person answers, the group decides again
          if (spec.termination.textMention && answer.text.includes(spec.termination.textMention)) reason = `"${spec.termination.textMention}" spoken`;
          continue;
        }

        // ---- model turn: optional tools, then the message ----
        let content;
        try {
          content = await this._turn({ spec, speaker, model, allowSensitive, ask, emit, view });
        } catch (e) {
          if (e.message === "ceiling") { reason = "model-call ceiling reached"; break; }
          throw e;
        }
        content = content.slice(0, MAX_MESSAGE_CHARS);

        // handoff mode: the speaker names a successor, or keeps the floor.
        if (spec.mode === "handoff") {
          const m = content.match(/HANDOFF:\s*([A-Za-z][\w-]*)/);
          const next = m ? spec.agents.find((a) => a.name.toLowerCase() === m[1].toLowerCase()) : null;
          floor = next || speaker;
          if (m) content = content.replace(/HANDOFF:\s*[A-Za-z][\w-]*/g, "").trim();
        }

        transcript.push({ name: speaker.name, content });
        emit({ type: "message", name: speaker.name, content });
        if (spec.termination.textMention && content.includes(spec.termination.textMention)) {
          reason = `"${spec.termination.textMention}" spoken`;
        }
        // All model agents silent (empty turns) is a stall, not progress.
        if (!content && modelAgents.length === 1) reason = "the model returned nothing";
      }
    } finally {
      this._runs.delete(runId);
    }

    emit({ type: "note", detail: `ended: ${reason} (${calls} model calls, ${transcript.length - 1} messages)` });
    return { runId, transcript, modelCalls: calls, reason };
  }

  /** One model agent's turn: a bounded tool loop, then the spoken message. */
  async _turn({ spec, speaker, model, allowSensitive, ask, emit, view }) {
    const handoffNote =
      spec.mode === "handoff"
        ? `\nTo pass the conversation to another agent, include "HANDOFF: <name>" (agents: ${spec.agents.map((a) => a.name).join(", ")}).`
        : "";
    const persona =
      `${speaker.systemPrompt}\n\nYou are "${speaker.name}" in a team conversation. ` +
      `Speak as yourself, to the team, advancing the task.${handoffNote}` +
      (spec.termination.textMention ? `\nWhen the task is fully complete, include "${spec.termination.textMention}".` : "");

    const available = (this.registry ? this.registry.list() : []).filter((t) => speaker.tools.includes(t.name));
    if (!available.length) {
      return (await ask([
        { role: "system", content: persona },
        { role: "user", content: view() },
      ])).trim();
    }

    // Tool phase: same JSON-action grammar as the solo agent and teams.
    const names = available.map((t) => t.name);
    let convo = [
      { role: "system", content: `${persona}\n\n${buildAgentSystem(available, { question: view().slice(-2000), allNames: names })}` },
      { role: "user", content: view() },
    ];
    for (let step = 0; step < spec.maxToolActionsPerTurn; step++) {
      const out = await ask(trimConvo(convo));
      const action = parseAgentAction(out, names);
      if (!action) return out.trim(); // prose IS the turn
      if (action.answer) break;
      let observation;
      try {
        observation = await this.registry.call(action.tool, action.args, { confirmed: allowSensitive });
      } catch (e) {
        observation = `tool error: ${e.message}`;
      }
      emit({ type: "tool", name: speaker.name, detail: `${action.tool} -> ${String(observation).slice(0, 200)}` });
      convo.push({ role: "assistant", content: out });
      convo.push({ role: "user", content: `Observation:\n${String(observation).slice(0, 4000)}\n\nContinue, or reply {"answer": true} to speak to the team.` });
    }
    const spoken = await ask([
      { role: "system", content: persona },
      { role: "user", content: `${view()}\n\nNow give your message to the team, using what your tools found.` },
    ]);
    return spoken.trim();
  }
}

/** Saved team definitions — the Builder's persistence. Raw specs are stored
 *  (the developer's own shape survives round trips) but every save must
 *  normalize cleanly first, so the store can never hold an unrunnable spec. */
const fs = require("fs");
const path = require("path");
const MAX_DEFS = 50;

class GroupDefs {
  constructor(file) {
    this.file = file;
  }

  _read() {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  _write(defs) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(defs, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() {
    return this._read();
  }

  save({ id, spec }, knownTools = null) {
    const normalized = normalizeGroupSpec(spec, knownTools); // throws with the exact rule
    const defs = this._read();
    const defId = String(id || crypto.randomBytes(6).toString("hex"));
    const entry = { id: defId, label: normalized.label, spec, savedAt: new Date().toISOString() };
    const at = defs.findIndex((d) => d.id === defId);
    if (at >= 0) defs[at] = entry;
    else {
      if (defs.length >= MAX_DEFS) throw new Error(`at most ${MAX_DEFS} saved teams — delete one first`);
      defs.push(entry);
    }
    this._write(defs);
    return entry;
  }

  remove(id) {
    const defs = this._read();
    const next = defs.filter((d) => d.id !== String(id));
    if (next.length === defs.length) return false;
    this._write(next);
    return true;
  }

  get(id) {
    return this._read().find((d) => d.id === String(id)) || null;
  }
}

module.exports = { GroupChatRunner, GroupDefs, normalizeGroupSpec };
