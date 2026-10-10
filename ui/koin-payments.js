"use strict";
(() => {
  const bridge = window.kaiKoinTestBridge, section = document.getElementById("koin-test-payments");
  if (!bridge || !section) return;
  const el = id => document.getElementById(id);
  const status = el("koin-test-payment-status"), select = el("koin-test-transaction");
  const buttons = [...section.querySelectorAll("[data-koin-test]")];
  let busy = false, configured = false, mainnet = false, hasSession = false, providing = false, activated = false;
  const amount = value => {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return "—";
    const n = BigInt(value); return `${n / 100000000n}.${(n % 100000000n).toString().padStart(8, "0")}`;
  };
  const words = value => String(value || "").replaceAll("_", " ");
  const unit = () => mainnet ? "mainnet KOIN" : "test KOIN";
  function message(text, error = false) { status.textContent = text; status.dataset.error = String(error); }
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
    for (const button of buttons) {
      const action = button.dataset.koinTest;
      button.disabled = action === "stop" ? !busy : busy ||
        (!configured && !["status", "import", "restore"].includes(action)) ||
        (configured && action === "import") ||
        (!hasSession && ["session-review", "session-status", "session-revoke", "session-retry", "chat", "chat-retry", "chat-status"].includes(action)) ||
        (!select.value && ["check", "resume", "recover", "repair"].includes(action));
      if (action === "stop") button.hidden = !busy;
      if (action === "worker-start") button.hidden = providing;
      if (action === "worker-stop") button.hidden = !providing;
    }
    section.setAttribute("aria-busy", String(busy));
    el("koin-provider-state").textContent = providing ? "Providing AI capacity" : "Not providing";
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
    }
    if (Array.isArray(result.transactions)) {
      const selected = select.value; select.replaceChildren();
      for (const tx of result.transactions) {
        const option = document.createElement("option"); option.value = tx.id;
        option.textContent = `${words(tx.purpose)} · ${words(tx.state)} · ${tx.txId || tx.id}`; select.appendChild(option);
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
        el("koin-spending-summary").textContent = "Reserve a budget, then review its limits before sending requests.";
        el("koin-model-label").textContent = "Reserve a session to see your model";
      }
    }
    if (Object.hasOwn(result, "worker")) providing = !!result.worker?.running;
    if (result.paused) message("New spending is paused by the network. Existing payment recovery remains available.");
  }
  function outcome(result) {
    const state = result?.state || result?.status;
    const fundingMessages = {
      funding_moving: "New blocks arrived during the account checks. Your saved deposit is unchanged. Wait a moment, then check confirmation again.",
      funding_reversible: "Waiting for the account checks to become irreversible. Check confirmation again shortly; then review the saved transaction if requested.",
      funding_changed: "The account changed during verification. Check confirmation again before continuing.",
      funding_forked: "The chain changed during verification. Check confirmation again before continuing.",
      funding_user_stopped: "Deposit saved. Choose Review saved transaction to continue with the original deposit.",
      funding_resume_review_required: "Deposit saved. Choose Review saved transaction to continue with the original deposit.",
      funding_insufficient_rc: "The node reported insufficient Mana or a resource limit. Keep this saved deposit for recovery; do not create another payment.",
      funding_submission_uncertain: "The submission response was unavailable. Check confirmation for this saved deposit before retrying.",
    };
    const funding = result?.funding;
    const fundingMessage = funding?.state === "unknown" && funding.attempts > 0
      ? "Submission was attempted; confirmation is still unknown. Check confirmation again. Do not create another deposit."
      : fundingMessages[funding?.reason || result?.reason];
    const messages = {
      cancelled: "Action cancelled. No new approval was granted.", stopped: "Action stopped. Check payment activity if submission had already started.",
      signed: "Transaction signed. Check confirmation in Payment activity before continuing.", finalized: "Transaction confirmed on chain.",
      uncertain: "The result is uncertain. Check the saved transaction before trying again.",
      await_finality: "Deposit submission attempted. Check confirmation in Payment activity before continuing.",
      reverted: "Transaction reverted. Check payment activity for details.",
      access_imported: "Invitation added. Your account is ready for connection checks.",
      backed_up: "Payment history backed up.", restored: "Payment history restored. Pending transactions still need confirmation.",
      test_worker_running: "This computer is providing AI capacity.", test_worker_stopped: "This computer has stopped providing AI capacity.",
      request_cancelled: "Request was cancelled before dispatch. You can send a new request.",
      request_unknown: "Request remains uncertain. Check or retry the original request in Advanced & recovery.",
      revoked: "New requests are stopped. Previously dispatched work stays reserved.",
    };
    if (result?.error) message(String(result.error).slice(0, 280), true);
    else if (fundingMessage && !["finalized", "reverted", "consumed_elsewhere"].includes(state)) message(fundingMessage);
    else if (state) message(messages[state] || words(state));
    if (state === "test_worker_running" || state === "test_worker_stopped") providing = state === "test_worker_running";
    if (["signed", "uncertain", "reverted", "consumed_elsewhere"].includes(state)) el("koin-activity").open = true;
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
    if (result?.deposit) status.appendChild(document.createTextNode(" · Deposit: " + words(result.deposit.state)));
  }
  const refreshAfter = new Set(["import", "access", "purchase", "fund-rewards", "reserve", "refund", "revoke", "release", "check", "resume", "recover", "repair", "restore", "worker-start", "worker-stop"]);
  async function run(action) {
    if (busy && action !== "stop") return;
    if (action !== "stop") { busy = true; message(action === "status" ? "Refreshing your account…" : "Follow the approval in the desktop window, if requested."); controls(); }
    try {
      let input;
      if (["chat", "chat-retry"].includes(action)) input = el("koin-test-prompt").value;
      if (["purchase", "refund"].includes(action)) input = el("koin-test-amount").value.trim();
      if (action === "fund-rewards") input = el("koin-reward-amount").value.trim();
      if (["revoke", "release"].includes(action)) input = el("koin-test-session-id").value.trim();
      if (["check", "resume"].includes(action)) input = select.value;
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
      message(String(error.message || "Payment action unavailable").slice(0, 280), true);
    } finally { if (action !== "stop") busy = false; controls(); }
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
  controls(); run("status");
})();
