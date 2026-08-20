"use strict";

const crypto = require("crypto");

/*
 * Earn worker (M2 step 3, §5.7): started by the Earn toggle. Connects
 * OUTBOUND to the project scheduler (§13 — no inbound ports), long-polls for
 * approved jobs (§31), runs them through the local runtime ladder, and
 * submits receipts signed with the wallet key (§17). Stop is immediate (§10):
 * the loop checks a flag between polls and in-flight work finishes cleanly.
 */
class Worker {
  /**
   * §7.4 anti-Sybil signal #3 — a deterministic DEVICE fingerprint: the hash
   * of hardware facts that don't change between runs (chip, cores, memory,
   * GPUs, platform). Two wallets on one machine hash the same; a fleet of
   * clones on identical VMs also hashes the same — which is exactly the
   * point: fingerprint collisions are a SIGNAL for the reputation shadow,
   * never an automatic verdict. Self-reported and spoofable by a modified
   * client, like every other single signal — the gate design stacks them.
   * Coarse by construction: nothing here identifies a person or a serial
   * number, and it never leaves the machine except toward the scheduler
   * the user opted into earning with.
   */
  static fingerprint(hw) {
    const crypto = require("crypto");
    const parts = [
      hw?.platform ?? "",
      hw?.arch ?? "",
      hw?.cpu?.model ?? "",
      String(hw?.cpu?.cores ?? ""),
      // Rounded GB, not bytes: byte counts wobble with firmware/OS carve-outs.
      String(hw?.ramBytes ? Math.round(hw.ramBytes / 1e9) : ""),
      ...(Array.isArray(hw?.gpus) ? hw.gpus.map((g) => g?.name ?? g?.model ?? "").sort() : []),
    ];
    return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  }

  constructor({ schedulerUrl, wallet, runtime, hardware, models, onEvent }) {
    this.schedulerUrl = String(schedulerUrl || "").replace(/\/$/, "");
    this.wallet = wallet; // WalletService (unlocked)
    this.runtime = runtime; // RuntimeManager
    this.hardware = hardware;
    this.models = models || null; // ModelManager — advertises what this machine can serve
    this.onEvent = onEvent || (() => {});
    this.running = false;
    this.token = null;
    // Health fields exist so "Earning" in the UI can never silently mean
    // "talking to nobody": the Earn tab renders last contact and last error.
    this.stats = { jobsDone: 0, receiptsAccepted: 0, since: null, lastPollOkAt: null, lastJobAt: null, lastError: null };
    this._loop = null;
    this._pollAbort = null; // aborts the idle long-poll so stop is immediate (§10)
  }

  status() {
    return {
      running: this.running,
      scheduler: this.schedulerUrl || null,
      // Per-model advertise verdicts from the last registration (null before
      // one happens) — the UI's answer to "why isn't my model serving?".
      modelGate: this.modelGate ?? null,
      ramGb: this.ramGb ?? null,
      ...this.stats,
    };
  }

