"use strict";

/*
 * Unified tool layer (§7-aware). EVERYTHING a model can do besides generate
 * text registers here — built-ins (web, memory, workspace files), MCP server
 * tools, email, calendar — so policy lives in ONE place instead of being
 * re-implemented per feature:
 *
 *   egress:    the tool sends data off this machine. Refused outright in
 *              Local-Only mode, same contract as network chat and /core/search.
 *   sensitive: the tool changes something or exposes private data. A call
 *              must arrive with confirmed:true — the UI shows the user what
 *              is about to run and only sets that flag on an explicit yes.
 *              Core enforces it server-side; the flag is not a UI courtesy.
 *
 * The registry is deliberately dumb: no planning, no chaining. Agent loops
 * live in the renderer where the user can watch every step.
 */

const MAX_RESULT_CHARS = 8000; // observations must fit small local contexts

class ToolRegistry {
  constructor({ privacyMode }) {
    this._privacyMode = privacyMode || (() => "local-only"); // fail closed
    this._tools = new Map();
  }

  /** register({ name, description, params, egress, sensitive, handler }) */
  register(tool) {
    if (!/^[a-z0-9_.:-]+$/i.test(tool.name)) throw new Error(`bad tool name: ${tool.name}`);
    this._tools.set(tool.name, {
      params: {},
      egress: true, // unspecified = assume the worst
      sensitive: true,
      ...tool,
    });
  }

  unregister(prefix) {
    for (const name of [...this._tools.keys()]) {
      if (name === prefix || name.startsWith(prefix + ":")) this._tools.delete(name);
    }
  }

  /** Tools usable RIGHT NOW under the current privacy mode (for the UI and
   *  for building agent prompts). Egress tools vanish in Local-Only rather
   *  than showing up broken. */
  list() {
    const localOnly = this._privacyMode() === "local-only";
    return [...this._tools.values()]
      .filter((t) => !(localOnly && t.egress))
      .map(({ name, description, params, egress, sensitive }) => ({ name, description, params, egress, sensitive }));
  }

  async call(name, args = {}, { confirmed = false } = {}) {
    const tool = this._tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    if (tool.egress && this._privacyMode() === "local-only") {
      throw new Error(`Privacy mode is Local-Only: "${name}" sends data off this machine and is disabled`);
    }
    if (tool.sensitive && !confirmed) {
      // Machine-readable so the UI can turn this into a confirm dialog.
      const err = new Error(`"${name}" needs your confirmation before it runs`);
      err.needsConfirmation = true;
      throw err;
    }
    const out = await tool.handler(args);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    return text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + "\n[truncated]" : text;
  }
}

module.exports = { ToolRegistry, MAX_RESULT_CHARS };
