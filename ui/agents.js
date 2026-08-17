/*
 * Deep Research + Agent mode (renderer side). Both phases GATHER; the final
 * answer always streams through the normal chat path so the UX (typing dots,
 * markdown, stop button, citations) stays identical. Both run entirely
 * through Core endpoints — the renderer's CSP still egresses nowhere.
 *
 * Small-model discipline: every intermediate model call is short, has ONE
 * job, and demands a tiny output (notes, a JSON action). Pages are condensed
 * to notes immediately so the working set fits a 4k context no matter how
 * many rounds run.
 *
 * Dual-mode file (markdown.js pattern): browser gets window.KaiAgents; node
 * tests import the pure helpers.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KaiAgents = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var RESEARCH_MAX_ROUNDS = 3;
  var RESEARCH_MAX_PAGES = 6;
  var AGENT_MAX_STEPS = 6;
  var OBS_CAP = 1200; // chars of tool output fed back per step

  /** First balanced {...} block in model output → parsed object, or null.
   *  Small models wrap JSON in prose/fences; never trust raw JSON.parse. */
  function extractJson(text) {
    var s = String(text || "");
    var start = s.indexOf("{");
    while (start !== -1) {
      var depth = 0;
      var inStr = false;
      for (var i = start; i < s.length; i++) {
        var c = s[i];
        if (inStr) {
          if (c === "\\") i++;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(s.slice(start, i + 1));
            } catch (e) {
              break; // malformed — try the next candidate block
            }
          }
        }
      }
      start = s.indexOf("{", start + 1);
    }
    return null;
  }

  /** Validate a model "action" into {tool,args} | {answer:true} | null. */
  function parseAgentAction(text, toolNames) {
    var j = extractJson(text);
    if (!j) return null;
    if (j.answer === true || j.final === true || j.done === true) return { answer: true };
    var name = j.tool || j.name || j.action;
    if (typeof name === "string" && toolNames.indexOf(name) !== -1) {
      var args = j.args || j.arguments || j.parameters || {};
      return { tool: name, args: typeof args === "object" && args ? args : {} };
    }
    return null;
  }

  function buildAgentSystem(tools) {
    var lines = tools.map(function (t) {
      var params = Object.keys(t.params || {}).map(function (k) {
        return k + " (" + t.params[k] + ")";
      });
      return "- " + t.name + ": " + t.description + (params.length ? " Args: " + params.join(", ") : "");
    });
    return (
      "You can use tools before answering. Available tools:\n" +
      lines.join("\n") +
      '\n\nRespond with ONLY a JSON object, nothing else.\nTo use a tool: {"tool": "tool_name", "args": {...}}\nWhen you have enough to answer: {"answer": true}\nUse at most one tool per response. Prefer answering as soon as you can.'
    );
  }

  // ---- browser-only runtime below (needs fetch to Core) ----
  function makeRuntime(deps) {
    var askModelOnce = deps.askModelOnce; // (messages) => Promise<string>
    var setStatus = deps.setStatus || function () {};
    var confirmTool = deps.confirmTool || function () { return Promise.resolve(false); };

    function coreJson(path, opts) {
      return fetch(path, opts).then(function (r) {
        return r.json().then(function (j) {
          j._status = r.status;
          return j;
        });
      });
    }

    /** Multi-round research: search → read → condense → assess gap → repeat. */
    function deepResearch(question, model) {
      var notes = [];
      var citations = [];
      var seen = {};
      var pagesRead = 0;

      function searchOnce(query, round) {
        setStatus("🔎 Round " + round + ": searching — " + query);
        return coreJson("/core/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ q: query }),
        }).then(function (sr) {
          if (!sr.ok) throw new Error(sr.error || "search failed");
          var picks = (sr.results || []).filter(function (r) { return !seen[r.url]; }).slice(0, 2);
          var chain = Promise.resolve();
          picks.forEach(function (r) {
            chain = chain.then(function () {
              if (pagesRead >= RESEARCH_MAX_PAGES) return;
              seen[r.url] = true;
              pagesRead++;
              setStatus("📖 Reading " + (new URL(r.url).hostname) + "…");
              return coreJson("/core/fetch", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ url: r.url }),
              }).then(function (pr) {
                if (!pr.ok || !pr.page) return;
                setStatus("✍️ Taking notes from " + (new URL(r.url).hostname) + "…");
                return askModelOnce([
                  { role: "user", content: "Question: " + question + "\n\nArticle from " + r.url + ":\n" + String(pr.page.text || "").slice(0, 5000) + "\n\nList ONLY facts from this article that help answer the question, as short bullet points (max 6). If nothing helps, reply: NOTHING RELEVANT." },
                ], model).then(function (out) {
                  if (out && out.indexOf("NOTHING RELEVANT") === -1) {
                    notes.push("From " + r.url + ":\n" + out.trim().slice(0, 900));
                    citations.push({ title: pr.page.title || r.title || r.url, url: r.url });
                  }
                });
              }).catch(function () { /* page failed — research continues */ });
            });
          });
          return chain;
        });
      }

      function round(n, query) {
        return searchOnce(query, n).then(function () {
          if (n >= RESEARCH_MAX_ROUNDS || pagesRead >= RESEARCH_MAX_PAGES || !notes.length) return null;
          setStatus("🤔 Checking what's still missing…");
          return askModelOnce([
            { role: "user", content: "Question: " + question + "\n\nNotes so far:\n" + notes.join("\n\n").slice(0, 3000) + '\n\nCan the question be answered well from these notes? Respond with ONLY JSON: {"done": true} or {"search": "a better search query for what is missing"}' },
          ], model).then(function (out) {
            var j = extractJson(out);
            if (j && typeof j.search === "string" && j.search.trim() && n < RESEARCH_MAX_ROUNDS) {
              return round(n + 1, j.search.trim().slice(0, 120));
            }
            return null;
          });
        });
      }

      return round(1, question).then(function () {
        setStatus(notes.length ? "🧠 Writing up from " + citations.length + " sources…" : "");
        if (!notes.length) return null;
        return {
          context:
            "Research notes gathered from the web (with sources) for the next question:\n\n" +
            notes.join("\n\n") +
            "\n\nAnswer the question using these notes. Mention which source supports key claims.",
          citations: citations,
          trace: "🔬 Deep research — " + pagesRead + " pages across " + Math.min(RESEARCH_MAX_ROUNDS, citations.length ? RESEARCH_MAX_ROUNDS : 1) + " rounds",
        };
      });
    }

    /** Tool-using loop. Every step is visible; sensitive tools confirm. */
    function runAgent(question, model) {
      return coreJson("/core/tools", {}).then(function (tr) {
        var tools = tr.tools || [];
        if (!tools.length) return null;
        var toolNames = tools.map(function (t) { return t.name; });
        var system = buildAgentSystem(tools);
        var convo = [{ role: "system", content: system }, { role: "user", content: question }];
        var observations = [];
        var citations = [];
        var traceLines = [];

        function callTool(name, args, confirmed) {
          return coreJson("/core/tools/call", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: name, args: args, confirmed: Boolean(confirmed) }),
          }).then(function (out) {
            if (out.ok) return out.result;
            if (out.needsConfirmation && !confirmed) {
              return confirmTool(name, args).then(function (yes) {
                if (!yes) return "(the user declined this tool call — try another way or answer with what you have)";
                return callTool(name, args, true);
              });
            }
            return "(tool error: " + (out.error || "failed") + ")";
          });
        }

        function step(n) {
          if (n > AGENT_MAX_STEPS) return Promise.resolve();
          setStatus("🤖 Step " + n + ": deciding…");
          return askModelOnce(convo, model).then(function (out) {
            var action = parseAgentAction(out, toolNames);
            if (!action) {
              // Model refused the format twice = it wants to answer.
              convo.push({ role: "user", content: 'Respond with ONLY JSON: {"tool": ..., "args": ...} or {"answer": true}' });
              return n === AGENT_MAX_STEPS ? Promise.resolve() : step(n + 1);
            }
            if (action.answer) return Promise.resolve();
            var label = action.tool.replace(/^mcp:[^:]+:/, "");
            setStatus("🛠 " + label + " " + JSON.stringify(action.args).slice(0, 80) + "…");
            return callTool(action.tool, action.args).then(function (result) {
              traceLines.push("🛠 " + label + " → " + String(result).split("\n")[0].slice(0, 90));
              observations.push({ tool: label, args: action.args, result: String(result).slice(0, OBS_CAP) });
              // Harvest citations from web-ish results.
              if (action.tool === "web_search" || action.tool === "read_page") {
                var urls = String(result).match(/https?:\/\/[^\s\]]+/g) || [];
                if (action.args && action.args.url) urls.unshift(String(action.args.url));
                urls.slice(0, 2).forEach(function (u) {
                  if (!citations.some(function (c) { return c.url === u; })) citations.push({ title: u.replace(/^https?:\/\//, "").slice(0, 80), url: u });
                });
              }
              convo.push({ role: "assistant", content: JSON.stringify({ tool: action.tool, args: action.args }) });
              convo.push({ role: "user", content: "Tool result:\n" + String(result).slice(0, OBS_CAP) + '\n\nNext: ONLY JSON — another {"tool": ...} or {"answer": true}.' });
              return step(n + 1);
            });
          });
        }

        return step(1).then(function () {
          setStatus(observations.length ? "🧠 Writing up…" : "");
          if (!observations.length) return null;
          return {
            context:
              "You used tools to gather the following before answering:\n\n" +
              observations.map(function (o) { return "• " + o.tool + "(" + JSON.stringify(o.args) + "):\n" + o.result; }).join("\n\n").slice(0, 6000) +
              "\n\nNow answer the user's question using what you found.",
            citations: citations.slice(0, 8),
            trace: "🤖 Agent — " + observations.length + " tool call" + (observations.length === 1 ? "" : "s") + ": " + traceLines.map(function (l) { return l.split(" → ")[0].replace("🛠 ", ""); }).join(", "),
          };
        });
      });
    }

    return { deepResearch: deepResearch, runAgent: runAgent };
  }

  return {
    extractJson: extractJson,
    parseAgentAction: parseAgentAction,
    buildAgentSystem: buildAgentSystem,
    makeRuntime: makeRuntime,
    RESEARCH_MAX_ROUNDS: RESEARCH_MAX_ROUNDS,
    AGENT_MAX_STEPS: AGENT_MAX_STEPS,
  };
});
