"use strict";
(() => {
  const catalogData = window.KaiConnectionCatalog;
  const bundledLogos = new Set(["gmail","googlecalendar","googledrive","notion","slack","github","linear","outlook","microsoft_teams","googlesheets","googledocs","airtable","dropbox","trello","asana","hubspot","salesforce","shopify","discord","zoom","youtube","spotify","figma","clickup"]);
  const popular = [...bundledLogos];
  const rank = slug => popular.includes(slug) ? popular.indexOf(slug) : popular.length;
  const featured = [...catalogData.items].sort((a, b) => rank(a.slug) - rank(b.slug) || a.name.localeCompare(b.name));
  const authLabel = t => t.authSchemes?.some(a => /OAUTH/.test(a)) ? "Account sign-in" : t.authSchemes?.includes("NO_AUTH") ? "No account required" : t.authSchemes?.length ? "API credentials" : "Provider setup";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const btn = (label, action, value = "", primary = false) => `<button type="button" class="cn-button${primary ? " cn-primary" : ""}" data-cn="${action}" data-value="${esc(value)}">${esc(label)}</button>`;
  const check = (name, title, detail, checked, disabled = false) => `<label class="cn-permission"><input type="checkbox" name="${name}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}><span><strong>${esc(title)}</strong><small>${esc(detail)}</small></span></label>`;
  const field = (label, content) => `<label class="cn-field"><span>${esc(label)}</span>${content}</label>`;
  const logos = new Map(featured.filter(t => bundledLogos.has(t.slug)).map(t => [t.slug, "assets/connections/" + t.slug + ".svg"]));
  const logo = t => `<span class="cn-logo"><span>${esc(t.name?.slice(0, 1).toUpperCase() || "+")}</span><img alt="" data-cn-logo="${esc(t.slug)}" ${logos.has(t.slug) ? 'src="' + esc(logos.get(t.slug)) + '"' : ""}></span>`;
  let epoch = 0, search = "", category = "", auth = "", keyboard;
  const logoJobs = new Set(), logoFailures = new Set();
  const categories = catalogData.categories;
  function render(host, { state: initial, section, manage, navigate }) {
    keyboard?.abort(); keyboard = new AbortController();
    const generation = ++epoch; let state = initial, items = [], nextCursor = null, realCatalog = false, loading = false, timer, drawer = null, queryId = 0, pageSize = 72, matches = [], focusBeforeDrawer = null;
    const alive = () => generation === epoch && host.isConnected && host.getClientRects().length > 0;
    const status = () => state.composio || {};
    const ready = () => !status().blocked && (status().mode === "personal" ? status().personalConfigured : status().managedAvailable && status().signedIn);
    const connections = () => state.connections.filter(c => c.provider === "composio");
    const modeLabel = () => status().mode === "personal" ? "Your Composio" : "KAI-managed";
    let refreshing = null;
    const refresh = () => refreshing || (refreshing = (async () => {
      try { await manage("composioRefresh"); }
      finally { try { state = await manage("status"); } finally { refreshing = null; } }
    })());
    const notice = (message, error = false) => { if (!alive()) return; for (const e of host.querySelectorAll(".cn-notice")) { e.textContent = message; e.classList.toggle("cn-error", error); } };
    function readiness() {
      const s = status();
      if (s.blocked) return ["Online connections are paused", "Local-Only is on. Choose Local-First in Local API → Network & privacy to connect apps.", "Open privacy settings", "privacy"];
      if (s.mode === "personal") return s.personalConfigured ? null : ["Add your Composio key", "My Composio key is selected. Add your project key, or choose KAI-managed to use the server's connection service.", "Connection settings", "setup"];
      if (s.managedAvailable == null) return ["Checking KAI-managed connections…", "Checking whether your server's connection service is available.", "Check again", "refresh"];
      if (!s.managedAvailable) return ["KAI-managed connections are not enabled", "Your server has not enabled its connection service yet. If you just updated it, check again.", "Check again", "refresh"];
      if (!s.signedIn) return [s.sessionExpired ? "Sign in to KAI again" : "Sign in to KAI to connect apps", "The server's Composio service is enabled. Link this desktop app to your KAI account in Settings → Koinos AI account, then return here. No personal Composio key is needed.", "Sign in to KAI", "signin"];
      return null;
    }
    function readinessHTML() {
      const hint = readiness();
      return hint ? `<div class="cn-readiness"><div><strong>${esc(hint[0])}</strong><p>${esc(hint[1])}</p></div>${btn(hint[2], hint[3])}</div>` : "";
    }
    function updateReadiness() {
      for (const el of host.querySelectorAll("[data-cn-readiness]")) el.innerHTML = readinessHTML();
      const managed = host.querySelector("#cn-managed-status");
      if (managed) managed.textContent = status().managedAvailable == null ? "Checking server availability…" : status().managedAvailable ? status().signedIn ? "Available · KAI account signed in" : "Available · sign in to KAI to continue" : "Waiting for the server administrator to enable it";
    }
    function imageFallback() {
      for (const img of host.querySelectorAll("img[data-cn-logo]")) { img.addEventListener("error", () => { img.hidden = true; }, { once: true }); if (!img.getAttribute("src")) img.hidden = true; }
    }
    async function loadLogos() {
      if (status().blocked) return; const queue = [...new Set(items.map(t => t.slug).filter(s => !logos.has(s) && !logoJobs.has(s) && !logoFailures.has(s)))];
      queue.forEach(s => logoJobs.add(s));
      await Promise.all(Array.from({ length: 3 }, async () => {
        while (queue.length && alive()) { const key = queue.shift(); try { const src = await manage("composioLogo", { slug: key }); if (src?.startsWith("data:image/")) { logos.set(key, src); if (alive()) for (const img of host.querySelectorAll("img[data-cn-logo]")) if (img.dataset.cnLogo === key) { img.src = src; img.hidden = false; } } else logoFailures.add(key); } catch { logoFailures.add(key); } finally { logoJobs.delete(key); } }
        for (const key of queue) logoJobs.delete(key);
      }));
    }
    function draw() {
      if (!alive()) return;
      host.innerHTML = `<div class="cn-workspace"><div class="cn-notice" role="status" aria-live="polite"></div><div class="cn-main"></div><div class="cn-modal-host"></div></div>`;
      const out = host.querySelector(".cn-main");
      if (section === "setup") drawSetup(out); else if (section === "connected") drawConnected(out); else drawExplore(out);
      updateReadiness();
      if (drawer) drawDrawer(); imageFallback();
    }
    function drawExplore(out) {
      out.innerHTML = `<div class="cn-hero"><div><span class="cn-kicker">YOUR WORLD, CONNECTED</span><h2>Bring your everyday apps to KAI.</h2><p>One connection. More useful conversations, a richer Brain, and routines that follow through.</p></div><div class="cn-route"><span class="cn-route-dot"></span>${esc(modeLabel())}${btn("Change", "setup")}</div></div>
        <div data-cn-readiness></div><div class="cn-searchbar"><span aria-hidden="true">⌕</span><input type="search" id="cn-search" aria-label="Search apps" placeholder="Search apps, tools, or what you want to do…" value="${esc(search)}">${btn("Refresh", "refresh")}</div>
        <div class="cn-categories"><label class="cn-category-picker">Category<select id="cn-category"><option value="">All apps</option>${categories.map(c => `<option value="${esc(c.id)}" ${c.id === category ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label><label class="cn-category-picker">Connection type<select id="cn-auth"><option value="">All types</option>${["Account sign-in", "API credentials", "No account required", "Provider setup"].map(a => `<option ${a === auth ? "selected" : ""}>${a}</option>`).join("")}</select></label></div>
        <div class="cn-list-heading"><h3>Explore apps</h3><span id="cn-count"></span></div><div class="cn-app-grid" id="cn-apps"></div><div class="cn-more" id="cn-more"></div>
        <div class="cn-bottom-note">Sign in securely, then choose the actions and data KAI can use. ${btn("Connection settings", "setup")}</div>`;
      drawCards();
    }
    function drawCards() {
      const out = host.querySelector("#cn-apps"); if (!out) return;
      const shown = items;
      host.querySelector("#cn-count").textContent = `${shown.length} of ${matches.length.toLocaleString()} apps · ${featured.length.toLocaleString()} in catalog`;
      out.innerHTML = shown.map(t => { const active = connections().some(c => c.toolkit === t.slug && c.status === "ACTIVE"); return `<button type="button" class="cn-app-card" data-cn="app" data-value="${esc(t.slug)}">${logo(t)}<strong>${esc(t.name)}</strong><span class="cn-auth-label">${esc(authLabel(t))}</span><span class="cn-card-footer"><b class="${active ? "cn-connected-label" : ""}">${active ? "Connected ✓" : "Connect ↗"}</b></span></button>`; }).join("") || `<div class="cn-empty"><h3>${loading ? "Looking for apps…" : "No apps match that search"}</h3><p>Try an app name or another category.</p></div>`;
      host.querySelector("#cn-more").innerHTML = nextCursor ? btn("Show more apps", "more") : ""; imageFallback(); void loadLogos();
    }
    async function catalog(append = false) {
      if (!alive()) return;
      pageSize = append ? pageSize + 72 : 72;
      const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
      matches = featured.filter(t => (!category || t.category === category) && (!auth || authLabel(t) === auth) && terms.every(q => (t.name + " " + t.slug + " " + t.description + " " + t.originalCategory).toLowerCase().includes(q)));
      items = matches.slice(0, pageSize); nextCursor = matches.length > pageSize; realCatalog = true; loading = false; drawCards();
    }
    function drawConnected(out) {
      out.innerHTML = `<div class="cn-list-heading"><div><h2>Your connected apps</h2><p>Choose what KAI can use, and what belongs in your Brain.</p></div>${btn("Connect an app", "explore", "", true)}${btn("Refresh", "refresh")}</div><div class="cn-account-grid">${connections().map(c => {
        const t = featured.find(t => t.slug === c.toolkit) || { slug: c.toolkit, name: c.toolkit };
        return `<article class="cn-account-card"><div class="cn-account-top">${logo(t)}<span class="cn-status ${c.status === "ACTIVE" ? "active" : ""}">${esc(c.status === "ACTIVE" ? "Connected" : c.status === "EXPIRED" ? "Reconnect needed" : c.status.toLowerCase())}</span></div><h3>${esc(t.name)}</h3><p class="cn-account-name">${esc(c.name)}</p><div class="cn-account-detail">${c.operations.length} selected actions · ${c.allowSync ? "Brain sync available" : "Sync off"}</div><div class="cn-account-actions">${btn(c.status === "ACTIVE" ? "Manage access" : "Reconnect", c.status === "ACTIVE" ? "access" : "connect", c.status === "ACTIVE" ? c.id : c.toolkit, true)}${c.status === "ACTIVE" && c.operations.some(o => o.readOnly) ? btn("Collect into Brain", "collect", c.id) : ""}${btn("Disconnect", "disconnect", c.id)}</div></article>`;
      }).join("") || `<div class="cn-empty"><h3>A little more connected.</h3><p>Add an app you use every day. KAI will help you choose what to bring along.</p>${btn("Explore apps", "explore", "", true)}</div>`}</div>`;
      drawActivity(out);
    }
    function drawActivity(out) {
      const turns = (state.conversations || []).filter(t => t.actions?.length).sort((a,b) => Number(b.actions.some(x => x.status === "uncertain")) - Number(a.actions.some(x => x.status === "uncertain")) || b.at - a.at).slice(0, 12);
      if (!turns.length) return;
      const section = document.createElement("section"); section.className = "cn-recent-actions";
      section.innerHTML = `<h2>Recent chat actions</h2><p>Results stay here if a conversation stops or KAI restarts.</p>${turns.map(t => `<details class="kai-action-results"><summary>${esc(t.question)}</summary>${t.actions.map(a => `<div><strong>${esc(a.name)}</strong><p>${esc(a.runId ? state.runs.find(r => r.id === a.runId)?.status || a.status : a.status)}</p><p>${esc(a.message || "")}</p><small>Receipt ${esc(a.id)}</small>${a.status === "uncertain" ? btn("I inspected the destination", "reviewReceipt", t.id + ":" + a.id) : ""}<details><summary>Result details</summary><pre>${esc(JSON.stringify(a.data ?? a.ids ?? {}, null, 2))}</pre></details></div>`).join("")}</details>`).join("")}`;
      out.append(section);
    }
    function drawSetup(out) {
      const s = status();
      const grants = Array.isArray(state.settings?.approvalGrants) ? state.settings.approvalGrants : [];
      out.innerHTML = `<div class="cn-setup-intro"><h2>How would you like to connect?</h2><p>Both options open the same app catalog and secure sign-in flow.</p></div><div data-cn-readiness></div><form id="cn-settings"><div class="cn-mode-grid">
        <label class="cn-mode-card"><input type="radio" name="mode" value="managed" ${s.mode !== "personal" ? "checked" : ""}><span class="cn-mode-icon">K</span><strong>KAI-managed</strong><p>Use the Composio service configured by your KAI server. No Composio key to enter.</p><small id="cn-managed-status"></small></label>
        <label class="cn-mode-card"><input type="radio" name="mode" value="personal" ${s.mode === "personal" ? "checked" : ""}><span class="cn-mode-icon personal">C</span><strong>My Composio key</strong><p>Connect through your own Composio project. Manage your usage and billing directly.</p><small>${s.personalConfigured ? "Your key is saved securely" : "Bring your own project API key"}</small></label></div>
        <div class="cn-key-panel" ${s.mode !== "personal" ? "hidden" : ""}>${field("Composio project API key", `<input name="key" type="password" autocomplete="off" placeholder="${s.personalConfigured ? "Saved securely · leave blank to keep" : "Paste your Composio key"}">`)}<p>Find your project key in <a href="https://dashboard.composio.dev/" target="_blank" rel="noopener noreferrer">Composio settings ↗</a>. KAI encrypts it on this computer.</p></div>
        <div class="cn-setup-actions"><button class="cn-button cn-primary" type="submit">Save connection method</button>${!s.signedIn ? btn("Sign in to KAI", "signin") : ""}</div><p class="cn-muted">Connected accounts stay with the Composio project that created them. Changing methods does not move or disconnect those accounts.</p></form>
        <section class="cn-recent-actions"><h2>Always allowed actions</h2><p>These exact capabilities can run in an attended KAI request without another prompt. Account and action permission changes invalidate connected-app grants.</p>${grants.length ? grants.map(g => `<div><strong>${esc(g.label)}</strong>${btn("Revoke", "revokeGrant", g.key)}</div>`).join("") : '<p class="cn-muted">No actions are always allowed.</p>'}</section>`;
    }
    function openDrawer(title, content) {
      if (!host.querySelector(".cn-drawer")) focusBeforeDrawer = document.activeElement;
      host.querySelector(".cn-modal-host").innerHTML = `<div class="cn-overlay"><section class="cn-drawer" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="cn-drawer-heading"><h2>${esc(title)}</h2>${btn("Close", "close")}</div><div class="cn-notice" role="status"></div>${content}</section></div>`; imageFallback(); host.querySelector(".cn-drawer button")?.focus();
    }
    function drawDrawer() {
      if (!drawer) return; const d = drawer;
      if (d.kind === "app") {
        const t = d.app, active = connections().filter(c => c.toolkit === t.slug && c.status === "ACTIVE");
        openDrawer(t.name, `<div class="cn-connect-intro">${logo(t)}<h3>Connect ${esc(t.name)} to your world.</h3><p>${esc(t.description)}</p><span class="cn-status">${esc(authLabel(t))} · ${t.toolCount || 0} actions</span></div>${readinessHTML()}${ready() ? `<ol class="cn-connect-steps"><li>${authLabel(t) === "Account sign-in" ? `Sign in to ${esc(t.name)} in your browser.` : authLabel(t) === "No account required" ? "Open the tool setup in your browser." : "Enter the credentials requested by the provider in your browser."}</li><li>Choose the account and permissions to share.</li><li>Return to KAI and choose what it can use.</li></ol><p class="cn-muted">${esc(modeLabel())} handles the connection through Composio. Available authentication methods depend on the provider and your Composio project. Some apps require administrator setup or provider credentials.</p>${active.map(c => `<div class="cn-existing"><span>${esc(c.name)}</span>${btn("Manage", "access", c.id)}</div>`).join("")}${btn(active.length ? "Connect another account" : "Connect " + t.name, "connect", t.slug, true)}` : ""}`);
      } else if (d.kind === "waiting") {
        openDrawer("Finish connecting", `<div class="cn-connect-intro"><div class="cn-wait-orb">↗</div><h3>Continue in your browser</h3><p>Sign in and approve the account you want to connect. KAI will check when you return.</p></div><div class="cn-setup-actions">${btn("Check connection", "check", "", true)}${btn("Open sign-in again", "reopen")}</div><p class="cn-muted">The check stops after five minutes. You can start again if the link expires.</p>`);
      } else if (d.kind === "access") {
        const c = d.connection;
        openDrawer("Manage " + c.name, `<form id="cn-access">${field("Account name", `<input name="name" value="${esc(c.name)}" maxlength="100">`)}
          ${check("allowAgent", "Use in conversations", "KAI asks before using an action unless you explicitly make that account action always allowed.", c.allowAgent || !c.operations.length)}
          ${check("allowWrite", "Allow reviewed actions", "Changes and actions without verified read-only behavior always ask for approval.", c.allowWrite)}
          ${check("allowSync", "Allow Brain and workflow reads", "Only selected, verified read actions can run in the background.", c.allowSync)}
          ${window.KaiConnectionProfiles?.[c.toolkit] ? `<div class="cn-profile"><h3>${esc(window.KaiConnectionProfiles[c.toolkit].name)}</h3><p>${esc(window.KaiConnectionProfiles[c.toolkit].guidance)}</p><div class="cn-account-actions">${window.KaiConnectionProfiles[c.toolkit].searches.map(q => btn(q, "profileSearch", q)).join("")}</div><p>Choose the actions you need below, then Save access. These shortcuts do not grant permissions.</p></div>` : ""}<div class="cn-actions-heading"><h3>Choose actions for KAI</h3><span id="cn-selected-count"></span></div><input type="search" id="cn-action-search" aria-label="Search app actions" placeholder="Search actions and data…"><div class="cn-tool-list" id="cn-tool-list"></div><div id="cn-tool-more"></div>
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
      if (name === "signin") { await window.activateView("settings"); void window.renderAccount?.(true); document.getElementById("account-heading")?.scrollIntoView({ block: "center" }); return; }
      if (name === "privacy") return window.activateView("api");
      if (name === "close") { drawer = null; clearTimeout(timer); host.querySelector(".cn-modal-host").innerHTML = ""; focusBeforeDrawer?.focus(); return; }
      if (name === "category") { category = value; draw(); return catalog(); }
      if (name === "more") return catalog(true);
      if (name === "refresh") {
        logoFailures.clear();
        try { await refresh(); } finally { if (alive()) { updateReadiness(); if (drawer?.kind === "app") drawDrawer(); else if (section === "connected") draw(); } }
        if (alive() && section === "explore") await catalog(); return;
      }
      if (name === "app") {
        const app = items.find(t => t.slug === value); if (!app) return;
        drawer = { kind: "app", app }; drawDrawer();
        // Recheck a cached disabled service or a sign-in completed in Settings.
        // Keep the chosen app open while the initial status request finishes.
        if (!ready() && !status().blocked) void action("refresh").catch(error => notice(error.message, true)); return;
      }
      if (name === "connect") {
        const selectedDrawer = drawer;
        state = await manage("status");
        if (!ready()) { await action("refresh"); if (!alive() || !ready()) return; }
        if (!alive() || drawer !== selectedDrawer) return;
        try { await manage("composioConnect", { slug: value }); }
        catch (error) { state = await manage("status"); if (alive()) { updateReadiness(); if (drawer?.kind === "app") drawDrawer(); } throw error; }
        if (!alive() || drawer !== selectedDrawer) return; drawer = { kind: "waiting", toolkit: value, until: Date.now() + 5 * 60000 }; drawDrawer(); scheduleCheck(); return;
      }
      if (name === "reopen") return manage("composioReopen");
      if (name === "check") return checkConnection();
      if (name === "access") { const c = connections().find(c => c.id === value); if (!c) return; drawer = { kind: "access", connection: c, tools: c.operations, selected: new Set(c.operations.map(o => o.id)), known: new Map(c.operations.map(o => [o.id, o])), initial: true }; drawDrawer(); await loadTools(); return; }
      if (name === "reviewReceipt") { const [turnId, id] = value.split(":"); await manage("conversationReview", { turnId, id }); state = await manage("status"); draw(); return; }
      if (name === "revokeGrant") { await manage("approvalGrantRemove", { key: value }); state = await manage("status"); draw(); return; }
      if (name === "profileSearch") { host.querySelector("#cn-action-search").value = value; return loadTools(); }
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
    host.addEventListener("click", async e => {
      const b = e.target.closest("[data-cn]"); if (!b) return;
      const blocking = !["close", "signin", "privacy"].includes(b.dataset.cn);
      if (busy && blocking) return; if (blocking) busy = true; b.disabled = true;
      try { await action(b.dataset.cn, b.dataset.value); } catch (error) { notice(error.message, true); }
      finally { if (blocking) busy = false; b.disabled = false; }
    });
    host.addEventListener("input", e => { if (e.target.id === "cn-search") { search = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => catalog(), 300); } if (e.target.id === "cn-action-search") { clearTimeout(toolSearchTimer); toolSearchTimer = setTimeout(() => loadTools().catch(e => notice(e.message, true)), 300); } });
    host.addEventListener("change", e => {
      if (e.target.id === "cn-category") { category = e.target.value; void catalog(); }
      if (e.target.id === "cn-auth") { auth = e.target.value; void catalog(); }
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
          if (d.kind === "collect") { const source = d.source || await manage("source", { connectionId: d.connection.id, operationId: op.id, variables, name: f.elements.sourceName.value, autoSync: f.elements.autoSync.checked }); d.source = source; for (const el of f.querySelectorAll("input, select, textarea")) el.disabled = true; try { await manage("sync", { id: source.id }); notice("Added to Brain and synced. Find it under Brain → Sources."); b.textContent = "Refresh this source"; } catch (error) { b.textContent = "Retry sync"; throw new Error("Source added to Brain, but its first sync failed: " + error.message); } }
          else { const result = await manage("request", { connectionId: d.connection.id, operationId: op.id, variables }); const out = host.querySelector("#cn-result"); out.hidden = false; out.textContent = result; notice("Action completed."); }
        }
      } catch (error) { notice(error.message, true); } finally { busy = false; b.disabled = false; }
    });
    matches = featured; items = featured.slice(0, pageSize); draw(); if (section === "explore") void catalog();
    void (async () => {
      let error;
      try { if (!status().blocked) await refresh(); } catch (e) { error = e; }
      if (!alive()) return;
      // Updating status must not reset a key or connection method being edited.
      updateReadiness(); if (section === "connected") draw(); else if (drawer?.kind === "app") drawDrawer();
      if (section === "explore") await catalog();
      if (error) notice(error.message, true);
    })();
  }
  window.KaiConnections = { render };
})();
