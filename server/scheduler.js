"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Signer } = require("koilib");

/*
 * Koinos AI scheduler — M2 alpha (§12/§13/§16/§17). Project-operated; workers
 * connect OUTBOUND only (register + long-poll + submit), never accept inbound
 * connections. Alpha job types are protocol-funded and profile-approved (§31):
 * "inference-eval" only. Receipts are signed by the worker's wallet key and
 * verified here by address recovery; a sampling rate of hidden known-answer
 * challenges (§17) flags dishonest providers. Epochs aggregate receipts into
 * a Merkle root ready for on-chain commitment (M2 step 5).
 *
 *   node server/scheduler.js          (PORT, KAI_OPERATOR_SECRET env)
 */

const LONG_POLL_MS = 20000;
const CHALLENGE_RATE = 0.2; // §17 sampling

class Scheduler {
  constructor({ dataDir, operatorSecret, chain, onEvent } = {}) {
    this.chain = chain || null; // ChainClient — when set, epoch roots anchor on-chain (§20)
    this.dataDir = dataDir || path.join(process.cwd(), "scheduler-data");
    this.operatorSecret = operatorSecret || null;
    this.onEvent = onEvent || (() => {});
    this.workers = new Map(); // token -> {address, capabilities, lastSeen}
    this.queue = []; // pending jobs
    this.pending = new Map(); // jobId -> job (dispatched, awaiting result)
    this.waiters = []; // long-poll resolvers
    this.receipts = []; // current epoch receipts
    this.epoch = 1;
    this.server = null;
  }

  enqueue(job) {
    const id = "job_" + crypto.randomBytes(8).toString("hex");
    const full = {
      id,
      type: job.type || "inference-eval",
      model: job.model || "dev-tiny",
      prompt: String(job.prompt || ""),
      // Hidden challenge (§17): expected output known only to the scheduler.
      challenge: job.expected ? { expected: job.expected } : null,
      createdAt: new Date().toISOString(),
    };
    this.queue.push(full);
    const waiter = this.waiters.shift();
    if (waiter) waiter();
    return full;
  }

  _json(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(data);
  }

