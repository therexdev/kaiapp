/*
 * The Koinos node's screens, inside Koinos AI.
 *
 * Every button here calls a real channel over POST /core/koinos/rpc — the same
 * handlers Koinos Node Desktop uses, against mainnet. Written fresh rather
 * than pasted from that app's renderer.js: it declares its own `const $` (a
 * SyntaxError here), uses inline style attributes this app's CSP drops, and
 * inverts the hidden/active convention. It is the spec for what the screens
 * SAY, not code to copy.
 *
 * The wallet is Koinos AI's wallet — the same address that earns KAI. Anything
 * that sends value to someone else asks for the password on the spot, because
 * Core reopens the wallet at start-up and "unlocked" is not evidence a person
 * is here. Burning, registering a producer key and automatic reburn keep the
 * value at your own address, so they never ask.
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  if (!$("view-koinos-wallet")) return;

  var VIEWS = ["koinos", "koinos-wallet", "koinos-fund", "koinos-burn", "koinos-node", "koinos-returns", "koinos-settings"];
  var busy = false;

  function rpc(channel, payload) {
    return fetch("/core/koinos/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: channel, payload: payload || {} }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || j.ok === false) throw new Error((j && j.error) || "That did not work");
      return j.data;
    });
  }

  /* Chain amounts travel as satoshi strings (8 decimals). Format them here
   * rather than trusting a float: 4308560000 must read 43.0856, not 43.08560001. */
  function fmt(sats) {
    if (sats == null || sats === "") return "—";
    var s = String(sats);
    if (!/^-?\d+$/.test(s)) return s; // already formatted by the handler
    var neg = s[0] === "-";
    if (neg) s = s.slice(1);
    while (s.length < 9) s = "0" + s;
    var whole = s.slice(0, -8).replace(/^0+(?=\d)/, "");
    var frac = s.slice(-8).replace(/0+$/, "");
    return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
  }
  function pct(n) { return n == null ? "—" : (Math.round(Number(n) * 10) / 10) + "%"; }

  // ---- tiny DOM helpers; no innerHTML with data in it ----
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function stat(label, value) {
    var d = el("div", "kn-stat");
    d.appendChild(el("span", "k-label", label));
    d.appendChild(el("span", "k-value", value == null || value === "" ? "—" : value));
    return d;
  }
  function grid() {
    var d = el("div", "kn-grid");
    for (var i = 0; i < arguments.length; i++) if (arguments[i]) d.appendChild(arguments[i]);
    return d;
  }
  function row() {
    var d = el("div", "kn-row");
    for (var i = 0; i < arguments.length; i++) if (arguments[i]) d.appendChild(arguments[i]);
    return d;
  }
  function input(id, ph, type) {
    var e = document.createElement("input");
    e.id = id; e.type = type || "text"; e.placeholder = ph || ""; e.spellcheck = false;
    return e;
  }
  function button(text, cls, onClick) {
    var b = el("button", cls || "small", text);
    b.addEventListener("click", onClick);
    return b;
  }
  function note(text, cls) { return el("p", "kn-note" + (cls ? " " + cls : ""), text); }
  function h(text) { return el("h2", null, text); }

  /* An action's outcome has to outlive the redraw that follows it, or the user
   * clicks Send and watches the confirmation vanish half a second later. The
   * message is parked here and re-rendered until they navigate away. */
  var flash = null;

  /** Run an action, showing its outcome in `out` and never leaving the button live. */
  function act(btn, out, fn) {
    busy = true;
    btn.disabled = true;
    out.textContent = "Working…";
    out.className = "kn-note";
    var land = function (text, cls) {
      out.textContent = text;
      out.className = "kn-note " + cls;
      flash = { view: currentView(), text: text, cls: cls };
    };
    Promise.resolve()
      .then(fn)
      .then(function (msg) { land(msg || "Done.", "kn-ok"); })
      .catch(function (e) { land(String(e.message || e), "kn-bad"); })
      .then(function () { busy = false; btn.disabled = false; refresh(); });
  }

  // ---------------- dashboard ----------------
  function renderDashboard(body) {
    return rpc("dashboard:summary").then(function (d) {
      var sym = (d.network && d.network.tokenSymbol) || "KOIN";
      body.appendChild(h("Node dashboard"));
      var b = d.balances && !d.balances.error ? d.balances : null;
      body.appendChild(grid(
        stat(sym, b ? fmt(b.koin) : "—"),
        stat("VHP (producing stake)", b ? fmt(b.vhp) : "—"),
        stat("Mana", b ? fmt(b.mana) : "—"),
        stat("Node", d.node && d.node.isRunning ? "Running · " + d.node.runningCount + " services" : "Stopped")
      ));

      if (d.sync && d.sync.local) {
        body.appendChild(note(
          "Chain height " + (d.sync.local.height != null ? d.sync.local.height : "—") +
          (d.sync.remote && d.sync.remote.height != null ? " of " + d.sync.remote.height : "") +
          (d.sync.inSync ? " — up to date." : d.sync.progressPct != null ? " — " + pct(d.sync.progressPct) + " synced." : "")
        ));
      }

      var w = d.stats && d.stats.windows;
      if (w) {
        body.appendChild(h("What it has earned"));
        body.appendChild(grid(
          stat("Last 24 hours", fmt(w.last24h) + " " + sym),
          stat("Last 7 days", fmt(w.last7d) + " " + sym),
          stat("Last 30 days", fmt(w.last30d) + " " + sym)
        ));
      } else if (d.node && d.node.isRunning) {
        body.appendChild(note("Earnings appear here once the node has produced its first blocks."));
      }

      if (d.returns) {
        body.appendChild(grid(
          stat("Yearly return on stake", pct(d.returns.yearlyReturnPct)),
          stat("…with automatic reburn", pct(d.returns.yearlyReturnReburnPct))
        ));
        body.appendChild(note("Projected from recent blocks at today's network conditions. Not a promise."));
      }

      if (d.node && d.node.error) body.appendChild(note(d.node.error, "kn-bad"));
      body.appendChild(note(d.wallet && d.wallet.address ? "Wallet " + d.wallet.address : "No wallet yet — create one in Earn."));
    });
  }

  // ---------------- wallet ----------------
  function renderWallet(body) {
    return rpc("wallet:status").then(function (w) {
      body.appendChild(h("Wallet"));
      body.appendChild(note("This is your Koinos AI wallet — the same address you earn KAI with. The Ethereum address below comes from the same key, so one backup covers both chains."));
      body.appendChild(grid(
        stat("Koinos address", w.address || "No wallet yet"),
        stat("Ethereum address", w.ethAddress),
        stat("Status", w.unlocked ? "Unlocked" : "Locked")
      ));

      return rpc("chain:balances").catch(function () { return null; }).then(function (b) {
        if (b && b.formatted) {
          body.appendChild(grid(
            stat("KOIN", b.formatted.koin),
            stat("VHP", b.formatted.vhp),
            stat("Mana", b.formatted.mana)
          ));
        }

        body.appendChild(h("Send KOIN"));
        body.appendChild(note("Sending moves money to someone else and cannot be undone. Your password is required every time."));
        var to = input("kn-send-to", "Recipient Koinos address");
        var amt = input("kn-send-amt", "Amount");
        var pw = input("kn-send-pw", "Wallet password", "password");
        var out = note("");
        var go = button("Send", "primary small", function () {
          if (!window.confirm("Send " + (amt.value || "0") + " KOIN to " + (to.value || "—") + "?\n\nThis cannot be reversed.")) return;
          act(go, out, function () {
            return rpc("chain:send", { to: to.value.trim(), amount: amt.value.trim(), token: "koin", password: pw.value })
              .then(function (r) { pw.value = ""; amt.value = ""; return "Sent. Transaction " + String(r.txId || "").slice(0, 18) + "…"; });
          });
        });
        body.appendChild(row(to, amt, pw, go));
        body.appendChild(out);
      });
    });
  }

  // ---------------- fund ----------------
  var MAX_FUND_ETH = 0.05; // the same beta cap the node app enforces
  var fundQuote = null;   // last comparison, so a redraw does not throw the prices away

  function renderFund(body) {
    return rpc("fund:status").then(function (f) {
      body.appendChild(h("Fund node"));
      body.appendChild(note("Buy ETH with a card, then bring it across to KOIN. The Ethereum address below comes from your Koinos AI wallet, so what you buy lands in the wallet you already have."));

      var g = grid(stat("Your Ethereum address", f.ethAddress || "Unlock your wallet first"));
      body.appendChild(g);
      rpc("fund:ethBalance").then(function (e) { g.appendChild(stat("ETH balance", e.eth)); }, function () {});

      var out = note("");
      var buy = button("Buy ETH with a card", "primary small", function () {
        act(buy, out, function () {
          return rpc("fund:buyUrl", {}).then(function (r) {
            if (r && r.url) window.open(r.url, "_blank");
            return "Opened the purchase page in your browser.";
          });
        });
      });
      body.appendChild(row(buy));

      body.appendChild(h("Bring it across to KOIN"));
      body.appendChild(note("There are two ways across. Price both, then pick — they can differ by a lot. Once started it runs by itself, so the password is asked once, up front."));
      var amt = input("kn-fund-amt", "Amount in ETH, e.g. 0.02");
      var pw = input("kn-fund-pw", "Wallet password", "password");
      var routes = el("div", "kn-routes");

      if (fundQuote && fundQuote.routes.length) {
        amt.value = fundQuote.amountEth;
        fundQuote.routes.forEach(function (rt) { routes.appendChild(routeCard(rt, amt, pw, out)); });
      }

      var quote = button("Price both routes", "primary small", function () {
        act(quote, out, function () {
          var v = Number(amt.value);
          if (!v || v <= 0) throw new Error("Enter an amount in ETH first");
          if (v > MAX_FUND_ETH) throw new Error("Up to " + MAX_FUND_ETH + " ETH at a time while this is new");
          return rpc("fund:routeCompare", { amountEth: amt.value.trim() }).then(function (r) {
            // Kept in module state, not just in the DOM: the ten-second poll
            // redraws this screen, and prices the user asked for must survive it.
            fundQuote = { amountEth: amt.value.trim(), routes: r.routes || [] };
            return fundQuote.routes.length ? "Priced. Pick a route below." : "No route could be priced right now.";
          }).then(function (msg) {
            return rpc("fund:routeMaxEth").then(function (gas) {
              if (Number(amt.value) + Number(gas.gasReserveEth) > Number(gas.balanceEth)) {
                return msg + " Low on gas: a run needs about " + Number(gas.gasReserveEth).toFixed(4) +
                  " ETH of fees on top of the amount, and this address holds " + Number(gas.balanceEth).toFixed(4) + " ETH.";
              }
              return msg;
            }, function () { return msg; });
          });
        });
      });
      body.appendChild(row(amt, pw, quote));
      body.appendChild(routes);
      body.appendChild(out);

      return Promise.all([
        rpc("fund:bridgeStatus").catch(function () { return null; }),
        rpc("fund:routeCStatus").catch(function () { return null; }),
      ]).then(function (jobs) {
        for (var i = 0; i < jobs.length; i++) {
          var job = jobs[i];
          if (job && job.status) {
            body.appendChild(note(
              "In progress: " + job.status + (job.step ? " — " + job.step : "") + (job.error ? " — " + job.error : ""),
              job.error || job.status === "error" ? "kn-bad" : "kn-ok"
            ));
          }
        }
      });
    });
  }

  /** One priced route, with the button that runs it. Route C swaps to vKOIN and
   *  bridges; route B bridges to vETH and swaps. Which is better changes with
   *  the market, so the app never picks for you — it just marks the winner. */
  function routeCard(rt, amt, pw, out) {
    var card = el("div", "kn-step");
    card.appendChild(el("b", null, "Route " + rt.id + " — " + rt.label + (rt.isBest ? "  ★ best right now" : "")));
    card.appendChild(note((rt.steps || []).join(" → ")));
    card.appendChild(note(
      rt.koinOut ? fmt(rt.koinOut) + " KOIN" + (!rt.isBest && rt.bestMultiple ? " — the best route returns " + rt.bestMultiple + "× more" : "")
                 : "Could not be priced" + (rt.error ? ": " + rt.error : ""),
      rt.koinOut ? (rt.isBest ? "kn-ok" : "") : "kn-bad"
    ));
    if (!rt.koinOut) return card;
    var go = button("Use route " + rt.id, rt.isBest ? "primary small" : "small", function () {
      if (!window.confirm("Send " + amt.value + " ETH through route " + rt.id + "?\n\nThis spends real funds, runs several steps on its own, and takes a few minutes. Leave Koinos AI open.")) return;
      act(go, out, function () {
        var body = { amountEth: amt.value.trim(), password: pw.value };
        if (rt.id === "C") body.source = "eth";
        return rpc(rt.id === "C" ? "fund:routeCStart" : "fund:bridgeStart", body)
          .then(function () { pw.value = ""; fundQuote = null; return "Route " + rt.id + " started — progress shows below."; });
      });
    });
    card.appendChild(row(go));
    return card;
  }

  // ---------------- burn ----------------
  function renderBurn(body) {
    body.appendChild(h("Burn KOIN → VHP"));
    body.appendChild(note("Block production runs on VHP. Burning converts your KOIN into VHP at your own address — it stays yours, and turns back into KOIN as your node produces blocks. It spends mana, which refills over about five days."));
    return rpc("chain:maxBurn").catch(function () { return null; }).then(function (m) {
      var amt = input("kn-burn-amt", "Amount in KOIN");
      if (m) {
        body.appendChild(note(
          "Most you can burn right now: " + m.maxFormatted + " KOIN" +
          (m.manaLimited ? " — limited by mana (" + m.manaFormatted + " available), not by your balance." : ".")
        ));
        var max = button("Use max", "small", function () { amt.value = m.maxFormatted; });
      }
      var out = note("");
      var go = button("Burn", "primary small", function () {
        if (!window.confirm("Burn " + (amt.value || "0") + " KOIN into VHP at your own address?\n\nThe value stays yours. It cannot be undone directly.")) return;
        act(go, out, function () {
          return rpc("chain:burn", { amount: amt.value.trim() }).then(function (r) {
            amt.value = "";
            return "Burned " + r.amountFormatted + " KOIN. Transaction " + String(r.txId || "").slice(0, 18) + "…";
          });
        });
      });
      body.appendChild(row(amt, max, go));
      body.appendChild(out);
    });
  }

  // ---------------- node ----------------
  function renderNode(body) {
    return Promise.all([
      rpc("node:status"),
      rpc("setup:status").catch(function () { return null; }),
      rpc("producer:status").catch(function () { return null; }),
    ]).then(function (r) {
      var n = r[0], setup = r[1] || n.setup, prod = r[2];
      body.appendChild(h("Node"));
      body.appendChild(grid(
        stat("Docker", setup && setup.docker ? (setup.docker.running ? "Running" : setup.docker.installed ? "Installed, not running" : "Not installed") : (n.docker && n.docker.ok ? "Running" : "Not ready")),
        stat("Node", n.isRunning ? "Running · " + n.runningCount + " services" : "Stopped"),
        stat("Auto-restart", n.autoRecover ? "On" : "Off")
      ));

      var out = note("");

      // The guided setup: the node's own plan, one click per step. Each step
      // carries the channel that performs it, so nothing is hard-coded here.
      if (setup && setup.steps && !setup.ready) {
        body.appendChild(h("Set this up"));
        body.appendChild(note("One click per step. No terminal, nothing to download by hand."));
        setup.steps.forEach(function (s) {
          var card = el("div", "kn-step kn-step-" + s.status);
          card.appendChild(el("b", null, s.title));
          card.appendChild(note(s.detail));
          var acts = [];
          [s.action, s.altAction].forEach(function (a, i) {
            if (!a) return;
            var b = button(a.label, i === 0 ? "primary small" : "small", function () {
              act(b, out, function () { return rpc(a.channel).then(function () { return a.label + " — started."; }); });
            });
            b.disabled = s.status === "pending" || s.status === "done";
            acts.push(b);
          });
          if (acts.length) card.appendChild(row.apply(null, acts));
          body.appendChild(card);
        });
        if (setup.op) body.appendChild(note(setup.op.label || setup.op.kind || "Working…"));
      } else {
        var startBtn = button(n.isRunning ? "Stop node" : "Start node", "primary small", function () {
          act(startBtn, out, function () {
            return rpc(n.isRunning ? "node:stop" : "node:start", { produce: true })
              .then(function () { return n.isRunning ? "Node stopping." : "Node starting — the first run takes a few minutes."; });
          });
        });
        var qs = button("Quick sync", "small", function () {
          if (!window.confirm("Download a recent chain snapshot instead of syncing from the beginning?\n\nThis replaces local chain data and takes a while.")) return;
          act(qs, out, function () { return rpc("node:quickSync").then(function () { return "Quick sync started."; }); });
        });
        body.appendChild(row(startBtn, qs));
      }
      body.appendChild(out);

      if (n.op) body.appendChild(note((n.op.label || n.op.kind || "Working") + (n.op.pct != null ? " — " + pct(n.op.pct) : "")));
      if (n.health && !n.health.ok) body.appendChild(note("Node health: " + (n.health.reason || "needs attention"), "kn-bad"));

      body.appendChild(h("Block production key"));
      var out2 = note("");
      if (prod && prod.registeredPublicKey && prod.matches) {
        body.appendChild(note("Registered — this address is set up to produce blocks.", "kn-ok"));
      } else if (prod && prod.filePublicKey) {
        body.appendChild(note(prod.registeredPublicKey
          ? "Your node's key does not match the one registered on chain. Register the new one."
          : "Your node created a key. Register it so the chain knows it produces for your address."));
        var reg = button("Register this key", "primary small", function () {
          act(reg, out2, function () { return rpc("producer:register").then(function () { return "Registered."; }); });
        });
        body.appendChild(row(reg));
      } else {
        body.appendChild(note("Start the node once and it will create its key here."));
      }
      body.appendChild(out2);

      if (!n.isRunning) return;
      return rpc("node:logs", { tail: 60 }).catch(function () { return null; }).then(function (logs) {
        var text = typeof logs === "string" ? logs : logs && (logs.text || (logs.lines || []).join("\n"));
        if (text) {
          body.appendChild(h("Recent log"));
          body.appendChild(el("pre", "kn-log", text));
        }
      });
    });
  }

  // ---------------- returns ----------------
  function renderReturns(body) {
    return rpc("rewards:status").then(function (r) {
      var c = r.config || {};
      body.appendChild(h("Reward returns"));
      body.appendChild(note("As your node produces blocks it earns KOIN. This puts a share of it straight back into VHP so the node keeps growing. It runs on its own and never asks for your password, because nothing leaves your wallet."));
      body.appendChild(grid(
        stat("Automatic", c.enabled ? "On" : "Off"),
        stat("Share returned", (c.pct != null ? c.pct : "—") + "%"),
        stat("Next run", r.nextRunAt ? new Date(r.nextRunAt).toLocaleString() : "—")
      ));
      if (r.derived) {
        body.appendChild(grid(
          stat("Earned since turned on", fmt(r.derived.rewardsSinceEnable) + " KOIN"),
          stat("Put back so far", fmt(r.derived.returned) + " KOIN"),
          stat("Waiting to go back", fmt(r.derived.pending) + " KOIN")
        ));
      }

      var pctIn = input("kn-ret-pct", "Percent to return, e.g. 50");
      pctIn.value = c.pct != null ? String(c.pct) : "";
      var out = note("");
      var save = button(c.enabled ? "Turn off" : "Turn on", "primary small", function () {
        act(save, out, function () {
          return rpc("rewards:configure", { enabled: !c.enabled, pct: Number(pctIn.value) || c.pct || 50, mode: c.mode || "burn" })
            .then(function () { return c.enabled ? "Automatic returns off." : "Automatic returns on."; });
        });
      });
      var now = button("Run once now", "small", function () {
        act(now, out, function () {
          return rpc("rewards:runNow").then(function (s) { return "Ran — " + ((s.last && s.last.outcome) || "done") + "."; });
        });
      });
      body.appendChild(row(pctIn, save, now));
      body.appendChild(out);
      if (r.last) body.appendChild(note("Last run: " + r.last.outcome + " · " + new Date(r.last.time).toLocaleString()));
    });
  }

  // ---------------- settings ----------------
  function renderSettings(body) {
    return rpc("app:info").then(function (info) {
      var s = info.settings || {};
      var net = s.network || "mainnet";
      body.appendChild(h("Node settings"));
      body.appendChild(grid(
        stat("Network", net),
        stat("Data folder", info.userData),
        stat("Node software", info.version)
      ));

      var out = note("");
      var rpcUrl = input("kn-set-rpc", "Custom RPC URL (optional)");
      rpcUrl.value = s["customRpc." + net] || "";
      var save = button("Save", "primary small", function () {
        act(save, out, function () {
          var patch = { customRpc: {} };
          patch.customRpc[net] = rpcUrl.value.trim();
          return rpc("settings:update", patch).then(function () { return "Saved."; });
        });
      });
      body.appendChild(row(rpcUrl, save));
      body.appendChild(note("Leave this blank to use the public Koinos endpoint. Point it at your own node once it is synced."));

      var keep = input("kn-set-keep", "KOIN to keep liquid, e.g. 10");
      keep.value = s.keepLiquidKoin != null ? String(s.keepLiquidKoin) : "";
      var saveKeep = button("Save", "small", function () {
        act(saveKeep, out, function () {
          return rpc("settings:update", { keepLiquidKoin: keep.value.trim() }).then(function () { return "Saved."; });
        });
      });
      body.appendChild(h("Keep some KOIN liquid"));
      body.appendChild(note("Burning and automatic returns leave this much KOIN alone, so there is always some on hand for fees."));
      body.appendChild(row(keep, saveKeep));

      var on = s["node.autoRecover"] !== false;
      var auto = button(on ? "Turn auto-restart off" : "Turn auto-restart on", "small", function () {
        act(auto, out, function () {
          return rpc("node:setAutoRecover", { on: !on }).then(function () { return "Saved."; });
        });
      });
      body.appendChild(h("Auto-restart"));
      body.appendChild(note("Brings the node back if it stops unexpectedly."));
      body.appendChild(row(auto));
      body.appendChild(out);
    });
  }

  var RENDER = {
    "koinos": renderDashboard,
    "koinos-wallet": renderWallet,
    "koinos-fund": renderFund,
    "koinos-burn": renderBurn,
    "koinos-node": renderNode,
    "koinos-returns": renderReturns,
    "koinos-settings": renderSettings,
  };

  function currentView() {
    for (var i = 0; i < VIEWS.length; i++) {
      var v = $("view-" + VIEWS[i]);
      if (v && !v.hidden) return VIEWS[i];
    }
    return null;
  }

  function refresh() {
    var v = currentView();
    if (!v || busy) return Promise.resolve();
    var body = $(v + "-body");
    if (!body) return Promise.resolve();
    // Never redraw under someone's fingers — a poll that eats a half-typed
    // password or address is worse than a stale number.
    var a = document.activeElement;
    if (a && body.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return Promise.resolve();
    // Whatever is half-typed survives the redraw. Without this, pricing a route
    // or a ten-second poll empties the password box the person just filled in
    // and the next click silently sends a blank one.
    var typed = {};
    body.querySelectorAll("input[id]").forEach(function (i) { if (i.value) typed[i.id] = i.value; });

    var fresh = document.createElement("div");
    return Promise.resolve()
      .then(function () { return RENDER[v](fresh); })
      .then(function () {
        if (flash && flash.view !== v) flash = null; // it belonged to the screen they left
        if (flash) fresh.appendChild(note(flash.text, flash.cls));
        fresh.querySelectorAll("input[id]").forEach(function (i) {
          if (!i.value && typed[i.id] != null) i.value = typed[i.id];
        });
        body.replaceChildren.apply(body, Array.prototype.slice.call(fresh.childNodes));
      })
      .catch(function (e) { body.replaceChildren(note(String(e.message || e), "kn-bad")); });
  }

  window.KaiKoinosNode = { refresh: refresh, views: VIEWS };
})();
