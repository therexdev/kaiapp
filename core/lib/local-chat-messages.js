"use strict";

// The pinned Gemma 3 templates accept one leading system message followed by
// alternating user/assistant turns. Chat enrichment may add several instruction
// turns or adjacent user turns (research context, then the question). Adapt only
// the request sent to those local packages; never rewrite saved conversations or
// messages whose network signature/metering was already established elsewhere.
function isGemma3(model) {
  return /^google_gemma-3-(4b|12b|27b)-it-q4_k_m@1$/.test(model?.packageId || "");
}

function joinContent(left, right) {
  if (typeof left === "string" && typeof right === "string") return left + "\n\n" + right;
  const parts = value => typeof value === "string" ? [{ type: "text", text: value }] : value;
  const before = parts(left), after = parts(right);
  // Gemma trims every text part separately, so a standalone whitespace part
  // would vanish. Join adjacent text at the boundary inside one part instead.
  if (before.at(-1)?.type === "text" && after[0]?.type === "text") {
    return [...before.slice(0, -1), { ...before.at(-1), text: before.at(-1).text + "\n\n" + after[0].text }, ...after.slice(1)];
  }
  return [...before, ...after];
}

function instructionText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.every(part => part?.type === "text" && typeof part.text === "string")) return content.map(part => part.text).join("\n\n");
  return null;
}

function localChatMessages(messages, model) {
  if (!isGemma3(model) || !Array.isArray(messages) || !messages.length) return messages;
  // Native tool-call protocols have their own template and parser contract.
  // The app's Agent/Research observations are ordinary text, handled below;
  // do not silently discard tool identifiers or invent native tool support.
  if (messages.some(m => !m || !["system", "developer", "user", "assistant"].includes(m.role) || m.tool_calls || m.function_call)) return messages;
  if (messages.some(m => typeof m.content !== "string" && !Array.isArray(m.content))) return messages;
  const out = [], instructions = [];
  let at = 0;
  for (; at < messages.length && ["system", "developer"].includes(messages[at].role); at++) {
    const text = instructionText(messages[at].content);
    // A multimodal instruction must not be reduced to its first text part,
    // which is all Gemma's leading-system branch renders. Keep its full parts
    // in the first user turn instead.
    if (text === null) break;
    instructions.push(text);
  }
  if (instructions.length) out.push({ ...structuredClone(messages[0]), role: "system", content: instructions.join("\n\n") });
  const append = message => {
    const previous = out.at(-1);
    if (previous?.role === message.role) previous.content = joinContent(previous.content, message.content);
    else out.push(message);
  };
  for (; at < messages.length; at++) {
    const original = messages[at], message = structuredClone(original);
    if (["system", "developer"].includes(message.role)) {
      message.content = joinContent("[" + (message.role === "developer" ? "Developer" : "System") + " message]", message.content);
      message.role = "user";
    }
    if (message.role === "assistant" && (!out.length || out.at(-1).role === "system")) append({ role: "user", content: "" });
    append(message);
  }
  // System-only requests still need a user turn for the generation prefix.
  if (out.at(-1)?.role === "system") out.push({ role: "user", content: "" });
  return out;
}

module.exports = { localChatMessages, isGemma3 };
