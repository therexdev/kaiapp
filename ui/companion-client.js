"use strict";
(() => {
  const bridge = window.kaiCompanionBridge;
  async function checked(promise) { const out = await promise; if (!out?.ok) throw new Error(out?.error || "Companion unavailable."); return out.result; }
  // Only final replies receive automatic recall. Planning accesses Brain with
  // explicit private tools, so ordinary web research never starts with notes.
  async function enrich(body) {
    if (!bridge || !body.model) return body;
    const query = [...(body.messages || [])].reverse().find(m => m.role === "user" && typeof m.content === "string")?.content || "";
    const out = await checked(bridge.context(body.model, query));
    if (!out.eligible) return body;
    const next = { ...body, kai_private_desktop: true };
    if (body.stream !== false && out.context) next.messages = [{ role: "system", content: out.context }, ...(body.messages || [])];
    return next;
  }
  function toolJSON(model, fallback, signal) {
    let privateUsed = false, privateTools = [];
    signal?.addEventListener("abort", () => bridge?.cancel().catch(() => {}), { once: true });
    return async (url, options = {}) => {
      signal?.throwIfAborted();
      if (!bridge) return fallback(url, options);
      if (url === "/core/tools") {
        const [core, extra] = await Promise.all([fallback(url, options), checked(bridge.tools(model))]);
        privateTools = extra; return { ...core, tools: [...(core.tools || []), ...extra] };
      }
      if (url === "/core/tools/call") {
        const call = JSON.parse(options.body);
        if (privateTools.some(t => t.name === call.name)) {
          privateUsed = true;
          try { const result = await checked(bridge.tool(call.name, call.args, model)); signal?.throwIfAborted(); return { ok: true, result: typeof result === "string" ? result : JSON.stringify(result) }; }
          catch (e) { signal?.throwIfAborted(); throw e; }
        }
        // Once private observations enter the planner, it cannot forward them
        // to a web/MCP/Core tool. Further private connection calls ask natively.
        if (privateUsed) throw new Error("Private Brain or connection data is in this turn. Start a separate request to use other tools.");
      }
      return fallback(url, options);
    };
  }
  window.KaiCompanionClient = { enrich, toolJSON, checked };
})();
