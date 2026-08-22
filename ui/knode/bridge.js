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
 *   3. THE CHAIN DATA FOLDER IS A CHOICE. The standalone app puts tens of
 *      gigabytes wherever its own data lives and never mentions it, which is
 *      wrong for anyone with a small system drive. Here it is offered — with
 *      the default pre-filled — before quick sync downloads anything, and can
 *      be moved to another drive afterwards. Both are added from this file,
 *      so renderer.js stays byte-identical to the app it came from.
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
    // Ask where the data goes BEFORE the download is described, so the free
    // space the modal quotes is the drive the user actually picked.
    if (channel === "node:quickSyncInfo") {
      return maybeAskBeforeQuickSync().then(function () { return rpc(channel, payload); });
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

  // ---- difference 3: the chain data folder is the user's choice ----

  function fmtBytes(n) {
    if (n == null) return "unknown";
    if (n >= 1e12) return (n / 1e12).toFixed(2) + " TB";
    if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
    if (n >= 1e6) return (n / 1e6).toFixed(0) + " MB";
    return Math.max(1, Math.round(n / 1e3)) + " kB";
  }

  /*
   * The native folder picker lives on the HOST window's preload — Electron
   * does not run preload in sub-frames, so `koinosShell` is undefined in
   * here. The parent is same-origin, so reaching through to it is the whole
   * adaptation. Outside Electron (a browser, the tests) there is no picker at
   * all, so the modal falls back to a typed path rather than a dead button.
   */
  function shell() {
    try {
      if (window.koinosShell && window.koinosShell.pickFolder) return window.koinosShell;
      if (window.parent && window.parent !== window && window.parent.koinosShell) return window.parent.koinosShell;
    } catch (e) { /* cross-origin: no picker, fall back to typing */ }
    return null;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /** The app's own modal shell, so anything added here looks native. */
  function kaiModal(title) {
    var root = document.getElementById("modal-root");
    if (!root) return null;
    var backdrop = el("div", "modal-backdrop");
    var box = el("div", "modal");
    var body = el("div", "modal-body");
    var actions = el("div", "actions");
    box.appendChild(el("h2", null, title));
    box.appendChild(body);
    box.appendChild(actions);
    backdrop.appendChild(box);
    root.appendChild(backdrop);
    return {
      body: body,
      actions: actions,
      close: function () { backdrop.remove(); },
    };
  }

  /**
   * Ask where the chain data should live.
   *
   * `info` is node:dataDir. The current path is shown as the answer already
   * chosen — the point is that it is editable, not that it must be edited.
   * Resolves the chosen absolute path, or null if the user backed out.
   */
  function askFolder(info, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var m = kaiModal(opts.title || "Where should the chain data go?");
      if (!m) return resolve(null);

      var lead = el("p", "small");
      lead.textContent = opts.lead ||
        "A fully synced Koinos node is tens of gigabytes. It will go here unless you choose somewhere else — " +
        "an external or secondary drive is fine.";
      m.body.appendChild(lead);

      var chosen = info.path;
      var pathLine = el("p", "mono small");
      pathLine.id = "kai-dd-path";
      pathLine.style.wordBreak = "break-all";
      pathLine.style.margin = "10px 0 4px";
      pathLine.textContent = chosen;
      m.body.appendChild(pathLine);

      var facts = el("p", "small muted");
      var refreshFacts = function (free) {
        facts.textContent = free == null
          ? "Free space on that drive: unknown"
          : "Free space on that drive: " + fmtBytes(free);
      };
      refreshFacts(info.freeBytes);
      m.body.appendChild(facts);

      var warn = el("div", "banner warn");
      warn.id = "kai-dd-warn";
      warn.style.display = "none";
      m.body.appendChild(warn);

      // Typed fallback for a plain browser, where no native picker exists.
      var typed = null;
      if (!shell()) {
        typed = document.createElement("input");
        typed.type = "text";
        typed.id = "kai-dd-input";
        typed.value = chosen;
        typed.style.width = "100%";
        typed.style.marginTop = "10px";
        typed.addEventListener("input", function () { chosen = typed.value.trim(); pathLine.textContent = chosen; });
        m.body.appendChild(typed);
      }

      var change = el("button", "btn", shell() ? "Choose a different folder…" : "Check this folder");
      change.id = "kai-dd-change";
      var confirm = el("button", "btn primary", opts.confirmLabel || "Use this folder");
      confirm.id = "kai-dd-confirm";
      var cancel = el("button", "btn", "Cancel");
      cancel.id = "kai-dd-cancel";

      var vet = function (candidate) {
        return invoke("node:inspectDataDir", { path: candidate }).then(function (r) {
          if (!r.ok) { warn.style.display = ""; warn.textContent = r.error || "That folder can't be used."; return false; }
          var d = r.data;
          if (!d.ok) { warn.style.display = ""; warn.textContent = d.reason; confirm.disabled = true; return false; }
          warn.style.display = "none";
          confirm.disabled = false;
          chosen = d.target;
          pathLine.textContent = chosen;
          refreshFacts(d.targetFreeBytes);
          return true;
        });
      };

      change.addEventListener("click", function () {
        var sh = shell();
        if (!sh) return vet(typed ? typed.value.trim() : chosen);
        sh.pickFolder("Where should the Koinos chain data go?").then(function (dir) {
          if (!dir) return;
          vet(dir);
        });
      });
      cancel.addEventListener("click", function () { m.close(); resolve(null); });
      confirm.addEventListener("click", function () { m.close(); resolve(chosen); });

      m.actions.appendChild(cancel);
      m.actions.appendChild(change);
      m.actions.appendChild(confirm);
    });
  }

  /*
   * Quick sync is the moment the disk decision becomes expensive — it is
   * about to download and unpack the whole chain. Asking here, once, with the
   * default already filled in, is the difference between "it chose for me"
   * and "I chose". Asked only while there is nothing to move yet; after that
   * the Node screen's Change button is the right route, because then it is a
   * move rather than a setting.
   */
  var askedThisSession = false;
  function maybeAskBeforeQuickSync() {
    if (askedThisSession) return Promise.resolve();
    return invoke("node:dataDir", {}).then(function (r) {
      if (!r || !r.ok) return; // never block quick sync on this
      var info = r.data;
      if (info.hasData || !info.isDefault) { askedThisSession = true; return; }
      return askFolder(info, {}).then(function (dir) {
        askedThisSession = true;
        if (!dir || dir === info.path) return;
        return invoke("node:setDataDir", { path: dir }).then(function (res) {
          if (res && res.ok) toastish("Chain data will go to " + dir);
        });
      });
    })["catch"](function () { /* the choice is a courtesy; the sync still runs */ });
  }

  /** The app's toast, if the renderer has booted; otherwise silence. */
  function toastish(msg) {
    try {
      var wrap = document.getElementById("toasts");
      if (!wrap) return;
      var t = el("div", "toast good", msg);
      wrap.appendChild(t);
      setTimeout(function () { t.remove(); }, 6000);
    } catch (e) { /* cosmetic only */ }
  }

  /*
   * Moving what is already there. This is the one the owner asked for by
   * name: someone buys a bigger drive and needs the node to come with them.
   * The heavy lifting and every safety rule is in Core (koinos/data-move.js);
   * this is the conversation around it.
   */
  function onChangeDataFolder() {
    return invoke("node:dataDir", {}).then(function (r) {
      if (!r || !r.ok) return;
      var info = r.data;

      if (!info.hasData) {
        // Nothing downloaded yet: changing it is just a setting.
        return askFolder(info, { confirmLabel: "Use this folder" }).then(function (dir) {
          if (!dir || dir === info.path) return;
          return invoke("node:setDataDir", { path: dir }).then(function (res) {
            if (res && res.ok) toastish("Chain data will go to " + dir);
            else if (res) alert(res.error);
          });
        });
      }

      return askFolder(info, {
        title: "Move the chain data",
        lead: "There is " + fmtBytes(info.sizeBytes) + " of chain data here. Choosing a new folder copies all of it " +
          "across, checks it arrived, and only then removes the original — so nothing is lost if it is interrupted. " +
          "The node stops while it runs.",
        confirmLabel: "Move the data here",
      }).then(function (dir) {
        if (!dir || dir === info.path) return;
        startMove(dir, info);
      });
    });
  }

  /** Run the move with a progress modal that cannot be dismissed by accident. */
  function startMove(target, info) {
    var m = kaiModal("Moving the chain data");
    if (!m) return;
    var line = el("p", "small");
    line.id = "kai-move-phase";
    line.textContent = "Stopping the node…";
    var bar = el("div", "small mono");
    bar.id = "kai-move-bar";
    bar.style.marginTop = "8px";
    var note = el("p", "small muted");
    note.style.marginTop = "10px";
    note.textContent = "Safe to leave running. If this is interrupted, the original data stays exactly where it is.";
    m.body.appendChild(line);
    m.body.appendChild(bar);
    m.body.appendChild(note);

    var cancel = el("button", "btn", "Cancel");
    cancel.id = "kai-move-cancel";
    cancel.addEventListener("click", function () {
      cancel.disabled = true;
      cancel.textContent = "Cancelling…";
      invoke("node:moveDataDirCancel", {});
    });
    m.actions.appendChild(cancel);

    var PHASES = {
      stopping: "Stopping the node…",
      copying: "Copying",
      verifying: "Checking every file arrived…",
      switching: "Switching over…",
      cleaning: "Removing the old copy…",
    };

    var poll = setInterval(function () {
      invoke("node:moveDataDirStatus", {}).then(function (r) {
        if (!r || !r.ok || !r.data) return;
        var s = r.data;
        line.textContent = PHASES[s.phase] || s.phase;
        if (s.phase === "copying" && s.totalBytes) {
          var pct = Math.min(100, Math.round((s.copiedBytes / s.totalBytes) * 100));
          bar.textContent = fmtBytes(s.copiedBytes) + " of " + fmtBytes(s.totalBytes) + "  (" + pct + "%)";
        }
        if (s.running) return;
        clearInterval(poll);
        m.close();
        if (s.phase === "done") {
          toastish("Chain data moved to " + s.target);
        } else if (s.cancelled) {
          toastish("Move cancelled — your data is untouched.");
        } else {
          alert("The move did not finish: " + (s.error || "unknown error") +
            "\n\nYour original data was left exactly where it was.");
        }
      });
    }, 700);

    invoke("node:moveDataDir", { path: target }).then(function (r) {
      if (r && !r.ok) {
        clearInterval(poll);
        m.close();
        alert(r.error + "\n\nYour original data was left exactly where it was.");
      }
    });
    if (info && info.sizeBytes) bar.textContent = "0 of " + fmtBytes(info.sizeBytes);
  }

  /*
   * The Node screen re-renders whenever its data refreshes, so the button is
   * (re)attached by watching for the vendored "Data folder" button to appear
   * rather than by hooking a render we do not own.
   */
  function attachChangeButton() {
    var open = document.getElementById("n-open");
    if (!open || document.getElementById("kai-n-move")) return;
    var btn = el("button", "btn ghost", "Change data folder");
    btn.id = "kai-n-move";
    btn.title = "Move the chain data to another drive";
    btn.addEventListener("click", onChangeDataFolder);
    open.parentNode.insertBefore(btn, open.nextSibling);
  }
  setInterval(attachChangeButton, 500);

  // Reachable for tests, which cannot click through a native folder picker.
  window.KaiNodeData = {
    change: onChangeDataFolder,
    attach: attachChangeButton,
    askBeforeQuickSync: maybeAskBeforeQuickSync,
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
