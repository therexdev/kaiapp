"use strict";
(() => {
  const bridge = window.kaiKoinReviewBridge;
  const section = document.getElementById("koin-review-preview");
  if (!bridge || !section) return;
  section.hidden = false;
  const button = document.getElementById("btn-koin-review-preview");
  const status = document.getElementById("koin-review-status");
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    KaiI18n.setText(status, "Review the example in the desktop dialog.");
    try {
      const result = await bridge.preview();
      const valid = result?.mode === "shadow" && result.paymentsEnabled === false;
      KaiI18n.setText(status, valid && result.status === "reviewed" ? "Example reviewed. No request was signed or sent." :
        valid && result.status === "cancelled" ? "Preview cancelled. No KOIN was spent." : "Preview unavailable. Please try again.");
    } catch {
      KaiI18n.setText(status, "Preview unavailable. Please try again.");
    } finally { button.disabled = false; }
  });
})();

(() => {
  const bridge = window.kaiKoinSessionBridge, section = document.getElementById("koin-session-rehearsal");
  if (!bridge || !section) return;
  const status = document.getElementById("koin-session-status");
  const buttons = ["review", "retry", "status", "revoke"].map(action => [action, document.getElementById("btn-koin-session-" + action)]);
  let busy = false;
  async function run(action) {
    if (busy) return;
    busy = true; for (const [, button] of buttons) button.disabled = true;
    try {
      const result = await bridge[action]();
      if (result?.mode !== "funded-rehearsal" || result.paymentsEnabled !== false) throw Error("Invalid session response");
      section.hidden = !result.enabled;
      const messages = { unapproved: "No session approval saved. Review the limits to begin.",
        active: "Session approved for accounting rehearsal. Paid chat remains disabled.",
        revoked: "Session approval revoked. Dispatched work stays reserved.",
        expired: "Session approval expired.", cancelled: "Session action cancelled.",
        uncertain: "The session result is uncertain. Refresh or retry the saved approval.",
        account_unavailable: "The account grant is unavailable. New requests are blocked.",
        reconciliation_required: "Session accounting needs reconciliation. New requests are blocked." };
      KaiI18n.setText(status, messages[result.state] || "Session rehearsal unavailable. Retry the saved approval if a response was lost.");
      if (result.error) status.appendChild(document.createTextNode(" " + String(result.error).slice(0, 220)));
    } catch { KaiI18n.setText(status, "Session rehearsal unavailable. Retry the saved approval if a response was lost."); }
    finally { busy = false; for (const [, button] of buttons) button.disabled = false; }
  }
  for (const [action, button] of buttons) button.addEventListener("click", () => run(action));
  run("status");
})();
