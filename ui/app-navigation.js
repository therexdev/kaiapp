(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KaiAppNavigation = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const views = Object.freeze(["chat", "docs", "compare", "models", "tasks", "tools", "api", "earn", "code", "devtools", "settings", "network", "koinos", "koinos-wallet", "koinos-fund", "koinos-burn", "koinos-node", "koinos-returns", "koinos-settings"]);
  const valid = view => typeof view === "string" && views.includes(view);
  function request(text) {
    const match = String(text).trim().match(/^(?:(?:hey[ ,]+kai)[ ,.!]*\s*)?(?:(?:please|can you|could you|would you)\s+)?(?:open(?: up)?|show|bring up|take me to)\s+(?:(?:my|the)\s+)?(?:(?:main|full)\s+)?(app|application|koinos ai|chat|models|wallet|earnings|earn|settings|tools|documents|docs|tasks|network|node|koinos code)(?:\s+(?:screen|page|tab))?(?:\s+(?:for me|please))?[.!?]*$/i);
    if (!match) return null;
    const key = match[1].toLowerCase();
    return ({ app: "chat", application: "chat", "koinos ai": "chat", wallet: "koinos-wallet", earnings: "earn", documents: "docs", node: "koinos-node", "koinos code": "code" })[key] || key;
  }
  return { views, valid, request };
});
