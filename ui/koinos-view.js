/*
 * The "Run Koinos Node" switch.
 *
 * This file owns one thing: the switch in Settings, and what it reveals.
 * Flipping it on unhides the single "Koinos Node" sidebar entry (its seven
 * screens are a rail inside that view now); flipping it off hides it again and
 * walks the user back to Settings — where the switch they just flipped is —
 * rather than stranding them on a view that is no longer there. The screens themselves live in
 * koinos-node-view.js and talk to the real node channels.
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var toggle = $("btn-koinos-toggle");
  if (!toggle) return; // markup absent: do nothing rather than throw

  var POLL_MS = 10000;
  var state = { enabled: false, timer: null };

  function jget(path) { return fetch(path).then(function (r) { return r.json(); }); }
  function jpost(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }

  function onKoinosView() {
    var v = document.querySelector(".koinos-view:not([hidden])");
    return Boolean(v);
  }

  function paintToggle() {
    toggle.setAttribute("aria-checked", state.enabled ? "true" : "false");
    toggle.classList.toggle("on", state.enabled);
    var navs = document.querySelectorAll(".koinos-nav");
    for (var i = 0; i < navs.length; i++) navs[i].hidden = !state.enabled;
    var open = $("koinos-toggle-open");
    if (open) open.hidden = !state.enabled;
    // Turning it off while looking at one of its screens would strand the user
    // on a hidden view, so send them somewhere real.
    if (!state.enabled && onKoinosView() && typeof activateView === "function") activateView("settings");
  }

  function loadStatus() {
    return jget("/core/koinos").then(function (s) {
      state.enabled = Boolean(s && s.enabled);
      paintToggle();
      return s;
    });
  }

  function flip() {
    toggle.disabled = true;
    return jpost("/core/koinos/config", { enabled: !state.enabled })
      .then(function (s) {
        state.enabled = Boolean(s && s.enabled);
        paintToggle();
        // Land on the dashboard so "on" has somewhere visible to go.
        if (state.enabled && typeof activateView === "function") activateView("koinos");
        else if (state.enabled && window.KaiKoinosNode) return window.KaiKoinosNode.refresh();
      })
      .catch(function () {})
      .then(function () { toggle.disabled = false; });
  }

  toggle.addEventListener("click", flip);
  toggle.addEventListener("keydown", function (e) {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
  });

  function refresh() {
    // Status only. The embedded app runs its own heartbeat; navigating it
    // from this poll is what made screens jump back to the dashboard.
    return loadStatus().catch(function () {});
  }

  // Self-rescheduling, so a slow poll never stacks up behind itself.
  function tick() { refresh().then(function () { state.timer = setTimeout(tick, POLL_MS); }); }
  loadStatus().catch(function () {});
  state.timer = setTimeout(tick, POLL_MS);

  window.KaiKoinos = { refresh: refresh, status: function () { return state; } };
})();
