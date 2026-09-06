"use strict";
(() => {
  const button = document.getElementById("launch-kai"), error = document.getElementById("kai-launch-error");
  if (!button || !window.koinosShell?.launchMascot) return;
  button.hidden = false;
  button.addEventListener("click", async () => {
    button.disabled = true; error.hidden = true;
    try {
      const model = typeof composedChatModel === "function" ? composedChatModel() : null;
      await window.koinosShell.launchMascot({ model });
    } catch {
      error.textContent = "KAI could not open. Try again, or restart the app.";
      error.hidden = false;
    } finally { button.disabled = false; }
  });
  window.koinosShell.onMascotOpenView?.(view => {
    const safeView = ["chat", "models", "settings"].includes(view) ? view : "chat";
    document.querySelector('[data-view="' + safeView + '"]')?.click();
    if (typeof refreshChatList === "function") refreshChatList();
  });
  window.addEventListener("focus", () => {
    if (typeof refreshChatList === "function") refreshChatList();
  });
})();
