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
      <section class="product-panel"><h2>Simple, predictable spending</h2><p>Daily free credits are used first on eligible models. Purchased credits keep their USD service value.</p><div class="product-detail"><span>1,000 credits</span><strong>$1 of AI usage</strong></div><div class="product-detail"><span>Purchased credits</span><strong>No expiry</strong></div><p class="product-fine">Purchased credits are nonrefundable and nontransferable.</p></section></div>
      <section class="product-panel product-history"><div class="product-row"><h2>Activity</h2><div id="product-activity-filters"><button class="active" data-activity-filter="all">All</button><button data-activity-filter="usage">Usage</button><button data-activity-filter="purchase">Purchases</button></div></div><div class="product-table-wrap"><table><thead><tr><th>Activity</th><th>When</th><th>Status</th><th>Credits</th></tr></thead><tbody id="product-credit-history"><tr><td colspan="4">No verified activity loaded.</td></tr></tbody></table></div></section><p class="product-footer">Looking for an older pilot transaction? <button data-product-action="legacy">Account help</button></p>
    </section>
    <section id="view-buy-credits" class="view product-page" hidden>
      ${head("Buy credits", "Pay with KOIN. Your credits keep their USD service value.", button("chat", "Back to Chat"))}
      <section class="product-purchase-wallet" aria-label="Payment wallet"><div><p class="product-eyebrow">KOIN in your wallet</p><strong id="product-wallet-balance">Checking…</strong><p id="product-wallet-address">Reading this computer’s wallet.</p><p id="product-wallet-note" role="status"></p></div><div class="product-actions"><button id="product-wallet-refresh">Refresh balance</button><button data-product-action="payment-wallet">Manage wallet</button></div></section>
      <section class="product-purchase-availability" role="status"><div><strong id="product-purchase-title">Checking purchases…</strong><p id="product-purchase-detail">Your wallet balance and your AI credits are separate.</p></div><div class="product-actions"><button id="product-purchase-check">Check again</button><button data-product-action="signin" id="product-purchase-signin" hidden>Open account</button></div></section>
      <ol class="product-steps"><li class="active">Choose credits</li><li>Approve payment</li><li>Credits added</li></ol>
      <div class="product-two"><section class="product-panel"><h2>How much would you like to add?</h2><p>1,000 credits = $1 of AI usage.</p><div class="product-packs">${[1, 5, 10].map(n => `<button data-credit-pack="${n}"><strong>$${n}</strong><small>${(n * 1000).toLocaleString()} credits</small></button>`).join("")}</div><label for="product-usd-amount">Or choose an amount</label><div class="product-input"><span>$</span><input id="product-usd-amount" inputmode="decimal" autocomplete="off" placeholder="Enter USD amount" maxlength="12" /><span>USD</span></div><p>The current exchange quote determines how much KOIN you pay. Review the exact KOIN amount before approving.</p><div class="product-divider"></div><p>✓ Pay directly with KOIN from your wallet.</p><p>✓ Free credits are used first on eligible models.</p></section>
      <section class="product-panel product-order"><p class="product-eyebrow">You receive</p><div class="product-balance"><span id="product-pack-credits">—</span> <small>credits</small></div><div class="product-detail"><span>KOIN payment</span><strong id="product-quote-koin">Quote required</strong></div><div class="product-detail"><span>Price source</span><strong>Uniswap v4 · vKOIN/USDT</strong></div><div class="product-detail"><span>Last updated</span><strong id="product-quote-time">No verified quote</strong></div><div class="product-detail"><span>Valid until</span><strong id="product-quote-expiry">—</strong></div><p id="product-quote-state" role="status">Choose an amount to check purchasing availability. Existing credits remain usable while a purchase confirms or pricing is unavailable.</p><button id="product-quote-refresh" class="primary" disabled>Checking availability…</button><button id="product-quote-approve" class="primary" hidden>Review payment</button><p class="product-fine">Nonrefundable · nontransferable · no expiry</p><div id="product-pending-purchases"></div></section></div>
    </section>
    <section id="view-network-overview" class="view product-page" hidden>
      ${head("Network overview", "Available AI, the people providing it, and work being completed.", button("earn", "Back to Earn"))}
      <section class="product-network-status"><div><h2 id="product-network-state">Checking network status</h2><p id="product-network-time">No verified observation yet.</p></div><div><strong id="product-model-count">—</strong><small>models available</small></div><div><strong id="product-provider-count">—</strong><small>providers ready</small></div><div><strong id="product-waiting-count">—</strong><small>requests waiting</small></div></section>
      <div class="product-two"><section class="product-panel"><h2>Models on the network</h2><div id="product-network-models"><p>Available models will appear after a verified status check.</p></div></section><section class="product-panel"><p class="product-eyebrow">Work completed today</p><div class="product-balance"><span id="product-completed-count">—</span> <small>requests</small></div><p>Requests with verified delivered replies, including saved partial replies.</p><div class="product-divider"></div><p>Provider payouts are handled separately. Your earnings are shown in Earn.</p></section></div>
      <section class="product-panel"><h2>Computers providing AI</h2><div id="product-network-providers"><p>No current provider observations.</p></div></section><section class="product-panel"><h2>Recent activity</h2><div id="product-network-activity"><p>No verified activity loaded.</p></div></section>
    </section>
    <section id="view-recovery" class="view product-page" hidden>
      ${head("Clear answers when something stops.", "Credits, purchases, Chat and provider payouts each keep their own status.")}
      <div class="product-two"><section class="product-panel"><h2>Purchase confirmation</h2><p id="product-recovery-purchase">Check the purchase record before retrying. Existing credits remain available.</p><div class="product-actions">${button("chat", "Keep chatting", true)}${button("buy-credits", "View purchase")}<button data-product-action="purchase-retry">Review saved payment</button></div></section><section class="product-panel"><h2>Interrupted reply</h2><p>Recover the original request and its verified usage. Received text is preserved. A request with no usable answer is not charged.</p><button data-product-action="recover">Recover saved reply</button><p id="product-recovery-state" role="status"></p></section><section class="product-panel"><h2>Model unavailable</h2><p>Choose another network model or use this computer. Your model and spending preference will not change automatically.</p><div class="product-actions">${button("network-overview", "Choose a model")}<button data-product-action="local">Use local AI</button></div></section><section class="product-panel"><h2>Provider payout</h2><p id="product-recovery-payout">Check your verified earnings and payout status. A pending payout does not block Chat or sharing.</p>${button("earn", "View earnings")}</section></div><p class="product-footer">Older pilot balance or transaction? <button data-product-action="legacy">Get account help</button></p>
    </section>`);
  $("sidebar").querySelector(".brand").insertAdjacentHTML("afterend", `<section class="product-sidebar-credits"><p class="product-eyebrow">Available to use</p><strong><span data-credit-total>—</span> <small>credits</small></strong><p data-credit-breakdown>Credit account unavailable</p>${button("buy-credits", "+ Buy credits", true)}<button class="product-text-button" data-product-view="credits">Balance &amp; activity ↗</button></section>`);
  const header = main.querySelector(".workspace-header");
  header.insertAdjacentHTML("afterbegin", '<button id="product-sidebar-toggle" aria-label="Toggle sidebar" aria-expanded="true">☰</button>');
  header.insertAdjacentHTML("beforeend", '<button id="product-mobile-credits" data-product-view="credits"><span data-credit-total>—</span> credits</button><button id="product-mobile-buy" data-product-view="buy-credits">Buy credits</button>');
  header.appendChild($("launch-kai")); $("launch-kai").querySelector("strong").textContent = "Open KAI";
  const chats = $("chats-pane"); chats.classList.add("product-recent");
  chats.insertAdjacentHTML("afterbegin", '<div class="product-row"><span class="product-eyebrow">Recent chats</span><button id="product-history-all">View all</button></div>');
  $("sidebar").insertBefore(chats, $("status-pane"));
  $("product-history-all").addEventListener("click", () => { $("sidebar").classList.toggle("history-expanded"); $("chat-search").focus({ preventScroll: true }); });
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
  $("nav-network").title = "Network"; $("nav-network").setAttribute("aria-label", "Network");
  document.querySelector(".chat-pane").insertBefore(document.querySelector(".composer-options"), document.querySelector(".chat-toolbar"));
  const oldEarn = $("view-earn").firstElementChild, legacy = document.createElement("details"); legacy.id = "product-legacy-account"; legacy.innerHTML = '<summary>Payment wallet &amp; earlier account activity</summary>'; oldEarn.replaceWith(legacy); legacy.appendChild(oldEarn);
  legacy.insertAdjacentHTML("beforebegin", `<div class="product-earn">${head("Share your AI. Earn KOIN.", "Contribute this computer’s spare AI capacity to the network.", button("network-overview", "◎ View network"))}<div class="product-two"><section class="product-panel product-provider"><div class="product-row"><span>Share AI capacity</span><button id="product-provider-toggle" role="switch" aria-checked="false" aria-label="Share AI capacity">Off</button></div><div class="product-provider-state"><span class="product-live-dot"></span><h2 id="product-provider-label">OFFLINE</h2><p id="product-provider-detail">Sharing is off. Turn it on when you’re ready.</p></div><div class="product-divider"></div><strong id="product-provider-model">Model not confirmed</strong><p class="product-fine">Only current, verified qualification counts as ready.</p></section><div><section class="product-panel"><p class="product-eyebrow">AI provider earnings</p><p id="product-provider-earnings">No verified earnings loaded.</p><p class="product-fine">Rewards remain estimates until review and chain confirmation.</p><button data-product-action="payouts">Refresh earnings</button></section><section class="product-panel"><h2>Provider setup</h2><p id="product-provider-setup">Choose an approved model, check this computer, then turn on sharing.</p><div class="product-actions"><button data-product-action="provider-setup">Check this computer</button><button id="product-provider-download" data-product-action="provider-download" hidden>Download approved model</button><button id="product-provider-cancel" data-product-action="provider-cancel" hidden>Cancel setup</button><button data-product-action="legacy">Reward wallet</button></div></section></div></div><section class="product-panel"><h2>Readiness at a glance</h2><p id="product-provider-readiness">Model, qualification and network confirmation must all be current before this computer is shown as ONLINE.</p></section><p class="product-footer">AI earnings are KOIN. They are separate from chat credits.</p></div>`);
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
    const rows = usd ? [...state.snapshot.usage.map(u => ({ kind: "usage", title: `Chat · ${u.model}`, at: u.at, status: "Delivered", amount: "−" + credits(u.credits) })), ...state.snapshot.purchases.map(p => ({ kind: "purchase", title: "Purchased credits", at: p.confirmedAt || p.createdAt, status: p.state === "confirmed" ? "Added to balance" : p.state, amount: p.state === "confirmed" ? "+" + credits(p.credits || p.amount) : "Pending" }))].sort((a, b) => b.at - a.at).filter(r => filter === "all" || filter === r.kind) : [];
    $("product-credit-history").innerHTML = rows.length ? rows.map(r => `<tr><td>${esc(r.title)}</td><td>${esc(new Date(r.at).toLocaleString())}</td><td>${esc(r.status)}</td><td>${esc(r.amount)}</td></tr>`).join("") : `<tr><td colspan="4">${usd && !stale ? "No activity yet." : "No verified activity loaded."}</td></tr>`;
    const pending = state.snapshot?.purchases?.filter(p => p.state === "pending") || [];
    $("product-pending-purchases").textContent = pending.length ? `${pending.length} purchase${pending.length === 1 ? " is" : "s are"} confirming. You can keep using existing credits.` : "";
    $("product-recovery-purchase").textContent = pending.length ? "Your payment is confirming. Existing credits remain available; do not create another payment to retry this one." : !usd || stale ? "Purchase status is unavailable. Refresh your account before starting or retrying a payment." : "No pending purchase in the last verified account snapshot. Refresh your account before starting another payment.";
  }
  let publicProvider = false;
  function paintProvider() {
    if (publicProvider) return;
    $("product-provider-label").textContent = $("koin-provider-state").textContent;
    $("product-provider-detail").textContent = $("koin-provider-detail").textContent;
    const start = document.querySelector('[data-koin-test="worker-start"]'), stop = document.querySelector('[data-koin-test="worker-stop"]'), on = !stop.hidden;
    const toggle = $("product-provider-toggle"); toggle.textContent = on ? "On" : "Off"; toggle.setAttribute("aria-checked", String(on)); toggle.disabled = !window.kaiKoinTestBridge || (on ? stop.disabled : start.disabled);
    $("product-provider-label").dataset.state = $("koin-provider-state").dataset.state;
    $("product-provider-earnings").textContent = $("koin-payout-summary").textContent;
    $("product-provider-model").textContent = $("koin-model-label").textContent;
    $("product-provider-readiness").textContent = $("koin-provider-state").dataset.state === "online" ? "Model ready · qualification current · fresh network confirmation" : "Readiness is not confirmed. " + $("koin-provider-detail").textContent;
  }
  function paintNetwork() {
    const fresh = network && !networkError && Date.now() < network.validUntil && network.observedAt <= Date.now() + 5000;
    $("product-network-state").textContent = fresh ? network.state === "available" ? "AI network status" : "Network paused" : "Network status unavailable";
    $("product-network-time").textContent = network ? `Observed ${new Date(network.observedAt).toLocaleString()} · ${fresh ? "checks every 15 seconds" : "stale — reconnect to refresh"}` : networkError || "No verified observation yet.";
    for (const [id, value] of [["product-model-count", network?.models.filter(m => m.available).length], ["product-provider-count", network?.readyProviders], ["product-waiting-count", network?.waitingRequests], ["product-completed-count", network?.completedToday]]) $(id).textContent = fresh ? value : "—";
    if (!network) return;
    $("product-network-models").innerHTML = network.models.map(m => `<div class="product-model-row"><div><strong>${esc(m.id)}</strong><p>${m.freeEligible ? "Free credits eligible" : "Purchased credits"}</p></div><div><p>${fresh && m.available ? `${m.providers} providers ready` : "Availability unconfirmed"}</p><button data-network-model="${esc(m.id)}" ${fresh && m.available ? "" : "disabled"}>Use model</button></div></div>`).join("");
    $("product-network-providers").innerHTML = network.providers.length ? network.providers.map(p => `<div class="product-detail"><span>Provider ${esc(p.id)} · ${esc(p.model)}</span><span>${fresh ? esc(p.state.replaceAll("-", " ")) : "Last seen — status stale"}</span></div>`).join("") : "<p>No recently observed providers.</p>";
    $("product-network-activity").innerHTML = network.activity.length ? network.activity.map(a => `<div class="product-detail"><span>Reply delivered · ${esc(a.model)}</span><time>${esc(new Date(a.at).toLocaleTimeString())}</time></div>`).join("") : "<p>No verified replies recorded today.</p>";
  }
  async function refreshNetwork() {
    if (networkPending || document.hidden) return; networkPending = true;
    try { const result = await window.kaiKoinTestBridge?.run("network-overview"); const n = result?.network;
      if (!n || !Number.isSafeInteger(n.observedAt) || !Number.isSafeInteger(n.validUntil) || n.validUntil < n.observedAt || n.validUntil > n.observedAt + 15000 || !["available", "paused"].includes(n.state) ||
          ![n.readyProviders, n.waitingRequests, n.completedToday].every(v => Number.isSafeInteger(v) && v >= 0) ||
          !Array.isArray(n.models) || n.models.length > 256 || n.models.some(m => typeof m.id !== "string" || typeof m.available !== "boolean" || typeof m.freeEligible !== "boolean" || !Number.isSafeInteger(m.providers) || m.providers < 0) ||
          !Array.isArray(n.providers) || n.providers.length > 256 || n.providers.some(p => typeof p.id !== "string" || typeof p.model !== "string" || typeof p.state !== "string") ||
          !Array.isArray(n.activity) || n.activity.length > 50 || n.activity.some(a => typeof a.model !== "string" || !Number.isSafeInteger(a.at))) throw Error("No verified network status available");
      network = n; networkError = "";
    } catch (e) { networkError = String(e.message || "Network status unavailable"); } finally { networkPending = false; paintNetwork(); }
  }
  let purchaseInfo = { activation: "loading" }, purchaseWallet = null, walletError = "", walletReading = false, purchaseReading = false;
  let walletRead, purchaseRead, purchaseGeneration = 0, quoteWalletKey = null;
  const buyVisible = () => !document.hidden && !$("view-buy-credits").hidden;
  const message = error => String(error?.message || error || "Connection unavailable").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  const walletKey = () => purchaseWallet?.address ? JSON.stringify([purchaseWallet.address, purchaseWallet.network]) : null;
  const walletReady = () => !!purchaseWallet?.address && purchaseWallet.network === "mainnet" && typeof purchaseWallet.koin === "string";
  const amountAtoms = value => { const [whole, fraction = ""] = value.split("."); return BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, "0")); };
  function invalidateQuote(text) {
    quoteRevision++; quote = null; quoteWalletKey = null; $("product-quote-approve").hidden = true;
    $("product-quote-koin").textContent = "Quote required"; $("product-quote-time").textContent = "No verified quote"; $("product-quote-expiry").textContent = "—";
    if (text) $("product-quote-state").textContent = text;
  }
  function paintPurchase() {
    const wallet = purchaseWallet, state = purchaseInfo.activation;
    let balance = walletReading && !wallet ? "Checking…" : "Balance unavailable";
    if (wallet?.koin != null) {
      const [whole, fraction] = wallet.koin.split("."), locale = document.documentElement.lang || "en";
      const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find(p => p.type === "decimal").value;
      balance = BigInt(whole).toLocaleString(locale) + (fraction ? decimal + fraction : "") + " " + wallet.tokenSymbol;
    } else if (wallet && !wallet.address) balance = "No wallet set up";
    $("product-wallet-balance").textContent = balance;
    $("product-wallet-address").textContent = wallet?.address ? `${wallet.address} · ${wallet.network === "mainnet" ? "Koinos Mainnet" : wallet.network}` : wallet ? "Set up or restore your wallet to pay with KOIN." : "Wallet address unconfirmed";
    $("product-wallet-note").textContent = walletError || (wallet?.address && wallet.network !== "mainnet" ? "Credit purchases use KOIN on Mainnet. Change the wallet network before buying." : wallet?.address ? "This is the KOIN in your wallet. It is separate from AI credits." : "");
    $("product-wallet-refresh").disabled = walletReading;
    $("product-purchase-check").disabled = purchaseReading;
    $("product-purchase-signin").hidden = state !== "signin-required";
    const labels = {
      loading: ["Checking purchases…", "Your wallet balance and your AI credits are separate."],
      unavailable: ["Credit purchases are not activated yet", "The credit service still needs to be activated. Having KOIN in your wallet does not enable purchases until that setup is complete."],
      "signin-required": ["Your account needs attention before buying", purchaseInfo.blocked || "Sign in to your credit account."],
      ready: ["Credit purchases are available", "Choose an amount, review the current KOIN quote, then approve the payment."],
      error: ["Purchasing availability could not be checked", purchaseInfo.blocked || "Check again when your connection is available."],
    };
    const [title, detail] = labels[state] || labels.error;
    $("product-purchase-title").textContent = title; $("product-purchase-detail").textContent = detail;
    const refresh = $("product-quote-refresh");
    refresh.disabled = state !== "ready" || !walletReady() || quoting || approving || walletReading;
    refresh.textContent = state === "loading" ? "Checking availability…" : state === "unavailable" ? "Purchases not activated" : state === "signin-required" ? "Account setup required" : state !== "ready" ? "Purchasing unavailable" : !walletReady() ? "Payment wallet required" : quoting ? "Getting quote…" : "Get KOIN quote";
    if (quote) {
      const enough = walletReady() && amountAtoms(purchaseWallet.koin) >= amountAtoms(quote.koin);
      $("product-quote-approve").disabled = approving || walletReading || !enough || state !== "ready";
      $("product-quote-approve").textContent = enough ? "Review payment" : "Not enough KOIN";
    }
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
          if (oldKey !== walletKey() && (oldKey !== null || quote || quoting)) invalidateQuote(purchaseInfo.activation === "ready" ? "Payment wallet changed or could not be verified. Get a fresh quote before paying." : undefined);
          paintPurchase();
        }
      }
    })();
    return walletRead;
  }
  async function refreshPurchaseInfo() {
    if (purchaseRead) return purchaseRead;
    const generation = purchaseGeneration; purchaseReading = true; paintPurchase();
    purchaseRead = Promise.resolve().then(() => {
      if (!window.kaiKoinTestBridge) throw Error("Open the desktop app to buy credits.");
      return window.kaiKoinTestBridge.run("purchase-info");
    }).then(info => {
      if (generation !== purchaseGeneration) return;
      if (!["ready", "unavailable", "signin-required"].includes(info?.activation)) throw Error("Purchasing availability could not be verified.");
      purchaseInfo = info;
      if (info.activation !== "ready") invalidateQuote(info.activation === "unavailable" ? "Purchasing will be available when the credit service is activated." : info.blocked);
    }).catch(error => { if (generation === purchaseGeneration) { purchaseInfo = { activation: "error", blocked: message(error) }; invalidateQuote("Purchasing availability must be verified before payment."); } })
      .finally(() => { if (generation === purchaseGeneration) { purchaseReading = false; purchaseRead = null; paintPurchase(); } });
    return purchaseRead;
  }
  const refreshPurchases = () => Promise.all([refreshPurchaseWallet(), refreshPurchaseInfo()]);
  function pack() {
    invalidateQuote(); const raw = $("product-usd-amount").value.trim(), valid = /^(0|[1-9]\d{0,5})(\.\d{1,2})?$/.test(raw) && Number(raw) > 0;
    $("product-pack-credits").textContent = valid ? (Number(raw) * 1000).toLocaleString() : "—";
    return valid ? raw : null;
  }
  $("product-wallet-refresh").addEventListener("click", refreshPurchaseWallet);
  $("product-purchase-check").addEventListener("click", refreshPurchases);
  $("product-usd-amount").addEventListener("input", pack);
  $("product-quote-refresh").addEventListener("click", async () => {
    if (quoting || approving || purchaseInfo.activation !== "ready" || !walletReady()) return;
    const usd = pack(); if (!usd) { $("product-quote-state").textContent = "Choose a positive USD amount with up to two decimal places."; $("product-usd-amount").focus(); return; }
    const revision = quoteRevision, key = walletKey(); quoting = true; paintPurchase();
    try {
      const r = await window.kaiKoinTestBridge.run("purchase-preview", { usd });
      if (revision !== quoteRevision || key !== walletKey()) return;
      if (!r?.quote) throw Error("Purchases are unavailable until a validated exchange quote is available. Existing credits can still be used.");
      if (typeof r.quote.id !== "string" || typeof r.quote.koin !== "string" || !/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(r.quote.koin) || !Number.isSafeInteger(r.quote.observedAt) || !Number.isSafeInteger(r.quote.expiresAt) || r.quote.observedAt > Date.now() + 5000 || r.quote.expiresAt <= Date.now()) throw Error("A fresh verified quote is required.");
      quote = r.quote; quoteWalletKey = key;
      if (typeof quote.credits === "string" && /^(0|[1-9]\d*)(\.\d{1,5})?$/.test(quote.credits)) $("product-pack-credits").textContent = quote.credits;
      $("product-quote-koin").textContent = quote.koin + " KOIN"; $("product-quote-time").textContent = new Date(quote.observedAt).toLocaleTimeString(); $("product-quote-expiry").textContent = new Date(quote.expiresAt).toLocaleTimeString(); $("product-quote-approve").hidden = false;
      $("product-quote-state").textContent = amountAtoms(purchaseWallet.koin) >= amountAtoms(quote.koin) ? "Review the exact payment in the secure desktop approval." : "Your wallet balance is below this quote. Choose a smaller amount or add KOIN to your wallet.";
    } catch (error) { if (revision === quoteRevision) $("product-quote-state").textContent = message(error); }
    finally { quoting = false; paintPurchase(); }
  });
  $("product-quote-approve").addEventListener("click", async () => {
    if (approving || !quote || $("product-quote-approve").disabled) return;
    approving = true; const saved = quote; paintPurchase();
    try {
      await refreshPurchases();
      if (quote !== saved || quoteWalletKey !== walletKey() || purchaseInfo.activation !== "ready" || !walletReady()) return;
      if (Date.now() >= quote.expiresAt) return invalidateQuote("Quote expired. Get a fresh quote before approving.");
      if (amountAtoms(purchaseWallet.koin) < amountAtoms(quote.koin)) { $("product-quote-state").textContent = "Your wallet no longer has enough KOIN for this quote."; return; }
      const id = quote.id; invalidateQuote();
      const result = await window.kaiKoinTestBridge.run("purchase-approve", id);
      $("product-quote-state").textContent = result.state === "cancelled" ? "Payment cancelled. No new purchase was started." : "Payment confirmation is pending. Existing credits remain available.";
      await Promise.all([window.KaiCredits.refresh(), refreshPurchaseWallet()]);
    } catch (error) { $("product-quote-state").textContent = message(error); }
    finally { approving = false; paintPurchase(); }
  });
  for (const name of ["kai-account-signed-out", "kai-credit-identity-changed"]) window.addEventListener(name, () => {
    purchaseGeneration++; walletRead = purchaseRead = null; walletReading = purchaseReading = false; purchaseWallet = null;
    purchaseInfo = { activation: "loading" }; invalidateQuote("Account changed. Check your payment wallet and get a fresh quote."); paintPurchase();
    if (buyVisible()) refreshPurchases();
  });
  document.addEventListener("visibilitychange", () => { if (buyVisible()) refreshPurchases(); });
  setInterval(() => { if (buyVisible()) refreshPurchases(); }, 30000);
  document.addEventListener("click", async event => {
    const view = event.target.closest("[data-product-view]"); if (view) return go(view.dataset.productView);
    const p = event.target.closest("[data-credit-pack]"); if (p) { $("product-usd-amount").value = p.dataset.creditPack; pack(); document.querySelectorAll("[data-credit-pack]").forEach(b => b.classList.toggle("selected", b === p)); return; }
    const f = event.target.closest("[data-activity-filter]"); if (f) { filter = f.dataset.activityFilter; document.querySelectorAll("[data-activity-filter]").forEach(b => b.classList.toggle("active", b === f)); paintCredits(window.KaiCredits.get()); return; }
    const model = event.target.closest("[data-network-model]"); if (model && !model.disabled) { go("chat"); window.dispatchEvent(new CustomEvent("kai-network-use", { detail: { model: model.dataset.networkModel } })); return; }
    const action = event.target.closest("[data-product-action]")?.dataset.productAction; if (!action) return;
    if (action === "payment-wallet") {
      go("earn"); legacy.open = true; await renderEarn();
      const target = !$("earn-setup").hidden ? $("earn-setup") : !$("earn-unlock").hidden ? $("earn-unlock") : $("wallet-address");
      target.scrollIntoView({ block: "center" }); (target.matches("input") ? target : target.querySelector("input,button"))?.focus({ preventScroll: true });
    }
    if (action === "legacy") { go("earn"); legacy.open = true; legacy.scrollIntoView({ block: "start" }); }
    if (action === "provider-setup") { await refreshPublicProvider(); }
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
    if (action === "signin") { go("settings"); $("btn-account-signin").scrollIntoView({ block: "center" }); }
    if (action === "start-free") { go("chat"); window.dispatchEvent(new Event("kai-network-use")); }
    if (action === "local") { go("chat"); $("src-pick").value = "local"; $("src-pick").dispatchEvent(new Event("change")); }
  });
  let providerBusy = false, providerInfoPending = false, providerExpiry;
  async function refreshPublicProvider() {
    if (providerInfoPending || !window.kaiKoinTestBridge) return; providerInfoPending = true;
    try {
      const info = await window.kaiKoinTestBridge.run("provider-public-info"); publicProvider = true;
      const on = info.enabled === true, toggle = $("product-provider-toggle");
      toggle.textContent = on ? "On" : "Off"; toggle.setAttribute("aria-checked", String(on));
      toggle.disabled = on ? false : providerBusy || info.state !== "ready";
      $("product-provider-model").textContent = info.model?.label || "Model not confirmed";
      $("product-provider-setup").textContent = info.detail + (info.model ? ` Required memory: ${info.model.requiredRamGb} GB.${!info.model.installed && Number.isFinite(info.model.bytes) ? " Download: " + (info.model.bytes / 1e9).toFixed(2) + " GB." : ""}` : "") + (info.progress ? ` ${info.progress.pct}% downloaded.` : "");
      $("product-provider-download").hidden = info.state !== "download-required";
      $("product-provider-download").disabled = providerBusy;
      $("product-provider-cancel").hidden = !providerBusy;
      let status = info.running ? await window.kaiKoinTestBridge.run("provider-public-status") : { state: "offline", label: on ? "RECONNECTING" : "OFFLINE", detail: on ? info.detail : "Sharing is off. Check setup, then turn it on." };
      clearTimeout(providerExpiry);
      const paint = value => {
        $("product-provider-label").textContent = value.label; $("product-provider-label").dataset.state = value.state;
        $("product-provider-detail").textContent = value.detail;
        $("product-provider-readiness").textContent = value.state === "online" ? "Model ready · qualification current · fresh network confirmation" : "Readiness is not confirmed. " + value.detail;
      };
      paint(status);
      if (status.state === "online") providerExpiry = setTimeout(() => paint({ state: "stale", label: "CHECKING CONNECTION", detail: "Network confirmation has expired. Refreshing eligibility…" }), Math.max(0, status.validUntil - Date.now()));
    } catch (e) {
      publicProvider = true; clearTimeout(providerExpiry);
      $("product-provider-label").textContent = "CONNECTION UNCONFIRMED"; $("product-provider-label").dataset.state = "stale";
      $("product-provider-detail").textContent = e.message; $("product-provider-setup").textContent = e.message;
      $("product-provider-download").hidden = true;
    } finally { providerInfoPending = false; }
  }
  async function providerAction(action) {
    if (providerBusy && action !== "stop") return;
    if (action !== "stop") providerBusy = true;
    $("product-provider-cancel").hidden = false; $("product-provider-download").disabled = true;
    $("product-provider-setup").textContent = action === "download" ? "Downloading the approved model. You can cancel and resume later." : action === "stop" ? "Stopping new work and cancelling active inference. Verified delivered text remains saved and metered." : "Preparing the model and connecting for qualification…";
    try { await window.kaiKoinTestBridge.run("provider-public-" + action); }
    catch (e) { $("product-provider-detail").textContent = e.message; }
    finally { if (action !== "stop") providerBusy = false; await refreshPublicProvider(); }
  }
  $("product-provider-toggle").addEventListener("click", () => providerAction($("product-provider-toggle").getAttribute("aria-checked") === "true" ? "stop" : "start"));
  for (const host of [document.querySelector(".product-sidebar-credits"), document.querySelector("#view-credits .product-panel")]) {
    host.querySelector("[data-credit-breakdown]").insertAdjacentHTML("afterend", '<p data-credit-status role="status"></p><div class="product-credit-actions"><button type="button" class="product-text-button" data-credit-refresh>Refresh</button><button type="button" class="product-text-button" data-credit-help data-product-action="legacy" hidden>Account help</button></div>');
  }
  document.addEventListener("click", event => { if (event.target.closest("[data-credit-refresh]")) window.KaiCredits.refresh(); });
  window.KaiCredits?.subscribe(paintCredits);
  new MutationObserver(paintProvider).observe($("koin-test-payments"), { subtree: true, attributes: true, childList: true, characterData: true }); paintProvider();
  window.KaiProduct = { render(view) { if (["credits", "buy-credits", "recovery"].includes(view)) window.KaiCredits?.refresh(); if (view === "buy-credits") refreshPurchases(); if (view === "network-overview") refreshNetwork(); if (view === "earn") refreshPublicProvider(); } };
  setInterval(() => { if (document.hidden) return; if (!$("view-network-overview").hidden) refreshNetwork(); if (!$("view-earn").hidden) refreshPublicProvider(); }, 15000);
  setInterval(() => { if (document.hidden) return; paintNetwork(); paintCredits(window.KaiCredits.get()); if (quote && Date.now() >= quote.expiresAt) { invalidateQuote("Quote expired. Get a fresh quote before approving."); } }, 1000);
})();
