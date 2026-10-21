"use strict";
(() => {
  const states = new Set(["idle", "running", "complete", "incomplete", "unavailable"]);
  const message = error => String(error?.message || "The local check could not be reached. Try again.").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  function valid(value) {
    if (!value || !states.has(value.state) || typeof value.detail !== "string" || value.detail.length > 4096 ||
        typeof value.stage !== "string" || value.stage.length > 128 || typeof value.reportAvailable !== "boolean" ||
        ![value.completed, value.total].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000) || value.completed > value.total ||
        !(value.passed === null || Number.isSafeInteger(value.passed) && value.passed >= 0 && value.passed <= value.total) ||
        !(value.model === null || value.model && typeof value.model.id === "string" && value.model.id.length <= 100 &&
          typeof value.model.label === "string" && value.model.label.length <= 256)) throw Error("The local check returned an unreadable status. Try again.");
    return value;
  }
  function create({ root, bridge }) {
    const $ = name => root.querySelector("[data-check-" + name + "]");
    let value = { state: "idle", stage: "", detail: "Check the model currently running locally. No account or credits needed.", completed: 0, total: 0, passed: null, reportAvailable: false, model: null };
    let starting = false, cancelling = false, exporting = false, pendingRead = false, revision = 0, operation = 0, disposed = false;
    const available = !!bridge && ["start", "status", "cancel", "copy", "save", "onProgress"].every(key => typeof bridge[key] === "function");
    function paint() {
      const running = value.state === "running" || starting, report = value.reportAvailable && !running;
      root.dataset.state = value.state; root.setAttribute("aria-busy", String(running));
      $("model").textContent = value.model ? "Local model check · " + value.model.label : "Local model check";
      $("detail").textContent = cancelling ? "Stopping the local check…" : starting ? "Starting the local model check…" : value.detail;
      $("progress").hidden = !running;
      if (value.total) { $("progress").max = value.total; $("progress").value = value.completed; }
      else $("progress").removeAttribute("value");
      $("summary").textContent = value.total ? `${value.completed} of ${value.total} checks completed${value.passed === null ? "." : ` · ${value.passed} candidate answers matched.`}` : "";
      $("start").disabled = !available || running || cancelling;
      $("start").textContent = ["complete", "incomplete"].includes(value.state) ? "Run check again" : "Check this computer";
      $("cancel").hidden = !running; $("cancel").disabled = cancelling;
      for (const name of ["copy", "save"]) { $(name).hidden = !report; $(name).disabled = exporting; }
    }
    function accept(next) { value = valid(next); paint(); }
    function error(error) { $("export").textContent = message(error); }
    async function refresh() {
      if (!available || disposed || pendingRead || starting || cancelling) return;
      const seen = revision; pendingRead = true;
      try { const next = await bridge.status(); if (!disposed && revision === seen) accept(next); }
      catch (e) { if (!disposed && revision === seen) error(e); }
      finally { pendingRead = false; }
    }
    async function action(name) {
      if (!available || disposed) return;
      if (name === "start" && (starting || cancelling || value.state === "running")) return;
      if (name === "cancel" && (cancelling || !starting && value.state !== "running")) return;
      if (["copy", "save"].includes(name) && (exporting || starting || value.state === "running" || !value.reportAvailable)) return;
      $("export").textContent = "";
      if (name === "copy" || name === "save") {
        exporting = true; paint();
        try {
          const result = await bridge[name]();
          if (!disposed) $("export").textContent = result?.cancelled || result?.canceled ? "Save cancelled. Your report is still available." : name === "copy" ? "Report copied. Paste it into your support conversation." : "Report saved.";
        } catch (e) { if (!disposed) error(e); }
        finally { exporting = false; if (!disposed) paint(); }
        return;
      }
      const current = ++operation, seen = ++revision;
      if (name === "start") starting = true; else cancelling = true;
      paint();
      try {
        const next = await bridge[name]();
        if (!disposed && operation === current && revision === seen) accept(next);
      } catch (e) { if (!disposed && operation === current) error(e); }
      finally {
        if (operation === current) { starting = cancelling = false; if (!disposed) { paint(); await refresh(); } }
      }
    }
    const click = event => { const control = event.target.closest("[data-check-action]"); if (control && root.contains(control)) action(control.dataset.checkAction); };
    root.addEventListener("click", click);
    const unsubscribe = available ? bridge.onProgress(next => {
      if (disposed) return; revision++;
      try { accept(next); } catch (e) { error(e); }
    }) : null;
    if (!available) value = { ...value, state: "unavailable", detail: "Open the updated desktop app to check this computer." };
    paint(); refresh();
    return { refresh, dispose() { disposed = true; unsubscribe?.(); root.removeEventListener("click", click); } };
  }
  if (typeof module === "object") module.exports = { valid, create };
  if (typeof window !== "undefined") window.KaiProviderCheckUI = { create };
})();
