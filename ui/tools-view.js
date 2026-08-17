"use strict";

/*
 * Tools & accounts view. The design brief was "extremely user friendly":
 *   - Catalog servers are ONE click (requirements stated up front).
 *   - Every server row shows plain state: connected or not, how many tools,
 *     ask-first vs trusted — and the dangerous options explain themselves.
 *   - Email/calendar are guided forms with provider presets and the exact
 *     place to find an app password, not a wall of ports.
 */
(function toolsView() {
  const $ = (id) => document.getElementById(id);
  if (!$("view-tools")) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const jfetch = (url, opts) => fetch(url, opts).then((r) => r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` })));

  let refreshTimer = null;

  async function render() {
    if ($("view-tools").hidden) return;

    // ---- MCP servers ----
    const mj = await jfetch("/core/mcp");
    const tj = await jfetch("/core/tools");
    const localOnly = !((tj.tools || []).some((t) => t.egress)); // heuristic mirror; note below uses email status
    const list = $("mcp-list");
    list.innerHTML = "";
    for (const s of mj.servers || []) {
      const row = el("div", "tool-row");
      const head = el("div", "tool-row-head");
      head.appendChild(el("b", null, s.name));
      head.appendChild(el("span", "hint", s.transport === "http" ? " web server" : " runs on this machine"));
      const state = el("span", `tool-state ${s.connected ? "on" : ""}`, s.connected ? `connected · ${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}` : "not connected");
      head.appendChild(state);
      row.appendChild(head);
      if (s.connected && s.tools.length) {
        row.appendChild(el("div", "hint", s.tools.map((t) => t.name).join(" · ").slice(0, 220)));
      }
      const controls = el("div", "tool-controls");
      const conn = el("button", "linklike", s.connected ? "Disconnect" : "Connect");
      conn.onclick = async () => {
        conn.textContent = "…";
        const r = await jfetch(`/core/mcp/${s.id}/${s.connected ? "disconnect" : "connect"}`, { method: "POST" });
        if (!r.ok) alert(`Couldn't connect "${s.name}":\n${r.error}\n\nIf this is an npx server, Node.js must be installed on this computer.`);
        render();
      };
      controls.appendChild(conn);
      const trust = el("label", "tool-flag");
      trust.innerHTML = `<input type="checkbox" ${s.trusted ? "checked" : ""}/> don't ask before each use`;
      trust.querySelector("input").onchange = async (e) => {
        await jfetch(`/core/mcp/${s.id}/flags`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trusted: e.target.checked }) });
        render();
      };
      controls.appendChild(trust);
      const rm = el("button", "linklike danger", "Remove");
      rm.onclick = async () => {
        if (confirm(`Remove "${s.name}" and its tools?`)) {
          await jfetch(`/core/mcp/${s.id}`, { method: "DELETE" });
          render();
        }
      };
      controls.appendChild(rm);
      row.appendChild(controls);
      list.appendChild(row);
    }
    if (!(mj.servers || []).length) list.appendChild(el("p", "hint", "No tool servers yet — add one below and your AI gains its abilities in Agent mode."));

    const cat = $("mcp-catalog");
    cat.innerHTML = (mj.catalog || [])
      .map((c) => `<option value="${esc(c.id)}">${esc(c.name)} — ${esc(c.description)}</option>`)
      .join("");

    // Node runtime: most catalog servers are npm packages. If this machine
    // has no Node, offer to set one up (managed, inside the app) rather than
    // sending the user off to a website mid-task.
    const nodeBox = $("mcp-node-note");
    const node = mj.node || {};
    nodeBox.innerHTML = "";
    if (node.available) {
      nodeBox.appendChild(el("span", "hint", node.source === "system"
        ? `Tool runtime ready (using the Node.js already on this computer, ${node.version}).`
        : "Tool runtime ready (managed by Koinos AI)."));
    } else if (node.installable) {
      const mb = Math.round((node.downloadBytes || 0) / 1e6);
      nodeBox.appendChild(el("span", "hint", `Most tool servers need a small runtime (Node.js, ~${mb} MB, one time). It installs inside Koinos AI — no system changes.`));
      const btn = el("button", "primary small", `Set up tool runtime (~${mb} MB)`);
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "Downloading…";
        const r = await jfetch("/core/mcp/runtime", { method: "POST" });
        if (!r.ok) {
          btn.disabled = false;
          btn.textContent = `Set up tool runtime (~${mb} MB)`;
          alert(`Couldn't set up the runtime:\n${r.error}`);
        }
        render();
      };
      const row = el("div", "form-row");
      row.appendChild(btn);
      nodeBox.appendChild(row);
    } else {
      nodeBox.appendChild(el("span", "hint", "Tool servers that need Node.js aren't available for this platform yet — web-based (URL) servers still work."));
    }

    // ---- memory ----
    const mem = await jfetch("/core/memory");
    const ml = $("memory-list");
    ml.innerHTML = "";
    for (const m of (mem.memories || []).slice(0, 50)) {
      const row = el("div", "tool-row slim");
      row.appendChild(el("span", null, m.text));
      const rm = el("button", "linklike danger", "Forget");
      rm.onclick = async () => {
        await jfetch(`/core/memory/${m.id}`, { method: "DELETE" });
        render();
      };
      row.appendChild(rm);
      ml.appendChild(row);
    }
    if (!(mem.memories || []).length) ml.appendChild(el("p", "hint", "Nothing remembered yet. Pin a message with 📌, or add a fact below."));

    // ---- email ----
    const ej = await jfetch("/core/email");
    $("tools-localonly-note").hidden = !ej.localOnly;
    renderAccount($("email-panel"), {
      kind: "email",
      connected: ej.connected,
      who: ej.email,
      presets: ej.presets || [],
      encrypted: ej.credsEncrypted,
      localOnly: ej.localOnly,
      fields: (preset) => [
        { id: "email", label: "Email address", value: "" },
        { id: "pass", label: "App password", type: "password", help: preset?.help },
        ...(preset?.id === "custom" ? [
          { id: "imapHost", label: "IMAP server" },
          { id: "smtpHost", label: "SMTP server" },
        ] : []),
      ],
      save: (vals, preset) => jfetch("/core/email/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...vals, imapHost: vals.imapHost || preset.imapHost, imapPort: preset.imapPort, smtpHost: vals.smtpHost || preset.smtpHost, smtpPort: preset.smtpPort }),
      }),
      remove: () => jfetch("/core/email/config", { method: "DELETE" }),
      afterConnected: `Your AI can now search and read email in Agent mode (it asks first). Sending always needs your click — the AI can only draft.`,
    });

    // ---- calendar ----
    const cj = await jfetch("/core/calendar");
    renderAccount($("calendar-panel"), {
      kind: "calendar",
      connected: cj.connected,
      who: cj.url,
      presets: cj.presets || [],
      encrypted: cj.credsEncrypted,
      localOnly: cj.localOnly,
      fields: (preset) => [
        { id: "url", label: "Calendar URL", help: preset?.help },
        { id: "user", label: "Username" },
        { id: "pass", label: "Password / app password", type: "password" },
      ],
      save: (vals) => jfetch("/core/calendar/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(vals) }),
      remove: () => jfetch("/core/calendar/config", { method: "DELETE" }),
      afterConnected: `Your AI can list upcoming events and create new ones in Agent mode — creating always asks first.`,
    });
  }

  /** One guided connect-an-account panel (shared by email + calendar). */
  function renderAccount(panel, cfg) {
    panel.innerHTML = "";
    if (cfg.localOnly && !cfg.connected) {
      panel.appendChild(el("p", "hint", "Switched off in Local-Only privacy mode."));
      return;
    }
    if (cfg.connected) {
      const row = el("div", "tool-row");
      row.appendChild(el("span", null, `Connected: ${cfg.who}`));
      row.appendChild(el("span", "hint", cfg.encrypted ? " credentials in your OS keychain" : " credentials on disk (no OS keychain here)"));
      const rm = el("button", "linklike danger", "Disconnect");
      rm.onclick = async () => {
        if (confirm("Disconnect and forget the saved login?")) {
          await cfg.remove();
          render();
        }
      };
      row.appendChild(rm);
      panel.appendChild(row);
      panel.appendChild(el("p", "hint", cfg.afterConnected));
      if (cfg.kind === "email") renderInbox(panel);
      if (cfg.kind === "calendar") renderUpcoming(panel);
      return;
    }
    const sel = el("select");
    sel.innerHTML = cfg.presets.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
    const fieldsBox = el("div");
    const drawFields = () => {
      const preset = cfg.presets.find((p) => p.id === sel.value) || cfg.presets[0];
      fieldsBox.innerHTML = "";
      if (preset?.help) fieldsBox.appendChild(el("p", "hint", `Where to get it: ${preset.help}`));
      for (const f of cfg.fields(preset)) {
        const row = el("div", "form-row");
        const input = el("input");
        input.id = `${cfg.kind}-${f.id}`;
        input.placeholder = f.label;
        if (f.type) input.type = f.type;
        row.appendChild(input);
        fieldsBox.appendChild(row);
      }
      const save = el("button", "primary small", "Connect");
      save.onclick = async () => {
        const vals = {};
        for (const f of cfg.fields(preset)) vals[f.id] = $(`${cfg.kind}-${f.id}`)?.value || "";
        save.textContent = "Connecting…";
        const r = await cfg.save(vals, preset);
        if (!r.ok && r.error) alert(`Couldn't connect: ${r.error}`);
        render();
      };
      const wrap = el("div", "form-row");
      wrap.appendChild(save);
      fieldsBox.appendChild(wrap);
    };
    sel.onchange = drawFields;
    const selRow = el("div", "form-row");
    selRow.appendChild(sel);
    panel.appendChild(selRow);
    panel.appendChild(fieldsBox);
    drawFields();
  }

  /** Hand a prompt to the chat view — the AI actions (summarize, draft)
   *  run through the normal chat so the answer is visible, editable, and
   *  cheap to redo. Nothing is auto-sent anywhere. */
  function toChat(prompt) {
    document.querySelector('.nav-item[data-view="chat"]')?.click();
    const input = $("input");
    if (input) {
      input.value = prompt;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    }
  }

  function renderInbox(panel) {
    const box = el("div");
    const open = el("button", "linklike", "Open inbox ▸");
    open.onclick = async () => {
      open.remove();
      box.appendChild(el("p", "hint", "Loading…"));
      const r = await jfetch("/core/email/inbox");
      box.innerHTML = "";
      if (!r.ok) return box.appendChild(el("p", "error", r.error || "couldn't load the inbox"));
      for (const m of r.messages || []) {
        const row = el("div", "tool-row slim");
        const label = el("span", null, `${m.seen ? "" : "● "}${m.fromName || m.from} — ${m.subject}`);
        label.style.cursor = "pointer";
        label.onclick = async () => {
          const mr = await jfetch(`/core/email/message?uid=${m.uid}`);
          if (!mr.ok) return alert(mr.error || "couldn't open it");
          const body = el("div", "tool-row");
          body.appendChild(el("p", "hint", `${mr.message.from} · ${mr.message.date ? new Date(mr.message.date).toLocaleString() : ""}`));
          const pre = el("pre", null, mr.message.text);
          pre.style.whiteSpace = "pre-wrap";
          pre.style.maxHeight = "300px";
          pre.style.overflow = "auto";
          body.appendChild(pre);
          const acts = el("div", "tool-controls");
          const sum = el("button", "linklike", "Summarize in chat");
          sum.onclick = () => toChat(`Summarize this email in a few bullet points:\n\nFrom: ${mr.message.from}\nSubject: ${mr.message.subject}\n\n${mr.message.text.slice(0, 4000)}`);
          const draft = el("button", "linklike", "Draft a reply in chat");
          draft.onclick = () => toChat(`Draft a reply to this email in my voice. Keep it concise. I'll review before sending anything:\n\nFrom: ${mr.message.from}\nSubject: ${mr.message.subject}\n\n${mr.message.text.slice(0, 4000)}`);
          acts.append(sum, draft);
          body.appendChild(acts);
          row.after(body);
          label.onclick = () => body.remove();
        };
        row.appendChild(label);
        box.appendChild(row);
      }
      // Compose: three fields and one very human button. This is the ONLY
      // path that sends mail — the model never can.
      const compose = el("details");
      compose.innerHTML = `<summary class="hint">Write an email</summary>`;
      const to = el("input"); to.placeholder = "To";
      const subj = el("input"); subj.placeholder = "Subject";
      const bodyTa = document.createElement("textarea"); bodyTa.rows = 5; bodyTa.placeholder = "Message (tip: draft it in chat, paste it here)"; bodyTa.style.width = "100%";
      const send = el("button", "primary small", "Send");
      send.onclick = async () => {
        if (!confirm(`Send this email to ${to.value}?`)) return;
        send.textContent = "Sending…";
        const r = await jfetch("/core/email/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: to.value, subject: subj.value, text: bodyTa.value }) });
        send.textContent = r.ok ? "Sent ✓" : "Send";
        if (!r.ok) alert(r.error || "couldn't send");
        else { to.value = subj.value = bodyTa.value = ""; setTimeout(() => (send.textContent = "Send"), 1500); }
      };
      for (const f of [to, subj]) { const fr = el("div", "form-row"); fr.appendChild(f); compose.appendChild(fr); }
      compose.appendChild(bodyTa);
      const sr = el("div", "form-row"); sr.appendChild(send); compose.appendChild(sr);
      box.appendChild(compose);
    };
    box.appendChild(open);
    panel.appendChild(box);
  }

  function renderUpcoming(panel) {
    const box = el("div");
    const open = el("button", "linklike", "Show upcoming events ▸");
    open.onclick = async () => {
      open.remove();
      box.appendChild(el("p", "hint", "Loading…"));
      const r = await jfetch("/core/calendar/events?days=14");
      box.innerHTML = "";
      if (!r.ok) return box.appendChild(el("p", "error", r.error || "couldn't load events"));
      for (const ev of (r.events || []).slice(0, 15)) {
        const when = ev.allDay ? new Date(ev.start).toLocaleDateString() : new Date(ev.start).toLocaleString();
        box.appendChild(el("div", "tool-row slim", `${when} — ${ev.summary}${ev.location ? " @ " + ev.location : ""}${ev.repeats ? " ↻" : ""}`));
      }
      if (!(r.events || []).length) box.appendChild(el("p", "hint", "Nothing in the next two weeks."));
      const add = el("details");
      add.innerHTML = `<summary class="hint">New event</summary>`;
      const title = el("input"); title.placeholder = "Title";
      const start = el("input"); start.type = "datetime-local";
      const create = el("button", "primary small", "Add to calendar");
      create.onclick = async () => {
        if (!title.value || !start.value) return alert("Give it a title and a start time.");
        create.textContent = "Adding…";
        const r2 = await jfetch("/core/calendar/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ summary: title.value, startIso: new Date(start.value).toISOString() }) });
        create.textContent = r2.ok ? "Added ✓" : "Add to calendar";
        if (!r2.ok) alert(r2.error || "couldn't create it");
        else { title.value = start.value = ""; setTimeout(() => (create.textContent = "Add to calendar"), 1500); }
      };
      for (const f of [title, start, create]) { const fr = el("div", "form-row"); fr.appendChild(f); add.appendChild(fr); }
      box.appendChild(add);
    };
    box.appendChild(open);
    panel.appendChild(box);
  }

  // ---- wire the add buttons ----
  $("mcp-add-catalog")?.addEventListener("click", async () => {
    const btn = $("mcp-add-catalog");
    const mj = await jfetch("/core/mcp");
    const entry = (mj.catalog || []).find((c) => c.id === $("mcp-catalog").value);
    if (!entry) return;
    // If this server needs Node and the machine has none, offer to fetch it
    // right here — adding a tool must never dead-end on a manual install.
    if (entry.requires === "node" && !mj.node?.available) {
      if (!mj.node?.installable) return alert("This tool server needs Node.js, which isn't available for this platform yet.");
      const mb = Math.round((mj.node.downloadBytes || 0) / 1e6);
      if (!confirm(`"${entry.name}" needs a small runtime to run (Node.js, about ${mb} MB).\n\nKoinos AI can set it up for you now — it installs inside the app, changes nothing else on your computer, and only needs doing once.\n\nSet it up and continue?`)) return;
      btn.disabled = true;
      btn.textContent = "Setting up runtime…";
      const nr = await jfetch("/core/mcp/runtime", { method: "POST" });
      btn.disabled = false;
      btn.textContent = "Add";
      if (!nr.ok) {
        render();
        return alert(`Couldn't set up the runtime:\n${nr.error}`);
      }
    }
    let args = entry.args || [];
    if (entry.argsPrompt) {
      const extra = prompt(entry.argsPrompt.label);
      if (!extra) return;
      args = [...args, extra];
    }
    const r = await jfetch("/core/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: entry.name, transport: entry.transport, url: entry.url, command: entry.command, args }),
    });
    if (r.ok) {
      // First run downloads the server package itself and can take a
      // minute+ — an unexplained wait here reads as a hang (Windows CI
      // finding: the handshake outlasted the old 30s budget mid-download).
      btn.disabled = true;
      btn.textContent = "Downloading & starting… (first time only)";
      const c = await jfetch(`/core/mcp/${r.server.id}/connect`, { method: "POST" });
      btn.disabled = false;
      btn.textContent = "Add";
      if (!c.ok) alert(`Added, but couldn't start it:\n${c.error}\n\nIt stays in your list — press Connect to try again.`);
    } else alert(r.error || "couldn't add");
    render();
  });

  $("mcp-add-custom")?.addEventListener("click", async () => {
    const url = $("mcp-url").value.trim();
    const cmd = $("mcp-cmd").value.trim();
    if (!url && !cmd) return alert("Give either a server URL or a local command.");
    if (cmd && !confirm("A local tool server is a PROGRAM that runs on this computer with your user account. Only continue if you trust where this command came from.\n\nContinue?")) return;
    const r = await jfetch("/core/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: $("mcp-name").value.trim() || (url ? new URL(url).hostname : cmd.split(" ")[0]), transport: cmd ? "stdio" : "http", url: url || undefined, command: cmd || undefined }),
    });
    if (r.ok) {
      $("mcp-name").value = $("mcp-url").value = $("mcp-cmd").value = "";
      const c = await jfetch(`/core/mcp/${r.server.id}/connect`, { method: "POST" });
      if (!c.ok) alert(`Added, but couldn't connect:\n${c.error}`);
    } else alert(r.error || "couldn't add");
    render();
  });

  $("memory-add")?.addEventListener("click", async () => {
    const text = $("memory-new").value.trim();
    if (!text) return;
    await jfetch("/core/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    $("memory-new").value = "";
    render();
  });

  // Render when the view opens; light refresh while it stays open.
  const observer = new MutationObserver(() => {
    clearInterval(refreshTimer);
    if (!$("view-tools").hidden) {
      render();
      refreshTimer = setInterval(render, 20000);
    }
  });
  observer.observe($("view-tools"), { attributes: true, attributeFilter: ["hidden"] });
})();
