"use strict";

/*
 * Developer Tools view (task #64) — its own sidebar destination, node-style,
 * with a sub-menu: Multi-agent (the full-AutoGen track), Playground,
 * Pipelines (the simple track that shipped first), and Benchmark. Loads
 * after app.js and uses its globals ($, coreGet, state, esc).
 *
 * The JSON boxes are ALWAYS the source of truth: builders write them, runs
 * read them — what you see is exactly what runs.
 */

(() => {
  // ---------- shared: SSE reader (same wire format everywhere) ----------
  async function readSse(resp, onEvent) {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of resp.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)));
      }
    }
  }

  const showError = (msg) => {
    $("dev-error").textContent = String(msg);
    $("dev-error").hidden = false;
  };
  const clearError = () => {
    $("dev-error").hidden = true;
  };

  // ---------- sub-menu tabs ----------
  for (const b of document.querySelectorAll("#devtools-tabs .subtab")) {
    b.addEventListener("click", () => {
      for (const x of document.querySelectorAll("#devtools-tabs .subtab")) x.classList.toggle("active", x === b);
      for (const p of document.querySelectorAll(".devtab")) p.hidden = p.id !== `devtab-${b.dataset.tab}`;
      clearError();
    });
  }

  // ---------- tool list, shared by both builders ----------
  let toolCache = null;
  async function loadTools() {
    if (toolCache) return toolCache;
    const j = await coreGet("/core/tools");
    toolCache = j.tools || [];
    return toolCache;
  }

  function toolCheckboxes(host, cls, checked = []) {
    host.innerHTML = "";
    for (const t of toolCache || []) {
      const label = document.createElement("label");
      label.className = "check";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = cls;
      box.dataset.tool = t.name;
      box.checked = checked.includes(t.name);
      label.appendChild(box);
      label.appendChild(document.createTextNode(` ${t.name}${t.sensitive ? " ⚠" : ""}`));
      host.appendChild(label);
    }
  }

  // ================== Multi-agent builder ==================
  const AG_EXAMPLE = {
    label: "Research duo",
    mode: "round_robin",
    agents: [
      { name: "Researcher", systemPrompt: "You research the task and report concrete facts.", tools: ["web_search", "read_page"] },
      { name: "Writer", systemPrompt: "You turn the researcher's facts into the final answer. When it is complete, say TERMINATE." },
    ],
    termination: { maxMessages: 12, maxModelCalls: 40 },
  };
  let currentDefId = null;

  function addAgentCard(a = {}) {
    const card = document.createElement("div");
    card.className = "agent-card";
    const row = document.createElement("div");
    row.className = "form-row";
    const name = document.createElement("input");
    name.className = "ag-name";
    name.placeholder = "Name (e.g. Researcher)";
    name.value = a.name || "";
    const human = document.createElement("label");
    human.className = "check";
    const humanBox = document.createElement("input");
    humanBox.type = "checkbox";
    humanBox.className = "ag-human";
    humanBox.checked = a.human === true;
    human.appendChild(humanBox);
    human.appendChild(document.createTextNode(" human (asks you)"));
    const rm = document.createElement("button");
    rm.className = "linklike ag-remove";
    rm.textContent = "remove";
    rm.addEventListener("click", () => card.remove());
    row.append(name, human, rm);
    const prompt = document.createElement("textarea");
    prompt.className = "ag-prompt";
    prompt.rows = 2;
    prompt.placeholder = "Role instructions (system prompt)";
    prompt.value = a.systemPrompt || "";
    const tools = document.createElement("div");
    tools.className = "form-row ag-tools";
    toolCheckboxes(tools, "ag-tool", a.tools || []);
    // A human agent holds no tools — the engine enforces it; the form says it.
    const syncHuman = () => {
      tools.hidden = humanBox.checked;
      prompt.hidden = humanBox.checked;
    };
    humanBox.addEventListener("change", syncHuman);
    syncHuman();
    card.append(row, prompt, tools);
    $("ag-list").appendChild(card);
  }

  function collectSpec() {
    const agents = [...document.querySelectorAll("#ag-list .agent-card")].map((card) => {
      const a = {
        name: card.querySelector(".ag-name").value.trim(),
        systemPrompt: card.querySelector(".ag-prompt").value.trim(),
      };
      if (card.querySelector(".ag-human").checked) {
        a.human = true;
        delete a.systemPrompt;
      } else {
        const tools = [...card.querySelectorAll(".ag-tool:checked")].map((el) => el.dataset.tool);
        if (tools.length) a.tools = tools;
      }
      return a;
    });
    const spec = {
      label: $("ag-label").value.trim() || "Group chat",
      mode: $("ag-mode").value,
      agents,
      termination: {
        maxMessages: Number($("ag-maxmsg").value) || 12,
        maxModelCalls: Number($("ag-maxcalls").value) || 40,
      },
    };
    const term = $("ag-term").value.trim();
    if (term) spec.termination.textMention = term;
    return spec;
  }

  function fillBuilder(spec) {
    $("ag-label").value = spec.label || "";
    $("ag-mode").value = spec.mode || "round_robin";
    $("ag-maxmsg").value = spec.termination?.maxMessages ?? 12;
    $("ag-maxcalls").value = spec.termination?.maxModelCalls ?? 40;
    $("ag-term").value = spec.termination?.textMention ?? "";
    $("ag-list").innerHTML = "";
    for (const a of spec.agents || []) addAgentCard(a);
  }

  async function refreshDefs() {
    const j = await coreGet("/core/agents/defs").catch(() => ({ defs: [] }));
    const defs = j.defs || [];
    for (const sel of [$("ag-defs"), $("pg-source")]) {
      sel.innerHTML = "";
      if (sel.id === "pg-source") {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "Team in the builder (JSON box)";
        sel.appendChild(opt);
      }
      for (const d of defs) {
        const opt = document.createElement("option");
        opt.value = d.id;
        opt.textContent = d.label;
        sel.appendChild(opt);
      }
    }
    if (!defs.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(no saved teams yet)";
      $("ag-defs").appendChild(opt);
    }
  }

  $("btn-ag-add").addEventListener("click", () => addAgentCard());
  $("btn-ag-tojson").addEventListener("click", () => {
    $("ag-json").value = JSON.stringify(collectSpec(), null, 2);
    clearError();
  });
  $("btn-ag-save").addEventListener("click", async () => {
    clearError();
    let spec;
    try {
      spec = JSON.parse($("ag-json").value || "null") || collectSpec();
    } catch (e) {
      return showError(`The JSON box is not valid JSON: ${e.message}`);
    }
    const r = await fetch("/core/agents/defs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: currentDefId || undefined, spec }),
    });
    const j = await r.json();
    if (!j.ok) return showError(j.error);
    currentDefId = j.def.id;
    await refreshDefs();
    $("ag-defs").value = currentDefId;
  });
  $("btn-ag-load").addEventListener("click", async () => {
    clearError();
    const id = $("ag-defs").value;
    if (!id) return;
    const j = await coreGet("/core/agents/defs");
    const def = (j.defs || []).find((d) => d.id === id);
    if (!def) return showError("that saved team is gone — refresh");
    currentDefId = def.id;
    fillBuilder(def.spec);
    $("ag-json").value = JSON.stringify(def.spec, null, 2);
  });
  $("btn-ag-del").addEventListener("click", async () => {
    clearError();
    const id = $("ag-defs").value;
    if (!id) return;
    await fetch(`/core/agents/defs/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (currentDefId === id) currentDefId = null;
    refreshDefs();
  });

  // ================== Playground ==================
  let pgRunId = null;
  let pgInputId = null;

  function pgBubble(name, content, cls = "pg-msg") {
    const div = document.createElement("div");
    div.className = cls;
    const who = document.createElement("span");
    who.className = "pg-name";
    who.textContent = name;
    div.appendChild(who);
    div.appendChild(document.createTextNode(content));
    $("pg-convo").appendChild(div);
    div.scrollIntoView({ block: "nearest" });
  }

  $("btn-pg-run").addEventListener("click", async () => {
    clearError();
    const task = $("pg-task").value.trim();
    if (!task) return showError("Give the team a task first.");
    const body = { task, model: state.alias ?? "dev-tiny" };
    let toolNames = [];
    if ($("pg-source").value) {
      body.defId = $("pg-source").value;
      const j = await coreGet("/core/agents/defs").catch(() => ({ defs: [] }));
      const def = (j.defs || []).find((d) => d.id === body.defId);
      toolNames = (def?.spec?.agents || []).flatMap((a) => a.tools || []);
    } else {
      try {
        body.spec = JSON.parse($("ag-json").value);
      } catch (e) {
        return showError(`The JSON box is not valid JSON: ${e.message}`);
      }
      toolNames = (body.spec.agents || []).flatMap((a) => a.tools || []);
    }
    // run_code in any agent gets the same upfront human yes as everywhere.
    if (toolNames.includes("run_code")) {
      body.allowSensitive = confirm(
        "This team includes run_code — agents may write and run code in the sandbox (its own scratch folder, no network). Allow for this run?"
      );
    }
    $("pg-convo").innerHTML = "";
    $("pg-input-row").hidden = true;
    $("btn-pg-run").disabled = true;
    $("btn-pg-stop").hidden = false;
    $("pg-status").textContent = "running…";
    try {
      const resp = await fetch("/core/agents/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok || !resp.body) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || `agents endpoint answered ${resp.status}`);
      }
      let done = null;
      await readSse(resp, (ev) => {
        const t = ev.trace;
        if (t?.type === "start") pgRunId = t.runId;
        if (t?.type === "message") pgBubble(t.name, t.content);
        if (t?.type === "tool") pgBubble(t.name, t.detail, "pg-tool");
        if (t?.type === "input-request") {
          pgInputId = t.inputId;
          $("pg-input-row").hidden = false;
          $("pg-input").focus();
          $("pg-status").textContent = `waiting for you (${t.name})…`;
        }
        if (t?.type === "note") $("pg-status").textContent = t.detail;
        if (ev.done) done = ev;
      });
      if (!done) throw new Error("the run ended without a result");
      if (done.error) throw new Error(done.error);
      $("pg-status").textContent = `ended: ${done.reason} — ${done.modelCalls} model calls`;
    } catch (e) {
      showError(e.message);
      $("pg-status").textContent = "";
    } finally {
      $("btn-pg-run").disabled = false;
      $("btn-pg-stop").hidden = true;
      $("pg-input-row").hidden = true;
      pgRunId = null;
      pgInputId = null;
    }
  });

  $("btn-pg-send").addEventListener("click", async () => {
    if (!pgInputId) return;
    const text = $("pg-input").value;
    $("pg-input").value = "";
    $("pg-input-row").hidden = true;
    await fetch("/core/agents/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputId: pgInputId, text }),
    });
    pgInputId = null;
  });
  $("pg-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btn-pg-send").click();
  });
  $("btn-pg-stop").addEventListener("click", async () => {
    if (!pgRunId) return;
    await fetch("/core/agents/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: pgRunId }),
    });
  });

  // ================== Pipelines (the simple track, moved verbatim) ==================
  const DEV_SPEC_EXAMPLE = JSON.stringify(
    {
      label: "My research team",
      stages: ["plan", "work", "write", "critique", "revise"],
      tools: ["web_search", "read_page"],
      workGoal: "Research this sub-question and gather concrete facts with sources.",
      prompts: { writer: "Write for a technical reader. Cite sources inline." },
      maxSubtasks: 2,
      maxActionsPerWork: 3,
      maxModelCalls: 16,
    },
    null,
    2
  );

  document.querySelectorAll("#devb-stages input").forEach(() => {}); // stages are static markup
  $("btn-devb-apply").addEventListener("click", () => {
    const stages = [...document.querySelectorAll("#devb-stages input:checked")].map((el) => el.dataset.stage);
    const tools = [...document.querySelectorAll("#devb-tools input:checked")].map((el) => el.dataset.tool);
    const spec = {
      label: $("devb-label").value.trim() || "Custom team",
      stages,
      tools,
      maxSubtasks: Number($("devb-subtasks").value) || 4,
      maxActionsPerWork: Number($("devb-actions").value) || 4,
      maxModelCalls: Number($("devb-calls").value) || 24,
    };
    const goal = $("devb-workgoal").value.trim();
    if (goal) spec.workGoal = goal;
    $("dev-spec").value = JSON.stringify(spec, null, 2);
  });

  $("btn-dev-run").addEventListener("click", async () => {
    clearError();
    const out = $("dev-team-out");
    let spec;
    try {
      spec = JSON.parse($("dev-spec").value);
    } catch (e) {
      return showError(`The spec is not valid JSON: ${e.message}`);
    }
    const question = $("dev-question").value.trim();
    if (!question) return showError("Give the team a task first.");
    let allowSensitive = false;
    if (Array.isArray(spec.tools) && spec.tools.includes("run_code")) {
      allowSensitive = confirm(
        "This spec includes run_code — the team may write and run code in the sandbox (its own scratch folder, no network, no other programs). Allow for this run?"
      );
    }
    out.hidden = false;
    out.textContent = "";
    $("btn-dev-run").disabled = true;
    $("dev-run-status").textContent = "running…";
    try {
      const resp = await fetch("/core/teams/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spec, question, model: state.alias ?? "dev-tiny", allowSensitive }),
      });
      if (!resp.ok || !resp.body) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || `teams endpoint answered ${resp.status}`);
      }
      let done = null;
      await readSse(resp, (ev) => {
        if (ev.trace) out.textContent += `[${ev.trace.stage}] ${String(ev.trace.detail)}\n`;
        if (ev.done) done = ev;
      });
      if (!done) throw new Error("the team stream ended without an answer");
      if (done.error) throw new Error(done.error);
      out.textContent += `\n=== answer (${done.modelCalls} model calls) ===\n${done.answer}\n`;
    } catch (e) {
      showError(e.message);
    } finally {
      $("btn-dev-run").disabled = false;
      $("dev-run-status").textContent = "";
    }
  });

  // ================== Benchmark (moved verbatim) ==================
  $("btn-dev-bench").addEventListener("click", async () => {
    clearError();
    const out = $("dev-bench-out");
    out.hidden = false;
    out.textContent = "";
    $("btn-dev-bench").disabled = true;
    $("dev-bench-status").textContent = "running…";
    try {
      const resp = await fetch("/core/bench/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ suite: "core", model: state.alias ?? "dev-tiny" }),
      });
      if (!resp.ok || !resp.body) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || `bench endpoint answered ${resp.status}`);
      }
      let done = null;
      await readSse(resp, (ev) => {
        if (ev.case) {
          const c = ev.case;
          out.textContent += `${c.pass ? "✓" : "✗"} ${c.id}  (${c.ms} ms, ${c.modelCalls} call${c.modelCalls === 1 ? "" : "s"})${c.pass ? "" : ` — ${c.why}`}\n`;
        }
        if (ev.done) done = ev;
      });
      if (!done) throw new Error("the bench stream ended without a summary");
      if (done.error) throw new Error(done.error);
      const s = done.summary;
      out.textContent += `\nScore: ${s.passed}/${s.total} on "${s.suite}" with ${s.model} — ${(s.ms / 1000).toFixed(1)}s, ${s.modelCalls} model calls\n`;
    } catch (e) {
      showError(e.message);
    } finally {
      $("btn-dev-bench").disabled = false;
      $("dev-bench-status").textContent = "";
    }
  });

  // ---------- entry point, called by app.js on navigation ----------
  let rendered = false;
  async function render() {
    try {
      await loadTools();
      const host = $("devb-tools");
      if (host && !host.querySelector("input")) toolCheckboxes(host, "devb-tool");
      if (!rendered) {
        rendered = true;
        if (!$("ag-json").value.trim()) {
          fillBuilder(AG_EXAMPLE);
          $("ag-json").value = JSON.stringify(AG_EXAMPLE, null, 2);
        }
        if (!$("dev-spec").value.trim()) $("dev-spec").value = DEV_SPEC_EXAMPLE;
      }
      await refreshDefs();
    } catch {
      /* core not up yet — the next navigation retries */
    }
  }

  window.KaiDevTools = { render };
})();
