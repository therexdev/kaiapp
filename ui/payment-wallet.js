"use strict";
(() => {
  const $ = id => document.getElementById(id), page = $("view-payment-wallet");
  if (!page) return;
  const controls = $("product-wallet-controls"), ready = $("earn-ready");
  const address = $("wallet-address"), copy = $("btn-wallet-copy"), refreshButton = $("btn-wallet-balances");
  const balances = $("wallet-balances"), lock = $("btn-earn-lock"), reveal = $("btn-earn-reveal"), revealRow = $("earn-reveal-row");
  const tokenRow = $("wallet-send-token").closest(".form-row"), sendRow = $("wallet-send-pass").closest(".form-row"), message = $("wallet-msg");
  controls.classList.remove("product-panel"); controls.querySelector(":scope > .product-fine")?.remove();
  page.querySelector(".product-head h1").textContent = "Wallet";
  page.querySelector(".product-head p").textContent = "Your Koinos wallet for AI payments and rewards.";
  page.querySelector('.product-head [data-product-view="buy-credits"]')?.remove();
  const actions = document.createElement("div"); actions.className = "payment-wallet-actions";
  const send = document.createElement("button"); send.id = "payment-wallet-open-send"; send.type = "button"; send.textContent = "Send"; send.disabled = true;
  lock.className = ""; lock.textContent = "Lock"; lock.hidden = true; actions.append(send, lock); page.querySelector(".product-head").append(actions);
  const account = document.createElement("section"); account.id = "payment-wallet-account"; account.hidden = true;
  account.innerHTML = '<section class="payment-wallet-card"><div class="payment-wallet-row"><div><h2>Your address</h2><p id="payment-wallet-network" class="hint">Share this address to receive KOIN or VHP.</p></div><span id="payment-wallet-lock-state" class="payment-wallet-badge"></span></div><div id="payment-wallet-receive" class="payment-wallet-row"></div><p id="payment-wallet-address-note" class="hint" role="status"></p></section><div id="payment-wallet-metrics"></div><p id="payment-wallet-balance-note" class="hint" role="status"></p><section class="payment-wallet-card payment-wallet-history"><div class="payment-wallet-row"><h2>Transaction history</h2><button id="payment-wallet-history-refresh" type="button" hidden>Try again</button></div><p id="payment-wallet-history-status" class="hint" role="status">Loading transaction history…</p><div class="payment-wallet-table"><table><thead><tr><th>Activity</th><th>Amount</th><th>When</th><th>Status</th></tr></thead><tbody id="payment-wallet-history-rows"></tbody></table></div><button id="payment-wallet-history-more" type="button" hidden>Load older transactions</button></section>';
  ready.before(account);
  copy.textContent = "Copy"; refreshButton.hidden = true;
  const explorer = document.createElement("a"); explorer.id = "payment-wallet-explorer"; explorer.textContent = "Explorer ↗"; explorer.target = "_blank"; explorer.rel = "noopener noreferrer"; explorer.hidden = true;
  $("payment-wallet-receive").append(address, copy, explorer);
  balances.className = "payment-wallet-stats";
  balances.innerHTML = '<div class="payment-wallet-stat"><div class="label" id="payment-wallet-koin-label">KOIN (liquid)</div><div class="value" id="payment-wallet-koin">—</div><div class="sub">Spendable KOIN · fuels Mana</div></div><div class="payment-wallet-stat"><div class="label">VHP</div><div class="value" id="payment-wallet-vhp">—</div><div class="sub">Virtual hash power for block production</div></div><div class="payment-wallet-stat"><div class="label">Mana</div><div class="value" id="payment-wallet-mana">—</div><div class="sub">Recharges over time · used by transactions</div></div>';
  $("payment-wallet-metrics").append(balances); $("payment-wallet-balance-note").after(refreshButton);
  const sendPanel = document.createElement("details"); sendPanel.id = "payment-wallet-send-panel"; sendPanel.className = "payment-wallet-card";
  sendPanel.innerHTML = '<summary>Send KOIN or VHP</summary><p class="hint">Enter the recipient, amount and your wallet password. Review the exact transfer before confirming.</p>';
  sendPanel.append(tokenRow, sendRow, message);
  const backup = document.createElement("section"); backup.className = "payment-wallet-card payment-wallet-backup";
  backup.innerHTML = '<h2>Wallet backup</h2><p class="hint">Your private key controls this wallet. Your password is required to display it.</p>';
  reveal.textContent = "Show backup code"; reveal.className = ""; backup.append(reveal, revealRow);
  ready.replaceChildren(sendPanel, backup);
  $("earn-setup").classList.add("payment-wallet-card"); $("earn-unlock").classList.add("payment-wallet-card");
  $("earn-setup").querySelector("h2").textContent = "Create a wallet";
  $("earn-unlock").querySelector("h2").textContent = "Unlock your wallet";
  $("earn-unlock-hint").insertAdjacentHTML("afterend", '<p class="hint">You can view balances and history while locked. Unlock to send or back up your wallet.</p>');
  const source = $("earn-setup").querySelector(":scope > .hint"); if (source) source.textContent = "Your private key is generated locally and encrypted with your password on this computer.";
  // First-time import refuses to replace an existing wallet. Recovery of an
  // existing wallet keeps its separate, explicit password-restore flow.
  const importButton = document.createElement("button"); importButton.type = "button"; importButton.textContent = "Import an existing wallet"; importButton.id = "payment-wallet-import";
  const importPanel = document.createElement("div"); importPanel.id = "payment-wallet-import-panel"; importPanel.hidden = true;
  importPanel.innerHTML = '<h2>Import an existing wallet</h2><label>Private key (WIF)<input id="payment-wallet-import-key" type="password" autocomplete="off" spellcheck="false" /></label><label>Password for this computer<input id="payment-wallet-import-pass" type="password" autocomplete="new-password" /></label><label>Confirm password<input id="payment-wallet-import-confirm" type="password" autocomplete="new-password" /></label><button id="payment-wallet-import-go" type="button">Import wallet</button><p id="payment-wallet-import-error" class="hint" role="status"></p>';
  $("earn-setup").append(importButton, importPanel);
  importButton.addEventListener("click", () => { importPanel.hidden = !importPanel.hidden; if (!importPanel.hidden) $("payment-wallet-import-key").focus(); });
  $("payment-wallet-import-go").addEventListener("click", async () => {
    const button = $("payment-wallet-import-go"), notice = $("payment-wallet-import-error");
    if (button.disabled) return;
    if ($("payment-wallet-import-pass").value !== $("payment-wallet-import-confirm").value) { notice.textContent = "Passwords do not match."; return; }
    const viewEpoch = window.KaiWalletPrivacy.version;
    button.disabled = true; notice.textContent = "Importing wallet…";
    try {
      await walletRpc("wallet:import", { wif: $("payment-wallet-import-key").value.trim(), password: $("payment-wallet-import-pass").value });
      if (viewEpoch !== window.KaiWalletPrivacy.version) return;
      for (const id of ["key", "pass", "confirm"]) $("payment-wallet-import-" + id).value = "";
      importPanel.hidden = true; notice.textContent = ""; renderEarn(); refreshSidebarWallet();
    } catch (error) { if (viewEpoch === window.KaiWalletPrivacy.version) notice.textContent = String(error.message || "Wallet import failed").slice(0, 240); }
    finally { button.disabled = false; }
  });

  let wallet = null, context = null, rows = [], cursor = null, pending = null, generation = 0, timer = null, historyObserved = null, historyExpanded = false, refreshProblem = false;
  const visible = () => !page.hidden && !document.hidden;
  const addressPattern = /^[1-9A-HJ-NP-Za-km-z]{25,40}$/;
  const hashPattern = /^0x1220[a-f0-9]{64}$/;
  const decimalPattern = /^(0|[1-9]\d*)(\.\d{1,8})?$/;
  const atomPattern = /^(0|[1-9]\d{0,19})$/;
  const errorText = error => String(error?.message || error || "Wallet data is unavailable").slice(0, 240);
  const amount = value => {
    if (typeof value !== "string" || !decimalPattern.test(value)) return "—";
    const [whole, fraction = ""] = value.split("."), tail = fraction.replace(/0+$/, "");
    return BigInt(whole).toLocaleString() + (tail ? new Intl.NumberFormat().formatToParts(1.1).find(p => p.type === "decimal").value + tail : "");
  };
  const atoms = value => { const n = BigInt(value); return amount(`${n / 100000000n}.${(n % 100000000n).toString().padStart(8, "0")}`); };
  const identity = value => value ? `${value.address}|${value.network}` : "";
  const same = value => context && identity(value) === identity(context) && wallet?.address === value.address;
  const fresh = () => context && Number.isSafeInteger(context.observedAt) && Date.now() - context.observedAt < 60000;
  function paintActions() {
    lock.hidden = !wallet?.unlocked; send.disabled = !wallet?.unlocked || !fresh() || !$("earn-wif").hidden;
    $("payment-wallet-lock-state").textContent = wallet?.unlocked ? "Unlocked" : "Locked";
    const retry = $("payment-wallet-history-refresh");
    retry.hidden = !refreshProblem && !historyExpanded; retry.disabled = !!pending;
    retry.textContent = refreshProblem ? "Try again" : "Back to latest";
    $("payment-wallet-history-more").disabled = !!pending;
  }
  function clear(resetSecrets = true) {
    context = null; rows = []; cursor = null; historyObserved = null; historyExpanded = false; refreshProblem = false;
    for (const id of ["koin", "vhp", "mana"]) $("payment-wallet-" + id).textContent = "—";
    $("payment-wallet-history-rows").replaceChildren(); $("payment-wallet-history-more").hidden = true;
    $("payment-wallet-balance-note").textContent = "Checking balances…";
    $("payment-wallet-history-status").textContent = "Loading transaction history…";
    explorer.hidden = true; explorer.removeAttribute("href");
    if (resetSecrets) window.KaiWalletPrivacy?.reset();
  }
  function stop() { generation++; pending?.controller.abort(); pending = null; clearTimeout(timer); paintActions(); }
  function observe(value) {
    const next = { exists: value?.exists === true, unlocked: value?.unlocked === true, address: value?.address || null };
    const changed = !wallet || wallet.address !== next.address;
    if (changed) { stop(); clear(!!wallet?.address); }
    if (wallet?.unlocked && !next.unlocked) window.KaiWalletPrivacy?.reset();
    wallet = next; account.hidden = !next.address; address.value = next.address || "";
    if (!next.address) $("payment-wallet-address-note").textContent = "";
    paintActions();
    if (visible() && next.address && (changed || !context && !pending)) refresh();
  }
  async function read(channel, payload, signal) {
    const response = await fetch("/core/koinos/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel, payload: payload || {} }), signal });
    const result = await response.json(); signal.throwIfAborted();
    if (!response.ok || !result.ok) throw Error(result.error || "Wallet data is unavailable");
    return result.data;
  }
  function paintHistory() {
    const host = $("payment-wallet-history-rows"), existing = new Map([...host.children].map(row => [row.dataset.key, row])), next = [];
    const focused = document.activeElement?.closest("tr")?.dataset.key, focusedLink = document.activeElement?.getAttribute("href");
    for (const entry of rows) {
      const key = entry.kind + ":" + entry.id, signature = JSON.stringify(entry);
      const previous = existing.get(key);
      if (previous?.dataset.signature === signature) { next.push(previous); continue; }
      const tr = document.createElement("tr"), activity = document.createElement("td"), value = document.createElement("td"), when = document.createElement("td"), status = document.createElement("td");
      const title = document.createElement("strong"); title.textContent = entry.label; activity.append(title);
      const ref = document.createElement("small"); ref.textContent = entry.kind === "block" ? "Block " + (entry.height || "") : entry.id;
      if (context.network === "mainnet" && entry.kind === "transaction" && hashPattern.test(entry.id)) {
        const link = document.createElement("a"); link.href = "https://koinosblocks.com/tx/" + entry.id; link.target = "_blank"; link.rel = "noopener noreferrer"; link.append(ref); activity.append(link);
      } else activity.append(ref);
      if (entry.counterparty) { const counterparty = document.createElement("small"); counterparty.textContent = entry.counterparty; activity.append(counterparty); }
      for (const change of entry.changes) { const changeLine = document.createElement("div"); changeLine.textContent = `${change.direction === "in" ? "+" : "−"}${atoms(change.amount)} ${change.asset}`; changeLine.className = "payment-wallet-" + change.direction; value.append(changeLine); }
      if (!entry.changes.length) value.textContent = "—";
      when.textContent = entry.timestamp == null ? "Time unavailable" : new Date(entry.timestamp).toLocaleString();
      status.textContent = ({ confirmed: "Confirmed", confirming: "Confirming", failed: "Failed" })[entry.status]; status.dataset.status = entry.status;
      tr.dataset.key = key; tr.dataset.signature = signature;
      tr.append(activity, value, when, status); next.push(tr);
    }
    const retained = new Set(next);
    for (const row of [...host.children]) if (!retained.has(row)) row.remove();
    next.forEach((row, index) => { if (host.children[index] !== row) host.insertBefore(row, host.children[index] || null); });
    if (focused && focusedLink && document.activeElement === document.body) {
      const row = next.find(row => row.dataset.key === focused);
      [...(row?.querySelectorAll("a") || [])].find(link => link.getAttribute("href") === focusedLink)?.focus({ preventScroll: true });
    }
    $("payment-wallet-history-more").hidden = !cursor;
  }
  function checkedHistory(result) {
    if (!same(result)) { clear(); throw Error("The wallet or network changed. Refresh to load its history."); }
    if (result.available !== true || !Array.isArray(result.rows) || result.rows.length > 50 || !Number.isSafeInteger(result.observedAt) || result.observedAt > Date.now() + 5000 || result.observedAt < Date.now() - 60000 || result.nextCursor != null && (typeof result.nextCursor !== "string" || result.nextCursor.length > 4096)) throw Error("Wallet history did not match the current account and network.");
    for (const row of result.rows) {
      if (!row || !["transaction", "block"].includes(row.kind) || !hashPattern.test(row.id) || typeof row.label !== "string" || row.label.length > 180 || !["confirmed", "confirming", "failed"].includes(row.status) || row.timestamp !== null && (!Number.isSafeInteger(row.timestamp) || row.timestamp < 0 || row.timestamp > Date.now() + 300000) || row.height !== null && !/^(0|[1-9]\d{0,19})$/.test(row.height) || row.counterparty !== null && (typeof row.counterparty !== "string" || row.counterparty.length > 120) || !Array.isArray(row.changes) || row.changes.length > 1024) throw Error("Wallet history contained an invalid transaction.");
      for (const change of row.changes) if (!change || ![context.tokenSymbol, "VHP"].includes(change.asset) || !["in", "out"].includes(change.direction) || typeof change.amount !== "string" || !atomPattern.test(change.amount) || BigInt(change.amount) > 18446744073709551615n) throw Error("Wallet history contained an invalid amount.");
    }
    return result;
  }
  async function refresh(older = false, automatic = false) {
    if (!visible() || !wallet?.address) return;
    if (pending) return pending.promise;
    const version = ++generation, expectedAddress = wallet.address, controller = new AbortController();
    const task = pending = { controller, promise: null }, deadline = setTimeout(() => controller.abort(Error("Wallet update timed out. Updates retry automatically.")), 20000);
    clearTimeout(timer); paintActions();
    if (older || !historyObserved) $("payment-wallet-history-status").textContent = older ? "Loading older transactions…" : "Loading transaction history…";
    const valid = () => version === generation && wallet?.address === expectedAddress && visible();
    task.promise = (async () => {
      try {
        if (!older) {
          const result = await read("wallet:summary", {}, controller.signal); if (!valid()) return;
          if (result.address !== expectedAddress) { clear(); throw Error("The wallet changed. Refresh to load its balances."); }
          if (!["mainnet", "harbinger"].includes(result.network) || result.tokenSymbol !== (result.network === "mainnet" ? "KOIN" : "tKOIN") || !Number.isSafeInteger(result.observedAt) || result.observedAt > Date.now() + 5000 || result.observedAt < Date.now() - 60000) throw Error("Wallet balance did not match the current account and network.");
          if (context && identity(context) !== identity(result)) clear();
          context = result;
          $("payment-wallet-koin-label").textContent = result.tokenSymbol + " (liquid)";
          for (const name of ["koin", "vhp", "mana"]) $("payment-wallet-" + name).textContent = amount(result[name]);
          $("payment-wallet-network").textContent = `${result.network === "mainnet" ? "Mainnet" : "Harbinger testnet"} · Share this address to receive ${result.tokenSymbol} or VHP.`;
          $("payment-wallet-balance-note").textContent = "Balances checked " + new Date(result.observedAt).toLocaleTimeString() + ". Mana is a resource balance, not a separate token.";
          explorer.hidden = result.network !== "mainnet" || !addressPattern.test(result.address);
          if (!explorer.hidden) explorer.href = "https://koinosblocks.com/address/" + result.address; else explorer.removeAttribute("href");
          paintActions();
        }
        if (automatic && historyExpanded) return; // Keep older history and any history error until Back to latest or a new visit.
        const result = await read("wallet:history", older ? { cursor } : {}, controller.signal); if (!valid()) return;
        const history = checkedHistory(result);
        rows = older ? [...new Map([...rows, ...history.rows].map(row => [row.kind + ":" + row.id, row])).values()] : history.rows;
        cursor = history.nextCursor; historyObserved = history.observedAt; historyExpanded = older; refreshProblem = false; paintHistory();
        $("payment-wallet-history-status").textContent = rows.length ? "On-chain activity · checked " + new Date(historyObserved).toLocaleTimeString() + ". Confirming transactions can still change." : cursor ? "No transfers in this page. Load older transactions to continue." : "No transactions were found for this wallet on this network.";
      } catch (error) {
        if (!valid()) return;
        refreshProblem = true;
        const note = errorText(controller.signal.aborted ? controller.signal.reason : error);
        if (!context || !fresh()) $("payment-wallet-balance-note").textContent = "Balances unavailable. " + note;
        $("payment-wallet-history-status").textContent = (rows.length ? "Could not refresh. Showing previously loaded history" + (historyObserved ? " from " + new Date(historyObserved).toLocaleTimeString() : "") + ". " : "Transaction history unavailable. ") + note;
      } finally {
        clearTimeout(deadline); if (pending === task) pending = null; paintActions();
        if (valid()) timer = setTimeout(() => refresh(false, true), 30000);
      }
    })();
    return task.promise;
  }
  send.addEventListener("click", () => { if (send.disabled) return; sendPanel.open = true; sendPanel.scrollIntoView({ block: "nearest", behavior: "smooth" }); $("wallet-send-to").focus({ preventScroll: true }); });
  sendPanel.addEventListener("toggle", () => { if (!sendPanel.open) window.KaiWalletPrivacy?.reset(); });
  lock.addEventListener("click", () => { window.KaiWalletPrivacy?.reset(); });
  $("payment-wallet-history-refresh").addEventListener("click", () => refresh());
  $("payment-wallet-history-more").addEventListener("click", () => { if (cursor) refresh(true); });
  let wasVisible = visible();
  function visibility() {
    const nowVisible = visible(), changed = nowVisible !== wasVisible;
    wasVisible = nowVisible;
    if (!changed) return;
    if (nowVisible) { if (wallet?.address) refresh(); }
    else { stop(); sendPanel.open = false; importPanel.hidden = true; window.KaiWalletPrivacy?.reset(); }
  }
  new MutationObserver(visibility).observe(page, { attributes: true, attributeFilter: ["hidden"] });
  document.addEventListener("visibilitychange", visibility);
  window.KaiPaymentWallet = { observe, refresh, context: () => wallet?.unlocked && fresh() ? { address: context.address, network: context.network, tokenSymbol: context.tokenSymbol } : null };
})();
