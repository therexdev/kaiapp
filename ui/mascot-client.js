(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KaiCompanion = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const PERSONA = "You are KAI, a friendly, capable desktop robot companion. Be warm, direct and useful. Answer the user's actual question, and ask a short follow-up when needed. Prefer concise conversational replies unless the user asks for detail. This conversation currently supports text and voice, not control of the computer. Do not claim you opened apps, read files, saw the screen, changed settings or performed actions. Explain how the user can do something when you cannot do it yourself.";
  function chooseModel(aliases, active, requested, saved) {
    const ready = aliases.filter(a => a.status === "ready");
    if (requested && /^koinos-network(?::.+)?$/.test(requested)) return requested;
    return [requested, saved, active].find(v => ready.some(a => a.alias === v)) ||
      ready.find(a => !a.dev)?.alias || ready[0]?.alias || "";
  }
  function messagesFor(history, contextSize = 4096) {
    const limit = Math.max(1000, Math.floor((contextSize - 1300) * 3));
    const kept = [];
    let used = PERSONA.length;
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (!["user", "assistant"].includes(m.role) || typeof m.content !== "string") continue;
      if (used + m.content.length > limit && kept.length) break;
      kept.unshift({ role: m.role, content: m.content });
      used += m.content.length + 20;
    }
    while (kept[0]?.role === "assistant") kept.shift();
    return [{ role: "system", content: PERSONA }, ...kept];
  }
  async function* completion(response) {
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error?.message || data?.error || "KAI could not get a reply (" + response.status + ").");
    }
    if (/application\/json/i.test(response.headers.get("content-type") || "")) {
      const data = await response.json();
      if (data.error) throw new Error(data.error.message || String(data.error));
      yield { content: data.choices?.[0]?.message?.content || "", model: data.model, served: data.servedModel };
      return;
    }
    if (!response.body) throw new Error("The reply stream is missing.");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "", finished = false;
    function parse(frame) {
      const data = frame.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
      if (!data) return null;
      if (data.trim() === "[DONE]") { finished = true; return null; }
      let value;
      try { value = JSON.parse(data); } catch { throw new Error("The reply stream contained an unreadable message. Please try again."); }
      if (value.error) throw new Error(value.error.message || String(value.error));
      if (value.choices?.[0]?.finish_reason != null) finished = true;
      return { content: value.choices?.[0]?.delta?.content || "", model: value.model, served: value.servedModel };
    }
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const delta = parse(frame);
          if (delta) yield delta;
        }
        if (done) break;
      }
      if (buffer.trim()) { const delta = parse(buffer); if (delta) yield delta; }
      if (!finished) throw new Error("The connection ended before KAI finished. You can try again.");
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  function speechText(text) {
    return String(text).replace(/\x60{3}[\s\S]*?\x60{3}/g, " Code is shown in the chat. ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[#*_\x60>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 6000);
  }
  return { PERSONA, chooseModel, messagesFor, completion, speechText };
});
