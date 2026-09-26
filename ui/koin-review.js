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
