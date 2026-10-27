"use strict";
(() => {
  const $ = id => document.getElementById(id), host = $("view-credits");
  if (!host) return;
  const panel = document.createElement("section");
  panel.id = "product-wallet-access"; panel.className = "product-panel";
  panel.innerHTML = '<h2>Use network credits</h2><p id="product-wallet-access-detail" role="status">Checking free credits and saved wallet access…</p><p id="product-wallet-access-address" class="product-fine"></p><div class="product-actions"><button id="product-wallet-access-connect" class="primary" disabled>Checking connection…</button><button id="product-wallet-access-session" hidden>Use free credits for this session</button><button data-product-action="signin" hidden>Sign in to an existing account</button></div><p id="product-wallet-access-session-note" class="product-fine" hidden>This session uses free credits only. Connect again after closing the app. Purchases need protected storage.</p>';
  host.querySelector(".product-head").after(panel);
  let info, pending, busy = false, revision = 0, notice = "";
  function paint() {
    const primary = $("product-wallet-access-connect"), session = $("product-wallet-access-session");
    const connected = info?.connected === true, freeAccess = info?.freeAccess === true;
    panel.hidden = !info || freeAccess;
    const upgrade = connected && info?.sessionOnly === true && info?.secureStorage?.available === true;
    $("product-wallet-access-detail").textContent = notice || info?.detail || "Checking free credits and saved wallet access…";
    $("product-wallet-access-address").textContent = info?.address ? `Wallet: ${info.address}` : "";
    $("product-wallet-access-session-note").hidden = true;
    const needsWallet = ["wallet-required", "wallet-unlock-required"].includes(info?.state);
    primary.textContent = busy ? "Connecting…" : freeAccess ? "Refresh credits" : info?.state === "wallet-required" ? "Set up wallet" : info?.state === "wallet-unlock-required" ? "Unlock wallet" : upgrade ? "Save wallet connection" : connected ? "Refresh credits" : "Connect wallet";
    primary.disabled = busy || !!pending || (!freeAccess && (!connected || upgrade) && !needsWallet && (info?.canConnect !== true || info?.secureStorage?.available !== true));
    session.hidden = freeAccess || connected || info?.canConnect !== true || info?.secureStorage?.available === true;
    panel.querySelector('[data-product-action="signin"]').hidden = !info || freeAccess || connected;
    session.disabled = busy || !!pending;
  }
  async function refresh() {
    if (pending) return pending;
    const generation = revision;
    pending = (async () => {
      try {
        if (!window.kaiKoinTestBridge) throw Error("Open the desktop app to connect your wallet.");
        const result = await window.kaiKoinTestBridge.run("wallet-info");
        if (!result || typeof result.state !== "string" || typeof result.detail !== "string") throw Error("Wallet connection status could not be verified.");
        if (generation === revision) info = result;
      } catch (error) {
        if (generation === revision) info = { state: "unavailable", detail: String(error.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") };
      } finally { if (generation === revision) { pending = null; paint(); } }
    })();
    paint(); return pending;
  }
  async function connect(sessionOnly) {
    if (busy) return;
    if (info?.freeAccess) { await window.KaiCredits?.refresh(); return; }
    if (["wallet-required", "wallet-unlock-required"].includes(info?.state)) {
      document.querySelector('#view-earn [data-product-action="payment-wallet"]')?.click(); return;
    }
    const upgrade = !sessionOnly && info?.sessionOnly === true && info?.secureStorage?.available === true;
    if (info?.connected && !upgrade) { await window.KaiCredits?.refresh(); return; }
    if (info?.canConnect !== true || (!sessionOnly && info?.secureStorage?.available !== true)) return;
    busy = true; notice = "Review the wallet connection in the app's approval window."; paint();
    const generation = revision;
    try {
      const result = await window.kaiKoinTestBridge.run("wallet-connect", { sessionOnly });
      if (generation !== revision) return;
      if (result?.state === "cancelled") { notice = "Connection cancelled. Your wallet and credits are unchanged."; return; }
      if (result?.state !== "connected") throw Error("Wallet connection was not confirmed.");
      notice = "";
      window.dispatchEvent(new Event("kai-credit-identity-changed"));
      await window.KaiNetwork?.refresh(); await window.KaiCredits?.refresh();
    } catch (error) {
      if (generation === revision) notice = String(error.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
    } finally { busy = false; await refresh(); paint(); }
  }
  $("product-wallet-access-connect").addEventListener("click", () => connect(false));
  $("product-wallet-access-session").addEventListener("click", () => connect(true));
  const open = () => { activateView("credits"); panel.scrollIntoView({ block: "start" }); void refresh(); };
  window.KaiWalletAccess = { open, refresh };
  document.addEventListener("click", event => { if (event.target.closest('[data-product-action="wallet-connect"]')) open(); });
  for (const name of ["kai-account-signed-out", "kai-credit-identity-changed"]) window.addEventListener(name, () => {
    revision++; pending = null; info = null; notice = ""; if (!host.hidden) void refresh();
  });
  const render = window.KaiProduct.render;
  window.KaiProduct.render = function (view) { render.call(this, view); if (view === "credits") void refresh(); };
})();
