"use strict";
(() => {
  const bridge = window.kaiKoinTestBridge, section = document.getElementById("koin-test-payments");
  if (!bridge || !section) return;
  const el = id => document.getElementById(id);
  const status = el("koin-test-payment-status"), select = el("koin-test-transaction");
  const buttons = [...section.querySelectorAll("[data-koin-test]")];
  let busy = false, configured = false, mainnet = false, hasSession = false, providing = false, activated = false;
  let transactions = [];
  const amount = value => {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return "—";
    const n = BigInt(value); return `${n / 100000000n}.${(n % 100000000n).toString().padStart(8, "0")}`;
  };
  const words = value => String(value || "").replaceAll("_", " ");
  const creditName = action => ({ release: "Release reserved credits", reserve: "Reserve credits", refund: "Refund credits", revoke: "Revoke session" })[action];
  const unit = () => mainnet ? "mainnet KOIN" : "test KOIN";
  const funded = tx => tx?.funding?.state === "funded";
  function activityDetails() {
    const tx = transactions.find(item => item.id === select.value), correction = tx?.correction;
    const detail = el("koin-mana-correction");
    detail.hidden = !correction;
    detail.textContent = correction
      ? `Mana correction · ${funded(tx) ? "deposit confirmed" : words(correction.state)}${correction.rcLimit ? " · Limit: " + amount(correction.rcLimit) + " Mana (not a KOIN fee)" : ""}${correction.txId ? " · Transaction: " + correction.txId : ""}`
      : "";
  }
  function message(text, error = false) { status.textContent = text; status.dataset.error = String(error); if (el("network-chat-status")) el("network-chat-status").textContent = text; }
  function activate() {
    section.hidden = false;
    if (activated) return;
    activated = true;
    el("koin-purchase-placeholder").hidden = true;
    for (const id of ["koin-shadow-overview", "koin-review-preview", "koin-session-rehearsal"]) {
      if (el(id)) el("koin-developer-content").appendChild(el(id));
    }
  }
  function controls() {
    const selected = transactions.find(item => item.id === select.value);
    for (const button of buttons) {
      const action = button.dataset.koinTest;
      button.disabled = action === "worker-stop" ? !providing : action === "stop" ? !busy : busy ||
        (!configured && !["status", "import", "restore"].includes(action)) ||
        (configured && action === "import") ||
        (!hasSession && ["session-review", "session-status", "session-revoke", "session-retry", "chat", "chat-retry", "chat-status"].includes(action)) ||
        (!select.value && ["check", "resume", "correct-mana", "recover", "repair"].includes(action)) ||
        (action === "correct-mana" && (!mainnet || selected?.purpose !== "funding" || funded(selected) || ["finalized", "reverted", "consumed_elsewhere"].includes(selected?.state)));
      if (action === "stop") button.hidden = !busy;
      if (action === "worker-start") button.hidden = providing;
      if (action === "worker-stop") button.hidden = !providing;
      if (action === "correct-mana") button.hidden = !mainnet;
    }
    section.setAttribute("aria-busy", String(busy));
    el("network-add-koin").disabled = busy || !configured;
    el("koin-open-chat").disabled = busy || !configured;
    activityDetails();
  }
  let providerPending = false, providerExpiry;
  function paintProvider(result) {
    clearTimeout(providerExpiry);
    const node = el("koin-provider-state"); node.textContent = result.label; node.dataset.state = result.state;
    el("koin-provider-detail").textContent = result.detail;
    if (result.state === "online") providerExpiry = setTimeout(() => paintProvider({ state: "checking", label: "CHECKING CONNECTION", detail: "Refreshing network confirmation…" }), Math.max(0, Math.min(15000, result.validUntil - Date.now())));
  }
  async function refreshProvider() {
    if (providerPending || !configured || document.hidden) return;
    providerPending = true;
    try { paintProvider(await bridge.run("provider-status")); }
    catch { paintProvider({ state: "reconnecting", label: "CONNECTION UNCONFIRMED", detail: "The network could not confirm this computer's eligibility. Check your invitation, wallet and online access, then retry." }); }
    finally { providerPending = false; }
  }
  function snapshot(result) {
    if (result?.enabled === false) { section.hidden = true; return; }
    if (!["test-deployment", "mainnet-pilot"].includes(result?.mode)) return;
    activate();
    if (result.configured === false) {
      configured = false; hasSession = false;
      el("koin-network-badge").textContent = "Not connected";
      el("koin-network-badge").dataset.network = "";
      el("koin-test-network-notice").textContent = "Connect a verified network to see its currency and spending limits.";
      el("koin-connection").open = true;
      el("koin-available").textContent = el("koin-reserved").textContent = "—";
      message("Connect your network account to get started.");
      return;
    }
    // A mode default is not evidence of a connected chain.
    if (result.configured !== true && !result.balances) return;
    configured = true; mainnet = result.mode === "mainnet-pilot";
    // A configured pilot has one provider control, rather than competing
    // legacy and paid workers sharing the same local runtime.
    el("btn-earn-toggle")?.closest(".form-row")?.setAttribute("hidden", "");
    el("earn-dot")?.closest(".earn-status")?.setAttribute("hidden", "");
    const badge = el("koin-network-badge");
    badge.textContent = mainnet ? "Mainnet · real KOIN" : "Testnet · test KOIN";
    badge.dataset.network = mainnet ? "mainnet" : "testnet";
    el("koin-test-network-notice").textContent = mainnet
      ? "Payments use REAL KOIN on mainnet. Review the amount and spending limits in each approval."
      : "Foundation testnet connection. Payments and rewards use test KOIN.";
    el("koin-test-amount-label").textContent = mainnet ? "Amount in KOIN" : "Amount in test KOIN";
    section.querySelectorAll(".koin-currency").forEach(node => { node.textContent = unit(); });
    el("koin-connection-state").textContent = result.accessReady ? "Connected" : "Network verified · invitation required";
    el("koin-connection-help").textContent = result.accessReady
      ? "Your network and invitation are configured for this wallet. Every payment still requires its own approval."
      : "Add your private invitation and allow online access in Privacy settings to use this connection.";
    el("koin-connection").open = !result.accessReady;
    if (result.owner) el("koin-connected-wallet").textContent = "Wallet · " + result.owner;
    if (result.balances) {
      el("koin-available").textContent = amount(result.balances.available);
      el("koin-reserved").textContent = amount(result.balances.reserved);
      el("network-chat-balance").textContent = `${amount(result.balances.available)} KOIN available · ${amount(result.balances.reserved)} reserved`;
    }
    if (Array.isArray(result.transactions)) {
      const deposits = new Map((result.deposits || []).map(deposit => [deposit.id, deposit]));
      transactions = result.transactions.map(tx => ({ ...tx, funding: deposits.get(tx.id) || tx.funding }));
      const selected = select.value; select.replaceChildren();
      for (const tx of transactions) {
        const option = document.createElement("option"); option.value = tx.id;
        option.textContent = `${creditName(tx.creditAction) || words(tx.purpose)} · ${funded(tx) ? "deposit confirmed" : words(tx.state)} · ${funded(tx) && tx.correction?.state === "finalized" ? tx.correction.txId : tx.txId || tx.id}`; select.appendChild(option);
      }
      if ([...select.options].some(option => option.value === selected)) select.value = selected;
      if (!select.options.length) { const option = document.createElement("option"); option.value = ""; option.textContent = "No payment transactions yet"; select.appendChild(option); }
      el("koin-activity-count").textContent = result.transactions.length ? `${result.transactions.length} saved` : "No transactions yet";
    }
    if (Object.hasOwn(result, "session")) {
      hasSession = !!result.session;
      if (result.session) {
        const s = result.session;
        el("koin-test-session-id").value = s.session;
        el("koin-spending-summary").textContent = `Reserved budget: ${amount(s.amount)} ${unit()}. Per request: ${amount(s.perJob)}. Review limits before sending.`;
        el("koin-model-label").textContent = s.model || "Approved network model";
      } else {
        el("koin-spending-summary").textContent = "Your first message prepares a spending allowance and asks you to approve its limits.";
        el("koin-model-label").textContent = "The normal chat uses your approved network model.";
      }
    }
    if (Object.hasOwn(result, "worker")) providing = !!result.worker?.running;
    if (result.paused) message("New spending is paused by the network. Existing payment recovery remains available.");
  }
  function outcome(result) {
    const state = result?.state || result?.status;
    const creditMessages = {
      credit_submission_pending: "Submission attempted. Check confirmation for this saved transaction.",
      credit_submission_uncertain: "The submission response was unavailable. Check confirmation for the saved transaction. Do not create another transaction.",
      credit_insufficient_rc: "The node reported insufficient Mana or a resource limit. Keep this saved transaction for diagnosis; do not create a replacement.",
      credit_await_finality: "The node reports this transaction. Irreversible confirmation is still pending; check confirmation again shortly.",
      credit_saved_review_required: "The node has not found this transaction and the wallet nonce is unchanged. Choose Review saved transaction to resend the original. Do not create another transaction.",
      credit_nonce_changed: "The wallet nonce has changed, but this transaction is not confirmed. Keep the saved transaction for recovery; do not resend it yet.",
      credit_confirmation_unavailable: "Confirmation checks are unavailable. Your saved transaction is unchanged. Retry Check confirmation after the connection recovers.",
    };
    const creditMessage = result?.purpose === "credits" && state === "signed" ? creditMessages[result.reason] : null;
    const fundingMessages = {
      funding_moving: "New blocks arrived during the account checks. Your saved deposit is unchanged. Wait a moment, then check confirmation again.",
      funding_reversible: "Waiting for the account checks to become irreversible. Check confirmation again shortly; then review the saved transaction if requested.",
      funding_changed: "The account changed during verification. Check confirmation again before continuing.",
      funding_forked: "The chain changed during verification. Check confirmation again before continuing.",
      funding_user_stopped: "Deposit saved. Choose Review saved transaction to continue with the original deposit.",
      funding_resume_review_required: "Deposit saved. Choose Review saved transaction to continue with the original deposit.",
      funding_insufficient_rc: mainnet
        ? "The node reported insufficient Mana or a resource limit. Choose Review Mana correction for this saved deposit; do not create another payment."
        : "The node reported insufficient Mana or a resource limit. Keep this saved deposit for recovery; do not create another payment.",
      funding_submission_uncertain: "The submission response was unavailable. Check confirmation for this saved deposit before retrying.",
    };
    const funding = result?.funding;
    const fundingMessage = !result?.correction && funding?.state === "unknown" && funding.attempts > 0
      ? "Submission was attempted; confirmation is still unknown. Check confirmation again. Do not create another deposit."
      : fundingMessages[funding?.reason || result?.reason];
    const messages = {
      cancelled: "Action cancelled. No new approval was granted.", stopped: "Action stopped. Check payment activity if submission had already started.",
      signed: "Transaction signed. Check confirmation in Payment activity before continuing.", finalized: "Transaction confirmed on chain.",
      uncertain: "The result is uncertain. Check the saved transaction before trying again.",
      await_finality: "Deposit submission attempted. Check confirmation in Payment activity before continuing.",
      correction_saved: "Mana correction saved. Choose Review saved transaction to continue with this deposit. Do not create another deposit.",
      correction_await_finality: "Mana correction submission attempted. Check confirmation for this saved deposit. Do not create another deposit.",
      correction_simulation_failed: "Mana correction did not pass the node’s simulation. This attempt was not submitted. Keep this saved deposit for recovery; do not create another deposit.",
      reverted: "Transaction reverted. Check payment activity for details.",
      access_imported: "Invitation added. Your account is ready for connection checks.",
      backed_up: "Payment history backed up.", restored: "Payment history restored. Pending transactions still need confirmation.",
      test_worker_running: "Provider started. Checking network eligibility…", test_worker_stopped: "This computer has stopped providing AI capacity.",
      request_cancelled: "Request was cancelled before dispatch. You can send a new request.",
      request_unknown: "Request remains uncertain. Check or retry the original request in Advanced & recovery.",
      revoked: "New requests are stopped. Previously dispatched work stays reserved.",
    };
    if (result?.error) message(String(result.error).slice(0, 280), true);
    else if (creditMessage) message(`${creditName(result.creditAction) || "Credit transaction"}: ${creditMessage}`,
      ["credit_insufficient_rc", "credit_nonce_changed", "credit_confirmation_unavailable", "credit_submission_uncertain"].includes(result.reason));
    else if (funding?.state === "funded") message("Deposit confirmed. Account balances have been refreshed.");
    else if (result?.correction?.state === "finalized") message("Mana correction confirmed on chain. Check confirmation to verify your credits.");
    else if (state === "correction_simulation_failed") message((funding?.reason || result?.reason) === "funding_insufficient_rc"
      ? "The correction still cannot run within its approved Mana limit or the available Mana. This attempt was not submitted. Keep this saved deposit for recovery; do not create another deposit."
      : messages.correction_simulation_failed);
    else if (fundingMessage && !["finalized", "reverted", "consumed_elsewhere"].includes(state)) message(fundingMessage);
    else if (result?.correction && ["signed", "await_finality"].includes(state)) message(result.correction.attempts > 0 ? messages.correction_await_finality : messages.correction_saved);
    else if (state) message(messages[state] || words(state));
    if (state === "test_worker_running" || state === "test_worker_stopped") providing = state === "test_worker_running";
    if (["signed", "uncertain", "reverted", "consumed_elsewhere", "correction_saved", "correction_await_finality", "correction_simulation_failed"].includes(state)) el("koin-activity").open = true;
    if (state === "request_unknown") el("koin-advanced").open = true;
    if (Array.isArray(result?.payouts)) {
      el("koin-payout-summary").textContent = result.payouts.length ? result.payouts.map(p => {
        const valid = [p.availability || "0", p.work || "0"].every(v => typeof v === "string" && /^(0|[1-9]\d*)$/.test(v));
        const total = valid ? amount(String(BigInt(p.availability || "0") + BigInt(p.work || "0"))) : "—";
        return `Day ${p.epoch} · ${total} ${unit()} · ${words(p.state)}`;
      }).join("\n") : "No rewards yet. Payouts are automatic after the review period.";
      message("Reward status updated.");
    }
    if (result?.answer) {
      el("koin-test-answer").textContent = result.answer; el("koin-answer-wrap").hidden = false;
      const charge = result.koin?.receipt?.usage?.amount;
      message(`Answer verified · ${result.usage?.prompt_tokens || 0} input tokens · ${result.usage?.completion_tokens || 0} output tokens${charge ? " · " + amount(charge) + " " + unit() + " awaiting settlement" : ""}`);
    }
    if (state === "active") {
      const text = `Spending approved · Spent: ${amount(result.spent)} · Held: ${amount(result.held)} ${unit()} · ${result.remainingJobs} requests remaining`;
      el("koin-spending-summary").textContent = text; message(text);
    }
    if (state === "request_settled") message(`Request settled once · ${amount(result.amount)} ${unit()}. You can send a new request.`);
    if (state === "correction_await_finality" && amount(result?.simulation?.rcUsed) !== "—") status.appendChild(document.createTextNode(" · Simulation: " + amount(result.simulation.rcUsed) + " Mana"));
    if (result?.deposit && funding?.state !== "funded") status.appendChild(document.createTextNode(" · Deposit: " + words(result.deposit.state)));
  }
  const refreshAfter = new Set(["import", "access", "purchase", "fund-rewards", "reserve", "refund", "revoke", "release", "check", "resume", "correct-mana", "recover", "repair", "restore", "worker-start", "worker-stop"]);
  async function run(action, amountInput = el("koin-test-amount")) {
    if (action === "worker-stop") {
      try { await bridge.run(action); providing = false; paintProvider({ state: "offline", label: "OFFLINE", detail: "This computer is no longer providing AI." }); }
      catch (e) { message(e.message, true); }
      controls(); return;
    }
    if (busy && action !== "stop") return;
    if (action === "purchase") {
      const value = amountInput.value.trim();
      // Match native decimal precision without rounding, inferring a value
      // from the placeholder, or removing a currency suffix. Native review
      // and validation remain authoritative for every actual payment.
      const validFormat = /^(0|[1-9]\d{0,11})(\.\d{1,8})?$/.test(value);
      const [whole, part = ""] = value.split(".");
      const atoms = validFormat ? BigInt(whole) * 100000000n + BigInt(part.padEnd(8, "0")) : 0n;
      if (!validFormat || atoms <= 0n || atoms > (1n << 64n) - 1n) {
        amountInput.setAttribute("aria-invalid", "true");
        message("To add funds, enter an amount greater than 0, such as 0.1 (up to 8 decimal places, without KOIN). To reserve your existing balance, send a chat message.", true);
        amountInput.focus(); return;
      }
      amountInput.removeAttribute("aria-invalid");
    }
    if (action !== "stop") { busy = true; message(action === "status" ? "Refreshing your account…" : "Follow the approval in the desktop window, if requested."); controls(); }
    try {
      let input;
      if (["chat", "chat-retry"].includes(action)) input = el("koin-test-prompt").value;
      if (["purchase", "refund"].includes(action)) input = amountInput.value.trim();
      if (action === "fund-rewards") input = el("koin-reward-amount").value.trim();
      if (["revoke", "release"].includes(action)) input = el("koin-test-session-id").value.trim();
      if (["check", "resume", "correct-mana"].includes(action)) input = select.value;
      if (["recover", "repair"].includes(action)) input = { id: select.value, txId: el("koin-test-recovery-tx").value.trim() };
      const result = await bridge.run(action, input);
      let refreshFailed = false;
      snapshot(result);
      if (action === "status" && result?.configured && !result.paused) message("Account updated. Payments require your approval.");
      if (refreshAfter.has(action) && result?.state !== "cancelled") {
        try { snapshot(await bridge.run("status")); }
        catch { refreshFailed = true; el("koin-available").textContent = el("koin-reserved").textContent = "—"; }
      }
      outcome(result);
      if (action === "import" && result?.configured) message("Network connected. Add your invitation to continue.");
      if (refreshFailed) message(status.textContent + " Account refresh unavailable. Check confirmation before starting another payment.", true);
      if (result?.id && [...select.options].some(option => option.value === result.id)) select.value = result.id;
    } catch (error) {
      activate();
      if (action === "status") { el("koin-available").textContent = el("koin-reserved").textContent = "—"; }
      message(String(error.message || "Payment action unavailable").replace(/^Error invoking remote method 'koin:test-payments': (?:Error: )?/, "").slice(0, 280), true);
    } finally { if (action !== "stop") busy = false; controls(); refreshProvider(); window.KaiNetwork?.refresh().then(() => window.KaiNetwork.paint()).catch(() => {}); }
  }
  const tabs = [...section.querySelectorAll("[data-koin-view]")];
  function choose(tab) {
    for (const item of tabs) { const active = item === tab; item.setAttribute("aria-selected", String(active)); item.tabIndex = active ? 0 : -1; el(item.getAttribute("aria-controls")).hidden = !active; }
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => choose(tab));
    tab.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : tabs[(index + 1) % tabs.length]; choose(next); next.focus();
    });
  });
  select.addEventListener("change", controls);
  buttons.forEach(button => button.addEventListener("click", () => run(button.dataset.koinTest)));
  el("koin-open-chat").addEventListener("click", () => window.dispatchEvent(new Event("kai-network-use")));
  window.addEventListener("kai-network-add-koin", event => { if (busy) return; el("koin-test-amount").value = String(event.detail || ""); run("purchase", el("network-koin-amount")); });
  for (const id of ["network-koin-amount", "koin-test-amount"]) el(id).addEventListener("input", event => event.target.removeAttribute("aria-invalid"));
  window.addEventListener("kai-network-account-changed", () => { if (!busy) run("status"); });
  bridge.onProgress?.(value => { if (busy) message(String(value?.text || "")); });
  setInterval(refreshProvider, 10000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshProvider(); });
  controls(); run("status");
})();
