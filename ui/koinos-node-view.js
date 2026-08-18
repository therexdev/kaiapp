/*
 * Hosts Koinos Node Desktop — the whole app — inside Koinos AI.
 *
 * ui/knode/ is that app's renderer, styles and markup, vendored verbatim; a
 * small bridge in there carries its calls to the same handlers, ported whole
 * into Core, against the same wallet. This file only owns the embedding: one
 * iframe, created the first time a node view is opened, and told which of its
 * seven views to show when a sidebar entry is clicked. Everything the user
 * sees and touches inside it is the node app's own code — which is exactly
 * the requirement.
 */
(function () {
  "use strict";

  var host = document.getElementById("koinos-frame-host");
  if (!host) return;

  // Sidebar entry -> the view name renderer.js uses internally.
  var VIEWS = {
    "koinos": "dashboard",
    "koinos-wallet": "wallet",
    "koinos-fund": "fund",
    "koinos-burn": "burn",
    "koinos-node": "node",
    "koinos-returns": "returns",
    "koinos-settings": "settings",
  };

  var frame = null;

  function ensure() {
    if (frame) return frame;
    frame = document.createElement("iframe");
    frame.id = "koinos-frame";
    frame.src = "knode/index.html";
    frame.title = "Koinos Node";
    host.appendChild(frame);
    return frame;
  }

  function show(navName) {
    var view = VIEWS[navName];
    if (!view) return;
    var f = ensure();
    // The bridge inside retries until renderer.js has booted, so posting
    // before init() finishes is fine.
    try { f.contentWindow.postMessage({ koinosView: view }, "*"); } catch { /* not loaded yet; the src default is the dashboard */ }
  }

  window.KaiKoinosNode = {
    show: show,
    views: Object.keys(VIEWS),
    // Field report: this used to navigate to the dashboard, and the Earn
    // toggle's ten-second poll called it — so the Fund or Node screen yanked
    // back to the dashboard mid-click. Only a sidebar click navigates now;
    // this just keeps the iframe alive.
    refresh: function () { ensure(); },
  };
})();
