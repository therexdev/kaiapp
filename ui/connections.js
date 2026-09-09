"use strict";
(() => {
  const featured = [
    ["gmail", "Gmail", "Email", "Find messages and keep up with your inbox."],
    ["googlecalendar", "Google Calendar", "Productivity", "Make room for what matters in your day."],
    ["googledrive", "Google Drive", "Files", "Bring your documents and project files together."],
    ["notion", "Notion", "Productivity", "Keep your notes, knowledge and projects close."],
    ["slack", "Slack", "Communication", "Stay in the loop with your team's conversations."],
    ["github", "GitHub", "Development", "Follow repositories, issues and pull requests."],
    ["linear", "Linear", "Development", "Connect your team's issues and project plans."],
    ["outlook", "Outlook", "Email", "Give KAI context from your Microsoft inbox."],
    ["microsoft_teams", "Microsoft Teams", "Communication", "Work with your team's conversations."],
    ["googlesheets", "Google Sheets", "Productivity", "Use the numbers and lists you work with."],
    ["googledocs", "Google Docs", "Files", "Connect the documents behind your work."],
    ["airtable", "Airtable", "Productivity", "Bring your bases and structured records to KAI."],
    ["dropbox", "Dropbox", "Files", "Find the files that keep projects moving."],
    ["trello", "Trello", "Productivity", "Keep track of boards, cards and next steps."],
    ["asana", "Asana", "Productivity", "Follow tasks, milestones and team projects."],
    ["hubspot", "HubSpot", "Business", "Stay close to your contacts and customer work."],
    ["salesforce", "Salesforce", "Business", "Connect your customer records and pipeline."],
    ["shopify", "Shopify", "Business", "Keep an eye on your store and products."],
    ["discord", "Discord", "Communication", "Connect with the communities you belong to."],
    ["zoom", "Zoom", "Communication", "Bring meetings into your everyday planning."],
    ["youtube", "YouTube", "Media", "Find channels, videos and useful ideas."],
    ["spotify", "Spotify", "Media", "Connect your music and playlists."],
    ["figma", "Figma", "Development", "Keep design files close to your projects."],
    ["clickup", "ClickUp", "Productivity", "Bring your tasks and workspaces into focus."],
  ].map(([slug, name, category, description]) => ({ slug, name, categories: [category], description }));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const btn = (label, action, value = "", primary = false) => `<button type="button" class="cn-button${primary ? " cn-primary" : ""}" data-cn="${action}" data-value="${esc(value)}">${esc(label)}</button>`;
  const check = (name, title, detail, checked, disabled = false) => `<label class="cn-permission"><input type="checkbox" name="${name}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}><span><strong>${esc(title)}</strong><small>${esc(detail)}</small></span></label>`;
  const field = (label, content) => `<label class="cn-field"><span>${esc(label)}</span>${content}</label>`;
  const logos = new Map(featured.map(t => [t.slug, "assets/connections/" + t.slug + ".svg"]));
  const logo = t => `<span class="cn-logo"><span>${esc(t.name?.slice(0, 1).toUpperCase() || "+")}</span><img alt="" data-cn-logo="${esc(t.slug)}" ${logos.has(t.slug) ? 'src="' + esc(logos.get(t.slug)) + '"' : ""}></span>`;
  let epoch = 0, search = "", category = "", keyboard;
  let categories = [...new Set(featured.map(t => t.categories[0]))].map(name => ({ id: name, name }));
  function render(host, { state: initial, section, manage, navigate }) {
    keyboard?.abort(); keyboard = new AbortController();
    const generation = ++epoch; let state = initial, items = [], nextCursor = null, realCatalog = false, loading = false, timer, drawer = null, queryId = 0, focusBeforeDrawer = null;
    const alive = () => generation === epoch && host.isConnected && host.getClientRects().length > 0;
    const status = () => state.composio || {};
    const ready = () => !status().blocked && (status().mode === "personal" ? status().personalConfigured : status().managedAvailable && status().signedIn);
    const connections = () => state.connections.filter(c => c.provider === "composio");
    const modeLabel = () => status().mode === "personal" ? "Your Composio" : "KAI-managed";
    const refresh = async () => { await manage("composioRefresh"); state = await manage("status"); };
    const notice = (message, error = false) => { if (!alive()) return; for (const e of host.querySelectorAll(".cn-notice")) { e.textContent = message; e.classList.toggle("cn-error", error); } };
    function imageFallback() {
      for (const img of host.querySelectorAll("img[data-cn-logo]")) { img.addEventListener("error", () => { img.hidden = true; }, { once: true }); if (!img.getAttribute("src")) img.hidden = true; }
    }
    async function loadLogos() {
      if (!ready()) return; const queue = [...new Set(items.map(t => t.slug).filter(s => !logos.has(s)))];
      await Promise.all(Array.from({ length: 3 }, async () => {
        while (queue.length && alive()) { const key = queue.shift(); try { const src = await manage("composioLogo", { slug: key }); if (src?.startsWith("data:image/")) { logos.set(key, src); if (alive()) for (const img of host.querySelectorAll("img[data-cn-logo]")) if (img.dataset.cnLogo === key) { img.src = src; img.hidden = false; } } } catch { /* The named card remains usable without its logo. */ } }
      }));
    }
    function draw() {
      if (!alive()) return;
      host.innerHTML = `<div class="cn-workspace"><div class="cn-notice" role="status" aria-live="polite"></div><div class="cn-main"></div><div class="cn-modal-host"></div></div>`;
      const out = host.querySelector(".cn-main");
      if (section === "setup") drawSetup(out); else if (section === "connected") drawConnected(out); else drawExplore(out);
      if (status().blocked) notice("Online connections are paused in Local-Only. Choose Local-First in Local API → Privacy when you're ready.");
      if (drawer) drawDrawer(); imageFallback();
    }
    function drawExplore(out) {
      out.innerHTML = `<div class="cn-hero"><div><span class="cn-kicker">YOUR WORLD, CONNECTED</span><h2>Bring your everyday apps to KAI.</h2><p>One connection. More useful conversations, a richer Brain, and routines that follow through.</p></div><div class="cn-route"><span class="cn-route-dot"></span>${esc(modeLabel())}${btn("Change", "setup")}</div></div>
        <div class="cn-searchbar"><span aria-hidden="true">⌕</span><input type="search" id="cn-search" aria-label="Search apps" placeholder="Search apps, tools, or what you want to do…" value="${esc(search)}">${btn("Refresh", "refresh")}</div>
        <div class="cn-categories"><label class="cn-category-picker">Category<select id="cn-category"><option value="">All apps</option>${categories.map(c => `<option value="${esc(c.id)}" ${c.id === category ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label></div>
        <div class="cn-list-heading"><h3>Explore apps</h3><span id="cn-count"></span></div><div class="cn-app-grid" id="cn-apps"></div><div class="cn-more" id="cn-more"></div>
        <div class="cn-bottom-note">${ready() ? "Sign in securely, then choose the actions and data KAI can use." : "Choose KAI-managed connections or add your Composio key to browse the full catalog and connect."} ${btn("Connection settings", "setup")}</div>`;
      drawCards();
    }
    function drawCards() {
      const out = host.querySelector("#cn-apps"); if (!out) return;
      const shown = realCatalog ? items : items.filter(t => !category || t.categories.includes(category));
      host.querySelector("#cn-count").textContent = loading ? "Finding apps…" : realCatalog ? shown.length + " apps shown" : "Featured apps";
      out.innerHTML = shown.map(t => { const active = connections().some(c => c.toolkit === t.slug && c.status === "ACTIVE"); return `<button type="button" class="cn-app-card" data-cn="app" data-value="${esc(t.slug)}">${logo(t)}<strong>${esc(t.name)}</strong><p>${esc(t.description)}</p><span class="cn-card-footer"><span>${esc(t.categories[0] || "App")}</span><b class="${active ? "cn-connected-label" : ""}">${active ? "Connected ✓" : "Connect ↗"}</b></span></button>`; }).join("") || `<div class="cn-empty"><h3>${loading ? "Looking for apps…" : "No apps match that search"}</h3><p>Try an app name or another category.</p></div>`;
      host.querySelector("#cn-more").innerHTML = nextCursor ? btn("Show more apps", "more") : ""; imageFallback(); void loadLogos();
    }
    async function catalog(append = false) {
      const currentQuery = ++queryId; loading = true; drawCards();
      try {
        if (!ready()) { items = featured.filter(t => (t.name + " " + t.description).toLowerCase().includes(search.toLowerCase())); realCatalog = false; nextCursor = null; }
        else { const r = await manage("composioCatalog", { search, cursor: append ? nextCursor : "", category }); if (!alive() || currentQuery !== queryId) return; items = append ? items.concat(r.items) : r.items; realCatalog = true; nextCursor = r.nextCursor; if (r.categories?.length) { categories = r.categories; if (!categories.some(c => c.id === category)) category = ""; const select = host.querySelector("#cn-category"); if (select) select.innerHTML = `<option value="">All apps</option>` + categories.map(c => `<option value="${esc(c.id)}" ${c.id === category ? "selected" : ""}>${esc(c.name)}</option>`).join(""); } }
      } catch (e) { notice(e.message, true); }
      finally { if (alive() && currentQuery === queryId) { loading = false; drawCards(); } }
    }
    function drawConnected(out) {
      out.innerHTML = `<div class="cn-list-heading"><div><h2>Your connected apps</h2><p>Choose what KAI can use, and what belongs in your Brain.</p></div>${btn("Connect an app", "explore", "", true)}${btn("Refresh", "refresh")}</div><div class="cn-account-grid">${connections().map(c => {
        const t = featured.find(t => t.slug === c.toolkit) || { slug: c.toolkit, name: c.toolkit };
        return `<article class="cn-account-card"><div class="cn-account-top">${logo(t)}<span class="cn-status ${c.status === "ACTIVE" ? "active" : ""}">${esc(c.status === "ACTIVE" ? "Connected" : c.status === "EXPIRED" ? "Reconnect needed" : c.status.toLowerCase())}</span></div><h3>${esc(t.name)}</h3><p class="cn-account-name">${esc(c.name)}</p><div class="cn-account-detail">${c.operations.length} selected actions · ${c.allowSync ? "Brain sync available" : "Sync off"}</div><div class="cn-account-actions">${btn(c.status === "ACTIVE" ? "Manage access" : "Reconnect", c.status === "ACTIVE" ? "access" : "connect", c.status === "ACTIVE" ? c.id : c.toolkit, true)}${c.status === "ACTIVE" && c.operations.some(o => o.readOnly) ? btn("Collect into Brain", "collect", c.id) : ""}${btn("Disconnect", "disconnect", c.id)}</div></article>`;
      }).join("") || `<div class="cn-empty"><h3>A little more connected.</h3><p>Add an app you use every day. KAI will help you choose what to bring along.</p>${btn("Explore apps", "explore", "", true)}</div>`}</div>`;
    }
    function drawSetup(out) {
      const s = status();
      out.innerHTML = `<div class="cn-setup-intro"><h2>How would you like to connect?</h2><p>Both options open the same app catalog and secure sign-in flow.</p></div><form id="cn-settings"><div class="cn-mode-grid">
        <label class="cn-mode-card"><input type="radio" name="mode" value="managed" ${s.mode !== "personal" ? "checked" : ""}><span class="cn-mode-icon">K</span><strong>KAI-managed</strong><p>Use the Composio service configured by your KAI server. No Composio key to enter.</p><small>${s.managedAvailable ? s.signedIn ? "Available · KAI account signed in" : "Available · sign in to KAI to continue" : "Waiting for the server administrator to enable it"}</small></label>
        <label class="cn-mode-card"><input type="radio" name="mode" value="personal" ${s.mode === "personal" ? "checked" : ""}><span class="cn-mode-icon personal">C</span><strong>My Composio key</strong><p>Connect through your own Composio project. Manage your usage and billing directly.</p><small>${s.personalConfigured ? "Your key is saved securely" : "Bring your own project API key"}</small></label></div>
        <div class="cn-key-panel" ${s.mode !== "personal" ? "hidden" : ""}>${field("Composio project API key", `<input name="key" type="password" autocomplete="off" placeholder="${s.personalConfigured ? "Saved securely · leave blank to keep" : "Paste your Composio key"}">`)}<p>Find your project key in <a href="https://dashboard.composio.dev/" target="_blank" rel="noopener noreferrer">Composio settings ↗</a>. KAI encrypts it on this computer.</p></div>
        <div class="cn-setup-actions"><button class="cn-button cn-primary" type="submit">Save connection method</button>${!s.signedIn ? btn("Sign in to KAI", "signin") : ""}</div><p class="cn-muted">Connected accounts stay with the Composio project that created them. Changing methods does not move or disconnect those accounts.</p></form>`;
    }
    function openDrawer(title, content) {
      if (!host.querySelector(".cn-drawer")) focusBeforeDrawer = document.activeElement;
      host.querySelector(".cn-modal-host").innerHTML = `<div class="cn-overlay"><section class="cn-drawer" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="cn-drawer-heading"><h2>${esc(title)}</h2>${btn("Close", "close")}</div><div class="cn-notice" role="status"></div>${content}</section></div>`; imageFallback(); host.querySelector(".cn-drawer button")?.focus();
    }
    function drawDrawer() {
      if (!drawer) return; const d = drawer;
      if (d.kind === "app") {
        const t = d.app, active = connections().filter(c => c.toolkit === t.slug && c.status === "ACTIVE");
        openDrawer(t.name, `<div class="cn-connect-intro">${logo(t)}<h3>Connect ${esc(t.name)} to your world.</h3><p>${esc(t.description)}</p></div><ol class="cn-connect-steps"><li>Sign in to ${esc(t.name)} in your browser.</li><li>Choose the account and permissions to share.</li><li>Return to KAI and choose what it can use.</li></ol><p class="cn-muted">${esc(modeLabel())} handles the connection through Composio. KAI receives access to the account you authorize.</p>${active.map(c => `<div class="cn-existing"><span>${esc(c.name)}</span>${btn("Manage", "access", c.id)}</div>`).join("")}${btn(active.length ? "Connect another account" : "Connect " + t.name, "connect", t.slug, true)}`);
      } else if (d.kind === "waiting") {
        openDrawer("Finish connecting", `<div class="cn-connect-intro"><div class="cn-wait-orb">↗</div><h3>Continue in your browser</h3><p>Sign in and approve the account you want to connect. KAI will check when you return.</p></div><div class="cn-setup-actions">${btn("Check connection", "check", "", true)}${btn("Open sign-in again", "reopen")}</div><p class="cn-muted">The check stops after five minutes. You can start again if the link expires.</p>`);
      } else if (d.kind === "access") {
        const c = d.connection;
        openDrawer("Manage " + c.name, `<form id="cn-access">${field("Account name", `<input name="name" value="${esc(c.name)}" maxlength="100">`)}
          ${check("allowAgent", "Use in conversations", "KAI asks before using an action from this account.", c.allowAgent || !c.operations.length)}
          ${check("allowWrite", "Allow reviewed actions", "Changes and actions without verified read-only behavior always ask for approval.", c.allowWrite)}
          ${check("allowSync", "Allow Brain and workflow reads", "Only selected, verified read actions can run in the background.", c.allowSync)}
          <div class="cn-actions-heading"><h3>Choose actions for KAI</h3><span id="cn-selected-count"></span></div><input type="search" id="cn-action-search" aria-label="Search app actions" placeholder="Search actions and data…"><div class="cn-tool-list" id="cn-tool-list"></div><div id="cn-tool-more"></div>
          <div class="cn-sticky-actions"><button class="cn-button cn-primary" type="submit">Save access</button>${c.operations.length ? btn("Try an action", "try", c.id) : ""}${c.operations.some(o => o.readOnly) ? btn("Collect into Brain", "collect", c.id) : ""}</div></form>`); drawTools();
      } else if (d.kind === "collect" || d.kind === "try") {
        const c = d.connection, ops = c.operations.filter(o => d.kind !== "collect" || o.readOnly);
        const chosen = ops.find(o => o.id === d.operation) || ops[0]; d.operation = chosen?.id;
        openDrawer(d.kind === "collect" ? "Collect into Brain" : "Try an action", `<form id="cn-run-action">${d.kind === "collect" ? field("Source name", `<input name="sourceName" value="${esc(c.name + " · " + (chosen?.name || "Source"))}" required maxlength="100">`) : ""}${field("What should KAI " + (d.kind === "collect" ? "collect?" : "do?"), `<select id="cn-operation">${ops.map(o => `<option value="${esc(o.id)}" ${o.id === d.operation ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select>`)}<p class="cn-muted">${esc(chosen?.description)}</p><div class="cn-argument-fields">${argumentFields(chosen)}</div>${d.kind === "collect" ? check("autoSync", "Keep this source up to date", "Refresh every 20 minutes while KAI is open.", false) : ""}<div class="cn-sticky-actions"><button class="cn-button cn-primary" type="submit">${d.kind === "collect" ? "Add to Brain" : "Run action"}</button></div><pre class="cn-result" id="cn-result" hidden></pre></form>`);
      }
    }
    function drawTools() {
      if (drawer?.kind !== "access") return; const d = drawer, target = host.querySelector("#cn-tool-list"); if (!target) return;
      const writes = host.querySelector('[name="allowWrite"]').checked;
      target.innerHTML = d.tools.map(t => `<label class="cn-tool"><input type="checkbox" data-cn-tool="${esc(t.id)}" ${d.selected.has(t.id) ? "checked" : ""} ${!t.readOnly && !writes ? "disabled" : ""}><span><strong>${esc(t.name)}</strong><small>${esc(t.description.slice(0, 180))}</small><b class="cn-tool-type">${t.readOnly ? "Read only" : "Review required"}</b></span></label>`).join("") || '<p class="cn-muted">No matching actions. Try another search.</p>';
      host.querySelector("#cn-selected-count").textContent = d.selected.size + " selected"; host.querySelector("#cn-tool-more").innerHTML = d.nextCursor ? btn("More actions", "moreTools") : "";
    }
    async function loadTools(append = false) {
      const d = drawer; if (d?.kind !== "access") return;
      const r = await manage("composioTools", { toolkit: d.connection.toolkit, search: host.querySelector("#cn-action-search")?.value || "", cursor: append ? d.nextCursor : "" });
      if (!alive() || drawer !== d) return; d.tools = append ? d.tools.concat(r.items) : r.items; d.nextCursor = r.nextCursor; for (const t of r.items) if (!d.selected.has(t.id) || !d.known.has(t.id)) d.known.set(t.id, t);
      d.tools = d.tools.map(t => d.selected.has(t.id) && d.known.has(t.id) ? d.known.get(t.id) : t);
      if (d.initial) { if (!d.connection.operations.length) r.items.filter(t => t.readOnly).slice(0, 8).forEach(t => d.selected.add(t.id)); d.initial = false; }
      drawTools();
    }
    function argumentFields(op) {
      if (!op) return '<p class="cn-muted">Select and save a read action in Manage access first.</p>';
      return Object.entries(op.schema.properties || {}).map(([key, p]) => {
        const required = op.schema.required?.includes(key), title = p.title || key.replace(/_/g, " ");
        const attrs = `data-cn-arg="${esc(key)}" ${required ? "required" : ""}`; let control;
        if (p.enum) control = `<select ${attrs}><option value="">Choose…</option>${p.enum.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("")}</select>`;
        else if (p.type === "boolean") control = `<select ${attrs}><option value="">Use default</option><option value="true">Yes</option><option value="false">No</option></select>`;
        else if (["object", "array"].includes(p.type)) control = `<textarea ${attrs} rows="3" placeholder="${p.type === "array" ? "[]" : "{}"}"></textarea>`;
        else control = `<input ${attrs} type="${["integer", "number"].includes(p.type) ? "number" : "text"}" ${p.type === "number" ? 'step="any"' : ""} placeholder="${esc(p.default === undefined ? "" : String(p.default))}">`;
        return field(title + (required ? " *" : ""), control + `<small>${esc(String(p.description || "").slice(0, 220))}</small>`);
      }).join("") || '<p class="cn-muted">This action needs no extra information.</p>';
    }
    function readArguments(form, op) {
      const out = {}; for (const el of form.querySelectorAll("[data-cn-arg]")) {
        if (el.value === "") continue; const key = el.dataset.cnArg, type = op.schema.properties[key].type;
        try { out[key] = ["number", "integer"].includes(type) ? Number(el.value) : type === "boolean" ? el.value === "true" : ["array", "object"].includes(type) ? JSON.parse(el.value) : el.value; } catch { throw new Error("Check the structured value for " + key.replace(/_/g, " ") + "."); }
      } return out;
    }
    async function action(name, value) {
      if (["setup", "explore", "connected"].includes(name)) return navigate(name);
      if (name === "signin") return window.activateView("settings");
      if (name === "close") { drawer = null; clearTimeout(timer); host.querySelector(".cn-modal-host").innerHTML = ""; focusBeforeDrawer?.focus(); return; }
      if (name === "category") { category = value; draw(); return catalog(); }
      if (name === "more") return catalog(true);
      if (name === "refresh") { await refresh(); if (!alive()) return; draw(); if (section === "explore") await catalog(); return; }
      if (name === "app") { if (!ready()) return navigate("setup"); drawer = { kind: "app", app: items.find(t => t.slug === value) }; drawDrawer(); return; }
      if (name === "connect") { if (!ready()) return navigate("setup"); await manage("composioConnect", { slug: value }); if (!alive()) return; drawer = { kind: "waiting", toolkit: value, until: Date.now() + 5 * 60000 }; drawDrawer(); scheduleCheck(); return; }
      if (name === "reopen") return manage("composioReopen");
      if (name === "check") return checkConnection();
      if (name === "access") { const c = connections().find(c => c.id === value); if (!c) return; drawer = { kind: "access", connection: c, tools: c.operations, selected: new Set(c.operations.map(o => o.id)), known: new Map(c.operations.map(o => [o.id, o])), initial: true }; drawDrawer(); await loadTools(); return; }
      if (name === "moreTools") return loadTools(true);
      if (name === "collect" || name === "try") { const c = connections().find(c => c.id === value); if (!c) return; if (name === "collect" && !c.allowSync) throw new Error("Enable Brain and workflow reads in Manage access first."); drawer = { kind: name, connection: c }; drawDrawer(); return; }
      if (name === "disconnect") { await manage("composioDisconnect", { id: value }); await refresh(); drawer = null; draw(); return; }
    }
    function scheduleCheck() { clearTimeout(timer); if (!alive() || drawer?.kind !== "waiting") return; timer = setTimeout(() => checkConnection().catch(e => { notice(e.message, true); scheduleCheck(); }), 3000); }
    async function checkConnection() {
      const d = drawer; if (!alive() || d?.kind !== "waiting") return;
      if (Date.now() > d.until) { notice("This sign-in check expired. Close this panel and connect again.", true); return; }
      await refresh(); if (!alive() || drawer !== d) return;
      if (!status().pending && status().completed?.toolkit === d.toolkit) { const c = connections().find(c => c.accountId === status().completed.accountId && c.toolkit === d.toolkit && c.status === "ACTIVE"); if (c) { clearTimeout(timer); await action("access", c.id); notice("Connected. Choose the actions and data KAI can use."); return; } }
      notice("Waiting for you to finish sign-in in the browser…"); scheduleCheck();
    }
    let busy = false, searchTimer, toolSearchTimer;
    host.addEventListener("click", async e => { const b = e.target.closest("[data-cn]"); if (!b || busy) return; busy = true; b.disabled = true; try { await action(b.dataset.cn, b.dataset.value); } catch (error) { notice(error.message, true); } finally { busy = false; b.disabled = false; } });
    host.addEventListener("input", e => { if (e.target.id === "cn-search") { search = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => catalog(), 300); } if (e.target.id === "cn-action-search") { clearTimeout(toolSearchTimer); toolSearchTimer = setTimeout(() => loadTools().catch(e => notice(e.message, true)), 300); } });
    host.addEventListener("change", e => {
      if (e.target.id === "cn-category") { category = e.target.value; void catalog(); }
      if (e.target.name === "mode") host.querySelector(".cn-key-panel").hidden = e.target.value !== "personal";
      if (e.target.name === "allowWrite" && drawer?.kind === "access") { if (!e.target.checked) for (const t of [...drawer.known.values()].filter(t => !t.readOnly)) drawer.selected.delete(t.id); drawTools(); }
      if (e.target.dataset.cnTool && drawer?.kind === "access") { if (e.target.checked) drawer.selected.add(e.target.dataset.cnTool); else drawer.selected.delete(e.target.dataset.cnTool); host.querySelector("#cn-selected-count").textContent = drawer.selected.size + " selected"; }
      if (e.target.id === "cn-operation") { drawer.operation = e.target.value; drawDrawer(); }
    });
    document.addEventListener("keydown", e => {
      if (!alive() || !drawer) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); void action("close"); }
      if (e.key === "Tab") {
        const targets = [...host.querySelectorAll('.cn-drawer button:not(:disabled), .cn-drawer input:not(:disabled), .cn-drawer select, .cn-drawer textarea, .cn-drawer a[href]')].filter(el => el.getClientRects().length);
        if (e.shiftKey && document.activeElement === targets[0]) { e.preventDefault(); targets.at(-1)?.focus(); }
        else if (!e.shiftKey && document.activeElement === targets.at(-1)) { e.preventDefault(); targets[0]?.focus(); }
      }
    }, { capture: true, signal: keyboard.signal });
    host.addEventListener("submit", async e => {
      if (!e.target.id.startsWith("cn-")) return; e.preventDefault(); if (busy) return; busy = true; const f = e.target, b = f.querySelector('button[type="submit"]'); b.disabled = true;
      try {
        if (f.id === "cn-settings") { const key = f.elements.key.value.trim(); f.elements.key.value = ""; await manage("composioSettings", { mode: f.elements.mode.value, key }); await refresh(); if (alive()) navigate("explore"); }
        if (f.id === "cn-access") { await manage("composioPermissions", { id: drawer.connection.id, name: f.elements.name.value, allowAgent: f.elements.allowAgent.checked, allowWrite: f.elements.allowWrite.checked, allowSync: f.elements.allowSync.checked, tools: [...drawer.selected].map(id => ({ id, version: drawer.known.get(id)?.version || "latest" })) }); state = await manage("status"); drawer = null; if (alive()) navigate("connected"); }
        if (f.id === "cn-run-action") {
          const d = drawer, op = d.connection.operations.find(o => o.id === d.operation), variables = readArguments(f, op);
          if (d.kind === "collect") { const source = d.source || await manage("source", { connectionId: d.connection.id, operationId: op.id, variables, name: f.elements.sourceName.value, autoSync: f.elements.autoSync.checked }); d.source = source; for (const el of f.querySelectorAll("input, select, textarea")) el.disabled = true; try { await manage("sync", { id: source.id }); notice("Added to Brain and synced. Find it under Brain → Sources & sync."); b.textContent = "Refresh this source"; } catch (error) { b.textContent = "Retry sync"; throw new Error("Source added to Brain, but its first sync failed: " + error.message); } }
          else { const result = await manage("request", { connectionId: d.connection.id, operationId: op.id, variables }); const out = host.querySelector("#cn-result"); out.hidden = false; out.textContent = result; notice("Action completed."); }
        }
      } catch (error) { notice(error.message, true); } finally { busy = false; b.disabled = false; }
    });
    items = featured; draw();
    void (async () => { try { if (!status().blocked) await refresh(); if (!alive()) return; draw(); if (section === "explore") await catalog(); } catch (error) { notice(error.message, true); } })();
  }
  window.KaiConnections = { render };
})();
