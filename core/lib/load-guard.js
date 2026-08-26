"use strict";

const { execFile } = require("child_process");

/*
 * Load guard: earning must never win a fight with the person who owns the
 * machine.
 *
 * Field report (2026-08-26): a tester doing heavy GPU design work with Earn
 * enabled had their PC freeze outright — and closing Koinos AI instantly
 * fixed it. That is the signature of VRAM oversubscription: the GPU engine
 * rungs boot llama-server with full offload, so the model's weights sit in
 * GPU memory the whole time Earn is on, whether or not a job is running.
 * When another application wants that memory, Windows' GPU memory manager
 * starts paging VRAM in and out and the entire desktop stalls with it.
 * Closing the app freed several gigabytes at once — hence the instant
 * recovery. The fix is to do that ourselves, before the freeze.
 *
 * The rule, borrowed from two decades of BOINC: donate the machine when it
 * is idle, get out of the way the moment it is not. Concretely:
 *
 *   - While Earn runs, sample total GPU utilization every SAMPLE_MS.
 *   - Samples taken while OUR engine is streaming are skipped — that load
 *     is ours, and backing off from our own work would oscillate.
 *   - ENTER_SAMPLES consecutive busy samples (someone else is really using
 *     the GPU, not a one-second blip) => contention: the worker stops
 *     polling for jobs (falls off the roster — the scheduler treats machines
 *     coming and going as normal), and the idle engine is stopped, which
 *     releases every byte of VRAM immediately.
 *   - EXIT_SAMPLES consecutive quiet samples (a real lull, not a pause
 *     between brush strokes) => resume: re-register and poll again. The
 *     model reloads lazily on the next job; the scheduler's warming grace
 *     (built for cold loads on big models) already forgives that delay.
 *
 * Only NVIDIA is measurable today (nvidia-smi ships with the driver on
 * every platform). That covers the machines that offload to GPU in the
 * first place — cudaEligible is what turns full offload on. On machines
 * without it the guard reports itself unsupported and does nothing, rather
 * than pretending: status() carries `supported` so the UI can say which.
 *
 * Deliberately NOT a signal (v1): VRAM-percent-full. Our own weights push
 * memory.used near the top of small cards on a machine nobody is touching,
 * so a pressure threshold would permanently pause earning on exactly the
 * modest hardware the network courts. Utilization from a skipped-when-busy
 * vantage point attributes load to "not us" cleanly; memory percent cannot.
 */

const SAMPLE_MS = 10_000;
const BUSY_PCT = 40; // sustained GPU use by other apps, not a compositor blip
const ENTER_SAMPLES = 3; // 30s of someone else working the GPU => back off
const EXIT_SAMPLES = 12; // 2min of quiet => come back (flapping costs a cold load)

/** Total GPU utilization across all processes, max over GPUs. Null when it
 *  cannot be known (no NVIDIA driver, tool missing, output unparseable). */
function sampleNvidiaGpu() {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const rows = String(stdout)
          .trim()
          .split("\n")
          .map((line) => line.split(",").map((s) => Number(s.trim())))
          .filter((r) => r.length >= 1 && Number.isFinite(r[0]));
        if (!rows.length) return resolve(null);
        const utilPct = Math.max(...rows.map((r) => r[0]));
        return resolve({ utilPct });
      }
    );
  });
}

class LoadGuard {
  /**
   * @param {object} opts
   * @param {() => boolean} opts.isOurLoad true while our engine is loading or
   *   streaming — those samples are skipped in BOTH directions (they neither
   *   trigger contention nor count as quiet; the counters simply hold).
   * @param {(info: {utilPct: number}) => void} opts.onContention called on
   *   every contended sample, first one included — actions must be idempotent.
   * @param {() => void} opts.onQuiet called once when contention clears.
   * @param {() => Promise<{utilPct: number}|null>} [opts.sample] injectable
   *   for tests; defaults to nvidia-smi.
   */
  constructor({ isOurLoad, onContention, onQuiet, onEvent, sample, busyPct, enterSamples, exitSamples, sampleMs }) {
    this.isOurLoad = isOurLoad || (() => false);
    this.onContention = onContention || (() => {});
    this.onQuiet = onQuiet || (() => {});
    this.onEvent = onEvent || (() => {});
    this.sample = sample || sampleNvidiaGpu;
    this.busyPct = busyPct ?? BUSY_PCT;
    this.enterSamples = enterSamples ?? ENTER_SAMPLES;
    this.exitSamples = exitSamples ?? EXIT_SAMPLES;
    this.sampleMs = sampleMs ?? SAMPLE_MS;
    this.paused = false; // "contention detected, earning backed off"
    this.supported = null; // unknown until the first sample answers
    this.lastUtilPct = null;
    this.pausedSince = null;
    this.pauses = 0;
    this._busyRun = 0;
    this._quietRun = 0;
    this._failRun = 0;
    this._timer = null;
    this._sampling = false;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), this.sampleMs);
    this._timer.unref?.();
    this._tick(); // first answer now, not in ten seconds
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
    // Leave `paused` as-is: earn.stop() tears the worker down anyway, and a
    // restart constructs a fresh guard.
  }

  status() {
    return {
      supported: this.supported,
      paused: this.paused,
      lastUtilPct: this.lastUtilPct,
      pausedSince: this.pausedSince,
      pauses: this.pauses,
    };
  }

  async _tick() {
    if (this._sampling) return; // a slow nvidia-smi must not stack calls
    this._sampling = true;
    try {
      if (this.isOurLoad()) return; // our own generation: attribution is "us", hold all counters
      const s = await this.sample();
      if (!s) {
        // Three strikes and the guard admits it cannot see the GPU — one
        // event, then silence, not a red X every ten seconds forever.
        this._failRun += 1;
        if (this._failRun >= 3 && this.supported !== false) {
          this.supported = false;
          this.onEvent({ type: "guard:unsupported" });
        }
        return;
      }
      this._failRun = 0;
      if (this.supported !== true) {
        this.supported = true;
        this.onEvent({ type: "guard:active" });
      }
      this.lastUtilPct = s.utilPct;

      if (s.utilPct >= this.busyPct) {
        this._busyRun += 1;
        this._quietRun = 0;
        if (this._busyRun >= this.enterSamples) {
          if (!this.paused) {
            this.paused = true;
            this.pausedSince = new Date().toISOString();
            this.pauses += 1;
            this.onEvent({ type: "guard:contention", utilPct: s.utilPct });
          }
          // Every contended sample, not just the first: the unload can be
          // skipped while a stream drains, and the retry has to come from
          // somewhere. Callee is idempotent.
          this.onContention({ utilPct: s.utilPct });
        }
      } else {
        this._quietRun += 1;
        this._busyRun = 0;
        if (this.paused && this._quietRun >= this.exitSamples) {
          this.paused = false;
          this.pausedSince = null;
          this.onEvent({ type: "guard:quiet" });
          this.onQuiet();
        }
      }
    } finally {
      this._sampling = false;
    }
  }
}

module.exports = { LoadGuard, sampleNvidiaGpu, BUSY_PCT, ENTER_SAMPLES, EXIT_SAMPLES, SAMPLE_MS };
