"use strict";
(() => {
  const SCALE = 100000000n, MAX = (1n << 64n) - 1n;
  // The legacy scheduler sometimes serializes tiny balances in exponent form.
  // Convert the decimal text exactly; never multiply floating-point balances.
  function atoms(value) {
    if (typeof value !== "string") throw Error("Missing testnet KAI balance");
    const m = /^(0|[1-9]\d{0,19})(?:\.(\d{1,20}))?(?:e([+-]?\d{1,2}))?$/i.exec(value);
    if (!m) throw Error("Invalid testnet KAI balance");
    let n = BigInt(m[1] + (m[2] || "")), shift = 8 + Number(m[3] || 0) - (m[2] || "").length;
    if (Math.abs(shift) > 28) throw Error("Invalid testnet KAI precision");
    if (shift >= 0) n *= 10n ** BigInt(shift);
    else { const scale = 10n ** BigInt(-shift); if (n % scale) throw Error("Invalid testnet KAI precision"); n /= scale; }
    if (n > MAX) throw Error("Invalid testnet KAI amount");
    return n;
  }
  function format(n) {
    const fraction = String(n % SCALE).padStart(8, "0").replace(/0+$/, "");
    return (n / SCALE).toLocaleString() + (fraction ? "." + fraction : "");
  }
  function summary(snapshot) {
    const wallet = snapshot?.wallet?.address, earnings = snapshot?.earnings;
    if (!wallet || earnings?.address !== wallet || earnings.error) return null;
    try { const kai = atoms(earnings.kai); return { wallet, kai: format(kai), koin: format(kai / 5n) }; }
    catch { return null; }
  }
  if (typeof module === "object") module.exports = { atoms, format, summary };
  if (typeof window === "undefined") return;
  let latest = null;
  function paint() {
    const node = document.getElementById("product-legacy-drop"); if (!node) return;
    const value = summary(latest);
    for (const [field, text] of [["kai", value?.kai || "—"], ["koin", value?.koin || "—"]]) {
      const amount = node.querySelector(`[data-legacy-drop="${field}"]`);
      if (amount.textContent !== text) amount.textContent = text;
    }
    node.title = value ? `Testnet KAI in wallet ${value.wallet}. Expected drop: 1 KOIN per 5 KAI, rounded down to 8 decimals. Estimate until the final drop snapshot.`
      : "Testnet KAI balance unavailable. The expected KOIN drop is calculated at 1 KOIN per 5 KAI when the balance is available.";
  }
  window.KaiLegacyDrop = { observe(snapshot) { latest = snapshot; paint(); }, clear() { latest = null; paint(); }, paint };
  for (const event of ["kai-credit-identity-changed", "kai-account-signed-out"]) window.addEventListener(event, () => window.KaiLegacyDrop.clear());
})();
