"use strict";
(() => {
  const $ = id => document.getElementById(id), bridge = window.compareFixture, pending = new Set();
  let state = null, version = -1, timer;
  function paint(next) {
    if (!next || next.version < version) return;
    version = next.version; state = next;
    $("plugin-status").textContent = next.installed ? next.enabled ? "Installed · enabled" : "Installed · disabled" : "Not installed";
    $("install").disabled = next.installed || pending.has("install");
    $("toggle").textContent = next.enabled ? "Disable" : "Enable"; $("toggle").disabled = !next.installed;
    $("uninstall").disabled = !next.installed;
    for (const [index, side] of ["a", "b"].entries()) {
      const select = $("model-" + side);
      if (!select.options.length) for (const model of next.models) { const option = document.createElement("option"); option.value = model.id; option.textContent = model.label; select.append(option); }
      select.value = next.selected[index];
      const model = next.models.find(m => m.id === next.selected[index]);
      $("permission-" + side).textContent = `${model.permission}${model.permission === "approved" ? ` · expires ${new Date(model.expiresAt).toLocaleTimeString()}` : ""}`;
      $("approve-" + side).disabled = !next.enabled || !!next.reviewing || next.running || pending.has("approve") || model.permission === "approved";
      $("revoke-" + side).disabled = model.permission === "not approved";
      $("label-" + side).textContent = model.label + " — fixture only";
      $("answer-" + side).textContent = next.results.find(r => r.model === model.id)?.text || "No accepted fixture response.";
    }
    $("run").disabled = !next.enabled || next.running || !!next.reviewing || pending.has("run") || pending.has("approve");
    $("notice").textContent = next.notice;
    $("counter").textContent = `Fixture callbacks dispatched: ${next.dispatched}. Real inference requests: 0. Payments: 0.`;
  }
  async function call(action, value) {
    if (pending.has(action)) return;
    pending.add(action); $("error").textContent = ""; if (state) paint(state);
    try { const result = await bridge[action](value); if (!result.ok) $("error").textContent = result.error; paint(result.state); }
    catch { $("error").textContent = "The fixture window changed or closed. Reopen the demo and review permissions again."; }
    finally { pending.delete(action); if (state) paint(state); }
  }
  if (!bridge) { $("plugin-status").textContent = "Development host unavailable. Start with npm run demo:compare."; for (const button of document.querySelectorAll("button")) button.disabled = true; return; }
  for (const action of ["install", "uninstall", "stop"]) $(action).addEventListener("click", () => call(action));
  $("toggle").addEventListener("click", () => call(state?.enabled ? "disable" : "enable"));
  for (const side of ["a", "b"]) {
    $("model-" + side).addEventListener("change", () => call("select", [$("model-a").value, $("model-b").value]));
    $("approve-" + side).addEventListener("click", () => call("approve", $("model-" + side).value));
    $("revoke-" + side).addEventListener("click", () => call("revoke", $("model-" + side).value));
  }
  $("run").addEventListener("click", () => call("run", $("prompt").value));
  async function refresh() { try { const result = await bridge.status(); if (result.ok) paint(result.state); } catch {} }
  refresh(); timer = setInterval(refresh, 500);
  window.addEventListener("pagehide", () => { clearInterval(timer); bridge.stop().catch(() => {}); });
})();
