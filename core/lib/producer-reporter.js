"use strict";

const crypto = require("crypto");

/*
 * Task #84 — a Koinos node reports itself without selling AI compute.
 *
 * Before this, the only thing that ever told koinosai.com about a block
 * producer was the earning Worker, on its own poll loop. So the dashboard
 * silently equated "this machine sells AI compute" with "this machine runs a
 * Koinos node", and an owner who turned Earning off watched their node
 * disappear from a page whose whole job is to tell them the node is fine.
 * Those are two separate decisions and this class reports the second one on
 * its own.
 *
 * It is deliberately a poor relation of the Worker: no token, no session, no
 * long poll. One signed POST on a timer, and nothing else. The scheduler
 * expires these rows on a TTL, so silence from a stopped node is self-
 * correcting rather than something that needs a goodbye to be delivered
 * reliably.
 */

// The scheduler drops a producer-only row after 30 minutes of silence, so
// report well inside that: three missed reports in a row still leave the
// dashboard showing the node. Matches the Worker's own producer cadence, so
// switching Earning on and off does not change how fresh the card is.
const REPORT_MS = 5 * 60 * 1000;

// A first report shortly after boot, rather than making the owner wait five
// minutes to see their node appear. Long enough that it lands after the
// Koinos node itself has had a chance to come up.
const FIRST_REPORT_MS = 45 * 1000;

class ProducerReporter {
  /**
   * @param {object}   o
   * @param {function} o.schedulerUrl  () => base URL, or "" when unset
   * @param {function} o.privacyMode   () => "local-only" | "local-first" | "network"
   * @param {object}   o.wallet        the app wallet (signHash + status)
   * @param {function} o.snapshot      () => Promise<snapshot|null>
   * @param {function} o.earning       () => true while the Worker is running
   * @param {function} [o.onEvent]
   * @param {function} [o.fetchImpl]   injected in tests
   */
  constructor({ schedulerUrl, privacyMode, wallet, snapshot, earning, onEvent, fetchImpl } = {}) {
    this.schedulerUrl = schedulerUrl || (() => "");
    this.privacyMode = privacyMode || (() => "local-only");
    this.wallet = wallet;
    this.snapshot = snapshot;
    this.earning = earning || (() => false);
    this.onEvent = onEvent || (() => {});
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.timer = null;
    this.running = false;
    // What the scheduler currently believes. Used only to avoid re-sending a
    // "forget me" for a node that is already forgotten — a stopped node must
    // not POST every five minutes for the rest of the session.
    this.reported = false;
    this.lastSentAt = 0;
    this.lastError = null;
    this.lastSkip = null;
  }

  start() {
    if (this.running) return this.status();
    this.running = true;
    this.timer = setTimeout(() => this._tick(), FIRST_REPORT_MS);
    if (this.timer.unref) this.timer.unref();
    return this.status();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.status();
  }

  status() {
    return {
      running: this.running,
      reported: this.reported,
      lastSentAt: this.lastSentAt || null,
      lastError: this.lastError,
      lastSkip: this.lastSkip,
    };
  }

  /*
   * Why a report is not being sent right now, or null when it should be.
   * Separated out because every one of these is a legitimate quiet state a
   * person might ask about ("why isn't my node on the dashboard?") and a
   * reason string is a better answer than an absent card.
   */
  _blocked() {
    /*
     * §29 strict: a Local-Only machine emits NOTHING. The Worker's kill-switch
     * poll has an exception for an actively earning worker because it is
     * already talking to the scheduler; there is no such exception here — this
     * reporter only ever runs when Earning is OFF, so a Local-Only machine
     * saying "here is my node, here is my VHP" would be a plain contract
     * break with no offsetting reason.
     */
    if (this.privacyMode() === "local-only") return "local-only privacy mode";
    if (!this.schedulerUrl()) return "no scheduler URL";
    /*
     * The earning Worker reports the same snapshot down its own channel and
     * the scheduler prefers the worker row. Two reporters would not be wrong,
     * only wasteful and confusing to read in the logs — so whichever is on,
     * exactly one of them speaks.
     */
    if (this.earning()) return "earning worker is reporting";
    // Signing needs the private key in memory. A locked wallet is a normal
    // state, not a failure — the next tick after an unlock picks it up.
    const s = this.wallet?.status?.();
    if (!s?.unlocked || !s.address) return "wallet locked";
    return null;
  }

