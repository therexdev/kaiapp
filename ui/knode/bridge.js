/*
 * The bridge that stands where Koinos Node Desktop's preload.js stood.
 *
 * renderer.js and styles.css in this folder are byte-for-byte the other
 * app's files — that is the point. They talk to `window.koinos.invoke`,
 * which preload.js used to satisfy over Electron IPC; here the same calls
 * travel over POST /core/koinos/rpc to the same handlers, ported whole into
 * Core. The response shape is identical ({ok, data|error}), so the renderer
 * cannot tell the difference.
 *
 * The two agreed differences with the standalone app both live here, so the
 * vendored files stay pristine and future versions re-vendor cleanly:
 *
 *   1. SAME WALLET. Core serves the channels against Koinos AI's own
 *      keystore — nothing to do here; it simply is.
 *   2. PASSWORD BEFORE FUNDS LEAVE. Core refuses the six channels that move
 *      value to someone else unless the call proves the wallet password. The
 *      standalone app doesn't send one, so this file intercepts those six
 *      and asks — with the app's own modal, so it looks native — then
 *      attaches what was typed to that one call and forgets it.
 *
 * It also adapts the three Electron-only util channels (clipboard, external
 * links, folder opening) and lets the surrounding Koinos AI sidebar drive
 * which view is shown.
 */
(function () {
  "use strict";

  // ---- password gate: value leaving the wallet proves the password HERE ----
  var OUTBOUND = {
    "chain:send": "Send KOIN",
    "fund:bridgeStart": "Bridge ETH to KOIN",
    "fund:routeCStart": "Fund with a swap",
    "fund:ethSend": "Send ETH",
    "fund:usdtSend": "Send USDT",
    "fund:vkoinSend": "Send vKOIN",
  };

  /** Ask for the wallet password with the app's own modal classes. Resolves
   *  the typed string, or null on cancel. Never stores what was typed. */
  function askPassword(title) {
    return new Promise(function (resolve) {
      var root = document.getElementById("modal-root");
      if (!root) return resolve(null);
      var backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      var modal = document.createElement("div");
      modal.className = "modal";
      var h = document.createElement("h2");
      h.textContent = title;
      var body = document.createElement("div");
      body.className = "modal-body";
      var p = document.createElement("p");
      p.className = "small muted";
      p.textContent = "Your wallet password is required whenever funds leave your wallet.";
      var input = document.createElement("input");
      input.type = "password";
      input.placeholder = "Wallet password";
      input.autocomplete = "current-password";
      input.style.width = "100%";
      input.style.marginTop = "10px";
      body.appendChild(p);
      body.appendChild(input);
      var actions = document.createElement("div");
      actions.className = "actions";
      var done = function (v) { backdrop.remove(); resolve(v); };
      var cancel = document.createElement("button");
      cancel.className = "btn";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", function () { done(null); });
      var okBtn = document.createElement("button");
      okBtn.className = "btn primary";
      okBtn.textContent = "Confirm";
      okBtn.addEventListener("click", function () { done(input.value); });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") done(input.value);
        if (e.key === "Escape") done(null);
      });
      actions.appendChild(cancel);
      actions.appendChild(okBtn);
      modal.appendChild(h);
      modal.appendChild(body);
      modal.appendChild(actions);
      backdrop.appendChild(modal);
      root.appendChild(backdrop);
      input.focus();
    });
  }

  function rpc(channel, payload) {
    return fetch("/core/koinos/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: channel, payload: payload }),
    }).then(
      function (r) { return r.json(); },
      function (e) { return { ok: false, error: String((e && e.message) || e) }; }
    );
  }

  function invoke(channel, payload) {
    // Clipboard never needs Core.
    if (channel === "util:copy") {
      return navigator.clipboard.writeText(String((payload && payload.text) || "")).then(
        function () { return { ok: true, data: true }; },
        function (e) { return { ok: false, error: String(e.message || e) }; }
      );
    }
    if (channel in OUTBOUND && !(payload && payload.password)) {
      return askPassword(OUTBOUND[channel]).then(function (pw) {
        if (pw == null) return { ok: false, error: "Cancelled — no funds moved." };
        var withPw = Object.assign({}, payload || {}, { password: pw });
        return rpc(channel, withPw);
      });
    }
    return rpc(channel, payload).then(function (res) {
      // Links Core hands back are opened here, where a window exists.
      if (res && res.ok && res.data && res.data.openUrl) window.open(res.data.openUrl, "_blank");
      return res;
    });
  }

  // ---- events: Core pushes the same app:event stream over SSE ----
  var listeners = [];
  function connectEvents() {
    try {
      var es = new EventSource("/core/koinos/events");
      es.onmessage = function (m) {
        var data;
        try { data = JSON.parse(m.data); } catch { return; }
        listeners.forEach(function (cb) { try { cb(data); } catch { /* one bad listener is not our problem */ } });
      };
      es.onerror = function () {
        es.close();
        setTimeout(connectEvents, 5000); // Core restarting is normal; come back
      };
    } catch { /* EventSource missing: heartbeat polling still covers it */ }
  }
  connectEvents();

  window.koinos = {
    invoke: invoke,
    onEvent: function (cb) {
      listeners.push(cb);
      return function () { listeners = listeners.filter(function (x) { return x !== cb; }); };
    },
  };

  // ---- embedded in Koinos AI: its sidebar drives the views ----
  // The host hides this page's own sidebar (the menus live in Koinos AI's,
  // revealed by the Run Koinos Node switch) and posts {koinosView: "..."}.
  // Clicking the hidden nav item is the switch mechanism, so this stays true
  // to renderer.js's own navigation no matter how it changes. Clicks land
  // only after init() attaches listeners, so keep trying until the view is
  // actually active.
  var wanted = null;
  window.addEventListener("message", function (e) {
    if (e.data && typeof e.data.koinosView === "string") wanted = e.data.koinosView;
  });
  setInterval(function () {
    if (!wanted) return;
    var section = document.getElementById("view-" + wanted);
    if (section && section.classList.contains("active")) { wanted = null; return; }
    var item = document.querySelector('.nav-item[data-view="' + wanted + '"]');
    if (item) item.click();
  }, 200);

  document.addEventListener("DOMContentLoaded", function () {
    if (window.parent === window) return; // standalone: leave the page alone
    var sidebar = document.getElementById("sidebar");
    if (sidebar) sidebar.style.display = "none";
  });
})();
