(function(root) {
  "use strict";
  const DAY = 86400000, MAX = (1n << 64n) - 1n;
  const states = new Set(["awaiting_review", "reviewing", "finalizing", "needs_review"]);
  const atom = v => typeof v === "string" && /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) <= MAX;
  const epoch = v => typeof v === "string" && /^(0|[1-9]\d{0,9})$/.test(v);
  const time = v => Number.isSafeInteger(v) && v >= 0;
  function validate(value, account, observedAt, payouts = []) {
    if (!value || value.schema !== 1 || value.account !== account || !value.current || !Array.isArray(value.pending) || value.pending.length > 32) throw Error("Daily reward summary unavailable");
    const c = value.current, start = Number(c.epoch) * DAY;
    if (!epoch(c.epoch) || c.epoch !== String(Math.floor(observedAt / DAY)) || c.closesAt !== start + DAY ||
        !(c.availability === null ? c.asOf === null : atom(c.availability) && time(c.asOf) && c.asOf >= start && c.asOf < c.closesAt && c.asOf <= observedAt)) throw Error("Invalid daily reward estimate");
    const seen = new Set(payouts.map(r => r.epoch));
    const pending = value.pending.map(r => {
      if (!r || !epoch(r.epoch) || Number(r.epoch) >= Number(c.epoch) || seen.has(r.epoch) || !states.has(r.state) ||
          !atom(r.availability) || !atom(r.work) || BigInt(r.availability) + BigInt(r.work) > MAX ||
          !(r.reviewUntil === null || time(r.reviewUntil) && r.reviewUntil >= (Number(r.epoch) + 2) * DAY)) throw Error("Invalid pending reward allocation");
      seen.add(r.epoch);
      return { epoch: r.epoch, availability: r.availability, work: r.work, state: r.state, reviewUntil: r.reviewUntil };
    });
    return { schema: 1, account, current: { epoch: c.epoch, closesAt: c.closesAt, availability: c.availability, asOf: c.asOf }, pending };
  }
  function totals(summary, payouts) {
    const pending = [...(summary?.pending || []), ...payouts.filter(r => !["paid", "paid_elsewhere"].includes(r.state))];
    return { availability: pending.reduce((n, r) => n + BigInt(r.availability), 0n).toString(),
      work: pending.reduce((n, r) => n + BigInt(r.work), 0n).toString(),
      attention: pending.some(r => r.state === "needs_review"),
      reviewing: summary?.pending.length || 0,
      sending: payouts.filter(r => !["paid", "paid_elsewhere", "needs_review"].includes(r.state)).length,
      reviewUntil: Math.min(...(summary?.pending || []).filter(r => r.state === "reviewing" && r.reviewUntil !== null).map(r => r.reviewUntil)) };
  }
  const api = { validate, totals };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KaiRewardSummary = api;
})(typeof window !== "undefined" ? window : globalThis);
