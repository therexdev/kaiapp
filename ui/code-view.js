/*
 * Koinos Code — the workspace view (task #74).
 *
 * REWRITTEN, and the reason matters: the previous version drove every action
 * through window.prompt(). **window.prompt() DOES NOT EXIST IN ELECTRON** — it
 * returns null without ever showing anything, so in the packaged app every one
 * of those buttons silently did nothing. The same trap is recorded in
 * ui/tools-view.js from an earlier field report. Nothing here uses prompt() or
 * confirm(); every input is an inline form, and folder choice goes through the
 * NATIVE picker when the app shell offers one, with an in-app directory
 * browser everywhere else.
 *
 * Shape: a projects rail with "New chat", and a pane that is either the start
 * screen (pick a folder, or clone one) or a conversation. The permission model
 * is untouched — every write is a card with its diff, every command a card
 * with the exact line, and nothing happens until a button is pressed.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  // NOT named `state`: app.js declares a top-level `state` this file reads for
  // the selected model alias, and shadowing it would silently break that.
  const kc = {
    projects: [],
    projectId: null,
    sessions: [],
    sessionId: null,
    runId: null,
    gh: null,
    browseFor: "project", // "project" | "clone"
    browsePath: "",
    allTools: [],
    maxTools: 8,
    toolsByProject: {}, // projectId -> [tool names] — opt-in, per project
  };

  async function api(path, opts = {}) {
    const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || `request failed (${r.status})`);
    return j;
  }

  const status = (t) => { $("kc-status").textContent = t || ""; };
  function startError(msg) {
    const el = $("kc-start-error");
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  function currentProject() {
    return kc.projects.find((p) => p.id === kc.projectId) || null;
  }

  // ------------------------------------------------------------ transcript

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

  /*
   * A PLAN is a proposal, so it gets a card rather than becoming a turn: the
   * agent has read the project and written what it would do, and nothing has
   * happened yet. Approving re-runs the same task in acting mode with the plan
   * as the thing to follow.
   */
  function planCard(planText, task) {
    const card = document.createElement("div");
    card.className = "kc-approval";
    const head = document.createElement("div");
    head.className = "kc-approval-head";
    head.textContent = "proposed plan — nothing has been changed yet";
    const body = document.createElement("div");
    body.className = "pg-msg";
    body.textContent = planText;
    const row = document.createElement("div");
    row.className = "form-row";
    const go = document.createElement("button");
    go.className = "primary small";
    go.textContent = "Approve and run";
    const no = document.createElement("button");
    no.className = "small";
    no.textContent = "Discard";
    go.addEventListener("click", () => {
      go.disabled = no.disabled = true;
      card.classList.add("answered");
      head.textContent = "plan approved";
      run(task, { plan: planText });
    });
    no.addEventListener("click", () => {
      go.disabled = no.disabled = true;
      card.classList.add("answered");
      head.textContent = "plan discarded";
      status("");
    });
    row.append(go, no);
    card.append(head, body, row);
    $("kc-trace").appendChild(card);
    card.scrollIntoView({ block: "nearest" });
  }

  // -------------------------------------------------------------- rendering

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
      // A moved or deleted folder is SAID, not silently dropped.
      sub.textContent = p.missing ? "folder not found" : p.path;
      b.append(name, sub);
      b.addEventListener("click", () => selectProject(p.id));
      host.appendChild(b);
    }
  }

  function renderSessions() {
    const host = $("kc-sessions");
    host.innerHTML = "";
    $("kc-sessions-label").hidden = !kc.projectId;
    for (const s of kc.sessions) {
      const b = document.createElement("button");
      b.className = `kc-item${s.id === kc.sessionId ? " on" : ""}`;
      b.title = s.title;
      const t = document.createElement("span");
      t.textContent = s.title;
      const sub = document.createElement("span");
      sub.className = "kc-sub";
      sub.textContent = `${s.turns} turn${s.turns === 1 ? "" : "s"}`;
      b.append(t, sub);
      b.addEventListener("click", () => selectSession(s.id));
      host.appendChild(b);
    }
  }

  /** Start screen when nothing is chosen; conversation when something is. */
  function showChat(on) {
    $("kc-start").hidden = on;
    $("kc-chat").hidden = !on;
  }

  async function loadProjects() {
    const j = await api("/core/code/projects");
    kc.projects = j.projects || [];
    if (kc.projectId && !kc.projects.some((p) => p.id === kc.projectId)) kc.projectId = null;
    renderProjects();
    if (kc.projectId) await loadSessions();
    else {
      kc.sessions = [];
      renderSessions();
      showChat(false);
    }
  }

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

  async function loadSessions() {
    await refreshSessionList();
    showChat(true);
    if (kc.sessionId) await loadTranscript();
    else $("kc-trace").innerHTML = "";
  }

  /** Replay a session so switching back shows what happened, rather than an
   *  empty pane implying nothing did. */
  async function loadTranscript() {
    $("kc-trace").innerHTML = "";
    try {
      const j = await api(`/core/code/projects/${encodeURIComponent(kc.projectId)}/sessions/${encodeURIComponent(kc.sessionId)}`);
      for (const t of j.session.turns || []) bubble(t.role === "user" ? "You" : "Koinos Code", t.content);
    } catch {
      /* a session that vanished shows empty */
    }
  }

  async function selectProject(id) {
    kc.projectId = id;
    kc.sessionId = null;
    kc.sessions = [];
    renderProjects();
    status("");
    startError("");
    try {
      await loadSessions();
      await renderGit();
      renderToolsSummary();
      $("kc-tools-panel").hidden = true;
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

  // ----------------------------------------------------------- new / pick

  $("btn-kc-new").addEventListener("click", () => {
    // "New chat" from inside a project starts a fresh session there; from
    // nowhere it goes back to the start screen so a folder can be chosen.
    if (kc.projectId) {
      newSession();
    } else {
      kc.projectId = null;
      renderProjects();
      showChat(false);
      closePanels();
    }
  });

  async function newSession() {
    try {
      const j = await api(`/core/code/projects/${encodeURIComponent(kc.projectId)}/sessions`, { method: "POST", body: "{}" });
      kc.sessionId = j.session.id;
      await refreshSessionList();
      $("kc-trace").innerHTML = "";
      showChat(true);
      status("");
      $("kc-task").focus();
    } catch (e) {
      status(e.message);
    }
  }

  function closePanels() {
    $("kc-browse").hidden = true;
    $("kc-clone").hidden = true;
    startError("");
  }

  /** Add a folder as a project and go straight into it — choosing a folder
   *  IS the intent to work in it, so it should not need a second click. */
  async function useFolder(dir, name = "") {
    try {
      const j = await api("/core/code/projects", { method: "POST", body: JSON.stringify({ dir, name }) });
      kc.projectId = j.project.id;
      kc.sessionId = null;
      closePanels();
      await loadProjects();
      await renderGit();
      $("kc-task").focus();
    } catch (e) {
      startError(e.message);
    }
  }

  $("btn-kc-pick").addEventListener("click", async () => {
    startError("");
    // The app shell's NATIVE picker is the right experience and returns a real
    // on-disk path. The served UI has no such dialog, so it browses in-app.
    if (window.koinosShell?.pickFolder) {
      const dir = await window.koinosShell.pickFolder("Choose a project folder");
      if (dir) return useFolder(dir);
      return;
    }
    kc.browseFor = "project";
    $("kc-clone").hidden = true;
    $("kc-browse").hidden = false;
    await browse("");
  });

  // ------------------------------------------------------------- browsing

  async function browse(dir) {
    try {
      const j = await api("/core/code/browse", { method: "POST", body: JSON.stringify({ dir }) });
      kc.browsePath = j.path || "";
      $("kc-browse-path").value = kc.browsePath;
      $("kc-browse-here").textContent = kc.browsePath ? `Selected: ${kc.browsePath}` : "Pick a starting point";
      $("btn-kc-browse-use").disabled = !kc.browsePath;
      const host = $("kc-browse-list");
      host.innerHTML = "";
      if (j.parent) {
        const up = document.createElement("button");
        up.className = "kc-browse-item up";
        up.textContent = "⬆ up a level";
        up.addEventListener("click", () => browse(j.parent));
        host.appendChild(up);
      }
      for (const e of j.entries || []) {
        const b = document.createElement("button");
        b.className = "kc-browse-item";
        b.textContent = j.start ? e.name : `📁 ${e.name}`;
        b.title = e.path;
        b.addEventListener("click", () => browse(e.path));
        host.appendChild(b);
      }
      if (!j.start && !(j.entries || []).length) {
        const empty = document.createElement("div");
        empty.className = "kc-browse-item up";
        empty.textContent = "(no folders in here — you can still use it)";
        host.appendChild(empty);
      }
      startError("");
    } catch (e) {
      startError(e.message);
    }
  }

  $("btn-kc-browse-go").addEventListener("click", () => browse($("kc-browse-path").value.trim()));
  $("kc-browse-path").addEventListener("keydown", (e) => {
    if (e.key === "Enter") browse($("kc-browse-path").value.trim());
  });
  $("btn-kc-browse-close").addEventListener("click", closePanels);
  $("btn-kc-browse-use").addEventListener("click", () => {
    if (!kc.browsePath) return;
    if (kc.browseFor === "clone") {
      $("kc-clone-parent").value = kc.browsePath;
      $("kc-browse").hidden = true;
      $("kc-clone").hidden = false;
      return;
    }
    useFolder(kc.browsePath);
  });

  // --------------------------------------------------------------- cloning

  $("btn-kc-clone").addEventListener("click", async () => {
    startError("");
    $("kc-browse").hidden = true;
    $("kc-clone").hidden = false;
    $("kc-clone-status").textContent = "";
    // If an account is connected, offer what it can actually see rather than
    // making someone remember exact repository names.
    try {
      const g = kc.gh || (await api("/core/code/github"));
      if (g.connected) {
        const j = await api("/core/code/github/repos");
        const host = $("kc-repo-list");
        host.innerHTML = "";
        for (const r of j.repos || []) {
          const b = document.createElement("button");
          b.className = "kc-browse-item";
          b.textContent = `${r.private ? "🔒" : "📦"} ${r.full}`;
          b.title = r.description || r.full;
          b.addEventListener("click", () => {
            $("kc-clone-repo").value = r.full;
          });
          host.appendChild(b);
        }
        host.hidden = !(j.repos || []).length;
      }
    } catch {
      /* listing is a convenience; typing a name always works */
    }
  });

  $("btn-kc-clone-close").addEventListener("click", closePanels);

  $("btn-kc-clone-pick").addEventListener("click", async () => {
    if (window.koinosShell?.pickFolder) {
      const dir = await window.koinosShell.pickFolder("Where should the repository go?");
      if (dir) $("kc-clone-parent").value = dir;
      return;
    }
    kc.browseFor = "clone";
    $("kc-clone").hidden = true;
    $("kc-browse").hidden = false;
    await browse("");
  });

  $("btn-kc-clone-go").addEventListener("click", async () => {
    const repo = $("kc-clone-repo").value.trim();
    const parentDir = $("kc-clone-parent").value.trim();
    if (!repo) return startError("Name the repository — owner/name, or its GitHub URL.");
    if (!parentDir) return startError("Choose a folder to clone into.");
    $("btn-kc-clone-go").disabled = true;
    $("kc-clone-status").textContent = "cloning…";
    startError("");
    try {
      // Core clones AND registers the project; going straight into it is the
      // whole point of the flow.
      const j = await api("/core/code/github/clone", { method: "POST", body: JSON.stringify({ repo, parentDir }) });
      kc.projectId = j.project.id;
      kc.sessionId = null;
      closePanels();
      await loadProjects();
      await renderGit();
      status(`cloned ${j.repo}`);
      $("kc-task").focus();
    } catch (e) {
      startError(e.message);
      $("kc-clone-status").textContent = "";
    } finally {
      $("btn-kc-clone-go").disabled = false;
    }
  });

  // ---------------------------------------------------------------- GitHub

  async function renderGitHub() {
    try {
      const g = await api("/core/code/github");
      kc.gh = g;
      const el = $("kc-gh-status");
      if (!g.git?.ok) {
        // Far more use than a clone that fails for an unexplained reason.
        el.textContent = g.git?.error || "git is not available on this machine";
        $("btn-kc-gh").hidden = true;
        return;
      }
      $("btn-kc-gh").hidden = false;
      $("btn-kc-gh").textContent = g.connected ? "Disconnect GitHub" : "Connect GitHub";
      el.textContent = g.connected ? `${g.login} (${g.tokenTail})` : "Not connected";
    } catch (e) {
      $("kc-gh-status").textContent = e.message;
    }
  }

  $("btn-kc-gh").addEventListener("click", async () => {
    if (kc.gh?.connected) {
      try {
        await api("/core/code/github/disconnect", { method: "POST", body: "{}" });
        await renderGitHub();
      } catch (e) {
        startError(e.message);
      }
      return;
    }
    // Inline, because prompt() is dead in Electron. The token is typed into a
    // password field, sent once, and never rendered back.
    showChat(false);
    closePanels();
    const panel = $("kc-clone");
    panel.hidden = false;
    $("kc-clone-status").textContent = "";
    $("kc-repo-list").hidden = true;
    if (!$("kc-token-row")) {
      const row = document.createElement("div");
      row.id = "kc-token-row";
      row.className = "form-row";
      const input = document.createElement("input");
      input.type = "password";
      input.id = "kc-token";
      input.placeholder = "GitHub personal access token";
      input.autocomplete = "off";
      const save = document.createElement("button");
      save.className = "primary small";
      save.textContent = "Connect";
      const connect = async () => {
        const token = input.value.trim();
        if (!token) return;
        save.disabled = true;
        try {
          await api("/core/code/github/connect", { method: "POST", body: JSON.stringify({ token }) });
          input.value = "";
          row.remove();
          closePanels();
          await renderGitHub();
        } catch (e) {
          startError(e.message);
        } finally {
          save.disabled = false;
        }
      };
      save.addEventListener("click", connect);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") connect();
      });
      row.append(input, save);
      panel.insertBefore(row, panel.querySelector(".form-row"));
      const note = document.createElement("div");
      note.className = "kc-choice-sub";
      note.textContent = "Stored on this machine only, never shown again, and sent nowhere but github.com.";
      panel.insertBefore(note, row.nextSibling);
    }
    $("kc-token")?.focus();
  });

  // ------------------------------------------------------------------ git

  async function renderGit() {
    const p = currentProject();
    if (!p || p.missing) {
      $("btn-kc-git").hidden = true;
      $("kc-branch").hidden = true;
      $("kc-git-bar").hidden = true;
      return;
    }
    try {
      const j = await api("/core/code/github/status", { method: "POST", body: JSON.stringify({ projectId: p.id }) });
      const st = j.status;
      if (!st.repo) {
        $("btn-kc-git").hidden = true;
        $("kc-branch").hidden = true;
        return;
      }
      $("btn-kc-git").hidden = false;
      const bits = [st.branch];
      if (st.dirty) bits.push(`${st.files.length} changed`);
      if (st.ahead) bits.push(`${st.ahead}↑`);
      if (st.behind) bits.push(`${st.behind}↓`);
      $("kc-branch").textContent = bits.join(" · ");
      $("kc-branch").hidden = false;
    } catch {
      $("btn-kc-git").hidden = true;
      $("kc-branch").hidden = true;
    }
  }

  $("btn-kc-git").addEventListener("click", () => {
    $("kc-git-bar").hidden = !$("kc-git-bar").hidden;
    if (!$("kc-git-bar").hidden) $("kc-git-input").focus();
  });

  async function gitAction(pathname, body, working) {
    const p = currentProject();
    if (!p) return null;
    $("kc-git-status").textContent = working;
    try {
      const j = await api(pathname, { method: "POST", body: JSON.stringify({ projectId: p.id, ...body }) });
      await renderGit();
      return j;
    } catch (e) {
      $("kc-git-status").textContent = e.message;
      return null;
    }
  }

  const gitInput = () => $("kc-git-input").value.trim();
  const clearGitInput = () => { $("kc-git-input").value = ""; };

  $("btn-kc-branch").addEventListener("click", async () => {
    const name = gitInput();
    if (!name) return ($("kc-git-status").textContent = "Type a branch name first.");
    if (await gitAction("/core/code/github/branch", { name }, "switching branch…")) {
      $("kc-git-status").textContent = `on ${name}`;
      clearGitInput();
    }
  });

  $("btn-kc-commit").addEventListener("click", async () => {
    const message = gitInput();
    if (!message) return ($("kc-git-status").textContent = "Type a commit message first.");
    if (await gitAction("/core/code/github/commit", { message }, "committing…")) {
      $("kc-git-status").textContent = "committed";
      clearGitInput();
    }
  });

  $("btn-kc-push").addEventListener("click", async () => {
    const j = await gitAction("/core/code/github/push", {}, "pushing…");
    if (j) $("kc-git-status").textContent = `pushed ${j.branch}`;
  });

  $("btn-kc-pr").addEventListener("click", async () => {
    const title = gitInput();
    if (!title) return ($("kc-git-status").textContent = "Type a pull request title first.");
    const j = await gitAction("/core/code/github/pr", { title }, "opening pull request…");
    if (j) {
      $("kc-git-status").textContent = `opened #${j.pr.number}`;
      clearGitInput();
      const a = document.createElement("a");
      a.href = j.pr.url;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.textContent = `Pull request #${j.pr.number}`;
      const div = document.createElement("div");
      div.className = "pg-tool";
      div.appendChild(a);
      $("kc-trace").appendChild(div);
      div.scrollIntoView({ block: "nearest" });
    }
  });

  // -------------------------------------------------------- rename / forget

  $("btn-kc-rename").addEventListener("click", () => {
    const p = currentProject();
    if (!p) return;
    $("kc-rename-bar").hidden = false;
    $("kc-rename-input").value = p.name;
    $("kc-rename-input").focus();
  });
  $("btn-kc-rename-cancel").addEventListener("click", () => { $("kc-rename-bar").hidden = true; });
  $("btn-kc-rename-save").addEventListener("click", async () => {
    const p = currentProject();
    const name = $("kc-rename-input").value.trim();
    if (!p || !name) return;
    try {
      await api(`/core/code/projects/${encodeURIComponent(p.id)}`, { method: "PATCH", body: JSON.stringify({ name }) });
      $("kc-rename-bar").hidden = true;
      await loadProjects();
    } catch (e) {
      status(e.message);
    }
  });
  $("kc-rename-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btn-kc-rename-save").click();
    if (e.key === "Escape") $("btn-kc-rename-cancel").click();
  });

  $("btn-kc-forget").addEventListener("click", async () => {
    const p = currentProject();
    if (!p) return;
    // confirm() DOES work in Electron (unlike prompt), and this is a genuine
    // are-you-sure — though it says plainly that the folder is untouched.
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

  // ------------------------------------------------------------------ runs

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

  function send() {
    const p = currentProject();
    if (!p) return status("Choose a folder first.");
    if (p.missing) return status("That folder no longer exists — forget the project, or put the folder back.");
    const task = $("kc-task").value.trim();
    if (!task) return;
    bubble("You", task);
    $("kc-task").value = "";
    $("kc-task").style.height = "";
    // "Plan first" makes the FIRST pass read-only: it looks, proposes, and
    // waits. Approving the plan runs the same task for real.
    return run(task, { mode: $("kc-plan").checked ? "plan" : "act" });
  }

  async function run(task, { mode = "act", plan = "" } = {}) {
    const p = currentProject();
    if (!p) return;
    $("btn-kc-run").disabled = true;
    $("btn-kc-stop").hidden = false;
    status(mode === "plan" ? "reading the project…" : "running…");
    try {
      const resp = await fetch("/core/code/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: p.id,
          sessionId: kc.sessionId || "",
          task,
          model: state.alias ?? "",
          mode,
          plan,
          tools: allowedTools(),
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
      if (done.reason === "planned") {
        // A plan is a proposal, not a turn: it is not written to the session
        // and nothing has happened on disk.
        if (done.answer) planCard(done.answer, task);
        status("plan ready — approve it to make the changes");
        return;
      }
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
  }

  $("btn-kc-run").addEventListener("click", send);
  $("btn-kc-stop").addEventListener("click", async () => {
    if (!kc.runId) return;
    await fetch("/core/code/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: kc.runId }),
    }).catch(() => {});
  });

  // Enter sends, Shift+Enter is a newline — the composer convention people
  // already have in their fingers. The box grows with the text.
  $("kc-task").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $("kc-task").addEventListener("input", (e) => {
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  });

  // ---------------------------------------------------------------- tools

  function allowedTools() {
    return kc.toolsByProject[kc.projectId] || [];
  }

  function renderToolsSummary() {
    const n = allowedTools().length;
    $("kc-tools-summary").textContent = n ? `${n} tool${n === 1 ? "" : "s"} lent` : "";
  }

  async function loadTools() {
    try {
      const j = await api("/core/code/tools");
      kc.allTools = j.tools || [];
      kc.maxTools = j.max || 8;
    } catch {
      kc.allTools = [];
    }
  }

  function renderToolsPanel() {
    const host = $("kc-tools-list");
    host.innerHTML = "";
    const chosen = new Set(allowedTools());
    $("kc-tools-note").textContent = kc.allTools.length
      ? `Off by default. Pick up to ${kc.maxTools} — a small local model cannot hold many tool descriptions and still have room for the task. Anything marked "asks first" still shows you a card before it runs.`
      : "No tools are available right now. Add an MCP server under Tools, or switch off Local-Only if the tools you want reach the internet.";
    for (const t of kc.allTools) {
      const row = document.createElement("label");
      row.className = "kc-tool-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = chosen.has(t.name);
      cb.addEventListener("change", () => {
        const now = new Set(allowedTools());
        if (cb.checked) {
          if (now.size >= kc.maxTools) {
            cb.checked = false;
            $("kc-tools-note").textContent = `That is the limit (${kc.maxTools}). Uncheck something first.`;
            return;
          }
          now.add(t.name);
        } else {
          now.delete(t.name);
        }
        kc.toolsByProject[kc.projectId] = [...now];
        try {
          localStorage.setItem("kai-code-tools", JSON.stringify(kc.toolsByProject));
        } catch {
          /* storage off — the choice just does not outlive the session */
        }
        renderToolsSummary();
      });
      const text = document.createElement("span");
      const name = document.createElement("b");
      name.textContent = t.name;
      const sub = document.createElement("span");
      sub.className = "kc-sub";
      sub.textContent = `${t.description || ""}${t.sensitive ? " — asks first" : ""}${t.egress ? " · leaves this machine" : ""}`;
      text.append(name, sub);
      row.append(cb, text);
      host.appendChild(row);
    }
  }

  $("btn-kc-tools").addEventListener("click", async () => {
    const panel = $("kc-tools-panel");
    if (!panel.hidden) {
      panel.hidden = true;
      return;
    }
    await loadTools();
    renderToolsPanel();
    panel.hidden = false;
  });
  $("btn-kc-tools-close").addEventListener("click", () => { $("kc-tools-panel").hidden = true; });

  async function render() {
    try {
      try {
        kc.toolsByProject = JSON.parse(localStorage.getItem("kai-code-tools") || "{}") || {};
      } catch {
        kc.toolsByProject = {};
      }
      await loadProjects();
      await renderGitHub();
      renderToolsSummary();
      if (kc.projectId) await renderGit();
    } catch (e) {
      startError(e.message);
    }
  }

  window.KaiCode = { render };
})();
