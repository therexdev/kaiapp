"use strict";

/*
 * The block-producer snapshot: what this machine's Koinos node is doing,
 * shaped for the account page and the koinosai.com dashboard.
 *
 * This lived inside `earn.start()` until task #84, which is why a node that
 * was quietly producing blocks vanished from the owner's dashboard the moment
 * they turned Earning off. Running a Koinos node and selling AI compute are
 * two different decisions; only one of them was ever meant to control whether
 * the node reports itself. Both callers — the earning Worker and the
 * standalone reporter — now build the snapshot from this one function, so the
 * dashboard cannot describe the same node two different ways depending on
 * which switch happens to be on.
 *
 * `call` is the Koinos node service's request function; `appVersion` is
 * stamped into the snapshot so the website can tell an old client from a
 * chain RPC that would not answer.
 */
function createProducerSnapshot({ call, appVersion }) {
  /*
   * Where the account page's Koinos node card comes from. Both numbers
   * are taken from the SAME block_producer log lines so the ratio is
   * self-consistent — a VHP balance read seconds apart from a network
   * estimate is a subtly wrong share.
   *
   * Returns null when there is nothing to report: no node, a node that is
   * stopped or still syncing, or a node running without block production.
   * Callers treat null as "say nothing about this machine" — never as zero.
   */
  return async () => {
    const { parseProducerLog, summarize, stakeGap } = require("./producer-share");
    const text = await call("node:logs", { service: "block_producer", tail: 60 });
    const parsed = parseProducerLog(typeof text === "string" ? text : text?.logs || "");
    if (!parsed) return null;

    /*
     * The rest comes from dashboard:summary — the SAME call the desktop
     * Node screen draws from. Deriving a second, thinner version here
     * would guarantee the website and the app eventually disagree about
     * someone's money, and the one place that must never happen is the
     * number a person checks on their phone.
     *
     * It is best-effort: a chain RPC that will not answer, or a price
     * that has not arrived, leaves nulls that render as unknown. Only
     * the share (which came from the log) is guaranteed.
     */
    let sum = null;
    try {
      sum = await call("dashboard:summary", {});
    } catch { /* node down or RPC unreachable */ }
    const v = sum?.value || {};
    const price = sum?.price || {};
    const vhpSats = sum?.balances && !sum.balances.error ? String(sum.balances.vhp ?? "") || null : null;

    /*
     * The two VHP numbers, compared. They are not always the same: a
     * node can be entered in the block lottery with a fraction of the
     * stake its wallet holds, and every screen still looks healthy.
     * Nothing else in this snapshot would reveal it, because each side
     * is individually correct.
     */
    const gap = stakeGap({ producingVhp: parsed.producingVhp, walletVhpSats: vhpSats });

    return {
      ...summarize(parsed),
      at: parsed.at || null,
      koinSats: sum?.balances && !sum.balances.error ? String(sum.balances.koin ?? "") || null : null,
      vhpSats,
      // True when the node is producing with materially less than the
      // wallet holds — worth a person's attention, and worth saying out
      // loud rather than leaving two numbers side by side to be noticed.
      stakeBehind: gap.behind,
      stakeShortfallPct: gap.behind ? gap.shortfallPct : null,
      usdPerKoin: price.usdPerKoin ?? null,
      priceStale: price.stale ?? null,
      nodeValueUsd: v.nodeValueUsd ?? null,
      dailyUsd: v.dailyUsd ?? null,
      weeklyUsd: v.weeklyUsd ?? null,
      yearlyUsd: v.yearlyUsd ?? null,
      daysTracked: v.daysTracked ?? null,
      // "measured" or "no-history" — so the dashboard can say "not enough
      // history yet" instead of printing $0.00 at someone.
      basis: v.basis ?? null,
      /*
       * Which app built this snapshot. Older versions sent the block
       * share and nothing else, so a dashboard with empty value tiles
       * has two very different causes — a chain RPC that would not
       * answer, or an app that never had the fields. Without this the
       * website cannot tell them apart, and neither can the person
       * looking at it.
       */
      appVersion,
      reportedAt: new Date().toISOString(),
    };
  };
}

module.exports = { createProducerSnapshot };
