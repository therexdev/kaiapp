"use strict";
(() => {
  const bridge = window.kaiKoinReviewBridge;
  const section = document.getElementById("koin-review-preview");
  if (!bridge || !section) return;
  section.hidden = false;
  const button = document.getElementById("btn-koin-review-preview");
  const status = document.getElementById("koin-review-status");
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    KaiI18n.setText(status, "Review the example in the desktop dialog.");
    try {
      const result = await bridge.preview();
      const valid = result?.mode === "shadow" && result.paymentsEnabled === false;
      KaiI18n.setText(status, valid && result.status === "reviewed" ? "Example reviewed. No request was signed or sent." :
        valid && result.status === "cancelled" ? "Preview cancelled. No KOIN was spent." : "Preview unavailable. Please try again.");
    } catch {
      KaiI18n.setText(status, "Preview unavailable. Please try again.");
    } finally { button.disabled = false; }
  });
})();

(() => {
  const bridge = window.kaiKoinSessionBridge, section = document.getElementById("koin-session-rehearsal");
  if (!bridge || !section) return;
  const status = document.getElementById("koin-session-status");
  const buttons = ["review", "retry", "status", "revoke"].map(action => [action, document.getElementById("btn-koin-session-" + action)]);
  let busy = false;
  async function run(action) {
    if (busy) return;
    busy = true; for (const [, button] of buttons) button.disabled = true;
    try {
      const result = await bridge[action]();
      if (result?.mode !== "funded-rehearsal" || result.paymentsEnabled !== false) throw Error("Invalid session response");
      section.hidden = !result.enabled;
      const messages = { unapproved: "No session approval saved. Review the limits to begin.",
        active: "Session approved for accounting rehearsal. Paid chat remains disabled.",
        revoked: "Session approval revoked. Dispatched work stays reserved.",
        expired: "Session approval expired.", cancelled: "Session action cancelled.",
        uncertain: "The session result is uncertain. Refresh or retry the saved approval.",
        account_unavailable: "The account grant is unavailable. New requests are blocked.",
        reconciliation_required: "Session accounting needs reconciliation. New requests are blocked." };
      KaiI18n.setText(status, messages[result.state] || "Session rehearsal unavailable. Retry the saved approval if a response was lost.");
      if (result.error) status.appendChild(document.createTextNode(" " + String(result.error).slice(0, 220)));
    } catch { KaiI18n.setText(status, "Session rehearsal unavailable. Retry the saved approval if a response was lost."); }
    finally { busy = false; for (const [, button] of buttons) button.disabled = false; }
  }
  for (const [action, button] of buttons) button.addEventListener("click", () => run(action));
  run("status");
})();