  async _tick() {
    if (!this.running) return;
    try {
      await this.report();
    } catch (e) {
      // Never fatal, and never loud: the dashboard is a convenience and a
      // scheduler that will not answer must not turn into a stream of errors
      // in front of someone whose node is working perfectly.
      this.lastError = String(e?.message || e).slice(0, 200);
    }
    if (!this.running) return;
    this.timer = setTimeout(() => this._tick(), REPORT_MS);
    if (this.timer.unref) this.timer.unref();
  }

  /** One report. Exposed so a tick can be forced from a test or a nudge. */
  async report() {
    const blocked = this._blocked();
    if (blocked) {
      this.lastSkip = blocked;
      return { sent: false, reason: blocked };
    }
    this.lastSkip = null;

    let producer = null;
    try {
      producer = await this.snapshot();
    } catch (e) {
      // A node that cannot be read is reported as no node at all rather than
      // as a node with missing numbers — the dashboard's empty-tile case
      // already means "the app could not read this", and inventing a half
      // snapshot here would make that message a lie.
      this.lastError = String(e?.message || e).slice(0, 200);
      producer = null;
    }

    /*
     * Nothing to say. Tell the scheduler once so the card goes away promptly
     * (its handler deletes the row on an empty snapshot), then go quiet until
     * there is something to report again. Without the `reported` latch a
     * machine with no Koinos node would POST forever about the node it does
     * not have.
     */
    if (!producer) {
      if (!this.reported) return { sent: false, reason: "no producer" };
      const ok = await this._post(null);
      if (ok) {
        this.reported = false;
        this.onEvent({ type: "producer:cleared", message: "Your Koinos node stopped producing — removed from the dashboard." });
      }
      return { sent: ok, cleared: true };
    }

    const ok = await this._post(producer);
    // Only on the transition. This runs every five minutes for as long as the
    // node is up, and a log line each time would bury everything else.
    if (ok && !this.reported) {
      this.onEvent({ type: "producer:reported", message: "Your Koinos node is now on the dashboard, with Earning off." });
    }
    if (ok) this.reported = true;
    return { sent: ok, cleared: false };
  }

  async _post(producer) {
    const address = this.wallet.status().address;
    const ts = Date.now();
    /*
     * The "producer|" domain prefix is load-bearing, exactly as it is for
     * registration: this same wallet signs "consume|…" and "register|…" to
     * this same server, and without separate domains a signature captured
     * from one purpose would authorise another.
     */
    const hash = crypto.createHash("sha256").update(`producer|${address}|${ts}`).digest();
    let signature;
    try {
      signature = await this.wallet.signHash(hash);
    } catch (e) {
      this.lastError = `could not sign the producer report: ${String(e?.message || e).slice(0, 160)}`;
      return false;
    }
    const base = this.schedulerUrl().replace(/\/$/, "");
    const r = await this.fetch(`${base}/producer/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, ts, signature, producer }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      this.lastError = `scheduler refused the producer report (HTTP ${r.status})`;
      return false;
    }
    const body = await r.json().catch(() => null);
    if (body && body.ok === false) {
      this.lastError = String(body.error || "scheduler refused the producer report").slice(0, 200);
      return false;
    }
    this.lastError = null;
    this.lastSentAt = ts;
    return true;
  }
}

module.exports = { ProducerReporter, REPORT_MS, FIRST_REPORT_MS };
