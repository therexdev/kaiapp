"use strict";
(() => {
  function createCreditState({ read, clock = Date.now }) {
    const listeners = new Set(); let pending, value = { status: "loading", snapshot: null, error: null };
    const notify = () => { for (const listener of listeners) listener(structuredClone(value)); };
    const atoms = n => typeof n === "string" && /^(0|[1-9]\d{0,19})$/.test(n) && BigInt(n) <= (1n << 64n) - 1n;
    function accept(result) {
      const s = result?.credits;
      if (!s || !atoms(s.available) || !atoms(s.purchased?.available) || !atoms(s.free?.available) || !atoms(s.version) ||
          !["USD-1e-8", "legacy-KOIN-1e-8"].includes(s.unit) || !["available", "unavailable", "ineligible"].includes(s.free.state) ||
          BigInt(s.available) !== BigInt(s.purchased.available) + BigInt(s.free.available)) throw Error("Credit balance could not be verified");
      const key = JSON.stringify([result.product, result.owner]);
      if (value.snapshot?.key === key && BigInt(s.version) < BigInt(value.snapshot.credits.version)) return;
      value = { status: "ready", error: null, snapshot: { key, product: result.product, owner: result.owner, credits: structuredClone(s),
        purchases: structuredClone(result.purchases || []), usage: structuredClone(result.usage || []), receivedAt: clock() } }; notify();
    }
    async function refresh() {
      if (!pending) pending = Promise.resolve().then(read).then(accept).catch(error => {
        value = { ...value, status: "unavailable", error: String(error.message || "Credit balance unavailable") }; notify();
      }).finally(() => { pending = null; });
      await pending; return structuredClone(value);
    }
    return { accept, refresh, get: () => structuredClone(value), subscribe(listener) { listeners.add(listener); listener(structuredClone(value)); return () => listeners.delete(listener); } };
  }
  if (typeof module === "object") module.exports = { createCreditState };
  if (typeof window === "undefined") return;
  window.KaiCredits = createCreditState({ read: () => window.kaiKoinTestBridge.run("credit-status") });
  const credits = v => { const n = BigInt(v); return `${n / 100000n}.${String(n % 100000n).padStart(5, "0")}`.replace(/\.?0+$/, "") || "0"; };
  function paint(state) {
    if (!state.snapshot) return;
    const s = state.snapshot.credits, stale = state.status !== "ready" || Date.now() - state.snapshot.receivedAt > 30000;
    const balance = document.getElementById("network-chat-balance"), account = document.getElementById("koin-available");
    if (balance) balance.textContent = `${credits(s.available)} credits${stale ? " · last known balance" : ""}`;
    if (account) account.textContent = credits(s.available);
    const detail = document.getElementById("network-credit-sources");
    if (detail) detail.textContent = `Purchased ${credits(s.purchased.available)} · ${s.free.state === "unavailable" ? "Free allowance unavailable" : `Free today ${credits(s.free.available)} · resets ${new Date(s.free.resetAt).toLocaleTimeString()}`} · checked ${new Date(state.snapshot.receivedAt).toLocaleTimeString()}${stale ? " · reconnect to refresh" : ""}`;
  }
  window.KaiCredits.subscribe(paint);
  setInterval(() => { if (!document.hidden) paint(window.KaiCredits.get()); }, 1000);
  window.addEventListener("kai-network-account-changed", () => window.KaiCredits.refresh());
})();
