/*
 * Koinos Code — its own view (task #72).
 *
 * Was a tab under Developer Tools that took a path and ran one task. It is now
 * a place you work: projects you switch between, each with its own sessions, so
 * the agent carries what it has already been told. Nothing about the permission
 * model changed and nothing about it should — every file change still arrives
 * as a card with its diff, every command as a card with the exact line, and
 * nothing touches disk until you press the button.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  // NOT named `state`: app.js has a top-level `state` this file reads for the
  // selected model alias, and shadowing it would silently break that.
  const kc = { projects: [], projectId: null, sessions: [], sessionId: null, runId: null, gh: null };

  async function api(path, opts = {}) {
    const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || `request failed (${r.status})`);
    return j;
  }

  function status(text) {
    $("kc-status").textContent = text || "";
  }

  function trace(text) {
    const div = document.createElement("div");
    div.className = "pg-tool";
    div.textContent = text;
    $("kc-trace").appendChild(div);
    div.scrollIntoView({ block: "nearest" });
  }

  function bubble(who, text) {
    const div = document.createElement("div");
    div.className = "pg-msg";
    const name = document.createElement("span");
    name.className = "pg-name";
    name.textContent = who;
    div.appendChild(name);
    div.appendChild(document.createTextNode(text));
    $("kc-trace").appendChild(div);
    div.scrollIntoView({ block: "nearest" });
  }

  // ------------------------------------------------------------- projects

  function currentProject() {
    return kc.projects.find((p) => p.id === kc.projectId) || null;
  }

  function renderProjects() {
    const host = $("kc-projects");
    host.innerHTML = "";
    for (const p of kc.projects) {
      const b = document.createElement("button");
      b.className = `kc-item${p.id === kc.projectId ? " on" : ""}${p.missing ? " missing" : ""}`;
      b.title = p.path;
      const name = document.createElement("span");
      name.textContent = p.name;
      const sub = document.createElement("span");
      sub.className = "kc-sub";
      // A moved or deleted folder is SAID, not silently dropped — losing
      // someone's project from the list would be worse than showing it greyed.
      sub.textContent = p.missing ? "folder not found" : p.path;
      b.appendChild(name);
      b.appendChild(sub);
      b.addEventListener("click", () => selectProject(p.id));
      host.appendChild(b);
    }
    const has = kc.projects.length > 0;
    $("kc-empty").hidden = has;
    $("kc-work").hidden = !has || !kc.projectId;
  }

  function renderSessions() {
    const host = $("kc-sessions");
    host.innerHTML = "";
    $("kc-sessions-head").hidden = !kc.projectId;
    for (const s of kc.sessions) {
      const b = document.createElement("button");
      b.className = `kc-item${s.id === kc.sessionId ? " on" : ""}`;
      b.title = s.title;
      const t = document.createElement("span");
      t.textContent = s.title;
      const sub = document.createElement("span");
      sub.className = "kc-sub";
      sub.textContent = `${s.turns} turn${s.turns === 1 ? "" : "s"}`;
      b.appendChild(t);
      b.appendChild(sub);
      b.addEventListener("click", () => selectSession(s.id));
      host.appendChild(b);
    }
  }

  async function loadProjects() {
    const j = await api("/core/code/projects");
    kc.projects = j.projects || [];
    if (kc.projectId && !kc.projects.some((p) => p.id === kc.projectId)) kc.projectId = null;
    if (!kc.projectId && kc.projects.length) kc.projectId = kc.projects[0].id;
    renderProjects();
    if (kc.projectId) await loadSessions();
  }

  /* Refresh the session LIST only. Deliberately separate from replaying a
   * transcript: after a run finishes, the pane already shows what just
   * happened, and clearing it to rebuild from the store made the answer flash
   * away — and would lose it outright if the reload failed. The list updates,
   * the transcript stays. */
  async function refreshSessionList() {
    const j = await api(`/core/code/projects/${encodeURIComponent(kc.projectId)}/sessions`);
    kc.sessions = j.sessions || [];
    if (kc.sessionId && !kc.sessions.some((s) => s.id === kc.sessionId)) kc.sessionId = null;
    if (!kc.sessionId && kc.sessions.length) kc.sessionId = kc.sessions[0].id;
    renderSessions();
    const p = currentProject();
    if (p) {
      $("kc-title").textContent = p.name;
      $("kc-path").textContent = p.path;
    }
  }

  /** Refresh the list AND replay the selected session — for arriving at a
   *  project, where the pane holds nothing worth keeping. */
  async function loadSessions() {
    await refreshSessionList();
    if (kc.sessionId) await loadTranscript();
    else $("kc-trace").innerHTML = "";
  }

  /** Replay a session's turns so switching back to it shows what happened,
   *  rather than an empty pane that implies nothing did. */
  async function loadTranscript() {
    $("kc-trace").innerHTML = "";
    try {
      const j = await api(`/core/code/projects/${encodeURIComponent(kc.projectId)}/sessions/${encodeURIComponent(kc.sessionId)}`);
      for (const t of j.session.turns || []) bubble(t.role === "user" ? "You" : "Koinos Code", t.content);
    } catch {
      /* a session that vanished just shows empty */
    }
  }

  async function selectProject(id) {
    kc.projectId = id;
    kc.sessionId = null;
    kc.sessions = [];
    renderProjects();
    status("");
    try {
      await loadSessions();
      await renderGit();
    } catch (e) {
      status(e.message);
    }
  }

  async function selectSession(id) {
    kc.sessionId = id;
    renderSessions();
    await loadTranscript();
    status("");
  }

  // -------------------------------------------------------------- actions

  $("btn-kc-add").addEventListener("click", async () => {
    const dir = window.prompt("Full path to the project folder on this machine:");
    if (!dir) return;
    try {
      const j = await api("/core/code/projects", { method: "POST", body: JSON.stringify({ dir }) });
      kc.projectId = j.project.id;
      kc.sessionId = null;
      await loadProjects();
      status("");
    } catch (e) {
      status(e.message);
    }
  });

  $("btn-kc-rename").addEventListener("click", async () => {
    const p = currentProject();
    if (!p) return;
    const name = window.prompt("Project name:", p.name);
    if (!name) return;
    try {
      await api(`/core/code/projects/${encodeURIComponent(p.id)}`, { method: "PATCH", body: JSON.stringify({ name }) });
      await loadProjects();
    } catch (e) {
      status(e.message);
    }
  });

  $("btn-kc-forget").addEventListener("click", async () => {
    const p = currentProject();
    if (!p) return;
    // Says plainly that this is a list operation, not a delete — the folder
    // and its files are never touched.
    if (!window.confirm(`Remove "${p.name}" from this list?\n\nThe folder and its files are left exactly as they are.`)) return;
    try {
      await api(`/core/code/projects/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      kc.projectId = null;
      kc.sessionId = null;
      await loadProjects();
    } catch (e) {
      status(e.message);
    }
  });

  $("btn-kc-new-session").addEventListener("click", async () => {
    if (!kc.projectId) return;
    try {
      const j = await api(`/core/code/projects/${encodeURIComponent(kc.projectId)}/sessions`, { method: "POST", body: JSON.stringify({}) });
      kc.sessionId = j.session.id;
      await loadSessions();
      $("kc-trace").innerHTML = "";
      status("");
    } catch (e) {
      status(e.message);
    }
  });

  function approvalCard(t) {
    const card = document.createElement("div");
    card.className = "kc-approval";
    const head = document.createElement("div");
    head.className = "kc-approval-head";
    head.textContent = t.kind === "edit" ? `edit ${t.path}` : `run: ${t.cmd}`;
    card.appendChild(head);
    if (t.kind === "edit") {
      const pre = document.createElement("pre");
      pre.className = "kc-diff";
      for (const line of String(t.diff || "").split("\n")) {
        const span = document.createElement("span");
        span.className = line.startsWith("+") ? "kc-add" : line.startsWith("-") ? "kc-del" : "";
        span.textContent = `${line}\n`;
        pre.appendChild(span);
      }
      card.appendChild(pre);
    }
    const row = document.createElement("div");
    row.className = "form-row";
    const yes = document.createElement("button");
    yes.className = "primary small";
    yes.textContent = t.kind === "edit" ? "Apply edit" : "Run command";
    const no = document.createElement("button");
    no.className = "small";
    no.textContent = "Deny";
    const answer = async (approved) => {
      yes.disabled = no.disabled = true;
      card.classList.add("answered");
      head.textContent += approved ? " — approved" : " — denied";
      await fetch("/core/code/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId: t.approvalId, approved }),
      }).catch(() => {});
      status("running…");
    };
    yes.addEventListener("click", () => answer(true));
    no.addEventListener("click", () => answer(false));
    row.appendChild(yes);
    row.appendChild(no);
    card.appendChild(row);
    $("kc-trace").appendChild(card);
    card.scrollIntoView({ block: "nearest" });
  }

  async function readSse(resp, onEvent) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          onEvent(JSON.parse(line.slice(6)));
        } catch {
          /* a malformed frame is skipped, never fatal */
        }
      }
    }
  }

  $("btn-kc-run").addEventListener("click", async () => {
    const p = currentProject();
    if (!p) return status("Add a project first.");
    if (p.missing) return status("That folder no longer exists — forget the project, or put the folder back.");
    const task = $("kc-task").value.trim();
    if (!task) return status("Say what it should do.");
    bubble("You", task);
    $("kc-task").value = "";
    $("btn-kc-run").disabled = true;
    $("btn-kc-stop").hidden = false;
    status("running…");
    try {
      const resp = await fetch("/core/code/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: p.id,
          sessionId: kc.sessionId || "",
          task,
          model: state.alias ?? "",
        }),
      });
      if (!resp.ok || !resp.body) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || `Koinos Code answered ${resp.status}`);
      }
      let done = null;
      await readSse(resp, (ev) => {
        if (ev.session) kc.sessionId = ev.session.sessionId;
        const t = ev.trace;
        if (t?.type === "start") kc.runId = t.runId;
        if (t?.type === "tool") trace(`» ${t.name} ${t.args}`);
        if (t?.type === "obs") trace(`  ${t.text}`);
        if (t?.type === "note") trace(t.text);
        if (t?.type === "approval-request") {
          approvalCard(t);
          status("waiting for your approval…");
        }
        if (ev.done) done = ev;
      });
      if (!done) throw new Error("the run ended without a result");
      if (done.error) throw new Error(done.error);
      if (done.answer) bubble("Koinos Code", done.answer);
      status(
        done.reason === "budget"
          ? "step budget exhausted — the task may be incomplete"
          : done.reason === "stopped"
            ? "stopped"
            : `done — ${done.steps} tool step${done.steps === 1 ? "" : "s"}`
      );
      await refreshSessionList();
      await renderGit();
    } catch (e) {
      status(e.message);
    } finally {
      $("btn-kc-run").disabled = false;
      $("btn-kc-stop").hidden = true;
      kc.runId = null;
    }
  });

  $("btn-kc-stop").addEventListener("click", async () => {
    if (!kc.runId) return;
    await fetch("/core/code/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: kc.runId }),
    }).catch(() => {});
  });

  $("kc-task").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btn-kc-run").click();
  });

  // ---------------------------------------------------------------- GitHub

  async function renderGitHub() {
    try {
      const g = await api("/core/code/github");
      kc.gh = g;
      const el = $("kc-gh-status");
      if (!g.git?.ok) {
        // Saying "git is not installed" is far more use than a failed clone.
        el.textContent = g.git?.error || "git is not available on this machine";
        $("btn-kc-gh").hidden = true;
        $("btn-kc-clone").hidden = true;
        return;
      }
      $("btn-kc-gh").hidden = false;
      $("btn-kc-gh").textContent = g.connected ? "Disconnect" : "Connect";
      $("btn-kc-clone").hidden = false;
      el.textContent = g.connected ? `Connected as ${g.login} (${g.tokenTail})` : "Not connected — public repos can still be cloned.";
    } catch (e) {
      $("kc-gh-status").textContent = e.message;
    }
  }

  /** The git bar for the selected project: branch, and what you can do next. */
  async function renderGit() {
    const p = currentProject();
    const bar = $("kc-git");
    if (!p || p.missing) {
      bar.hidden = true;
      return;
    }
    try {
      const j = await api("/core/code/github/status", { method: "POST", body: JSON.stringify({ projectId: p.id }) });
      const st = j.status;
      if (!st.repo) {
        bar.hidden = true;
        return;
      }
      bar.hidden = false;
      const bits = [st.branch];
      if (st.dirty) bits.push(`${st.files.length} changed`);
      if (st.ahead) bits.push(`${st.ahead} ahead`);
      if (st.behind) bits.push(`${st.behind} behind`);
      $("kc-branch").textContent = bits.join(" · ");
    } catch {
      bar.hidden = true;
    }
  }

  $("btn-kc-gh").addEventListener("click", async () => {
    try {
      if (kc.gh?.connected) {
        if (!window.confirm("Disconnect GitHub? The stored token is deleted from this machine.")) return;
        await api("/core/code/github/disconnect", { method: "POST", body: "{}" });
      } else {
        const token = window.prompt(
          "Paste a GitHub personal access token.\n\n" +
            "It is stored on this machine only, never sent anywhere but github.com, and never shown again."
        );
        if (!token) return;
        await api("/core/code/github/connect", { method: "POST", body: JSON.stringify({ token }) });
      }
      await renderGitHub();
      status("");
    } catch (e) {
      status(e.message);
    }
  });

  $("btn-kc-clone").addEventListener("click", async () => {
    const repo = window.prompt("Repository to clone — owner/name, or its GitHub URL:");
    if (!repo) return;
    const parentDir = window.prompt("Clone into which folder on this machine?");
    if (!parentDir) return;
    status("cloning…");
    try {
      const j = await api("/core/code/github/clone", { method: "POST", body: JSON.stringify({ repo, parentDir }) });
      kc.projectId = j.project.id;
      kc.sessionId = null;
      await loadProjects();
      await renderGit();
      status(`cloned ${j.repo}`);
    } catch (e) {
      status(e.message);
    }
  });

  async function gitAction(pathname, body, working) {
    const p = currentProject();
    if (!p) return;
    status(working);
    try {
      const j = await api(pathname, { method: "POST", body: JSON.stringify({ projectId: p.id, ...body }) });
      await renderGit();
      return j;
    } catch (e) {
      status(e.message);
      return null;
    }
  }

  $("btn-kc-branch").addEventListener("click", async () => {
    const name = window.prompt("Branch name:");
    if (!name) return;
    if (await gitAction("/core/code/github/branch", { name }, "switching branch…")) status(`on ${name}`);
  });

  $("btn-kc-commit").addEventListener("click", async () => {
    const message = window.prompt("Commit message:");
    if (!message) return;
    if (await gitAction("/core/code/github/commit", { message }, "committing…")) status("committed");
  });

  $("btn-kc-push").addEventListener("click", async () => {
    const j = await gitAction("/core/code/github/push", {}, "pushing…");
    if (j) status(`pushed ${j.branch}`);
  });

  $("btn-kc-pr").addEventListener("click", async () => {
    const title = window.prompt("Pull request title:");
    if (!title) return;
    const body = window.prompt("Description (optional):") || "";
    const j = await gitAction("/core/code/github/pr", { title, body }, "opening pull request…");
    if (j) {
      status(`opened #${j.pr.number}`);
      const a = document.createElement("a");
      a.href = j.pr.url;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.textContent = `Pull request #${j.pr.number} — ${j.pr.url}`;
      const div = document.createElement("div");
      div.className = "pg-tool";
      div.appendChild(a);
      $("kc-trace").appendChild(div);
      div.scrollIntoView({ block: "nearest" });
    }
  });

  async function render() {
    try {
      await loadProjects();
      await renderGitHub();
      await renderGit();
    } catch (e) {
      status(e.message);
    }
  }

  window.KaiCode = { render };
})();
