"use strict";
const crypto = require("crypto"), P = require("../core/lib/koin-network/job-protocol");
class CreditRunExecutor {
  constructor({ service, core }) { Object.assign(this, { service, core }); this.active = new Map(); }
  stop(id) { P.digest(id); this.active.get(id)?.abort.abort(); }
  input({ runId, inputId, text }) {
    P.digest(runId); if (typeof inputId !== "string" || inputId.length > 200 || typeof text !== "string" || text.length > 24000) throw Error("Invalid run input");
    return { accepted: this.active.get(runId)?.runner?.provideInput(inputId, text) === true };
  }
  async execute(c, input, outerSignal) {
    if (!input || Object.keys(input).sort().join() !== "body,kind,runId" || !["team", "agents"].includes(input.kind)) throw Error("Exact supported advanced run required");
    const run = this.service.runs.read(c, input.runId), body = input.body;
    if (run.mode !== input.kind || !body || body.model !== "koinos-network" && body.model !== "koinos-network:" + run.model) throw Error("Approved run mode or model changed");
    if (this.active.has(run.id)) throw Error("This run is already executing");
    if ((input.kind === "agents" || body.spec !== undefined) && !this.core.gateway.dev?.status().enabled) throw Error("Custom agent definitions require Developer tools");
    const abort = new AbortController(), signal = AbortSignal.any([outerSignal, abort.signal]);
    const state = { abort, runner: null, localId: null }; this.active.set(run.id, state);
    const guard = () => { signal.throwIfAborted(); this.core.account.assertCreditAuthorization(c.auth, c.config.schedulerUrl); };
    const registry = this.core.gateway.tools;
    const tools = registry && { list: () => registry.list(), call: async (...args) => { guard(); const value = await registry.call(...args); guard(); return value; } };
    const chatFn = async ({ messages, maxTokens }) => {
      guard();
      const result = await this.service.runs.chat(c, { runId: run.id, callId: crypto.randomBytes(32).toString("hex"),
        request: { model: "koinos-network:" + run.model, messages, max_tokens: Math.min(maxTokens, c.config.maxOutput), stream: false } }, signal);
      guard(); return result.choices[0].message.content;
    };
    const onTrace = trace => {
      if (trace.type === "start") state.localId = trace.runId;
      this.service.progress({ runId: run.id, trace });
    };
    const cancel = () => { if (state.localId) state.runner?.stop(state.localId); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      guard();
      if (input.kind === "team") {
        if (Object.keys(body).some(k => !["template", "spec", "question", "model", "allowSensitive"].includes(k))) throw Error("Invalid team run");
        return await new (require("../core/lib/teams").TeamRunner)({ registry: tools, chatFn }).run({ ...body, allowSensitive: body.allowSensitive === true, onTrace });
      }
      if (Object.keys(body).some(k => !["defId", "spec", "task", "model", "allowSensitive"].includes(k))) throw Error("Invalid agent run");
      const spec = body.spec ?? this.core.gateway.agents?.defs.get(body.defId)?.spec;
      if (!spec) throw Error("Choose a saved agent definition");
      state.runner = new (require("../core/lib/groupchat").GroupChatRunner)({ registry: tools, chatFn });
      return await state.runner.run({ ...body, spec, allowSensitive: body.allowSensitive === true, onTrace });
    } finally { signal.removeEventListener("abort", cancel); this.active.delete(run.id); }
  }
}
module.exports = { CreditRunExecutor };
