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
  constructor({ schedulerUrl, wallet, runtime, hardware, onEvent }) {
    this.schedulerUrl = String(schedulerUrl || "").replace(/\/$/, "");
    this.wallet = wallet; // WalletService (unlocked)
    this.runtime = runtime; // RuntimeManager
    this.hardware = hardware;
    this.onEvent = onEvent || (() => {});
    this.running = false;
    this.token = null;
    this.stats = { jobsDone: 0, receiptsAccepted: 0, since: null };
    this._loop = null;
    this._pollAbort = null; // aborts the idle long-poll so stop is immediate (§10)
  }

  status() {
    return { running: this.running, scheduler: this.schedulerUrl || null, ...this.stats };
  }

  async start() {
    if (this.running) return this.status();
    if (!this.schedulerUrl) throw new Error("No scheduler URL configured (KAI_SCHEDULER_URL)");
    const address = this.wallet.address;
    if (!address) throw new Error("Earning needs a wallet — create one first");

    const r = await fetch(`${this.schedulerUrl}/worker/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, capabilities: this.hardware?.capabilities ?? {} }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`Scheduler refused registration: ${j.error}`);
    this.token = j.token;
    this.running = true;
    this.stats.since = new Date().toISOString();
    this.onEvent({ type: "worker:started", scheduler: this.schedulerUrl });
    this._loop = this._run();
    return this.status();
  }

  async stop() {
    this.running = false;
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
          signal: AbortSignal.any([AbortSignal.timeout(45000), this._pollAbort.signal]),
        });
        if (r.status === 200) job = (await r.json()).job;
      } catch {
        // Stop aborts the idle poll; anything else is the scheduler being
        // unreachable — back off, keep trying while enabled.
        if (!this.running) break;
        await new Promise((res) => setTimeout(res, 3000));
        continue;
      }
      if (!job || !this.running) continue;

      try {
        const output = await this._execute(job);
        const hash = crypto.createHash("sha256").update(`${job.id}|${output}`).digest();
        const signature = await this.wallet.signHash(hash);
        const res = await fetch(`${this.schedulerUrl}/worker/result?token=${this.token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId: job.id, output, signature }),
        });
        const jr = await res.json();
        this.stats.jobsDone += 1;
        if (jr.accepted) this.stats.receiptsAccepted += 1;
        this.onEvent({ type: "worker:job-done", jobId: job.id, accepted: !!jr.accepted });
      } catch (e) {
        this.onEvent({ type: "worker:job-failed", jobId: job.id, message: String(e.message) });
      }
    }
  }

  /** §31: only approved profiles execute — anything else is refused. */
  async _execute(job) {
    if (job.type !== "inference-eval" && job.type !== "chat") {
      throw new Error(`Unapproved job type: ${job.type}`);
    }
    const endpoint = await this.runtime.ensure(job.model);
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
      }),
    });
    if (!r.ok) throw new Error(`inference failed: HTTP ${r.status}`);
    const j = await r.json();
    return j.choices?.[0]?.message?.content ?? "";
  }
}

module.exports = { Worker };
