"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const crypto = require("crypto");
const { Scheduler } = require("../../server/scheduler");
const { WalletService } = require("../lib/wallet");

/*
 * Model-matched dispatch: workers advertise the models they hold, and the
 * scheduler only hands them jobs they can serve — a mismatched job would
 * trigger a mid-lease gigabyte download and time out. Legacy workers that
 * advertise nothing predate the launch catalog and hold only dev-tiny.
 */

const boot = (opts) =>
  new Scheduler({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "kai-disp-")), epoch: 70, ...opts });

async function register(base, address, models) {
  const r = await fetch(`${base}/worker/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, capabilities: {}, models }),
  });
  return (await r.json()).token;
}

async function poll(base, token) {
  const r = await fetch(`${base}/worker/next-job?token=${token}`, { signal: AbortSignal.timeout(2500) });
  return r.status === 200 ? (await r.json()).job : null;
}

test("dispatch matches jobs to advertised models; legacy workers get only dev-tiny", async () => {
  const sched = boot({});
  const port = await sched.listen();
  const base = `http://127.0.0.1:${port}`;
  try {
    const fastToken = await register(base, "1WorkerFast", ["koinos-fast"]);
    const legacyToken = await register(base, "1WorkerLegacy", []);

    sched.enqueue({ type: "inference-eval", prompt: "x", model: "koinos-fast" });
    sched.enqueue({ type: "inference-eval", prompt: "y", model: "dev-tiny" });

    const fastJob = await poll(base, fastToken);
    assert.strictEqual(fastJob.model, "koinos-fast", "advertising worker gets its class");
    const legacyJob = await poll(base, legacyToken);
    assert.strictEqual(legacyJob.model, "dev-tiny", "legacy worker gets the dev model, never the launch class");

    // Nothing servable left for the fast worker: its poll long-polls empty.
    sched.enqueue({ type: "inference-eval", prompt: "z", model: "dev-tiny" });
    const nothing = await poll(base, fastToken).catch(() => "timeout");
    assert.ok(nothing === null || nothing === "timeout", "a dev-tiny job never reaches a koinos-fast-only worker");
  } finally {
    await sched.close();
  }
});

test("consume fails fast with a clear 503 when no live provider serves the job class", async () => {
  const sched = boot({ jobModel: "koinos-fast" });
  const port = await sched.listen();
  const base = `http://127.0.0.1:${port}`;
  try {
    // Only a legacy (dev-tiny) worker online — nobody serves koinos-fast.
    await register(base, "1WorkerLegacy", []);
    // Properly signed request (§23) so the fail-fast — which runs after
    // auth — is what actually answers.
    const wdir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-disp-w-"));
    const wallet = new WalletService(wdir);
    wallet.create({ password: "correct horse" });
    const messages = [{ role: "user", content: "hi" }];
    const ts = Date.now();
    const hash = crypto.createHash("sha256").update(`consume|${wallet.address}|${ts}|${JSON.stringify(messages)}`).digest();
    const signature = await wallet.signHash(hash);
    const r = await fetch(`${base}/consume/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, address: wallet.address, ts, signature }),
    });
    assert.strictEqual(r.status, 503, "answers immediately — never the 90s dead-air hang");
    const j = await r.json();
    assert.match(j.error.message, /No providers are serving "koinos-fast"/);
    assert.match(j.error.message, /Start Earning/, "the error tells the tester the way out");
  } finally {
    await sched.close();
  }
});