(() => {
  const bridge = window.kaiKoinTestBridge, section = document.getElementById("koin-test-payments");
  if (!bridge || !section) return;
  const status = document.getElementById("koin-test-payment-status"), select = document.getElementById("koin-test-transaction");
  const buttons = [...section.querySelectorAll("[data-koin-test]")]; let busy = false, mainnet = false;
  const amount = value => { const n = BigInt(value || "0"); return `${n / 100000000n}.${(n % 100000000n).toString().padStart(8, "0")}`; };
  function show(result) {
    if (["test-deployment", "mainnet-pilot"].includes(result?.mode)) {
      section.hidden = result.enabled === false; mainnet = result.mode === "mainnet-pilot";
      document.getElementById("koin-test-title").textContent = mainnet ? "Payment testing · MAINNET · real KOIN" : "Payment testing · Foundation testnet";
      document.getElementById("koin-test-network-notice").textContent = mainnet ? "This Test app uses REAL KOIN. Deposits, approved requests and rewards move real funds. Review each native approval and its limits." : "Foundation testnet: deposits, requests and automatic rewards use test KOIN.";
      document.getElementById("koin-test-amount-label").textContent = mainnet ? "Real KOIN amount" : "Test KOIN amount";
      for (const [action, label] of [["purchase", mainnet ? "Buy credits with real KOIN" : "Buy Test credits"], ["fund-rewards", mainnet ? "Fund mainnet rewards" : "Fund Test rewards"], ["session-review", mainnet ? "Review real KOIN spending" : "Review Test spending"]]) section.querySelector(`[data-koin-test="${action}"]`).textContent = label;
    }
    const unit = mainnet ? "mainnet KOIN" : "test KOIN";
    if (result?.configured === false) { status.textContent = "Import the public manifest from your Test backend to begin."; return; }
    if (result?.balances) {
      document.getElementById("koin-test-balances").textContent = `Available: ${amount(result.balances.available)} ${unit} · Reserved: ${amount(result.balances.reserved)} ${unit}${result.paused ? " · New spending paused" : ""}`;
      const selected = select.value; select.replaceChildren();
      for (const tx of result.transactions || []) {
        const option = document.createElement("option"); option.value = tx.id; option.textContent = `${tx.purpose}: ${tx.state} · ${tx.txId || tx.id}`; select.appendChild(option);
      }
      if ([...select.options].some(o => o.value === selected)) select.value = selected;
      if (result.session) document.getElementById("koin-test-session-id").value = result.session.session;
    }
    const state = result?.state || result?.status || (result?.configured ? "Ready" : "Action complete");
    status.textContent = result?.error || String(state).replaceAll("_", " ");
    if (result?.payouts) status.textContent = result.payouts.length ? result.payouts.map(p => `Day ${p.epoch}: ${p.state} · ${amount((BigInt(p.availability || "0") + BigInt(p.work || "0")).toString())} ${unit}`).join("; ") : "No daily payouts yet. Rewards are automatic after the review period.";
    if (result?.answer) {
      document.getElementById("koin-test-answer").textContent = result.answer;
      const charge = result.koin?.receipt?.usage?.amount;
      status.textContent = `Answer verified · Input tokens: ${result.usage?.prompt_tokens || 0} · Output tokens: ${result.usage?.completion_tokens || 0}${charge ? " · Charge: " + amount(charge) + " " + unit + " (awaiting settlement)" : ""}`;
    }
    if (result?.deposit) status.textContent += ` · Deposit: ${result.deposit.state}`;
    if (result?.state === "active") status.textContent = `${mainnet ? "Real KOIN" : "Test"} spending approved. Spent: ${amount(result.spent)} · Held: ${amount(result.held)} · Remaining requests: ${result.remainingJobs}`;
    if (result?.state === "request_cancelled") status.textContent = "Request was cancelled before dispatch. You can send a new request.";
    if (result?.state === "request_settled") status.textContent = `Request settled once · Charge: ${amount(result.amount)} ${unit}. You can send a new request.`;
    if (result?.state === "request_unknown") status.textContent = "Request remains uncertain. Retry its original prompt; no new request has been started.";
  }
  async function run(action) {
    if (busy && action !== "stop") return;
    if (action !== "stop") { busy = true; for (const button of buttons) button.disabled = button.dataset.koinTest !== "stop"; }
    try {
      let input;
      if (["chat", "chat-retry"].includes(action)) input = document.getElementById("koin-test-prompt").value;
      if (["purchase", "refund", "fund-rewards"].includes(action)) input = document.getElementById("koin-test-amount").value.trim();
      if (["revoke", "release"].includes(action)) input = document.getElementById("koin-test-session-id").value.trim();
      if (["check", "resume"].includes(action)) input = select.value;
      if (["recover", "repair"].includes(action)) input = { id: select.value, txId: document.getElementById("koin-test-recovery-tx").value.trim() };
      show(await bridge.run(action, input));
    } catch (error) { section.hidden = false; status.textContent = String(error.message || "Test payment action unavailable").slice(0, 280); }
    finally { if (action !== "stop") { busy = false; for (const button of buttons) button.disabled = false; } }
  }
  for (const button of buttons) button.addEventListener("click", () => run(button.dataset.koinTest));
  run("status");
})();