  async _register() {
    // Single-flight, and the poll in the air is aborted afterward. The
    // scheduler keeps ONE token per address, so a register invalidates
    // whatever token the in-flight long-poll is carrying — without this,
    // the watchdog and the poll loop invalidate each other's tokens in a
    // perpetual 401 storm: ~90s on the roster after each register, then
    // aged off until the next one, in a 2–4 minute oscillation (field
    // finding — the night's actual final boss, timestamped by monitors).
    if (this._registerGate) return this._registerGate;
    this._registerGate = (async () => {
      const address = this.wallet.address;
      // Advertise the models actually on disk so the scheduler only hands
      // this machine jobs it can serve — a job for a missing model would
      // trigger a mid-lease gigabyte download and time out. Private models
      // stay private: custom imports and dev builds never ride the network
      // (unpriced, unvetted weights) — the scheduler enforces this too.
      // And only models this machine can serve COMFORTABLY: downloading a
      // model bigger than your RAM must not make you eligible for its jobs
      // (field feedback — it would reward hoarding over capability). The
      // same minRamGb line the catalog shows buyers gates what we offer.
      const ramGb = this.hardware?.ramBytes ? this.hardware.ramBytes / 1e9 : null;
      // Round like the capabilities report below does (field finding: a
      // "4 GB" Raspberry Pi sees ~3.9 GB after the GPU carve-out, so a
      // strict minRamGb<=ramGb refused Koinos Fast on the exact machine it
      // was named for — while the scheduler, receiving the ROUNDED ramGb,
      // would have accepted it. One fit rule, both sides).
      const fits = (a) => ramGb == null || !a.minRamGb || a.minRamGb <= Math.round(ramGb);
      // Per-model verdicts, kept on the worker so the UI can always answer
      // "why is my model not on the network?" with the actual rule that
      // fired (Pi field finding 2026-08-19: the machine sat online with an
      // empty advertisement and nothing anywhere said why).
      this.modelGate = this.models
        ? this.models.aliases().filter((a) => a.status === "ready").map((a) => ({
            alias: a.alias,
            advertised: !a.custom && !a.dev && fits(a),
            reason: a.custom
              ? "private import — never advertised"
              : a.dev
                ? "dev build — never advertised"
                : fits(a)
                  ? null
                  : `needs ${a.minRamGb} GB RAM — this machine reports ${Math.round(ramGb)} GB`,
          }))
        : [];
      this.ramGb = ramGb == null ? null : Math.round(ramGb);
      const ready = this.modelGate.filter((g) => g.advertised).map((g) => g.alias);
      // Every downloaded model is too big for this machine: say so instead
      // of silently earning nothing (the empty advertisement is correct —
      // this machine has nothing it can serve the network comfortably).
      if (this.models && ready.length === 0 && this.modelGate.some((g) => !g.advertised && g.reason?.includes("GB RAM"))) {
        const short = this.modelGate.filter((g) => g.reason?.includes("GB RAM")).map((g) => `${g.alias} (${g.reason})`).join("; ");
        this.onEvent({
          type: "worker:no-servable-models",
          message: `No model on this machine fits its RAM, so nothing is offered to the network: ${short}. Download a smaller model (like Koinos Fast) to serve and earn.`,
        });
      }
      const r = await fetch(`${this.schedulerUrl}/worker/register`, {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify({
          address,
          // RAM rides along so the scheduler can apply the same fit rule
          // server-side — the honest-client filter alone can't bind stale
          // or modified clients.
          capabilities: { ...(this.hardware?.capabilities ?? {}), ...(ramGb ? { ramGb: Math.round(ramGb) } : {}) },
          models: ready,
          // §7.4 anti-Sybil signal #3 (SHADOW): many wallets on one device —
          // or one device image cloned across a fleet — collide here.
          fingerprint: Worker.fingerprint(this.hardware),
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(`Scheduler refused registration: ${j.error}`);
      this.token = j.token;
      // The old token just died server-side: recall the in-flight poll so
      // the loop re-polls with the fresh token immediately instead of
      // waiting out a hold to receive a 401.
      this._pollAbort?.abort();
    })().finally(() => {
      this._registerGate = null;
    });
    return this._registerGate;
  }

  async start() {
    if (this.running) return this.status();
    if (!this.schedulerUrl) throw new Error("No scheduler URL configured (KAI_SCHEDULER_URL)");
    if (!this.wallet.address) throw new Error("Earning needs a wallet — create one first");

    await this._register();
    this.running = true;
    this.stats.since = new Date().toISOString();
    this.onEvent({ type: "worker:started", scheduler: this.schedulerUrl });
    this._startLoop();
    // Watchdog: "the pane says Online but the network disagrees" must be
    // impossible. If polls have been silent too long, re-register; if the
    // loop itself died, restart it. Runs while earning is on.
    this._lastTickAt = Date.now();
    this._watchdog = setInterval(async () => {
      if (!this.running) return;
      // Frozen-clock detection: if this 60s timer fired FAR later than
      // scheduled, the whole process was suspended (OS standby) — timers
      // don't drift minutes on a running machine. Re-register immediately
      // and count it, so the pane can tell the user their power settings
      // are pausing earning (field finding: an idle Windows laptop
      // suspended the app and the node silently fell off the roster).
      const gap = Date.now() - this._lastTickAt;
      this._lastTickAt = Date.now();
      if (gap > 180000) {
        this.stats.standbyResumes = (this.stats.standbyResumes || 0) + 1;
        this.stats.lastStandbyAt = new Date().toISOString();
        this.onEvent({ type: "worker:resumed-from-standby", suspendedSecs: Math.round(gap / 1000) });
        try {
          await this._register();
        } catch { /* next tick retries */ }
        return;
      }
      if (this._loopDone) {
        this.onEvent({ type: "worker:watchdog-restarted-loop" });
        this._startLoop();
        return;
      }
      const last = this.stats.lastPollOkAt ? new Date(this.stats.lastPollOkAt).getTime() : 0;
      if (!this._executing && Date.now() - last > 150000) {
        try {
          await this._register();
          this.onEvent({ type: "worker:watchdog-reregistered" });
        } catch {
          /* scheduler unreachable — pane shows the retry state */
        }
      }
    }, 60000);
    this._watchdog.unref?.();
    return this.status();
  }

  _startLoop() {
    this._loopDone = false;
    this._loop = this._run().finally(() => {
      this._loopDone = true;
    });
  }

  /** Immediate presence recovery — called on OS resume (the shell hears
   *  the native wake signal long before any timer notices). */
  async nudge() {
    if (!this.running) return { running: false };
    try {
      await this._register();
      this.onEvent({ type: "worker:nudged-reregistered" });
    } catch { /* unreachable — watchdog keeps retrying */ }
    return { running: true };
  }

  async stop() {
    this.running = false;
    clearInterval(this._watchdog);
    this._pollAbort?.abort();
    this.onEvent({ type: "worker:stopped" });
    await this._loop?.catch(() => {});
    this._loop = null;
  }

  async _run() {
    while (this.running) {
      let job = null;
      try {
        this._pollAbort = new AbortController();
        // Client timeout comfortably above the scheduler's 20s hold, so a
        // loaded machine doesn't abort polls the server is still serving.
        const r = await fetch(`${this.schedulerUrl}/worker/next-job?token=${this.token}`, {
          // Fresh TCP per request: NAT/routers silently drop idle pooled
          // connections and Node's pool then serves the corpse to every
          // later request — the node "goes offline" on an awake machine
          // and never heals (field finding, the day's final boss).
          headers: { connection: "close" },
          signal: AbortSignal.any([AbortSignal.timeout(45000), this._pollAbort.signal]),
        });
        if (r.status === 200) {
          this.stats.lastPollOkAt = new Date().toISOString();
          this.stats.lastError = null;
          job = (await r.json()).job;
        } else if (r.status === 401) {
          // The scheduler restarted (redeploy) and forgot our token: register
          // again and carry on — earning must survive scheduler restarts.
          await this._register();
          this.onEvent({ type: "worker:reregistered", scheduler: this.schedulerUrl });
          continue;
        } else if (r.status !== 204) {
          // Unexpected status (5xx, proxy error page): don't hot-spin on it.
          this.stats.lastError = `scheduler answered ${r.status} — retrying`;
          await new Promise((res) => setTimeout(res, 3000));
          continue;
        } else {
          this.stats.lastPollOkAt = new Date().toISOString();
          this.stats.lastError = null;
        }
      } catch {
        // Stop aborts the idle poll; anything else is the scheduler being
        // unreachable — back off, keep trying while enabled.
        if (!this.running) break;
        this.stats.lastError = "scheduler unreachable — retrying";
        await new Promise((res) => setTimeout(res, 3000));
        continue;
      }
      if (!job || !this.running) continue;

      // Heartbeat while executing: generation and model switching take
      // minutes, no polls happen meanwhile, and a silent worker used to
      // fall off the scheduler's live roster mid-job — consumers saw
      // "no providers" precisely when the provider was working hardest.
      const beat = setInterval(async () => {
        try {
          const r = await fetch(`${this.schedulerUrl}/worker/heartbeat?token=${this.token}`, { method: "POST", headers: { connection: "close" } });
          // Scheduler restarted mid-job and forgot us: re-register NOW so
          // the machine stays on the roster while it finishes generating
          // (field finding: a busy provider went invisible for the whole
          // job after a deploy — its heartbeats were failing silently).
          if (r.status === 401) await this._register();
        } catch {
          /* unreachable — next beat retries */
        }
      }, 25000);
      try {
        const t0 = Date.now();
        // Post generation deltas as they're produced — the consumer's
        // words appear live instead of arriving as one block. Batched
        // (~4/s) so a fast model doesn't turn into HTTP spam.
        let deltaBuf = "";
        let lastPost = 0;
        const postDelta = (text, force) => {
          deltaBuf += text;
          const now = Date.now();
          if (!deltaBuf || (!force && now - lastPost < 250)) return;
          const chunk = deltaBuf;
          deltaBuf = "";
          lastPost = now;
          fetch(`${this.schedulerUrl}/worker/chunk?token=${this.token}`, {
            method: "POST",
            headers: { "content-type": "application/json", connection: "close" },
            body: JSON.stringify({ jobId: job.id, delta: chunk }),
          }).catch(() => {});
        };
        this._executing = true;
        const { output, usage } = await this._execute(job, (d) => postDelta(d, false));
        postDelta("", true); // flush the tail
        // §51 CU groundwork: generation speed is the capability signal —
        // completion tokens over wall time (prefill is folded in; the
        // scheduler treats it as provider-reported, like usage).
        const ms = Math.max(1, Date.now() - t0);
        const perf = { ms, tokPerSec: +((usage.completion_tokens / (ms / 1000)) || 0).toFixed(2) };
        const hash = crypto.createHash("sha256").update(`${job.id}|${output}`).digest();
        const signature = await this.wallet.signHash(hash);
        const res = await fetch(`${this.schedulerUrl}/worker/result?token=${this.token}`, {
          method: "POST",
          headers: { "content-type": "application/json", connection: "close" },
          body: JSON.stringify({ jobId: job.id, output, usage, perf, signature }),
        });
        const jr = await res.json();
        this.stats.jobsDone += 1;
        this.stats.lastJobAt = new Date().toISOString();
        if (jr.accepted) this.stats.receiptsAccepted += 1;
        this.onEvent({ type: "worker:job-done", jobId: job.id, accepted: !!jr.accepted });
      } catch (e) {
        this.stats.lastError = `last job failed: ${String(e.message)}`;
        this.onEvent({ type: "worker:job-failed", jobId: job.id, message: String(e.message) });
      } finally {
        this._executing = false;
        clearInterval(beat);
      }
    }
  }

  /** §31: only approved profiles execute — anything else is refused. */
  async _execute(job, onDelta) {
    if (job.type !== "inference-eval" && job.type !== "chat") {
      throw new Error(`Unapproved job type: ${job.type}`);
    }
    // Cold engine swap ahead: acquiring a NON-resident model blocks through
    // the whole load (A40 field report: 166s cold for a 32B vs a 60s eval
    // lease — 8 timeout strikes with zero failed challenges). Tell the
    // scheduler BEFORE we go quiet so the lease gets a one-time warming
    // grace instead of blaming honest hardware. Fire-and-forget: an old
    // scheduler 404s and everything behaves exactly as before.
    if (this.runtime.activeAlias !== undefined && this.runtime.activeAlias !== job.model) {
      this.onEvent({ type: "worker:model-warming", jobId: job.id, model: job.model });
      fetch(`${this.schedulerUrl}/worker/warming?token=${this.token}`, {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ jobId: job.id }),
      }).catch(() => {});
    }
    // Hold the engine for the whole stream: a job for another model class
    // switching engines mid-generation is what cut network answers off.
    const hold = this.runtime.acquireFor
      ? await this.runtime.acquireFor(job.model)
      : { endpoint: await this.runtime.ensure(job.model), release: () => {} };
    try {
      return await this._executeOn(hold.endpoint, job, onDelta);
    } finally {
      hold.release();
    }
  }

  async _executeOn(endpoint, job, onDelta) {
    const served = this.runtime.servedModelName?.() ?? job.model;
    // chat = a relayed consumer request (§46.5); eval = protocol-funded (§16).
    const messages = job.type === "chat" && Array.isArray(job.messages)
      ? job.messages
      : [{ role: "user", content: job.prompt }];
    const r = await fetch(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: served,
        temperature: job.type === "chat" ? 0.7 : 0,
        max_tokens: job.type === "chat" ? 512 : 128,
        messages,
        // Stream from the engine so deltas can flow to the consumer live;
        // usage arrives in the final chunk (llama.cpp and Ollama both send
        // it) with a character-estimate fallback.
        stream: true,
      }),
    });
    if (!r.ok) throw new Error(`inference failed: HTTP ${r.status}`);
    // Engines that ignore stream:true answer plain JSON — take it whole.
    if (!(r.headers.get("content-type") || "").includes("text/event-stream")) {
      const j = await r.json();
      const whole = j.choices?.[0]?.message?.content ?? "";
      if (whole) onDelta?.(whole);
      return {
        output: whole,
        usage: {
          prompt_tokens: Number(j.usage?.prompt_tokens ?? 0),
          completion_tokens: Number(j.usage?.completion_tokens ?? 0),
        },
      };
    }
    let output = "";
    let usage = null;
    let buf = "";
    const decoder = new TextDecoder();
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            const d = j.choices?.[0]?.delta?.content || "";
            if (d) {
              output += d;
              onDelta?.(d);
            }
            if (j.usage) usage = j.usage;
          } catch {
            /* keep-alive frame */
          }
        }
      }
    }
    // Usage travels with the result — the network meters AI tokens (§14).
    // Engines that omit stream usage get a conservative char/4 estimate.
    return {
      output,
      usage: {
        prompt_tokens: Number(usage?.prompt_tokens ?? Math.ceil(JSON.stringify(messages).length / 4)),
        completion_tokens: Number(usage?.completion_tokens ?? Math.ceil(output.length / 4)),
      },
    };
  }
}

module.exports = { Worker };
