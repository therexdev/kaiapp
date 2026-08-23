"use strict";

/*
 * How often this machine should expect to produce a block.
 *
 * Koinos proof-of-burn is a lottery weighted by VHP: your chance at each block
 * is your producing VHP over the network's. The block_producer logs both
 * numbers every minute — "Producing with X VHP" and "Estimated total VHP
 * producing: Y" — which is everything needed, and nothing else is required to
 * answer the question people actually ask, which is "is my node working, and
 * how often should I see a block?"
 *
 * Deliberately NOT here: what a block pays. The reward is not a constant this
 * code can safely assume, and producer-stats.js already measures realised
 * profit from what actually landed on chain. An invented reward multiplied by
 * a correct block rate produces a confident, wrong dollar figure — which is
 * worse than not showing one.
 *
 * A worked example, from a real node on 2026-08-23:
 *   producing 659.46 VHP of an estimated 5,381,380 → 0.01225%, about one
 *   block in 8,160, roughly 3.5 blocks a day.
 */

// Koinos targets one block every 3 seconds.
const BLOCK_SECONDS = 3;
const SECONDS_PER_DAY = 86400;

/**
 * @param producingVhp  this node's VHP (a number, or a numeric string)
 * @param networkVhp    estimated total VHP producing network-wide
 * Returns nulls rather than Infinity/NaN when either side is missing — an
 * unknown share must render as unknown, never as zero or as a certainty.
 */
function summarize({ producingVhp, networkVhp, blockSeconds = BLOCK_SECONDS } = {}) {
  const mine = Number(producingVhp);
  const total = Number(networkVhp);
  const ok = Number.isFinite(mine) && Number.isFinite(total) && mine > 0 && total > 0;
  if (!ok) {
    return { producingVhp: Number.isFinite(mine) ? mine : null, networkVhp: Number.isFinite(total) ? total : null,
             sharePct: null, oneInBlocks: null, blocksPerDay: null, hoursPerBlock: null };
  }
  const share = mine / total;
  const blocksPerDay = share * (SECONDS_PER_DAY / blockSeconds);
  return {
    producingVhp: mine,
    networkVhp: total,
    sharePct: share * 100,
    oneInBlocks: 1 / share,
    blocksPerDay,
    // The number a person actually feels: "should I have seen one by now?"
    hoursPerBlock: blocksPerDay > 0 ? 24 / blocksPerDay : null,
  };
}

/**
 * Is a gap since the last block long enough to be worth worrying about?
 *
 * Block production is a Poisson process, so silence is the normal state for a
 * small producer — this node expects one block every ~7 hours, which means
 * quiet stretches of a day are unremarkable. The probability of seeing NO
 * block in `hours` is exp(-hours/hoursPerBlock); "quiet" only becomes
 * "suspicious" out in the tail. Without this, a dashboard that says "last
 * block 9 hours ago" reads like a fault when it is an ordinary Tuesday.
 */
function quietness({ hoursSinceLastBlock, hoursPerBlock }) {
  const h = Number(hoursSinceLastBlock);
  const rate = Number(hoursPerBlock);
  if (!Number.isFinite(h) || !Number.isFinite(rate) || rate <= 0) return { p: null, unusual: false };
  const p = Math.exp(-h / rate);           // chance of a gap at least this long
  return { p, unusual: p < 0.05 };         // ~3x the mean gap before we say anything
}

/*
 * Read the two numbers out of block_producer's log.
 *
 * The producer prints both every minute, and they are the only place the
 * network-wide total is available without querying the PoB contract directly.
 * Its own VHP balance could be read from chain, but taking BOTH from the same
 * line keeps them consistent with each other — a balance read seconds apart
 * from a network estimate is a subtly wrong ratio.
 *
 * Scans from the end and stops at the first complete pair, so a long log costs
 * nothing. Returns null when the lines are absent, which is the normal state
 * for a node that is synced but not producing.
 */
function parseProducerLog(text) {
  const lines = String(text || "").split("\n");
  let producingVhp = null;
  let networkVhp = null;
  let at = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (producingVhp == null) {
      const m = /Producing with ([\d.]+) VHP/.exec(line);
      if (m) {
        producingVhp = Number(m[1]);
        const t = /(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/.exec(line);
        if (t) at = `${t[1].replace(" ", "T")}Z`;
        continue;
      }
    }
    if (networkVhp == null) {
      const m = /Estimated total VHP producing: ([\d.]+) VHP/.exec(line);
      if (m) networkVhp = Number(m[1]);
    }
    if (producingVhp != null && networkVhp != null) break;
  }
  if (producingVhp == null && networkVhp == null) return null;
  return { producingVhp, networkVhp, at };
}

/**
 * Is the node producing with everything the wallet holds?
 *
 * It is not always. On a real machine on 2026-08-23 the chain said the wallet
 * held 41,123.92 VHP and the block producer said it was producing with
 * 16,955.37 — 41% of the stake, for the same address, on the same computer.
 * Nothing looked broken: the node was running, in sync, producing blocks, and
 * every screen was internally consistent. It was simply entered in the lottery
 * with a fraction of the tickets it had paid for.
 *
 * That is money. In proof-of-burn the producer derives, from its own VHP
 * figure, the moment its proof becomes valid — understate the stake and it
 * submits later and loses races it should have won. So this is worth checking
 * on every reading, not worth waiting for someone to notice.
 *
 * Deliberately one-directional: producing MORE than the wallet holds is not
 * flagged. The two numbers are read seconds apart while VHP is being consumed,
 * so tiny disagreements in that direction are ordinary, and a false alarm that
 * tells someone to restart a node is worse than silence.
 *
 * @param producingVhp   what the block_producer log says (a number)
 * @param walletVhpSats  the chain balance, in satoshis (string or number)
 * @param tolerance      fraction of the wallet stake to forgive; 2% covers a
 *                       reading taken a few minutes apart on a busy producer.
 */
function stakeGap({ producingVhp, walletVhpSats, tolerance = 0.02 } = {}) {
  const producing = Number(producingVhp);
  const wallet = Number(walletVhpSats) / 1e8;
  if (!Number.isFinite(producing) || !Number.isFinite(wallet) || wallet <= 0 || producing <= 0) {
    return { walletVhp: null, producingVhp: null, shortfallPct: null, behind: false };
  }
  const shortfall = (wallet - producing) / wallet;
  return {
    walletVhp: wallet,
    producingVhp: producing,
    // Positive means the node is producing with LESS than it holds.
    shortfallPct: shortfall * 100,
    behind: shortfall > tolerance,
  };
}

module.exports = { summarize, quietness, parseProducerLog, stakeGap, BLOCK_SECONDS };