  async _body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      return {};
    }
  }

  _auth(req) {
    const token = new URL(req.url, "http://x").searchParams.get("token");
    return token && this.workers.has(token) ? { token, ...this.workers.get(token) } : null;
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://x");

    if (url.pathname === "/worker/register" && req.method === "POST") {
      const b = await this._body(req);
      if (!b.address) return this._json(res, 400, { ok: false, error: "address required" });
      const token = "wt_" + crypto.randomBytes(16).toString("hex");
      this.workers.set(token, { address: b.address, capabilities: b.capabilities || {}, lastSeen: Date.now() });
      this.onEvent({ type: "scheduler:worker-registered", address: b.address });
      return this._json(res, 200, { ok: true, token, epoch: this.epoch });
    }

    if (url.pathname === "/worker/next-job" && req.method === "GET") {
      const w = this._auth(req);
      if (!w) return this._json(res, 401, { ok: false, error: "bad token" });
      w.lastSeen = Date.now();
      const give = () => {
        const job = this.queue.shift();
        this.pending.set(job.id, { ...job, worker: w.address });
        // The challenge's expected answer never leaves the scheduler.
        const { challenge, ...visible } = job;
        this._json(res, 200, { ok: true, job: visible });
      };
      if (this.queue.length > 0) return give();
      // Long-poll: wait for work or time out empty.
      await new Promise((resolve) => {
        const t = setTimeout(resolve, LONG_POLL_MS);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
      if (this.queue.length > 0 && !res.writableEnded) return give();
      return this._json(res, 204, { ok: true, job: null });
    }

    if (url.pathname === "/worker/result" && req.method === "POST") {
      const w = this._auth(req);
      if (!w) return this._json(res, 401, { ok: false, error: "bad token" });
      const b = await this._body(req);
      const job = this.pending.get(b.jobId);
      if (!job) return this._json(res, 404, { ok: false, error: "unknown job" });

      // §17: the receipt is a signature over sha256(jobId | output).
      const hash = crypto.createHash("sha256").update(`${b.jobId}|${b.output ?? ""}`).digest();
      let signer;
      try {
        signer = Signer.recoverAddress(hash, Buffer.from(String(b.signature), "base64"));
      } catch {
        return this._json(res, 400, { ok: false, error: "bad signature" });
      }
      if (signer !== w.address) {
        return this._json(res, 400, { ok: false, error: "signature does not match registered address" });
      }

      const honest = !job.challenge || this._passesChallenge(job.challenge, b.output);
      this.pending.delete(b.jobId);
      const receipt = {
        jobId: b.jobId,
        worker: w.address,
        outputHash: hash.toString("hex"),
        signature: b.signature,
        challenged: !!job.challenge,
        honest,
        at: new Date().toISOString(),
      };
      this.receipts.push(receipt);
      this._persist();
      this.onEvent({ type: honest ? "scheduler:receipt" : "scheduler:challenge-failed", worker: w.address });
      return this._json(res, 200, { ok: true, accepted: honest });
    }

    if (url.pathname === "/operator/enqueue" && req.method === "POST") {
      if (this.operatorSecret && req.headers["x-operator-secret"] !== this.operatorSecret) {
        return this._json(res, 401, { ok: false, error: "operator secret required" });
      }
      const b = await this._body(req);
      return this._json(res, 200, { ok: true, job: { id: this.enqueue(b).id } });
    }

    if (url.pathname === "/epoch/close" && req.method === "POST") {
      if (this.operatorSecret && req.headers["x-operator-secret"] !== this.operatorSecret) {
        return this._json(res, 401, { ok: false, error: "operator secret required" });
      }
      const summary = this.closeEpoch();
      if (this.chain) {
        try {
          summary.anchor = await this.chain.anchorRoot(summary.epoch, summary.root);
        } catch (e) {
          summary.anchorError = String(e.message);
        }
      }
      return this._json(res, 200, { ok: true, ...summary });
    }

    if (url.pathname === "/epoch/current" && req.method === "GET") {
      const totals = {};
      for (const r of this.receipts) if (r.honest) totals[r.worker] = (totals[r.worker] || 0) + 1;
      return this._json(res, 200, { ok: true, epoch: this.epoch, receipts: this.receipts.length, totals });
    }

    return this._json(res, 404, { ok: false, error: "not found" });
  }

  _passesChallenge(challenge, output) {
    // Alpha check: expected substring must appear (deterministic evals use
    // temperature 0; exact-match graduates with real eval jobs).
    return String(output ?? "").includes(challenge.expected);
  }

  /** Epoch close (§20): per-worker totals -> Merkle root over sorted leaves. */
  closeEpoch() {
    const totals = {};
    for (const r of this.receipts) if (r.honest) totals[r.worker] = (totals[r.worker] || 0) + 1;
    const leaves = Object.entries(totals)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([worker, count]) =>
        crypto.createHash("sha256").update(`${this.epoch}|${worker}|${count}`).digest()
      );
    const root = merkleRoot(leaves).toString("hex");
    const summary = { epoch: this.epoch, root, totals, receipts: this.receipts.length };
    this._persist(summary);
    this.epoch += 1;
    this.receipts = [];
    this.onEvent({ type: "scheduler:epoch-closed", ...summary });
    return summary;
  }

  _persist(summary) {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.dataDir, `epoch-${this.epoch}.json`),
        JSON.stringify({ epoch: this.epoch, receipts: this.receipts, summary: summary ?? null }, null, 2)
      );
    } catch {
      /* persistence is best-effort in alpha */
    }
  }

  listen(port = 0, host = "127.0.0.1") {
    this.server = http.createServer((req, res) =>
      this.handle(req, res).catch((e) => {
        try {
          this._json(res, 500, { ok: false, error: String(e.message) });
        } catch {
          /* response already gone */
        }
      })
    );
    return new Promise((resolve) => {
      this.server.listen(port, host, () => resolve(this.server.address().port));
    });
  }

  close() {
    for (const w of this.waiters.splice(0)) w();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections?.();
      this.server.close(resolve);
    });
  }
}

function merkleRoot(leaves) {
  if (leaves.length === 0) return crypto.createHash("sha256").update("empty").digest();
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? a; // odd leaf pairs with itself
      next.push(crypto.createHash("sha256").update(Buffer.concat([a, b])).digest());
    }
    level = next;
  }
  return level[0];
}

module.exports = { Scheduler, merkleRoot };

if (require.main === module) {
  const s = new Scheduler({
    operatorSecret: process.env.KAI_OPERATOR_SECRET,
    onEvent: (e) => console.log(`[scheduler] ${e.type}`, e.worker ?? e.root ?? ""),
  });
  s.listen(Number(process.env.PORT || 41200), process.env.HOST || "127.0.0.1").then((p) =>
    console.log(`[scheduler] listening on ${p}`)
  );
}
