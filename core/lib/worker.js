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
    return { running: this.running, scheduler: this.schedulerUrl || null, ...this.stats };
  }

  async _register() {
    const address = this.wallet.address;
    // Advertise the models actually on disk so the scheduler only hands
    // this machine jobs it can serve — a job for a missing model would
    // trigger a mid-lease gigabyte download and time out.
    const ready = this.models ? this.models.aliases().filter((a) => a.status === "ready").map((a) => a.alias) : [];
    const r = await fetch(`${this.schedulerUrl}/worker/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, capabilities: this.hardware?.capabilities ?? {}, models: ready }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`Scheduler refused registration: ${j.error}`);
    this.token = j.token;
  }

  async start() {
    if (this.running) return this.status();
    if (!this.schedulerUrl) throw new Error("No scheduler URL configured (KAI_SCHEDULER_URL)");
    if (!this.wallet.address) throw new Error("Earning needs a wallet — create one first");

    await this._register();
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
      const beat = setInterval(() => {
        fetch(`${this.schedulerUrl}/worker/heartbeat?token=${this.token}`, { method: "POST" }).catch(() => {});
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
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jobId: job.id, delta: chunk }),
          }).catch(() => {});
        };
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
          headers: { "content-type": "application/json" },
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
        clearInterval(beat);
      }
    }
  }

  /** §31: only approved profiles execute — anything else is refused. */
  async _execute(job, onDelta) {
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
