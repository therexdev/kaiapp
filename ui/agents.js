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
  var CONVO_KEEP_STEPS = 3; // tool exchanges carried forward (see trimConvo)

  /*
   * Tool-prompt budget. Local models run a 4096-token context (see
   * core/models/catalog.json) and Core REFUSES an oversized prompt outright
   * rather than failing mid-stream. Field report (v0.27.3, a 29-tool MCP
   * server): the tool menu alone blew past the context, every step 400'd, and
   * Agent mode silently degraded to "answering without tools".
   *
   * So the menu is bounded on both axes: each tool costs at most a line, and
   * only the tools most relevant to THIS question are listed. Any catalog
   * server can be large; the prompt cannot.
   */
  var TOOL_PROMPT_MAX_CHARS = 2200; // ≈550 tokens, leaving room for the loop
  var TOOL_DESC_MAX_CHARS = 110;
  var TOOL_MAX_PARAMS = 5;
  var TOOL_PARAMS_MAX_CHARS = 90;

  var MCP_PREFIX = /^mcp:[^:]+:/;

  /** Registry name → the bare tool name a model can actually reproduce. */
  function shortName(name) {
    var s = String(name || "").replace(MCP_PREFIX, "");
    return /^[A-Za-z0-9_.-]+$/.test(s) ? s : String(name || "");
  }

  /** Loose key: case and separators are exactly what small models get wrong. */
  function normKey(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  /*
   * Registry names are namespaced (mcp:<serverId>:<tool>) because two servers
   * may legitimately export the same tool name. Small local models cannot
   * reproduce that shape: shown mcp:srvmsxq1a2b:network_status they answer
   *
   *     {"mcp": "srvmsxq1a2b:network_status", "args": {}}
   *
   * — the namespace becomes the KEY and there is no "tool" field at all, so
   * the action fails to parse and the loop stalls out. Fix: show aliases (the
   * bare tool name), and map whatever comes back to a registry name. Two
   * servers exporting the same name get numbered aliases; the ambiguous bare
   * spelling then resolves to nothing rather than to a guess.
   */
  function toolAliases(names) {
    var list = (names || []).map(String);
    var used = Object.create(null);
    var alias = Object.create(null);
    var i;
    for (i = 0; i < list.length; i++) {
      var s = shortName(list[i]);
      if (used[s]) s = s + "_" + ++used[s];
      else used[s] = 1;
      alias[list[i]] = s;
    }

    // Reverse index of every spelling we accept. A key claimed by two
    // different tools is ambiguous and gets dropped — never a guess.
    var lookup = Object.create(null);
    var clash = Object.create(null);
    function add(key, name) {
      if (!key) return;
      if (lookup[key] !== undefined && lookup[key] !== name) clash[key] = true;
      else lookup[key] = name;
    }
    for (i = 0; i < list.length; i++) {
      var full = list[i];
      add(full, full);
      add(normKey(full), full);
      add(alias[full], full);
      add(normKey(alias[full]), full);
      add(normKey(shortName(full)), full); // bare name, even if it lost a collision
    }
    for (var k in clash) delete lookup[k];

    /** Whatever the model called it → a real registry name, or null. */
    function resolve(raw) {
      if (typeof raw !== "string") return null;
      var s = raw.trim();
      if (!s) return null;
      if (lookup[s] !== undefined) return lookup[s];
      if (lookup[normKey(s)] !== undefined) return lookup[normKey(s)];
      // Models routinely echo only part of a namespaced name
      // ("srvmsxq1a2b:network_status", "mcp:network_status"). Take the tail.
      var tail = normKey(s.split(":").pop());
      return lookup[tail] !== undefined ? lookup[tail] : null;
    }

    return { alias: alias, resolve: resolve };
  }

  var STOPWORDS = " the a an and or of to in for on at is are was can you your my me our what how why does did with from about please tell show get ";

  function questionWords(q) {
    var words = String(q || "").toLowerCase().match(/[a-z0-9]{3,}/g) || [];
    var out = [];
    for (var i = 0; i < words.length && out.length < 12; i++) {
      if (STOPWORDS.indexOf(" " + words[i] + " ") === -1 && out.indexOf(words[i]) === -1) out.push(words[i]);
    }
    return out;
  }

  /** Trim to the first sentence when there is one; hard-cap regardless. */
  function firstSentence(text, cap) {
    var d = String(text || "").trim().replace(/\s+/g, " ");
    var m = /^[\s\S]{20,}?[.!?](\s|$)/.exec(d);
    if (m && m[0].length <= cap) return m[0].trim();
    return d.length > cap ? d.slice(0, cap - 1).replace(/\s+\S*$/, "") + "…" : d;
  }

  function paramSummary(params) {
    var keys = Object.keys(params || {});
    if (!keys.length) return "";
    var parts = keys.slice(0, TOOL_MAX_PARAMS).map(function (k) {
      var v = String(params[k] == null ? "" : params[k]).trim().replace(/\s+/g, " ");
      if (!v) return k;
      return k + " (" + (v.length > 24 ? v.slice(0, 23) + "…" : v) + ")";
    });
    var s = parts.join(", ") + (keys.length > TOOL_MAX_PARAMS ? ", …" : "");
    // Prose that still will not fit degrades to bare names — the model needs
    // to know WHICH arguments exist far more than what they mean.
    return s.length > TOOL_PARAMS_MAX_CHARS ? keys.slice(0, TOOL_MAX_PARAMS).join(", ") : s;
  }

  function toolLine(t, name) {
    var desc = firstSentence(t.description, TOOL_DESC_MAX_CHARS);
    var p = paramSummary(t.params);
    return "- " + name + ": " + desc + (p ? " Args: " + p : "");
  }

  /**
   * Pick the tools worth spending prompt budget on for THIS question.
   * Greedy: score by keyword overlap, then fill to the char budget. Built-ins
   * carry a small bias so one large MCP server cannot crowd web_search out of
   * the menu entirely.
   */
  function selectTools(tools, question, aliasMap, budgetChars) {
    var budget = budgetChars || TOOL_PROMPT_MAX_CHARS;
    var words = questionWords(question);
    var ranked = (tools || []).map(function (t, i) {
      var hay = (shortName(t.name) + " " + (t.description || "")).toLowerCase();
      var s = 0;
      for (var w = 0; w < words.length; w++) if (hay.indexOf(words[w]) !== -1) s += 1;
      if (!MCP_PREFIX.test(String(t.name))) s += 0.5;
      return { t: t, i: i, s: s };
    });
    ranked.sort(function (a, b) { return b.s - a.s || a.i - b.i; });

    var picked = [];
    var used = 0;
    for (var k = 0; k < ranked.length; k++) {
      var t = ranked[k].t;
      var line = toolLine(t, (aliasMap && aliasMap[t.name]) || shortName(t.name));
      // Keep scanning rather than breaking: a later, shorter line may fit.
      if (picked.length && used + line.length + 1 > budget) continue;
      used += line.length + 1;
      picked.push(t);
    }
    return picked;
  }

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

  /** Validate a model "action" into {tool,args} | {answer:true} | null.
   *  `tool` is always a REGISTRY name, whatever spelling the model used. */
  function parseAgentAction(text, toolNames) {
    var j = extractJson(text);
    if (!j) return null;
    if (j.answer === true || j.final === true || j.done === true) return { answer: true };

    var args = j.args || j.arguments || j.parameters || j.input || {};
    // The name lands under whichever key the model felt like. "mcp" is not
    // hypothetical: a mcp:<id>:<tool> name in the prompt actively teaches the
    // model to split it into {"mcp": "<id>:<tool>"}.
    var raw = j.tool || j.name || j.action || j.mcp || j.tool_name || j.function;
    if (raw && typeof raw === "object") {
      // OpenAI shape: {"function": {"name": …, "arguments": …}}
      args = raw.arguments || raw.args || args;
      raw = raw.name;
    }
    if (typeof args === "string") args = extractJson(args) || {}; // arguments-as-string

    var name = toolAliases(toolNames || []).resolve(raw);
    if (!name) return null;
    return { tool: name, args: args && typeof args === "object" ? args : {} };
  }

  /**
   * The tool menu. opts.allNames is the FULL registry list so aliases stay
   * stable no matter which subset this question selected; opts.question
   * drives that selection.
   */
  function buildAgentSystem(tools, opts) {
    opts = opts || {};
    var all = opts.allNames || (tools || []).map(function (t) { return t.name; });
    var map = toolAliases(all);
    var listed = selectTools(tools, opts.question, map.alias, opts.budgetChars);
    var lines = listed.map(function (t) {
      return toolLine(t, map.alias[t.name] || shortName(t.name));
    });
    return (
      "You can use tools before answering. Available tools:\n" +
      lines.join("\n") +
      '\n\nRespond with ONLY a JSON object, nothing else.\nTo use a tool: {"tool": "tool_name", "args": {...}}\nWhen you have enough to answer: {"answer": true}\n' +
      "Copy the tool name exactly as written above. Use at most one tool per response. Prefer answering as soon as you can."
    );
  }

  /** Bound the working set: system + question always survive, older tool
   *  exchanges fall off so a long loop cannot walk off the end of a 4k
   *  context and turn every remaining step into a 400. */
  function trimConvo(convo) {
    var keep = CONVO_KEEP_STEPS * 2;
    if (convo.length <= 2 + keep) return convo;
    return convo.slice(0, 2).concat(convo.slice(convo.length - keep));
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
        var map = toolAliases(toolNames);
        var listed = selectTools(tools, question, map.alias);
        var system = buildAgentSystem(listed, { question: question, allNames: toolNames });
        // Subsetting is visible, not silent: a field report of "it stopped
        // using tools" is unanswerable without knowing what it was shown.
        var menu = listed.length < tools.length ? " (" + listed.length + " of " + tools.length + " tools)" : "";
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
          setStatus("🤖 Step " + n + ": deciding…" + menu);
          return askModelOnce(trimConvo(convo), model).then(function (out) {
            var action = parseAgentAction(out, toolNames);
            if (!action) {
              // Model refused the format twice = it wants to answer.
              convo.push({ role: "user", content: 'Respond with ONLY JSON: {"tool": ..., "args": ...} or {"answer": true}' });
              return n === AGENT_MAX_STEPS ? Promise.resolve() : step(n + 1);
            }
            if (action.answer) return Promise.resolve();
            var label = map.alias[action.tool] || action.tool.replace(/^mcp:[^:]+:/, "");
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
              // Echo the ALIAS back, never the registry name — replaying
              // mcp:<id>:<tool> into the transcript re-teaches the model the
              // exact spelling it cannot produce.
              convo.push({ role: "assistant", content: JSON.stringify({ tool: label, args: action.args }) });
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
    toolAliases: toolAliases,
    selectTools: selectTools,
    trimConvo: trimConvo,
    makeRuntime: makeRuntime,
    RESEARCH_MAX_ROUNDS: RESEARCH_MAX_ROUNDS,
    AGENT_MAX_STEPS: AGENT_MAX_STEPS,
    TOOL_PROMPT_MAX_CHARS: TOOL_PROMPT_MAX_CHARS,
  };
});
