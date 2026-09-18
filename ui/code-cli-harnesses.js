"use strict";
/*
 * Subscription coding harnesses (Codex / Claude Code / Grok Build).
 *
 * Shared by Settings (primary management surface) and Koinos Code (model
 * picker + shortcut). Enablement is Core-backed via /core/code/providers —
 * never starts a login and never spawns a vendor CLI from this UI.
 */
(() => {
  let cache = { providers: [], privacyMode: "local-only", ok: false, error: "" };
  let pending = null;

  async function fetchStatus() {
    if (!pending) {
      pending = (async () => {
        try {
          const r = await fetch("/core/code/providers", { headers: { "content-type": "application/json" } });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `providers ${r.status}`);
          cache = {
            providers: Array.isArray(j.providers) ? j.providers : [],
            privacyMode: j.privacyMode || "local-only",
            ok: true,
            error: "",
          };
        } catch (e) {
          cache = { ...cache, ok: false, error: String(e.message || e) };
        } finally {
          pending = null;
        }
        return cache;
      })();
    }
    return pending;
  }

  async function setEnabled(provider, enabled) {
    const r = await fetch("/core/code/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, enabled: enabled === true }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `providers ${r.status}`);
    cache = {
      providers: Array.isArray(j.providers) ? j.providers : [],
      privacyMode: j.privacyMode || cache.privacyMode,
      ok: true,
      error: "",
    };
    window.dispatchEvent(new CustomEvent("kai-code-harnesses-changed", { detail: { ...cache } }));
    return cache;
  }

  /* Koinos AI spawns vendor CLIs with shell:false, which cannot execute a
   * Windows .cmd/.ps1 shim — only a real .exe. Using shell:true instead would
   * put an attacker-influenced path through cmd.exe parsing, which is not a
   * trade worth making, so the limitation is stated rather than worked around. */
  const WINDOWS_SHIM_RISK = /win/i.test(navigator.platform || "") || /Windows/i.test(navigator.userAgent || "");

  /*
   * Enablement and usability are two different facts, and Local-Only is where
   * they come apart: the setting is saved and will apply the moment privacy
   * mode changes, but nothing can run right now. Saying "Enabled for Koinos
   * Code" in that state is a lie the person would only discover by trying it.
   */
  function statusLine(p, privacyMode = cache.privacyMode) {
    const blocked = privacyMode === "local-only";
    const bits = [
      p.installed ? "Installed" : "Not installed",
      p.loggedIn ? "Signed in" : `Not signed in — run \`${p.login}\` in a terminal`,
      p.enabled
        ? blocked
          ? "Enabled, but blocked by Local-Only"
          : "Enabled for Koinos Code"
        : "Disabled",
    ];
    if (!p.installed && WINDOWS_SHIM_RISK) bits.push("On Windows, only a .exe is detected — a .cmd/.ps1 shim is not");
    return bits.join(" · ");
  }

  function privacyNote(privacyMode) {
    if (privacyMode === "local-only") {
      return "Privacy mode is Local-Only: subscription harnesses would send your project's code to the vendor, so none of them can run — every run is refused before the vendor CLI is started. You can still switch one off here; this panel holds back switching one on until you choose Local-First or Network under Local API.";
    }
    return "Off by default. Enabling one makes it available in the Koinos Code model selector. Prompt and file content leave this machine to that vendor. Koinos Code still shows every write and command for your approval. Sign-in is never started here — use the vendor CLI in a terminal if needed.";
  }

  /**
   * Render full management cards into a Settings host.
   * host: #code-cli-harness-list, noteEl: #code-cli-harness-note
   */
  function renderSettingsCards({ host, noteEl, resultEl } = {}) {
    const list = host || document.getElementById("code-cli-harness-list");
    const note = noteEl || document.getElementById("code-cli-harness-note");
    const result = resultEl || document.getElementById("code-cli-harness-result");
    if (!list) return cache;
    list.innerHTML = "";
    if (note) note.textContent = cache.ok ? privacyNote(cache.privacyMode) : (cache.error || "Could not load subscription harnesses.");
    const localOnly = cache.privacyMode === "local-only";
    for (const p of cache.providers) {
      const card = document.createElement("div");
      card.className = "provider-card harness-card";
      card.dataset.harness = p.provider;

      const heading = document.createElement("div");
      heading.className = "provider-heading";
      const h3 = document.createElement("h3");
      h3.id = `harness-${p.provider}-title`;
      h3.textContent = p.label;
      const state = document.createElement("span");
      state.className = "hint";
      state.dataset.harnessState = "";
      state.textContent = statusLine(p, cache.privacyMode);
      heading.append(h3, state);

      const plan = document.createElement("p");
      plan.className = "hint";
      plan.textContent =
        `${p.plan} · ` +
        (localOnly
          ? "blocked while privacy mode is Local-Only"
          : p.enabled
            ? "available in the Koinos Code model selector"
            : "not offered to Koinos Code until enabled") +
        ` · sends prompt and file content to ${p.vendor}`;

      const row = document.createElement("div");
      row.className = "harness-toggle-row";
      const toggleId = `harness-${p.provider}-enabled`;
      const label = document.createElement("label");
      label.className = "check";
      label.setAttribute("for", toggleId);
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = toggleId;
      cb.checked = p.enabled === true;
      /*
       * Local-Only blocks ENABLING, never disabling. Freezing the checkbox
       * outright stranded anyone who switched to Local-Only with a harness
       * already on: the setting stayed true with no way to clear it.
       */
      cb.disabled = !cache.ok || (localOnly && p.enabled !== true);
      cb.setAttribute("aria-describedby", `harness-${p.provider}-title`);
      label.append(cb, document.createTextNode(" Enable for Koinos Code"));
      row.appendChild(label);

      const guidance = document.createElement("p");
      guidance.className = "hint";
      guidance.textContent = p.loggedIn
        ? `Signed in via the vendor CLI. Login is never started from this app.`
        : `Not signed in. In a terminal, run \`${p.login}\` — this app never asks for subscription credentials.`;

      cb.addEventListener("change", async () => {
        const want = cb.checked;
        cb.disabled = true;
        if (result) result.textContent = want ? `Enabling ${p.label}…` : `Disabling ${p.label}…`;
        try {
          await setEnabled(p.provider, want);
          renderSettingsCards({ host: list, noteEl: note, resultEl: result });
          if (result) result.textContent = want ? `${p.label} enabled for Koinos Code.` : `${p.label} disabled.`;
        } catch (e) {
          cb.checked = !want;
          if (result) result.textContent = e.message;
          cb.disabled = !cache.ok || (localOnly && cb.checked !== true);
        }
      });

      card.append(heading, plan, row, guidance);
      list.appendChild(card);
    }
    return cache;
  }

  async function renderSettings() {
    const section = document.getElementById("code-cli-harnesses");
    if (!section) return cache;
    section.hidden = false;
    await fetchStatus();
    renderSettingsCards();
    return cache;
  }

  function focusSettings() {
    if (typeof activateView === "function") activateView("settings");
    else {
      const btn = document.querySelector('[data-view="settings"]');
      btn?.click();
    }
    const section = document.getElementById("code-cli-harnesses");
    if (!section) return;
    section.hidden = false;
    section.classList.add("harness-focus");
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    const close = () => section.classList.remove("harness-focus");
    setTimeout(close, 2200);
    renderSettings().catch(() => {});
  }

  window.KaiCodeHarnesses = {
    refresh: fetchStatus,
    status: () => cache,
    setEnabled,
    renderSettings,
    renderSettingsCards,
    focusSettings,
    privacyNote,
    statusLine,
  };

  window.addEventListener("kai-code-harnesses-changed", () => {
    // Keep any open Settings cards in sync if another surface flipped a toggle.
    if (document.getElementById("view-settings") && !document.getElementById("view-settings").hidden) {
      renderSettingsCards();
    }
  });
})();
