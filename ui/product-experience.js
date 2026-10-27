"use strict";
(() => {
  const $ = id => document.getElementById(id), esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const credits = value => { const n = BigInt(value || "0"); return (Number(n) / 100000).toLocaleString(undefined, { maximumFractionDigits: 5 }); };
  const go = view => activateView(view), button = (view, label, primary = false) => `<button type="button" class="${primary ? "primary" : ""}" data-product-view="${view}">${label}</button>`;
  const head = (title, subtitle, action = "") => `<header class="product-head"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</header>`;
  const emblem = '<div class="product-emblem" aria-hidden="true"><img src="brand-mark.svg" alt="" /></div>';
  document.body.classList.add("product-v2");
  if (innerWidth <= 520) document.body.classList.add("product-sidebar-collapsed");
  const main = $("main");
  main.insertAdjacentHTML("beforeend", `
    <section id="view-credits" class="view product-page" hidden>
      ${head("Your credits", "Everything you can use, and where it went.", button("buy-credits", "+ Buy credits", true))}
      <div class="product-two"><section class="product-panel"><p class="product-eyebrow">Available to use</p><div class="product-balance"><span data-credit-total>—</span> <small>credits</small></div><div class="product-credit-track"><i id="product-free-track"></i></div><p data-credit-breakdown>Checking your credit account…</p><p class="product-fine" data-credit-freshness></p></section>
      <section class="product-panel"><h2>Simple, predictable spending</h2><p>Daily free credits are used first by default on eligible models. Change credit priority in Settings. Purchased credits keep their USD service value.</p><div class="product-detail"><span>1,000 credits</span><strong>$1 of AI usage</strong></div><div class="product-detail"><span>Purchased credits</span><strong>No expiry</strong></div><p class="product-fine">Purchased credits are nonrefundable and nontransferable.</p></section></div>
      <section class="product-panel product-history"><div class="product-row"><h2>Activity</h2><div id="product-activity-filters"><button class="active" data-activity-filter="all">All</button><button data-activity-filter="usage">Usage</button><button data-activity-filter="purchase">Purchases</button></div></div><div class="product-table-wrap"><table><thead><tr><th>Activity</th><th>When</th><th>Status</th><th>Credits</th></tr></thead><tbody id="product-credit-history"><tr><td colspan="4">No verified activity loaded.</td></tr></tbody></table></div></section><p class="product-footer">Looking for an older pilot transaction? <button data-product-action="legacy">Account help</button></p>
    </section>
    <section id="view-buy-credits" class="view product-page" hidden>
      ${head("Buy credits", "Pay with KOIN. Your credits keep their USD service value.", button("chat", "Back to Chat"))}
      <ol class="product-steps"><li class="active">Choose credits</li><li>Approve payment</li><li>Credits added</li></ol>
      <div class="product-two"><section class="product-panel"><h2>How much would you like to add?</h2><p>1,000 credits = $1 of AI usage.</p><div class="product-packs">${[1, 5, 10].map(n => `<button data-credit-pack="${n}"${n === 1 ? ' class="selected"' : ""}><strong>$${n}</strong><small>${(n * 1000).toLocaleString()} credits</small></button>`).join("")}</div><label for="product-usd-amount">Or choose an amount</label><div class="product-input"><span>$</span><input id="product-usd-amount" inputmode="decimal" autocomplete="off" value="1" placeholder="Enter USD amount" maxlength="12" /><span>USD</span></div><p>Your wallet shows the exact KOIN amount before you approve.</p></section>
      <section class="product-panel product-order"><p class="product-eyebrow">You receive</p><div class="product-balance"><span id="product-pack-credits">1,000</span> <small>credits</small></div><div class="product-detail"><span id="product-quote-label">Estimated KOIN payment</span><strong id="product-quote-koin">Calculating…</strong></div><p id="product-price-preview-support" class="product-fine" role="status" hidden></p><p id="product-price-limit" class="product-fine" role="status" hidden></p><details id="product-quote-details" hidden><summary>Price details</summary><div class="product-detail"><span>Price source</span><strong>Uniswap v4 · vKOIN/USDT</strong></div><div class="product-detail"><span>Exchange observation</span><strong id="product-quote-time">—</strong></div><div class="product-detail"><span>Valid until</span><strong id="product-quote-expiry">—</strong></div><div class="product-detail"><span>Purchase rate</span><strong id="product-quote-rate"></strong></div><p id="product-quote-reference" class="product-fine"></p><p id="product-quote-window" class="product-fine"></p></details><p id="product-quote-state" role="status">Choose an amount. You’ll approve the exact KOIN payment in your wallet.</p><p id="product-local-payment" role="status" hidden></p><p id="product-payment-recovery-status" role="status" hidden></p><div id="product-purchase-notice" class="product-purchase-notice" role="status" hidden><p id="product-purchase-detail"></p><div class="product-actions"><button id="product-purchase-check" hidden>Try again</button><button data-product-action="signin" id="product-purchase-signin" hidden>Open account</button><button data-product-action="payment-wallet" id="product-purchase-wallet" hidden>Open wallet</button></div></div><button id="product-quote-refresh" class="primary" disabled>Checking availability…</button><button id="product-purchase-stop" hidden>Stop payment check</button><p class="product-fine">Purchased credits: nonrefundable · nontransferable · no expiry</p><div id="product-pending-purchases"></div></section></div>
      <section id="product-model-pricing" class="product-panel product-model-pricing" aria-labelledby="product-model-pricing-title"><h2 id="product-model-pricing-title">Model pricing</h2><p>Prices per 1 million tokens. Input includes your messages and context; output is the model’s reply.</p><p id="product-model-pricing-status" class="product-fine" role="status">Loading model prices…</p><div id="product-model-pricing-table" class="product-table-wrap" hidden><table><thead><tr><th scope="col">Model</th><th scope="col">Input / 1M tokens</th><th scope="col">Output / 1M tokens</th></tr></thead><tbody id="product-model-pricing-rows"></tbody></table></div></section>
    </section>
    <section id="view-network-overview" class="view product-page" hidden>
      ${head("Network overview", "Available AI and the computers providing it.")}
      <section class="product-network-status"><div><h2 id="product-network-state">Checking network status</h2><p id="product-network-time">No verified observation yet.</p></div><div><strong id="product-model-count">—</strong><small>models available</small></div><div><strong id="product-provider-count">—</strong><small id="product-provider-count-label">providers ready</small></div><div><strong id="product-waiting-count">—</strong><small id="product-waiting-count-label">requests waiting</small></div></section>
      <div class="product-two" id="product-network-model-grid"><section class="product-panel"><h2>Models on the network</h2><div id="product-network-models"><p>Available models will appear after a verified status check.</p></div></section><section class="product-panel" id="product-network-completed"><p class="product-eyebrow">Work completed today</p><div class="product-balance"><span id="product-completed-count">—</span> <small id="product-completed-unit">requests</small></div><p id="product-completed-note">Requests with verified delivered replies, including saved partial replies.</p><div class="product-divider"></div><p>Provider payouts are handled separately. Your earnings are shown in Earn.</p></section></div>
      <section class="product-panel"><h2>Computers providing AI</h2><div id="product-network-providers"><p>No current provider observations.</p></div></section><section class="product-panel" id="product-network-recent"><h2>Recent activity</h2><div id="product-network-activity"><p>No verified activity loaded.</p></div></section>
    </section>
    <section id="view-recovery" class="view product-page" hidden>
      ${head("Account help", "Check a purchase, recover a reply, or review earlier account activity.")}
      <div class="product-two"><section class="product-panel"><h2>Purchase confirmation</h2><p id="product-recovery-purchase">Check the purchase record before retrying. Existing credits remain available.</p><div class="product-actions">${button("chat", "Keep chatting", true)}${button("buy-credits", "View purchase")}<button data-product-action="purchase-retry">Review saved payment</button></div></section><section class="product-panel"><h2>Interrupted reply</h2><p>Recover the original request and its verified usage. Received text is preserved. A request with no usable answer is not charged.</p><button data-product-action="recover">Recover saved reply</button><p id="product-recovery-state" role="status"></p></section><section class="product-panel"><h2>Model unavailable</h2><p>Choose another network model or use this computer. Your model and spending preference will not change automatically.</p><div class="product-actions">${button("network-overview", "Choose a model")}<button data-product-action="local">Use local AI</button></div></section><section class="product-panel"><h2>Provider payout</h2><p id="product-recovery-payout">Check your verified earnings and payout status. A pending payout does not block Chat or sharing.</p>${button("earn", "View earnings")}</section></div><p class="product-footer">Older pilot balance or transaction? <button data-product-action="legacy">Get account help</button></p>
    </section>
    <section id="view-payment-wallet" class="view product-page" hidden>
      ${head("Your wallet", "Manage the KOIN and VHP held in your wallet.", button("buy-credits", "Buy credits"))}
      <section id="product-wallet-controls" class="product-panel"><p class="product-fine">Your wallet balance is separate from AI credits. Wallet actions use the same local wallet and approval controls.</p></section>
    </section>`);
  $("sidebar").querySelector(".brand").insertAdjacentHTML("afterend", `<section class="product-sidebar-credits"><p class="product-eyebrow">Available to use</p><strong><span data-credit-total>—</span> <small>credits</small></strong><p data-credit-breakdown>Credit account unavailable</p>${button("buy-credits", "+ Buy credits", true)}<button class="product-text-button" data-product-view="credits">Balance &amp; activity ↗</button></section>`);
  const header = main.querySelector(".workspace-header");
  header.insertAdjacentHTML("afterbegin", '<button id="product-sidebar-toggle" aria-label="Toggle sidebar" aria-expanded="true">☰</button>');
  header.insertAdjacentHTML("beforeend", '<button id="product-mobile-credits" data-product-view="credits"><span data-credit-total>—</span> credits</button><button id="product-mobile-buy" data-product-view="buy-credits">Buy credits</button>');
  header.appendChild($("launch-kai")); $("launch-kai").querySelector("strong").textContent = "Open KAI";
  // Conversations belong to Chat's own rail; the main sidebar stays navigation.
  $("chats-pane").querySelector(".kc-rail-label").textContent = "Recent chats";
  $("product-sidebar-toggle").addEventListener("click", () => { const collapsed = document.body.classList.toggle("product-sidebar-collapsed"); $("product-sidebar-toggle").setAttribute("aria-expanded", String(!collapsed)); });
  $("sidebar").insertAdjacentHTML("afterbegin", '<button id="product-sidebar-close" aria-label="Close sidebar">×</button>');
  $("product-sidebar-close").addEventListener("click", () => $("product-sidebar-toggle").click());
  const workspace = $("nav-items-workspace").firstElementChild, toolkit = $("nav-items-toolkit").firstElementChild;
  const item = name => document.querySelector(`#nav [data-view="${name}"]`);
  for (const name of ["chat", "code", "brain", "workflows", "agents", "docs"]) workspace.appendChild(item(name));
  for (const name of ["models", "connections", "tools", "compare", "tasks", "api", "devtools"]) toolkit.appendChild(item(name));
  item("chat").querySelector("span").textContent = "Chat"; item("models").querySelector("span").textContent = "Models"; item("connections").querySelector("span").textContent = "Connections & tools";
  $("nav-group-toolkit").querySelector("span").textContent = "More";
  item("earn").querySelector("span").textContent = "Earn";
  $("nav-group-contribute").setAttribute("aria-expanded", "true"); $("nav-items-contribute").setAttribute("aria-hidden", "false"); $("nav-items-contribute").inert = false;
  $("nav-network").dataset.view = "network-overview"; $("nav-network").title = "Network"; $("nav-network").setAttribute("aria-label", "Network");
  document.querySelector(".chat-pane").insertBefore(document.querySelector(".composer-options"), document.querySelector(".chat-toolbar").nextSibling);
  const oldEarn = $("view-earn").firstElementChild, legacy = document.createElement("details");
  legacy.id = "product-legacy-account";
  legacy.innerHTML = '<summary>Earlier KOIN account &amp; transaction recovery</summary>';
  $("view-recovery").appendChild(legacy); legacy.appendChild(oldEarn);
  oldEarn.querySelector("h1").textContent = "Earlier account activity";
  oldEarn.querySelector(".lede").textContent = "Historical balances, reservations and recovery tools. These are separate from the current credit purchase flow.";
  // Keep the original wallet controls and their event handlers, but give them
  // a dedicated destination so managing KOIN never opens the old payment UI.
  const walletReadyPanel = $("earn-ready"), walletStart = $("btn-earn-lock").closest("p");
  const oldProvider = document.createElement("div"); oldProvider.id = "product-earlier-provider";
  walletReadyPanel.before(oldProvider);
  for (const node of [...walletReadyPanel.childNodes]) { if (node === walletStart) break; oldProvider.appendChild(node); }
  const walletControls = $("product-wallet-controls");
  for (const id of ["earn-setup", "earn-unlock", "earn-ready", "earn-error"]) walletControls.appendChild($(id));
  $("earn-setup").querySelector("h2").textContent = "Create your wallet";
  $("earn-unlock").querySelector("h2").textContent = "Unlock your wallet";
  oldEarn.insertAdjacentHTML("beforeend", '<p id="product-legacy-error" class="error" role="status" hidden></p>');
  $("view-earn").insertAdjacentHTML("afterbegin", `<div class="product-earn">${head("Share your AI. Earn KOIN.", "Contribute this computer’s spare AI capacity to the network.")}<div class="product-two"><section class="product-panel product-provider"><div class="product-row"><span>Share AI capacity</span><button id="product-provider-toggle" aria-describedby="product-provider-start-hint product-provider-readiness" disabled role="switch" aria-checked="false" aria-label="Share AI capacity">Start earning</button></div><p id="product-provider-start-hint" class="product-fine">Click the button to start earning.</p><div class="product-provider-state"><span class="product-live-dot"></span><h2 id="product-provider-label">OFFLINE</h2><p id="product-provider-detail">Sharing is off. Turn it on when you’re ready.</p></div><div class="product-divider"></div><strong id="product-provider-model">Model not confirmed</strong><p id="product-provider-readiness" class="product-fine">Waiting for current model and network confirmation.</p></section><div><section class="product-panel"><p class="product-eyebrow">AI provider earnings</p><p id="product-provider-earnings">No verified earnings loaded.</p><p class="product-fine">KOIN rewards are separate from chat credits.</p><button data-product-action="payouts">Refresh earnings</button></section><section class="product-panel"><h2>Connection</h2><details id="product-provider-options"><summary>Models and diagnostics</summary><div id="product-provider-model-choice"><label for="product-provider-model-pick">Startup model</label><select id="product-provider-model-pick" disabled aria-describedby="product-provider-model-help"><option value="">Checking models…</option></select><p id="product-provider-model-help" class="product-fine">Sharing prepares installed models automatically. This optional choice only changes the startup model.</p></div><div id="product-provider-check"><h3 data-check-model>Local model check</h3><p data-check-detail role="status">Check the model currently running locally. No account or credits needed.</p><progress data-check-progress aria-label="Local model check progress" hidden></progress><p data-check-summary class="product-fine"></p><div class="product-actions"><button data-check-start data-check-action="start" class="primary">Check this computer</button><button data-check-cancel data-check-action="cancel" hidden>Cancel check</button><button data-check-copy data-check-action="copy" hidden>Copy report</button><button data-check-save data-check-action="save" hidden>Save report</button></div><p data-check-export class="product-fine" role="status"></p><p class="product-fine">This local check is diagnostic only. The network check runs automatically while earning is on.</p></div></details><div class="product-divider"></div><p id="product-provider-setup" role="status">Start earning to prepare the installed models and connect.</p><p id="product-provider-refresh" class="product-fine" role="status" hidden></p><div class="product-actions"><button id="product-provider-reload" data-product-action="provider-reload">Reload setup</button><button data-product-action="signin">Open AI credit account</button><button id="product-provider-download" data-product-action="provider-download" hidden>Download approved model</button><button id="product-provider-cancel" data-product-action="provider-cancel" hidden>Cancel setup</button><button data-product-action="payment-wallet">Reward wallet</button></div></section></div></div></div>`);
  $("product-provider-readiness").insertAdjacentHTML("afterend", '<button id="product-provider-models-open" hidden>Choose shared models</button>');
  $("view-earn").querySelector(".product-earn").insertAdjacentHTML("beforeend", `<section id="product-provider-models" class="product-panel product-provider-models" hidden><h2>Models you share</h2><label class="product-share-all"><input type="checkbox" id="product-provider-share-all" checked /> <span>Share all compatible installed models</span></label><p class="product-fine">Models load as needed. Each model must pass its network check and be approved before it can earn from paid work.</p><p id="product-provider-model-summary" role="status"></p><div id="product-provider-model-list"></div><p id="product-provider-selection-status" class="product-fine" role="status" hidden></p><div id="product-provider-selection-actions" class="product-actions" hidden><button id="product-provider-models-apply" class="primary">Apply selection</button><button id="product-provider-models-reset">Cancel changes</button></div></section>`);
  $("product-provider-detail").insertAdjacentHTML("afterend", '<p id="product-provider-qualification" role="status" hidden></p>');
  const onboarding = $("view-onboarding"), oldOnboarding = onboarding.firstElementChild;
  oldOnboarding.classList.add("product-local-setup"); oldOnboarding.hidden = true;
  oldOnboarding.insertAdjacentHTML("afterbegin", '<button data-product-action="first-back">← Back to choices</button>');
  onboarding.insertAdjacentHTML("afterbegin", `<div class="product-first">${emblem}<h1>Start with what you want to do.</h1><p>Use the network with free credits when available, or run AI on this computer.<br>You’re in control of where your work happens.</p><div class="product-two"><section class="product-panel"><h2>Try network AI</h2><p>Get started without buying KOIN or connecting a payment wallet. A verified account keeps your daily free usage consistent across devices.</p><button class="primary" data-product-action="start-free">Start free →</button></section><section class="product-panel"><h2>Use this computer</h2><p>Run a model locally. We’ll check your computer and help you choose a good fit. No credits needed.</p><button data-product-action="setup-local">Set up local AI →</button></section></div><p id="product-first-status" role="status">Free-credit availability depends on the network’s published policy.</p><button data-product-action="signin">Your account</button></div>`);
  let filter = "all", network, networkError = "", networkPending = false, quote, quoteRevision = 0, approving = false, quoting = false;
  function paintCredits(state) {
    const display = window.KaiCreditPresentation(state), { usd, stale } = display;
    document.querySelectorAll("[data-credit-total]").forEach(node => { node.textContent = display.total; node.title = display.status; });
    document.querySelectorAll("[data-credit-breakdown]").forEach(node => { node.textContent = display.breakdown; });
    document.querySelectorAll("[data-credit-status]").forEach(node => { node.textContent = node.closest(".product-sidebar-credits") ? display.compactStatus : display.status; node.title = display.status; node.hidden = !display.status; });
    document.querySelectorAll("[data-credit-freshness]").forEach(node => { node.textContent = display.detail; });
    document.querySelectorAll("[data-credit-refresh]").forEach(node => { node.disabled = display.refreshing; node.textContent = display.refreshing ? "Checking…" : state.status === "unavailable" ? "Retry" : "Refresh"; });
    document.querySelectorAll("[data-credit-help]").forEach(node => { node.hidden = usd && !stale || state.status === "loading"; });
    const cancelled = new Set((purchaseInfo.cancelledPurchases || []).map(p => p.txId));
    const isCancelled = p => p.state !== "confirmed" && cancelled.has(p.id);
    const rows = usd ? [...state.snapshot.usage.map(u => ({ kind: "usage", title: `Chat · ${u.model}`, at: u.at, status: "Delivered", amount: "−" + credits(u.credits) })), ...state.snapshot.purchases.map(p => ({ kind: "purchase", title: "Purchased credits", txId: /^0x1220[a-f0-9]{64}$/.test(p.id || "") ? p.id : null, at: p.confirmedAt || p.createdAt, status: isCancelled(p) ? "Cancelled · no purchase" : p.state === "confirmed" ? "Added to balance" : p.state, amount: isCancelled(p) ? "0" : p.state === "confirmed" ? "+" + credits(p.credits || p.amount) : "Pending" }))].sort((a, b) => b.at - a.at).filter(r => filter === "all" || filter === r.kind) : [];
    $("product-credit-history").innerHTML = rows.length ? rows.map(r => `<tr><td>${esc(r.title)}${r.txId ? `<small class="product-payment-transaction">Transaction: ${esc(r.txId)}</small>` : ""}</td><td>${esc(new Date(r.at).toLocaleString())}</td><td>${esc(r.status)}</td><td>${esc(r.amount)}</td></tr>`).join("") : `<tr><td colspan="4">${usd && !stale ? "No activity yet." : "No verified activity loaded."}</td></tr>`;
    const pending = state.snapshot?.purchases?.filter(p => p.state === "pending" && !isCancelled(p)) || [];
    $("product-pending-purchases").textContent = pending.length ? `${pending.length} purchase${pending.length === 1 ? " is" : "s are"} not yet confirmed. You can keep using existing credits.` : "";
    $("product-recovery-purchase").textContent = pending.length ? "Your purchase has not been confirmed. Check the saved payment details on Buy credits before retrying." : !usd || stale ? "Purchase status is unavailable. Refresh your account before starting or retrying a payment." : "No pending purchase in the last verified account snapshot. Refresh your account before starting another payment.";
  }
  let publicProvider = false;
  function paintProvider() {
    if (publicProvider) return;
    $("product-provider-label").textContent = $("koin-provider-state").textContent;
    $("product-provider-detail").textContent = $("koin-provider-detail").textContent;
    const start = document.querySelector('[data-koin-test="worker-start"]'), stop = document.querySelector('[data-koin-test="worker-stop"]'), on = !stop.hidden;
    const toggle = $("product-provider-toggle"); toggle.textContent = on ? "Stop earning" : "Start earning"; toggle.setAttribute("aria-checked", String(on)); $("product-provider-start-hint").hidden = on; toggle.disabled = !window.kaiKoinTestBridge || (on ? stop.disabled : start.disabled);
    $("product-provider-label").dataset.state = $("koin-provider-state").dataset.state;
    $("product-provider-earnings").textContent = $("koin-payout-summary").textContent;
    $("product-provider-model").textContent = $("koin-model-label").textContent;
    $("product-provider-readiness").textContent = $("koin-provider-state").dataset.state === "online" ? "Model ready · qualification current · fresh network confirmation" : "Readiness is not confirmed. " + $("koin-provider-detail").textContent;
  }
  function paintNetwork() {
    const fresh = network && !networkError && Date.now() < network.validUntil && network.observedAt <= Date.now() + 5000;
    const publicStatus = network?.source === "public-scheduler";
    $("product-network-state").textContent = fresh ? network.state === "available" ? "AI network status" : "Network paused" : "Network status unavailable";
    $("product-network-time").textContent = network ? `Observed ${new Date(network.observedAt).toLocaleString()} · ${fresh ? "checks every 15 seconds" : "stale — reconnect to refresh"}` : networkError || "No verified observation yet.";
    $("product-provider-count-label").textContent = publicStatus ? "providers online" : "providers ready";
    $("product-waiting-count-label").textContent = publicStatus ? "jobs waiting" : "requests waiting";
    for (const [id, value] of [["product-model-count", network?.models.filter(m => m.available).length], ["product-provider-count", publicStatus ? network?.providersOnline : network?.readyProviders], ["product-waiting-count", network?.waitingRequests]]) $(id).textContent = fresh ? value : "—";
    const unreported = network?.completedToday === null;
    $("product-network-completed").hidden = unreported;
    $("product-network-model-grid").classList.toggle("product-single", unreported);
    $("product-network-recent").hidden = network?.activityAvailable === false;
    $("product-completed-count").textContent = fresh ? unreported ? "Not reported" : network.completedToday : "—";
    $("product-completed-count").dataset.unreported = String(unreported);
    $("product-completed-unit").hidden = unreported;
    $("product-completed-note").textContent = unreported ? "This network endpoint reports availability and queues, but does not publish completed requests." : "Requests with verified delivered replies, including saved partial replies.";
    if (!network) return;
    $("product-network-models").innerHTML = network.models.map(m => `<div class="product-model-row"><div><strong>${esc(m.id)}</strong>${m.freeEligible === null ? "" : `<p>${m.freeEligible ? "Free credits eligible" : "Purchased credits"}</p>`}</div><div><p>${fresh && m.available ? `${m.providers} providers ${publicStatus ? "online" : "ready"}` : "Availability unconfirmed"}</p>${publicStatus ? "" : `<button data-network-model="${esc(m.id)}" ${fresh && m.available && m.selectable !== false ? "" : "disabled"}>Use model</button>`}</div></div>`).join("") || "<p>No models are currently reported.</p>";
    $("product-network-providers").innerHTML = network.providers.length ? network.providers.map(p => `<div class="product-detail"><span>Provider ${esc(p.id)} · ${esc(p.model)}</span><span>${fresh ? esc(p.state.replaceAll("-", " ")) : "Last seen — status stale"}</span></div>`).join("") : "<p>No recently observed providers.</p>";
    $("product-network-activity").innerHTML = network.activityAvailable === false ? "<p>This network endpoint does not publish completed replies.</p>" : network.activity.length ? network.activity.map(a => `<div class="product-detail"><span>Reply delivered · ${esc(a.model)}</span><time>${esc(new Date(a.at).toLocaleTimeString())}</time></div>`).join("") : "<p>No verified replies recorded today.</p>";
  }
  async function refreshNetwork() {
    if (networkPending || document.hidden) return; networkPending = true;
    try {
      let result;
      if (window.kaiKoinTestBridge) result = await window.kaiKoinTestBridge.run("network-overview");
      else {
        const response = await fetch("/core/network/overview", { signal: AbortSignal.timeout(15000) });
        result = await response.json();
        if (!response.ok) throw Error(result?.error || "Network status unavailable");
      }
      const n = result?.network, publicStatus = n?.source === "public-scheduler";
      if (!n || !Number.isSafeInteger(n.observedAt) || !Number.isSafeInteger(n.validUntil) || n.validUntil < n.observedAt || n.validUntil > n.observedAt + 15000 || !["available", "paused"].includes(n.state) ||
          ![publicStatus ? n.providersOnline : n.readyProviders, n.waitingRequests, ...(publicStatus && n.completedToday === null ? [] : [n.completedToday])].every(v => Number.isSafeInteger(v) && v >= 0) ||
          (publicStatus && (n.readyProviders !== null || n.activityAvailable !== false)) ||
          !Array.isArray(n.models) || n.models.length > 256 || n.models.some(m => typeof m.id !== "string" || typeof m.available !== "boolean" || (publicStatus ? m.freeEligible !== null || m.selectable !== false : typeof m.freeEligible !== "boolean") || !Number.isSafeInteger(m.providers) || m.providers < 0) ||
          !Array.isArray(n.providers) || n.providers.length > 256 || n.providers.some(p => typeof p.id !== "string" || typeof p.model !== "string" || typeof p.state !== "string") ||
          !Array.isArray(n.activity) || n.activity.length > 50 || n.activity.some(a => typeof a.model !== "string" || !Number.isSafeInteger(a.at))) throw Error("No verified network status available");
      network = n; networkError = "";
    } catch (e) { networkError = message(e); } finally { networkPending = false; paintNetwork(); }
  }
  let purchaseInfo = { activation: "loading" }, purchaseWallet = null, walletError = "", walletReading = false, purchaseReading = false;
  let previousLocalPurchase = false, modelPricingRead = null;
  let walletRead, purchaseRead, purchaseGeneration = 0, quoteWalletKey = null;
  let previewTimer, previewRead = null, previewSelection = null, previewRevision = 0, previewSupport = null, previewSupportRead = null, previewSupportError = false;
  const buyVisible = () => !document.hidden && !$("view-buy-credits").hidden;
  const message = error => String(error?.message || error || "Connection unavailable").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  const walletKey = () => purchaseWallet?.address ? JSON.stringify([purchaseWallet.address, purchaseWallet.network]) : null;
  const walletReady = () => !!purchaseWallet?.address && purchaseWallet.network === "mainnet" && typeof purchaseWallet.koin === "string";
  const amountAtoms = value => { const [whole, fraction = ""] = value.split("."); return BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, "0")); };
  function invalidateQuote(text) {
    quoteRevision++; previewRevision++; clearTimeout(previewTimer); quote = null; quoteWalletKey = null;
    $("product-quote-label").textContent = "Estimated KOIN payment";
    $("product-price-limit").hidden = true; $("product-price-limit").textContent = "";
    $("product-quote-koin").textContent = "Calculating…"; $("product-quote-time").textContent = "—"; $("product-quote-expiry").textContent = "—";
    $("product-quote-details").hidden = true; $("product-quote-details").open = false;
    if (text) $("product-quote-state").textContent = text;
  }
  function paintPurchase() {
    const wallet = purchaseWallet, state = purchaseInfo.activation;
    const saved = purchaseInfo.localPurchase, paymentDetail = $("product-local-payment");
    paymentDetail.hidden = !saved;
    paymentDetail.textContent = saved ? `${/^0x1220[a-f0-9]{64}$/.test(saved.txId || "") ? "Transaction: " + saved.txId : ""}${/^0x1220[a-f0-9]{64}$/.test(saved.cancellation?.txId || "") ? "\nCancellation: " + saved.cancellation.txId : ""}${saved.issue ? "\nReference: " + saved.issue : ""}` : "";
    if (saved) { $("product-quote-state").textContent = saved.detail || "Check the saved payment before starting another purchase."; $("product-price-limit").hidden = true; }
    else if (previousLocalPurchase) $("product-quote-state").textContent = "Saved payment check finished. See Balance & activity for the outcome.";
    previousLocalPurchase = !!saved;
    const previewNotice = $("product-price-preview-support");
    previewNotice.hidden = state !== "ready" || previewSupport === true || !!saved;
    if (!saved && !approving && !quoting && state === "ready" && previewSupport !== true && selectedAmount()) {
      if (quote) invalidateQuote();
      $("product-quote-koin").textContent = previewSupport === false || previewSupportError ? "Price unavailable" : "Calculating…";
      previewNotice.textContent = previewSupport === false || previewSupportError
        ? "Price preview is unavailable. Buy credits checks the exact KOIN payment before approval."
        : "Calculating the current price. The exact payment will appear in your wallet.";
    }
    const reviewing = approving || saved?.busy === true || saved?.state === "reviewing";
    const busy = reviewing || quoting;
    $("product-usd-amount").disabled = reviewing;
    document.querySelectorAll("[data-credit-pack]").forEach(button => { button.disabled = reviewing; });
    $("product-purchase-stop").hidden = !busy && saved?.state !== "checking";
    if (!saved) $("product-payment-recovery-status").hidden = true;
    // Wallet balances live in the sidebar and Wallet. Show only an actionable
    // blocker here; a healthy purchase needs no separate readiness panel.
    const walletIssue = !saved && !walletReading && state === "ready"
      ? walletError || (!wallet?.address ? "Set up or restore your wallet to pay with KOIN." : wallet.network !== "mainnet" ? "Credit purchases use KOIN on Mainnet. Change the wallet network before buying." : "") : "";
    const detail = state === "unavailable" ? "Credit purchases are not activated yet. Please try again later."
      : state === "signin-required" ? purchaseInfo.blocked || "Sign in to your credit account."
      : state === "error" ? purchaseInfo.blocked || "Purchasing availability could not be checked. Try again."
      : walletIssue;
    $("product-purchase-notice").hidden = !detail;
    $("product-purchase-detail").textContent = detail;
    const check = $("product-purchase-check");
    check.hidden = !walletError && state !== "unavailable";
    check.disabled = purchaseReading || walletReading;
    $("product-purchase-signin").hidden = state !== "signin-required";
    $("product-purchase-wallet").hidden = !walletIssue || !!walletError;
    const refresh = $("product-quote-refresh");
    refresh.disabled = busy || !["ready", "error"].includes(state) || (state === "ready" && !saved && (!walletReady() || walletReading));
    refresh.textContent = state === "loading" ? "Checking availability…" : state === "unavailable" ? "Purchases not activated" : state === "signin-required" ? "Account setup required" : state === "error" ? "Try again" : state !== "ready" ? "Purchasing unavailable" : quoting ? "Getting current price…" : approving ? "Waiting for wallet…" : saved?.busy ? "Payment review in progress…" : saved ? saved.recovery ? "Continue payment" : "Check payment" : !walletReady() ? "Payment wallet required" : "Buy credits";

  }
  async function refreshPurchaseWallet() {
    if (walletRead) return walletRead;
    const generation = purchaseGeneration; walletReading = true; paintPurchase();
    walletRead = (async () => {
      const oldKey = walletKey();
      try {
        const response = await fetch("/core/koinos/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "wallet:summary", payload: {} }), signal: AbortSignal.timeout(15000) });
        const result = await response.json(), value = result.data;
        if (!response.ok || !result.ok || !value || typeof value.network !== "string" || typeof value.tokenSymbol !== "string" ||
            !(value.address === null || typeof value.address === "string" && value.address.length > 0) ||
            (value.address && (typeof value.koin !== "string" || !/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(value.koin)))) throw Error(result.error || "Wallet balance could not be verified. Refresh to try again.");
        if (generation !== purchaseGeneration) return;
        purchaseWallet = value; walletError = "";
      } catch (error) {
        if (generation !== purchaseGeneration) return;
        purchaseWallet = null; walletError = message(error);
      } finally {
        if (generation === purchaseGeneration) {
          walletReading = false; walletRead = null;
          if (oldKey !== walletKey() && (oldKey !== null || quote || quoting)) invalidateQuote(purchaseInfo.activation === "ready" ? "Wallet updated. Check the balance, then choose Buy credits." : undefined);
          paintPurchase();
        }
      }
    })();
    return walletRead;
  }
  async function purchaseReadOnly(action) {
    let timer;
    try {
      return await Promise.race([window.kaiKoinTestBridge.run(action), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(action === "model-pricing" ? "Model prices could not be reached. Reopen Buy credits to try again." : "Payment status could not be reached. Try again; any saved payment is preserved.")), 12000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function refreshPurchaseInfo() {
    if (purchaseRead) return purchaseRead;
    const generation = purchaseGeneration; purchaseReading = true; paintPurchase();
    purchaseRead = Promise.resolve().then(() => {
      if (!window.kaiKoinTestBridge) throw Error("Open the desktop app to buy credits.");
      return purchaseReadOnly("purchase-info");
    }).then(info => {
      if (generation !== purchaseGeneration) return;
      if (!["ready", "unavailable", "signin-required"].includes(info?.activation)) throw Error("Purchasing availability could not be verified.");
      purchaseInfo = info;
      if (window.KaiCredits) paintCredits(window.KaiCredits.get());
      if (info.activation !== "ready") invalidateQuote(info.activation === "unavailable" ? "Purchasing will be available when the credit service is activated." : info.blocked);
    }).catch(error => { if (generation === purchaseGeneration) { purchaseInfo = { ...purchaseInfo, activation: "error", blocked: message(error) }; invalidateQuote("Purchasing availability must be verified before payment."); } })
      .finally(() => { if (generation === purchaseGeneration) { purchaseReading = false; purchaseRead = null; paintPurchase(); } });
    return purchaseRead;
  }
  async function refreshPurchaseCapabilities() {
    if (previewSupportRead) return previewSupportRead;
    const generation = purchaseGeneration;
    const pending = purchaseReadOnly("purchase-capabilities").then(result => {
      if (generation !== purchaseGeneration) return;
      previewSupport = result?.purchasePricePreview === true; previewSupportError = false;
    }).catch(() => { if (generation === purchaseGeneration) { previewSupport = null; previewSupportError = true; } })
      .finally(() => {
        if (previewSupportRead === pending) previewSupportRead = null;
        if (generation === purchaseGeneration) { paintPurchase(); schedulePreview(0); }
      });
    previewSupportRead = pending; return pending;
  }
  const refreshPurchases = () => {
    // Capability lookup must never hold the purchase button or saved recovery.
    void refreshPurchaseCapabilities();
    return Promise.all([refreshPurchaseWallet(), refreshPurchaseInfo()]);
  };
  async function refreshModelPricing() {
    if (modelPricingRead) return modelPricingRead;
    const generation = purchaseGeneration;
    const status = $("product-model-pricing-status"), table = $("product-model-pricing-table"), rows = $("product-model-pricing-rows");
    status.textContent = "Loading model prices…";
    const decimal = value => typeof value === "string" && /^(0|[1-9]\d{0,23})(\.\d{1,8})?$/.test(value);
    const format = value => { const [whole, fraction] = value.split("."); const locale = document.documentElement.lang || "en", separator = new Intl.NumberFormat(locale).formatToParts(1.1).find(part => part.type === "decimal").value; return BigInt(whole).toLocaleString(locale) + (fraction ? separator + fraction : ""); };
    const pending = purchaseReadOnly("model-pricing").then(pricing => {
      if (generation !== purchaseGeneration) return;
      if (!pricing || pricing.schema !== 1 || pricing.product !== "prepaid-usd-v1" || !/^[a-f0-9]{64}$/.test(pricing.policyHash || "") || !Number.isSafeInteger(pricing.observedAt) || pricing.observedAt > Date.now() + 5000 || !Array.isArray(pricing.models) || !pricing.models.length || pricing.models.length > 256 ||
          pricing.models.some(model => typeof model.model !== "string" || !model.model || model.model.length > 128 || typeof model.label !== "string" || !model.label || model.label.length > 128 || ![model.inputCreditsPerMillion, model.outputCreditsPerMillion, model.inputUsdPerMillion, model.outputUsdPerMillion].every(decimal))) throw Error("Model prices could not be verified.");
      rows.innerHTML = pricing.models.map(model => `<tr><th scope="row">${esc(model.label)}</th><td><strong>${esc(format(model.inputCreditsPerMillion))} credits</strong><small>$${esc(format(model.inputUsdPerMillion))}</small></td><td><strong>${esc(format(model.outputCreditsPerMillion))} credits</strong><small>$${esc(format(model.outputUsdPerMillion))}</small></td></tr>`).join("");
      table.hidden = false; status.textContent = "1,000 credits = $1 of AI usage. These are configured model prices; network availability may vary.";
    }).catch(error => {
      if (generation !== purchaseGeneration) return;
      table.hidden = true; rows.replaceChildren(); status.textContent = message(error);
    }).finally(() => { if (modelPricingRead === pending) modelPricingRead = null; });
    modelPricingRead = pending; return pending;
  }
  function selectedAmount() {
    const raw = $("product-usd-amount").value.trim();
    return /^(0|[1-9]\d{0,5})(\.\d{1,2})?$/.test(raw) && Number(raw) > 0 ? raw : null;
  }
  function showQuote(value, key, estimate = false) {
    if (!value || (!estimate && typeof value.id !== "string") || typeof value.koin !== "string" || !/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(value.koin) || !Number.isSafeInteger(value.observedAt) || !Number.isSafeInteger(value.expiresAt) || value.observedAt > Date.now() + 5000 || value.expiresAt <= Date.now()) throw Error("The price could not be verified. It will refresh automatically.");
    const price = value.priceDetails, marketEstimate = estimate && price?.referenceKind === "market-estimate";
    if (!price || typeof price.usdPerKoin !== "string" || !/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(price.usdPerKoin) || amountAtoms(price.usdPerKoin) <= 0n ||
        !Number.isSafeInteger(price.windowSeconds) || (marketEstimate ? price.windowSeconds !== 0 : price.windowSeconds < 1 || price.windowSeconds > 86400) ||
        !(marketEstimate || ["merchant-exchange-reference", "signed-parity"].includes(price.referenceKind))) throw Error("The price could not be verified. It will refresh automatically.");
    if (value.withinPaymentLimit !== undefined && (typeof value.withinPaymentLimit !== "boolean" || typeof value.paymentLimitKoin !== "string" || !/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(value.paymentLimitKoin) || amountAtoms(value.paymentLimitKoin) <= 0n || value.withinPaymentLimit !== (amountAtoms(value.koin) <= amountAtoms(value.paymentLimitKoin)))) throw Error("The payment limit could not be verified. It will refresh automatically.");
    quote = value; quoteWalletKey = key;
    $("product-price-limit").hidden = value.withinPaymentLimit !== false;
    $("product-price-limit").textContent = value.withinPaymentLimit === false ? `This exceeds the ${value.paymentLimitKoin} KOIN purchase limit. Choose a smaller USD amount.` : "";
    if (typeof quote.credits === "string" && /^(0|[1-9]\d*)(\.\d{1,5})?$/.test(quote.credits)) {
      const [whole, fraction] = quote.credits.split("."), locale = document.documentElement.lang || "en";
      const separator = new Intl.NumberFormat(locale).formatToParts(1.1).find(part => part.type === "decimal").value;
      $("product-pack-credits").textContent = BigInt(whole).toLocaleString(locale) + (fraction ? separator + fraction : "");
    }
    $("product-quote-label").textContent = estimate ? "Estimated KOIN payment" : "KOIN payment";
    $("product-quote-koin").textContent = (marketEstimate ? "~" : "") + quote.koin + " KOIN"; $("product-quote-time").textContent = new Date(quote.observedAt).toLocaleString(); $("product-quote-expiry").textContent = new Date(quote.expiresAt).toLocaleTimeString();
    $("product-quote-rate").textContent = `1 KOIN = $${price.usdPerKoin}`;
    $("product-quote-reference").textContent = marketEstimate ? "Market estimate; the exact KOIN payment is shown in your wallet before approval." : price.referenceKind === "merchant-exchange-reference" ? "KOIN purchases use the vKOIN/USDT exchange reference under the published pricing policy." : "The vKOIN/USDT exchange reference includes a verified KOIN parity attestation.";
    $("product-quote-window").textContent = marketEstimate ? "The estimate uses the exchange price at a finalized Ethereum block and a verified USDT/USD feed." : `Exchange averaging window: ${price.windowSeconds % 60 === 0 ? `${price.windowSeconds / 60} minutes` : `${price.windowSeconds} seconds`}. USDT is converted to USD using the pricing service’s verified feed.`;
    $("product-quote-details").hidden = false;
  }
  const canPreview = () => previewSupport === true && buyVisible() && !approving && !quoting && !purchaseInfo.localPurchase && purchaseInfo.activation === "ready" && walletReady() && !walletReading;
  function schedulePreview(delay = 350) {
    clearTimeout(previewTimer);
    if (!canPreview() || !selectedAmount()) return;
    if (delay === 0) void refreshPreview();
    else previewTimer = setTimeout(() => { void refreshPreview(); }, delay);
  }
  async function refreshPreview() {
    if (!canPreview()) return;
    const usd = selectedAmount(); if (!usd) return;
    // Coalesce pending read-only estimates. A changed amount or hidden page
    // cannot accept a late response for an older selection.
    if (previewRead) {
      if (previewSelection?.usd === usd && previewSelection?.key === walletKey() && previewSelection?.revision === previewRevision) return previewRead;
      await previewRead; if (canPreview()) schedulePreview(0); return;
    }
    const revision = previewRevision, generation = purchaseGeneration, key = walletKey();
    const current = () => revision === previewRevision && generation === purchaseGeneration && key === walletKey() && usd === selectedAmount() && canPreview();
    if (!quote) $("product-quote-state").textContent = "Calculating the current KOIN payment…";
    const pending = Promise.resolve().then(() => window.kaiKoinTestBridge.run("purchase-estimate", { usd })).then(result => {
      if (!current()) return;
      showQuote(result?.estimate, key, true);
      $("product-quote-state").textContent = result.estimate.priceDetails.referenceKind === "market-estimate" ? "Market estimate updates every 30 seconds. The exact payment is shown in your wallet before approval." : "Price updates every 30 seconds. You’ll approve the exact KOIN payment in your wallet.";
    }).catch(error => {
      if (!current()) return;
      // Do not leave an old price looking current after a failed refresh.
      invalidateQuote(); $("product-quote-koin").textContent = "Price unavailable";
      $("product-quote-state").textContent = message(error) + " Price refresh retries automatically; Buy credits also checks again.";
    }).finally(() => { if (previewRead === pending) previewRead = null; });
    previewSelection = { usd, key, revision }; previewRead = pending; return pending;
  }
  function pack() {
    const raw = selectedAmount();
    invalidateQuote(raw ? previewSupport === true ? "Calculating the current KOIN payment…" : "Choose Buy credits to check the exact KOIN payment in your wallet." : "Choose a positive USD amount with up to two decimal places.");
    $("product-quote-koin").textContent = raw ? "Calculating…" : "—";
    $("product-pack-credits").textContent = raw ? (Number(raw) * 1000).toLocaleString() : "—";
    document.querySelectorAll("[data-credit-pack]").forEach(button => button.classList.toggle("selected", raw !== null && Number(button.dataset.creditPack) === Number(raw)));
    paintPurchase(); schedulePreview(); return raw;
  }
  $("product-purchase-check").addEventListener("click", async () => { await refreshPurchases(); schedulePreview(0); });
  let paymentOperation = 0;
  $("product-usd-amount").addEventListener("input", pack);
  $("product-purchase-stop").addEventListener("click", async () => {
    const stop = $("product-purchase-stop"); stop.disabled = true; paymentOperation++;
    try {
      await window.kaiKoinTestBridge.run("purchase-stop");
      approving = quoting = false;
      invalidateQuote("Payment check stopped. Any signed payment remains saved and will be checked automatically.");
      await refreshPurchaseInfo();
    } catch (error) { $("product-quote-state").textContent = message(error); }
    finally { stop.disabled = false; paintPurchase(); }
  });
  $("product-quote-refresh").addEventListener("click", async () => {
    if (approving || quoting || $("product-quote-refresh").disabled) return;
    const operation = ++paymentOperation, generation = purchaseGeneration;
    const current = () => operation === paymentOperation && generation === purchaseGeneration;
    if (purchaseInfo.activation !== "ready") { await refreshPurchases(); return; }
    const pending = purchaseInfo.localPurchase;
    if (pending && !pending.recovery) { await refreshPurchaseInfo(); return; }
    if (pending) {
      approving = true; invalidateQuote(); paintPurchase();
      const notice = $("product-payment-recovery-status"); notice.hidden = false;
      notice.textContent = "Continuing the saved payment. Review your wallet prompt if one is needed.";
      try {
        const result = await window.kaiKoinTestBridge.run("credit-purchase-retry");
        if (!current()) return;
        notice.textContent = result.state === "cancelled" ? "Wallet review closed. Your saved payment is unchanged." : result.state === "complete" ? "Payment check complete." : "Waiting for blockchain confirmation. This updates automatically.";
        await Promise.all([window.KaiCredits.refresh(), refreshPurchases()]);
      } catch (error) { if (current()) { notice.hidden = false; notice.textContent = message(error); } }
      finally { if (current()) { approving = false; paintPurchase(); } }
      return;
    }
    const usd = selectedAmount();
    if (!usd) { $("product-quote-state").textContent = "Choose a positive USD amount with up to two decimal places."; $("product-usd-amount").focus(); return; }
    clearTimeout(previewTimer); previewRevision++;
    const revision = quoteRevision, key = walletKey(); quoting = true; paintPurchase();
    const selectionCurrent = () => current() && revision === quoteRevision && key === walletKey();
    try {
      // The display estimate is read-only; only this click requests a signed
      // quote and the native approval always uses that exact verified price.
      const r = await window.kaiKoinTestBridge.run("purchase-preview", { usd });
      if (!selectionCurrent()) return;
      showQuote(r?.quote, key);
      // Refresh read-only state before handing the same exact quote to native
      // review. A changed account, wallet, amount or saved payment cancels it.
      await refreshPurchases();
      if (!selectionCurrent() || purchaseInfo.localPurchase || purchaseInfo.activation !== "ready" || !walletReady()) return;
      if (Date.now() >= quote.expiresAt) throw Error("The price expired before payment. Try Buy credits again.");
      if (amountAtoms(purchaseWallet.koin) < amountAtoms(quote.koin)) throw Error("Not enough KOIN for this amount. Choose a smaller amount or add KOIN to your wallet.");
      quoting = false; approving = true; paintPurchase();
      $("product-quote-state").textContent = "Approve the exact KOIN payment in your wallet.";
      const result = await window.kaiKoinTestBridge.run("purchase-approve", quote.id);
      if (!current()) return;
      invalidateQuote(result.state === "cancelled" ? "Payment cancelled. No new purchase was started." : "Checking your payment. Credits appear automatically after confirmation.");
      await Promise.all([window.KaiCredits.refresh(), refreshPurchases()]);
    } catch (error) { if (current()) $("product-quote-state").textContent = message(error); }
    finally { if (current()) { quoting = approving = false; paintPurchase(); } }
  });
  for (const name of ["kai-account-signed-out", "kai-credit-identity-changed"]) window.addEventListener(name, () => {
    purchaseGeneration++; paymentOperation++; modelPricingRead = null; $("product-model-pricing-table").hidden = true; $("product-model-pricing-rows").replaceChildren(); $("product-model-pricing-status").textContent = "Loading model prices…"; previewSupport = null; previewSupportError = false; previewSupportRead = null; quoting = approving = false; walletRead = purchaseRead = null; walletReading = purchaseReading = false; purchaseWallet = null;
    purchaseInfo = { activation: "loading" }; invalidateQuote("Account changed. Check your payment wallet before buying."); paintPurchase();
    if (buyVisible()) { refreshPurchases().then(() => schedulePreview(0)); refreshModelPricing(); }
  });
  document.addEventListener("visibilitychange", () => {
    clearTimeout(previewTimer); previewRevision++;
    if (buyVisible()) refreshPurchases().then(() => schedulePreview(0));
  });
  setInterval(() => { if (buyVisible() && !approving && !quoting) refreshPurchases().then(() => schedulePreview(0)); }, 30000);
  setInterval(() => { if (buyVisible() && purchaseInfo.localPurchase && !approving && !quoting) { refreshPurchaseInfo(); window.KaiCredits?.refresh(); } }, 5000);
  document.addEventListener("click", async event => {
    const view = event.target.closest("[data-product-view]"); if (view) return go(view.dataset.productView);
    const p = event.target.closest("[data-credit-pack]"); if (p) { $("product-usd-amount").value = p.dataset.creditPack; pack(); document.querySelectorAll("[data-credit-pack]").forEach(b => b.classList.toggle("selected", b === p)); return; }
    const f = event.target.closest("[data-activity-filter]"); if (f) { filter = f.dataset.activityFilter; document.querySelectorAll("[data-activity-filter]").forEach(b => b.classList.toggle("active", b === f)); paintCredits(window.KaiCredits.get()); return; }
    const model = event.target.closest("[data-network-model]"); if (model && !model.disabled) { go("chat"); window.dispatchEvent(new CustomEvent("kai-network-use", { detail: { model: model.dataset.networkModel } })); return; }
    const action = event.target.closest("[data-product-action]")?.dataset.productAction; if (!action) return;
    if (action === "payment-wallet") await openPaymentWallet();
    if (action === "legacy") { go("recovery"); legacy.open = true; $("view-recovery").scrollTop = legacy.offsetTop - $("view-recovery").offsetTop; }
    if (action === "provider-reload") { await refreshPublicProvider(true); }
    if (action === "provider-download") { await providerAction("download"); }
    if (action === "provider-cancel") { await providerAction("stop"); }
    if (action === "purchase-retry") {
      const target = event.target.closest("button"); target.disabled = true;
      try { const result = await window.kaiKoinTestBridge.run("credit-purchase-retry"); $("product-recovery-purchase").textContent = result.state === "cancelled" ? "Review cancelled. Any saved transaction remains preserved." : result.state === "complete" ? "No unfinished local payment remains. Refreshing your credit account." : "The saved payment is awaiting confirmation. Existing credits remain available."; await window.KaiCredits.refresh(); }
      catch (e) { $("product-recovery-purchase").textContent = e.message; }
      finally { target.disabled = false; }
    }
    if (action === "payouts") {
      const node = $("product-provider-earnings"); node.textContent = "Checking reward history…";
      try {
        const result = await window.kaiKoinTestBridge.run("provider-public-earnings");
        const koin = atoms => { const n = BigInt(atoms); return `${n / 100000000n}.${(n % 100000000n).toString().padStart(8, "0")}`; };
        node.textContent = result.payouts.length ? result.payouts.map(p => `Day ${p.epoch} · ${koin(String(BigInt(p.availability) + BigInt(p.work)))} KOIN · ${p.state.replaceAll("_", " ")}`).join(" · ") : "No recorded payouts for this reward wallet yet.";
        node.textContent += ` Observed ${new Date(result.observedAt).toLocaleString()}.`;
        if (!result.lastCycleCheck || Date.now() - result.lastCycleCheck > 60000) node.textContent += " Reward processing is not freshly confirmed.";
      } catch (e) { node.textContent = "Reward history unavailable. " + e.message; }
    }
    if (action === "recover") { go("chat"); window.dispatchEvent(new Event("kai-network-recover")); }
    if (action === "first-back") { oldOnboarding.hidden = true; onboarding.querySelector(".product-first").scrollIntoView({ block: "start" }); }
    if (action === "setup-local") { oldOnboarding.hidden = false; oldOnboarding.scrollIntoView({ block: "start" }); }
    if (action === "signin") { void window.selectAccountScope?.(false); go("settings"); $("btn-account-signin").scrollIntoView({ block: "center" }); }
    if (action === "start-free") { go("chat"); window.dispatchEvent(new Event("kai-network-use")); }
    if (action === "local") { go("chat"); $("src-pick").value = "local"; $("src-pick").dispatchEvent(new Event("change")); }
  });
  const providerCheck = window.KaiProviderCheckUI.create({ root: $("product-provider-check"), bridge: window.kaiProviderCheckBridge });
  let providerBusy = false, providerInfoPending = false, providerExpiry, providerManualRefresh = false, providerGeneration = 0, providerReadRevision = 0, providerActionRevision = 0;
  let providerModelInfo = null, providerModelStatus = null, providerSelectionDraft = null, providerSelectionSaved = null, providerSelectionNotice = "", providerModelsStale = true;
  const selectionKey = selection => JSON.stringify([selection.mode, [...selection.models].sort()]);
  const selectedProviderModels = (selection, models) => new Set(selection?.mode === "all" ? models.filter(model => model.compatible).map(model => model.id) : selection?.models || []);
  function providerModelRows(info = providerModelInfo) {
    return (info?.modelAvailability || (info?.models || []).filter(model => model.installed).map(model => ({ ...model, compatible: true })))
      .filter(model => model.installed && typeof model.id === "string" && /^[a-zA-Z0-9._-]{1,100}$/.test(model.id)).slice(0, 64);
  }
  function acceptProviderModels(info) {
    const selection = info.selection;
    if (!selection || !["all", "selected"].includes(selection.mode) || !Array.isArray(selection.models) || selection.models.some(id => typeof id !== "string")) {
      providerModelInfo = null; $("product-provider-models").hidden = true; $("product-provider-models-open").hidden = true; return;
    }
    if (!providerSelectionSaved || selectionKey(providerSelectionSaved) !== selectionKey(selection)) {
      providerSelectionDraft = structuredClone(selection); providerSelectionSaved = structuredClone(selection);
    }
    providerModelInfo = info; $("product-provider-models").hidden = false; $("product-provider-models-open").hidden = false;
  }
  function currentProviderRows(status = providerModelStatus) {
    return (Array.isArray(status?.models) ? status.models : status?.model ? [status] : [])
      .filter(row => Number.isSafeInteger(row.validUntil) && row.validUntil > Date.now());
  }
  function selectedProviderStatus(info, status) {
    if (!info.selection || !info.running) return status;
    if (providerBusy) return { state: "checking", label: "UPDATING SHARING", detail: "Finishing current work before updating the shared models." };
    const selected = selectedProviderModels(info.selection, providerModelRows(info)), offered = new Set(info.offeredModels || []);
    const rows = currentProviderRows(status).filter(row => selected.has(row.model) && offered.has(row.model));
    const ready = rows.find(row => row.state === "online");
    if (ready) return { ...status, ...ready, label: "ONLINE" };
    const checking = rows.find(row => ["qualifying", "preparing", "connecting"].includes(row.state));
    if (checking) return { ...status, ...checking, label: "CHECKING MODELS" };
    return { ...status, state: "checking", label: "WAITING FOR NETWORK", qualification: undefined,
      detail: "Sharing is on. None of your selected models is ready for paid work yet. See each model’s network status below." };
  }
  function paintProviderModels() {
    const info = providerModelInfo; if (!info?.selection || !providerSelectionDraft) return;
    const models = providerModelRows(), selected = selectedProviderModels(info.selection, models), draft = selectedProviderModels(providerSelectionDraft, models);
    const offered = new Set(info.offeredModels || []), states = new Map(currentProviderRows().map(row => [row.model, row]));
    const dirty = selectionKey(providerSelectionDraft) !== selectionKey(info.selection);
    const ready = !providerModelsStale && !providerBusy && info.running ? models.filter(model => model.compatible && selected.has(model.id) && offered.has(model.id) && states.get(model.id)?.state === "online").length : 0;
    const chosen = models.filter(model => model.compatible && selected.has(model.id)).length;
    $("product-provider-share-all").checked = providerSelectionDraft.mode === "all";
    $("product-provider-share-all").disabled = providerBusy;
    $("product-provider-model-summary").textContent = info.enabled
      ? `${chosen} selected · ${ready} ready for paid work${!ready ? ". No selected model is currently confirmed ready." : "."}`
      : `${chosen} selected. Earning is off.`;
    $("product-provider-model").textContent = info.selection.mode === "all" ? `All compatible installed models (${chosen})` : `${chosen} model${chosen === 1 ? "" : "s"} selected`;
    if (!providerBusy && !providerModelsStale) $("product-provider-readiness").textContent = !info.enabled ? "Earning is off. Your model selection is saved." : ready ? `${ready} of ${chosen} selected models qualified and ready for paid work.` : "No selected model is ready for paid work. Each model needs network qualification and approval.";
    const active = document.activeElement?.dataset.providerSharedModel;
    $("product-provider-model-list").innerHTML = models.map(model => {
      const row = states.get(model.id); let label, detail = "", state = "off";
      if (!model.compatible) { label = "Not compatible"; detail = model.reason || "This installed model cannot be offered to this network."; state = "blocked"; }
      else if (dirty && draft.has(model.id) !== selected.has(model.id)) { label = draft.has(model.id) ? "Will share after Apply" : "Will stop sharing after Apply"; state = "checking"; }
      else if (!selected.has(model.id)) label = "Not shared";
      else if (providerBusy) { label = "Updating sharing…"; state = "checking"; }
      else if (!info.enabled) label = "Selected · earning off";
      else if (!info.running || providerModelsStale) { label = "Checking connection"; state = "checking"; }
      else if (!offered.has(model.id)) { label = "Waiting to be offered"; state = "checking"; }
      else if (row?.state === "online") { label = "Available for paid work"; state = "online"; }
      else if (row?.state === "review-required") { label = "Network approval needed"; detail = row.detail || "The network has not approved this model for paid work."; state = "blocked"; }
      else if (row?.state === "update-required") { label = "App update needed"; detail = row.detail; state = "blocked"; }
      else if (row?.state === "qualification-failed") { label = "Network check not passed"; detail = "Another network check runs automatically."; state = "blocked"; }
      else if (row?.state === "qualifying") { label = "Checking model"; detail = row.qualification ? `${row.qualification.passed}/${row.qualification.total} checks passed` : "The network is checking this model."; state = "checking"; }
      else if (row?.state === "preparing") { label = "Preparing model"; state = "checking"; }
      else if (row?.state === "network-paused") { label = "Network reconnecting"; state = "checking"; }
      else { label = "Waiting for network qualification"; state = "checking"; }
      return `<div class="product-provider-model-row" data-shared-model="${esc(model.id)}"><label><input type="checkbox" data-provider-shared-model="${esc(model.id)}" ${draft.has(model.id) && model.compatible ? "checked" : ""} ${providerBusy || !model.compatible ? "disabled" : ""} /><span>${esc(model.label || model.id)}</span></label><div><span class="product-model-status" data-state="${state}">${esc(label)}</span>${detail ? `<small>${esc(detail)}</small>` : ""}</div></div>`;
    }).join("") || '<p class="product-fine">No compatible installed models found.</p>';
    if (active) $("product-provider-model-list").querySelector(`[data-provider-shared-model="${CSS.escape(active)}"]`)?.focus({ preventScroll: true });
    const notice = $("product-provider-selection-status");
    notice.textContent = providerBusy ? "Finishing current work before updating the shared models. Stop earning remains available." : providerSelectionNotice || (dirty ? "Changes are not applied yet. Choose at least one model, then Apply selection." : "");
    notice.hidden = !notice.textContent;
    $("product-provider-selection-actions").hidden = !dirty;
    $("product-provider-models-apply").disabled = providerBusy || !models.some(model => model.compatible && draft.has(model.id));
    $("product-provider-models-reset").disabled = providerBusy;
  }
  $("product-provider-models-open").addEventListener("click", () => { $("product-provider-models").scrollIntoView({ block: "start" }); $("product-provider-share-all").focus({ preventScroll: true }); });
  $("product-provider-share-all").addEventListener("change", event => {
    providerSelectionDraft = event.target.checked ? { mode: "all", models: [] } : { mode: "selected", models: [] };
    providerSelectionNotice = ""; paintProviderModels();
  });
  $("product-provider-model-list").addEventListener("change", event => {
    const input = event.target.closest("[data-provider-shared-model]"); if (!input || providerBusy || !providerModelInfo) return;
    const selected = selectedProviderModels(providerSelectionDraft, providerModelRows());
    if (input.checked) selected.add(input.dataset.providerSharedModel); else selected.delete(input.dataset.providerSharedModel);
    providerSelectionDraft = { mode: "selected", models: [...selected] }; providerSelectionNotice = ""; paintProviderModels();
  });
  $("product-provider-models-reset").addEventListener("click", () => { providerSelectionDraft = structuredClone(providerModelInfo.selection); providerSelectionNotice = ""; paintProviderModels(); });
  $("product-provider-models-apply").addEventListener("click", () => providerAction("models", structuredClone(providerSelectionDraft)));

  const providerMessage = error => {
    const detail = String(error?.message || error || "Provider setup could not be reached.").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
    return /Unexpected token.*<|<!DOCTYPE/i.test(detail)
      ? "The credit service returned a web page instead of setup data. Check the connection, then reload setup."
      : detail;
  };
  async function providerRead(action) {
    let timer;
    try {
      // The native request has its own network deadline. Also bound the UI
      // wait so a lost IPC reply cannot make every later Reload a silent no-op.
      return await Promise.race([window.kaiKoinTestBridge.run(action), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Setup check timed out. Click Reload setup to try again.")), 15000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function refreshPublicProvider(manual = false) {
    const reload = $("product-provider-reload"), notice = $("product-provider-refresh");
    if (manual) {
      providerManualRefresh = true; notice.hidden = false; notice.textContent = "Checking account, wallet and model setup…";
    }
    if (providerInfoPending) return;
    if (!window.kaiKoinTestBridge) {
      notice.hidden = false; notice.textContent = "Open the desktop app to check provider setup.";
      providerManualRefresh = false; return;
    }
    const generation = providerGeneration, revision = providerReadRevision;
    const current = () => generation === providerGeneration && revision === providerReadRevision;
    providerInfoPending = true; reload.textContent = "Checking setup…"; reload.setAttribute("aria-busy", "true");
    let failed = false;
    try {
      const info = await providerRead("provider-public-info"); if (!current()) return; publicProvider = true; acceptProviderModels(info);
      const on = info.enabled === true, toggle = $("product-provider-toggle");
      toggle.textContent = on ? "Stop earning" : "Start earning"; toggle.setAttribute("aria-checked", String(on)); $("product-provider-start-hint").hidden = on;
      toggle.disabled = on ? false : providerBusy || info.state !== "ready";
      $("product-provider-model").textContent = Array.isArray(info.offeredModels) && info.offeredModels.length ? "Installed: " + (info.models || []).filter(m => info.offeredModels.includes(m.id)).map(m => m.label || m.id).join(" · ") : info.model?.label || "Checking installed models";
      $("product-provider-model-choice").hidden = info.automatic === true;
      const choices = info.models || (info.model ? [info.model] : []), picker = $("product-provider-model-pick");
      picker.innerHTML = `${info.model ? "" : '<option value="">Choose a provider model</option>'}` + choices.map(m => `<option value="${esc(m.id)}">${esc(m.label || m.id)}${m.installed ? "" : " · download required"}</option>`).join("");
      picker.value = info.model?.id || "";
      picker.disabled = on || providerBusy || !choices.length || !["ready", "model-required", "download-required"].includes(info.state);
      const setup = info.running && !info.blocked ? "Sharing is on. Installed supported models load automatically when needed." : providerMessage(info.blocked || info.detail);
      $("product-provider-setup").textContent = setup + (info.model && !info.running ? ` Required memory: ${info.model.requiredRamGb} GB.${!info.model.installed && Number.isFinite(info.model.bytes) ? " Download: " + (info.model.bytes / 1e9).toFixed(2) + " GB." : ""}` : "") + (info.progress ? ` ${info.progress.pct}% downloaded.` : "");
      $("product-provider-download").hidden = info.state !== "download-required";
      $("product-provider-download").disabled = providerBusy;
      $("product-provider-cancel").hidden = !providerBusy;
      let status = info.running ? await providerRead("provider-public-status") : {
        state: "offline", label: on ? "RECONNECTING" : info.state === "ready" ? "OFFLINE" : "SETUP REQUIRED",
        detail: on || info.state !== "ready" ? providerMessage(info.blocked || info.detail) : "Ready to share. Start earning prepares the models and connects automatically."
      };
      if (!current()) return;
      providerModelStatus = status; providerModelsStale = false;
      status = selectedProviderStatus(info, status);
      clearTimeout(providerExpiry);
      const paint = value => {
        $("product-provider-label").textContent = value.label; $("product-provider-label").dataset.state = value.state;
        $("product-provider-detail").textContent = value.detail;
        const progress = $("product-provider-qualification"), q = value.qualification;
        progress.hidden = !q; progress.textContent = "";
        if (q) {
          const model = info.models?.find(m => m.id === value.model)?.label || value.model;
          progress.textContent = `Network check: ${q.passed}/${q.total} passed · ${q.completed}/${q.total} completed${model ? ` · ${model}` : ""}.`;
          if (q.state === "failed" && Number.isSafeInteger(q.retryAt)) {
            const at = new Date(q.retryAt).toLocaleTimeString();
            progress.textContent += q.retryAt > Date.now() ? ` Automatic retry scheduled for ${at}.` : ` Retry was scheduled for ${at}; waiting for the next network check.`;
          }
        }
        $("product-provider-readiness").textContent = value.state === "online" ? "Model ready · qualification current · fresh network confirmation" : q
          ? "The local check is diagnostic. Paid work needs a passing network check."
          : "Readiness is not confirmed. " + value.detail;
      };
      paint(status); paintProviderModels();
      const expiries = [status.validUntil, ...currentProviderRows().map(row => row.validUntil)].filter(Number.isSafeInteger);
      if (expiries.length) providerExpiry = setTimeout(() => {
        providerModelsStale = true; paintProviderModels();
        paint({ state: "stale", label: "CHECKING CONNECTION", detail: "Network confirmation has expired. Refreshing eligibility…" });
      }, Math.max(0, Math.min(...expiries) - Date.now()));
    } catch (e) {
      if (!current()) return;
      providerModelsStale = true; paintProviderModels();
      failed = true; publicProvider = true; clearTimeout(providerExpiry);
      $("product-provider-qualification").hidden = true; $("product-provider-qualification").textContent = "";
      $("product-provider-model-pick").disabled = true;
      if ($("product-provider-toggle").getAttribute("aria-checked") !== "true") $("product-provider-toggle").disabled = true;
      $("product-provider-label").textContent = "CONNECTION UNCONFIRMED"; $("product-provider-label").dataset.state = "stale";
      $("product-provider-detail").textContent = providerMessage(e); $("product-provider-setup").textContent = providerMessage(e);
      $("product-provider-readiness").textContent = "Readiness is not confirmed. Waiting for a fresh network status update.";
      $("product-provider-download").hidden = true;
    } finally {
      if (!current()) return;
      providerInfoPending = false; reload.textContent = "Reload setup"; reload.removeAttribute("aria-busy");
      if (providerManualRefresh) {
        notice.hidden = false;
        notice.textContent = failed ? "Setup check failed. You can retry with Reload setup." : "Setup checked at " + new Date().toLocaleTimeString() + ".";
      }
      providerManualRefresh = false;
    }
  }
  async function providerAction(action, input) {
    if (providerBusy && action !== "stop") return;
    if (action !== "stop") providerBusy = true;
    const generation = providerGeneration, operation = ++providerActionRevision;
    const current = () => generation === providerGeneration && operation === providerActionRevision;
    providerReadRevision++; providerInfoPending = false;
    if (action === "models") { providerModelsStale = true; providerModelStatus = null; clearTimeout(providerExpiry); $("product-provider-label").textContent = "UPDATING SHARING"; $("product-provider-label").dataset.state = "checking"; $("product-provider-readiness").textContent = "Model readiness will refresh after the selection is applied."; $("product-provider-qualification").hidden = true; }
    paintProviderModels();
    $("product-provider-cancel").hidden = false; $("product-provider-download").disabled = true;
    $("product-provider-model-pick").disabled = true;
    if (action === "start") { const toggle = $("product-provider-toggle"); toggle.textContent = "Stop earning"; toggle.setAttribute("aria-checked", "true"); $("product-provider-start-hint").hidden = true; toggle.disabled = false; $("product-provider-label").textContent = "STARTING"; }
    $("product-provider-setup").textContent = action === "models" ? "Applying your shared model selection…" : action === "model" ? "Saving the provider model…" : action === "download" ? "Downloading the approved model. You can cancel and resume later." : action === "stop" ? "Stopping new work and cancelling active inference. Verified delivered text remains saved and metered." : "Preparing the model and connecting for qualification…";
    try {
      await window.kaiKoinTestBridge.run("provider-public-" + action, input);
      if (!current()) return;
      if (action === "models") { providerSelectionNotice = "Model selection saved. Network readiness updates automatically."; providerSelectionSaved = null; providerSelectionDraft = null; }
    } catch (e) { if (current()) { $("product-provider-detail").textContent = e.message; if (action === "models") providerSelectionNotice = providerMessage(e); } }
    finally { if (current()) { providerBusy = false; providerReadRevision++; providerInfoPending = false; await refreshPublicProvider(); paintProviderModels(); } }
  }
  for (const name of ["kai-account-signed-out", "kai-credit-identity-changed"]) window.addEventListener(name, () => {
    providerGeneration++; providerReadRevision++; providerActionRevision++; clearTimeout(providerExpiry); providerInfoPending = providerBusy = false;
    providerModelInfo = providerModelStatus = providerSelectionDraft = providerSelectionSaved = null; providerModelsStale = true; providerSelectionNotice = "";
    $("product-provider-models").hidden = true; $("product-provider-models-open").hidden = true; $("product-provider-model-list").replaceChildren();
    $("product-provider-label").textContent = "CHECKING ACCOUNT"; $("product-provider-label").dataset.state = "checking";
    $("product-provider-model").textContent = "Checking installed models"; $("product-provider-readiness").textContent = "Waiting for current account and network confirmation.";
    $("product-provider-toggle").disabled = true; $("product-provider-qualification").hidden = true;
    if (!$("view-earn").hidden) refreshPublicProvider();
  });
  $("product-provider-toggle").addEventListener("click", () => providerAction($("product-provider-toggle").getAttribute("aria-checked") === "true" ? "stop" : "start"));
  $("product-provider-model-pick").addEventListener("change", event => providerAction("model", event.target.value));
  for (const host of [document.querySelector(".product-sidebar-credits"), document.querySelector("#view-credits .product-panel")]) {
    host.querySelector("[data-credit-breakdown]").insertAdjacentHTML("afterend", '<p data-credit-status role="status"></p><div class="product-credit-actions"><button type="button" class="product-text-button" data-credit-refresh>Refresh</button><button type="button" class="product-text-button" data-credit-help data-product-action="legacy" hidden>Account help</button></div>');
  }
  document.addEventListener("click", event => { if (event.target.closest("[data-credit-refresh]")) window.KaiCredits.refresh(); });
  window.KaiCredits?.subscribe(paintCredits);
  new MutationObserver(paintProvider).observe($("koin-test-payments"), { subtree: true, attributes: true, childList: true, characterData: true }); paintProvider();
  window.KaiProduct = { render(view) { if (["credits", "buy-credits", "recovery"].includes(view)) window.KaiCredits?.refresh(); if (view === "buy-credits") { refreshPurchases().then(() => schedulePreview(0)); refreshModelPricing(); } else { clearTimeout(previewTimer); previewRevision++; } if (view === "network-overview") refreshNetwork(); if (view === "earn") { providerCheck.refresh(); refreshPublicProvider(); } } };
  setInterval(() => { if (document.hidden) return; if (!$("view-network-overview").hidden) refreshNetwork(); if (!$("view-earn").hidden) { providerCheck.refresh(); refreshPublicProvider(); } }, 15000);
  setInterval(() => { if (document.hidden) return; paintNetwork(); paintCredits(window.KaiCredits.get()); if (quote && !approving && !quoting && Date.now() >= quote.expiresAt) { invalidateQuote("The price expired. Refreshing automatically…"); schedulePreview(0); } }, 1000);
})();
