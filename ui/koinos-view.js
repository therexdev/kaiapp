/*
 * Koinos node tools — the optional panel behind the Earn toggle.
 *
 * Written fresh rather than ported from Koinos Node Desktop's renderer.js,
 * for reasons that are mechanical rather than aesthetic: that file declares
 * its own `const $`, which would throw a SyntaxError here and take the whole
 * script down; it carries 138 inline style attributes that this app's CSP
 * (style-src 'self') silently drops; and its .view/.active convention is the
 * inverse of this app's `hidden` attribute. Treat renderer.js as the spec for
 * what the screens SAY, never as code to paste.
 *
 * Stage 1 is READ ONLY. Nothing in this file can move funds, and Core has no
 * route that would let it.
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  if (!$("view-koinos")) return; // markup absent: do nothing rather than throw

  var POLL_MS = 10000;
  var state = { enabled: false, busy: false, timer: null };

  function jget(path) {
    return fetch(path).then(function (r) { return r.json(); });
  }
  function jpost(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }

  function setText(id, text) { var e = $(id); if (e) e.textContent = text; }
  function show(id, on) { var e = $(id); if (e) e.hidden = !on; }
  function setState(id, text, kind) {
    var e = $(id);
    if (!e) return;
    e.textContent = text;
    e.className = "koinos-state" + (kind ? " " + kind : "");
  }

  /** Refuse to redraw while someone is typing in this view — the same guard
   *  tools-view.js needed after a refresh timer kept eating input. */
  function userIsBusy() {
    if (state.busy) return true;
    var a = document.activeElement;
    return Boolean(a && $("view-koinos").contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
  }

  // ---- the toggle, which lives in the Earn view ----

  function paintToggle() {
    var btn = $("btn-koinos-toggle");
    if (btn) {
      btn.textContent = state.enabled ? "Turn off" : "Turn on";
      btn.setAttribute("aria-pressed", state.enabled ? "true" : "false");
    }
    show("nav-koinos", state.enabled);
    show("koinos-toggle-open", state.enabled);
    // Turning it off while looking at it would strand the user on a hidden
    // view, so send them somewhere real.
    if (!state.enabled && !$("view-koinos").hidden && typeof showView === "function") showView("earn");
  }

  function loadStatus() {
    return jget("/core/koinos").then(function (s) {
      state.enabled = Boolean(s && s.enabled);
      paintToggle();
      if (!state.enabled) return s;
      paintNetwork(s);
      paintCapability(s.capability, s.companion);
      var rpc = $("koinos-rpc");
      if (rpc && document.activeElement !== rpc) rpc.value = s.rpcUrl || "";
      var watch = $("koinos-watch");
      if (watch && document.activeElement !== watch && s.watchAddress) watch.value = s.watchAddress;
      return s;
    });
  }

  function paintNetwork(s) {
    var tag = $("koinos-net-tag");
    if (tag && s.network) tag.textContent = s.network.label || s.network.id;
  }

  // ---- card C: can this computer run a node ----

  function paintCapability(cap, companion) {
    if (!cap) return;
    var req = cap.requirements || {};
    if (cap.canRun === false && cap.reason === "arch") {
      setState("koinos-cap-verdict", "This computer can't run a Koinos node.", "bad");
      setText(
        "koinos-cap-detail",
        "The node software is only published for Intel and AMD chips, and this is an " +
          cap.arch +
          " computer. It isn't that it would be slow — the software doesn't exist for this chip. " +
          "You can still watch a node running somewhere else: put its address in the box above."
      );
      show("koinos-companion-row", false);
      return;
    }
    if (cap.canRun === false && cap.reason === "ram") {
      setState("koinos-cap-verdict", "This computer doesn't have enough memory to run a node.", "bad");
      setText("koinos-cap-detail", "A node needs about " + req.minRamGb + " GB of memory; this machine has " + cap.ramGb + " GB. You can still watch a node running elsewhere.");
      show("koinos-companion-row", false);
      return;
    }
    if (cap.canRun === false && cap.reason === "disk") {
      setState("koinos-cap-verdict", "Not enough free disk space to run a node.", "bad");
      setText("koinos-cap-detail", "A node needs about " + req.minFreeGbToRun + " GB free; this machine has " + cap.freeGb + " GB. You can still watch a node running elsewhere.");
      show("koinos-companion-row", false);
      return;
    }
    setState("koinos-cap-verdict", "This computer can run a Koinos node.", "good");
    var detail = "Checked " + (req.verifiedOn || "recently") + ". Running one also needs Docker installed";
    detail += cap.platform === "win32" ? ", which on Windows means a restart during setup." : ".";
    if (cap.quickSync === false) {
      detail += " With " + cap.freeGb + " GB free it would have to build the chain from the beginning, which takes days — about " +
        req.minFreeGbForQuickSync + " GB would let it start from a snapshot instead.";
    }
    setText("koinos-cap-detail", detail);
    show("koinos-companion-row", true);
    show("btn-koinos-open", Boolean(companion && companion.installed));
    show("btn-koinos-get", !(companion && companion.installed));
  }

  // ---- card A: balances for any address ----

  function lookUp() {
    var input = $("koinos-watch");
    if (!input) return Promise.resolve();
    var address = input.value.trim();
    show("koinos-watch-error", false);
    if (!address) return Promise.resolve();
    state.busy = true;
    return jpost("/core/koinos/config", { watchAddress: address })
      .then(function (r) {
        if (r && r.ok === false) throw new Error(r.error || "That address was not accepted");
        return jget("/core/koinos/balances?address=" + encodeURIComponent(address));
      })
      .then(function (b) {
        if (!b || b.ok === false) throw new Error((b && b.error) || "Could not read that address");
        setText("koinos-koin", b.koin);
        setText("koinos-vhp", b.vhp);
        setText("koinos-mana", b.mana);
        // Mana is the one number people are surprised by: it is what a send or
        // a burn actually spends, and it refills over about five days.
        setText("koinos-mana-hint",
          b.mana === b.koin
            ? "Mana is what pays for transactions. It refills over about five days."
            : "Mana is what pays for transactions — it is spent when you send or burn, and refills over about five days.");
        show("koinos-balances", true);
      })
      .catch(function (e) {
        setText("koinos-watch-error", String(e.message || e));
        show("koinos-watch-error", true);
        show("koinos-balances", false);
      })
      .then(function () { state.busy = false; });
  }

  // ---- card B: is a node answering ----

  function probeNode() {
    if (!state.enabled) return Promise.resolve();
    return jget("/core/koinos/node")
      .then(function (n) {
        if (!n || n.ok === false) { setState("koinos-node-state", (n && n.error) || "Could not check.", "bad"); return; }
        if (!n.connected) {
          setState("koinos-node-state",
            "No node answering at " + n.url + ". If yours is running, it may be in memory-saver mode — that turns off the status port this needs.",
            "bad");
          return;
        }
        if (n.synced) {
          setState("koinos-node-state", "Connected — block " + n.height + ", up to date.", "good");
        } else {
          setState("koinos-node-state", "Connected — block " + n.height + ", about " + n.behind + " blocks behind.", "warn");
        }
      })
      .catch(function () { /* a failed poll is not worth shouting about */ });
  }

  // ---- card D: the machine's own address, as an identity ----

  function loadOwnAddress() {
    return jget("/core/earn/wallet")
      .then(function (w) {
        var addr = (w && (w.address || (w.wallet && w.wallet.address))) || null;
        setText("koinos-own-address", addr || "No wallet yet — create one in Earn.");
      })
      .catch(function () { setText("koinos-own-address", "—"); });
  }

  // ---- wiring ----

  var toggle = $("btn-koinos-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      toggle.disabled = true;
      jpost("/core/koinos/config", { enabled: !state.enabled })
        .then(function (s) {
          state.enabled = Boolean(s && s.enabled);
          paintToggle();
          if (state.enabled) return refresh({ force: true });
        })
        .catch(function () {})
        .then(function () { toggle.disabled = false; });
    });
  }

  var lookupBtn = $("btn-koinos-watch");
  if (lookupBtn) lookupBtn.addEventListener("click", lookUp);
  var watchInput = $("koinos-watch");
  if (watchInput) watchInput.addEventListener("keydown", function (e) { if (e.key === "Enter") lookUp(); });

  var rpcBtn = $("btn-koinos-rpc");
  if (rpcBtn) {
    rpcBtn.addEventListener("click", function () {
      var v = ($("koinos-rpc") || {}).value || "";
      state.busy = true;
      jpost("/core/koinos/config", { rpcUrl: v })
        .then(function (r) {
          if (r && r.ok === false) { setState("koinos-node-state", r.error, "bad"); return; }
          setState("koinos-node-state", "Checking…", "");
          return probeNode();
        })
        .catch(function () {})
        .then(function () { state.busy = false; });
    });
  }

  var copyBtn = $("btn-koinos-copy");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      var t = ($("koinos-own-address") || {}).textContent || "";
      if (!t || t === "—") return;
      navigator.clipboard.writeText(t).then(function () {
        copyBtn.textContent = "Copied";
        setTimeout(function () { copyBtn.textContent = "Copy"; }, 1400);
      }, function () {});
    });
  }

  var getBtn = $("btn-koinos-get");
  if (getBtn) {
    getBtn.addEventListener("click", function () {
      window.open("https://github.com/therexdev/koinos-node/releases", "_blank");
    });
  }
  var openBtn = $("btn-koinos-open");
  if (openBtn) {
    openBtn.addEventListener("click", function () {
      // Handled in the main process, which asks Core for the detected path
      // itself — a path arriving in a request body would let any local page
      // aim this at an arbitrary binary.
      if (window.kai && window.kai.openCompanion) window.kai.openCompanion();
      else window.open("https://github.com/therexdev/koinos-node/releases", "_blank");
    });
  }

  function refresh(opts) {
    if (!(opts && opts.force) && userIsBusy()) return Promise.resolve();
    return loadStatus().then(function () {
      if (!state.enabled) return;
      if ($("view-koinos").hidden) return; // on, but not being looked at
      return Promise.all([probeNode(), loadOwnAddress()]);
    }).catch(function () {});
  }

  // Self-rescheduling, so a slow poll never stacks up behind itself.
  function tick() {
    refresh().then(function () {
      state.timer = setTimeout(tick, POLL_MS);
    });
  }

  loadStatus().then(function () {
    if (state.enabled && !$("view-koinos").hidden) refresh({ force: true });
  }).catch(function () {});
  state.timer = setTimeout(tick, POLL_MS);

  window.KaiKoinos = { refresh: refresh, status: function () { return state; } };
})();
