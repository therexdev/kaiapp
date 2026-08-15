"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { WalletService } = require("../lib/wallet");
const { Worker } = require("../lib/worker");
const { Scheduler, merkleRoot } = require("../../server/scheduler");

test("wallet: create -> lock -> unlock roundtrip; wrong password fails; keys stay encrypted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-w-"));
  const w = new WalletService(dir);
  assert.equal(w.exists(), false);
  const { address, wif } = w.create({ password: "correct horse" });
  assert.ok(address.length >= 26 && wif.length > 40);
  assert.ok(!fs.readFileSync(w.keystorePath, "utf8").includes(wif), "no plaintext key on disk");

  w.lock();
  assert.throws(() => w.signer, /locked/);
  assert.equal(w.address, address, "address readable while locked");
  assert.throws(() => w.unlock("wrong password"), /Incorrect password/);
  assert.equal(w.unlock("correct horse").address, address);
  assert.throws(() => w.create({ password: "another pass" }), /already exists/);
});

test("wallet: signHash produces a signature the scheduler side can recover", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-w-"));
  const w = new WalletService(dir);
  const { address } = w.create({ password: "correct horse" });
  const hash = crypto.createHash("sha256").update("receipt").digest();
  const sig = await w.signHash(hash);
  assert.equal(WalletService.recoverAddress(hash, sig), address);
});

test("merkleRoot is order-stable and pairs odd leaves", () => {
  const L = (s) => crypto.createHash("sha256").update(s).digest();
  const r3 = merkleRoot([L("a"), L("b"), L("c")]).toString("hex");
  assert.equal(merkleRoot([L("a"), L("b"), L("c")]).toString("hex"), r3);
  assert.notEqual(merkleRoot([L("a"), L("b")]).toString("hex"), r3);
  assert.equal(merkleRoot([]).length, 32);
});

test("earn loop: register -> job -> local inference -> signed receipt -> epoch root", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-earn-"));
  const wallet = new WalletService(path.join(dir, "wallet"));
  const { address } = wallet.create({ password: "correct horse" });

  // Fake runtime: the worker only needs ensure() + an OpenAI-shaped endpoint.
  const http = require("http");
  const fakeLlm = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "the answer is 42" } }] }));
    });
  });
  const llmPort = await new Promise((r) => fakeLlm.listen(0, "127.0.0.1", function () { r(this.address().port); }));
  const runtime = { ensure: async () => `http://127.0.0.1:${llmPort}`, servedModelName: () => null };

  const events = [];
  const sched = new Scheduler({ dataDir: path.join(dir, "sched"), epoch: 1, onEvent: (e) => events.push(e.type) });
  const schedPort = await sched.listen();

  const worker = new Worker({
    schedulerUrl: `http://127.0.0.1:${schedPort}`,
    wallet,
    runtime,
    hardware: { capabilities: { cpuFallback: true } },
    onEvent: (e) => events.push(e.type),
  });

  try {
    await worker.start();
    // One plain job and one hidden challenge the fake answer satisfies (§17).
    sched.enqueue({ prompt: "What is 6x7?" });
    sched.enqueue({ prompt: "What is 6x7?", expected: "42" });

    const deadline = Date.now() + 15000;
    while (sched.receipts.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(sched.receipts.length, 2, `receipts arrived (events: ${events.join(",")})`);
    assert.ok(sched.receipts.every((r) => r.worker === address && r.honest), "signed + honest");

    const summary = sched.closeEpoch();
    assert.equal(summary.totals[address], 2);
    assert.match(summary.root, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(path.join(dir, "sched", "epoch-1.json")), "epoch persisted");
    assert.equal(worker.status().receiptsAccepted, 2);
  } finally {
    await worker.stop();
    await sched.close();
    fakeLlm.close();
  }
});

test("scheduler rejects a receipt signed by a different key", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-earn-"));
  const honest = new WalletService(path.join(dir, "w1"));
  honest.create({ password: "correct horse" });
  const imposter = new WalletService(path.join(dir, "w2"));
  imposter.create({ password: "correct horse" });

  const sched = new Scheduler({ dataDir: path.join(dir, "sched") });
  const port = await sched.listen();
  try {
    const reg = await (
      await fetch(`http://127.0.0.1:${port}/worker/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: honest.address }),
      })
    ).json();
    const job = sched.enqueue({ prompt: "x" });
    await fetch(`http://127.0.0.1:${port}/worker/next-job?token=${reg.token}`);

    const hash = crypto.createHash("sha256").update(`${job.id}|out`).digest();
    const badSig = await imposter.signHash(hash); // wrong key signs
    const res = await (
      await fetch(`http://127.0.0.1:${port}/worker/result?token=${reg.token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: job.id, output: "out", signature: badSig }),
      })
    ).json();
    assert.equal(res.ok, false);
    assert.match(res.error, /does not match/);
    assert.equal(sched.receipts.length, 0);
  } finally {
    await sched.close();
  }
});

test("a dead long-poll never consumes a job; a parked live worker still gets it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-earn-"));
  const sched = new Scheduler({ dataDir: path.join(dir, "sched") });
  const port = await sched.listen();
  const base = `http://127.0.0.1:${port}`;
  const reg = async (address) =>
    (await (
      await fetch(`${base}/worker/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      })
    ).json()).token;

  try {
    const tDead = await reg("1DeadWorkerAddr");
    const tLive = await reg("1LiveWorkerAddr");

    // A poll that parks first, then hangs up before any job arrives — the
    // CI-observed race: its server handler must not eat the next job.
    const ac = new AbortController();
    const dead = fetch(`${base}/worker/next-job?token=${tDead}`, { signal: ac.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 150)); // parked server-side
    ac.abort();
    await dead;
    await new Promise((r) => setTimeout(r, 150)); // server sees the close

    const live = fetch(`${base}/worker/next-job?token=${tLive}`);
    await new Promise((r) => setTimeout(r, 150)); // parked behind the corpse

    sched.enqueue({ prompt: "who gets me?" });
    const r = await live;
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.job, "the live worker received the job");
    assert.equal(sched.queue.length, 0, "job dispatched, not stranded");
  } finally {
    await sched.close();
  }
});

test("a job taken by a worker that vanishes is requeued after its lease", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-earn-"));
  const sched = new Scheduler({ dataDir: path.join(dir, "sched"), leaseMs: 200 });
  const port = await sched.listen();
  const base = `http://127.0.0.1:${port}`;

  try {
    const reg = await (
      await fetch(`${base}/worker/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: "1FlakyWorkerAddr" }),
      })
    ).json();
    const job = sched.enqueue({ prompt: "x" });

    // Worker takes the job... and never reports back.
    const took = await (await fetch(`${base}/worker/next-job?token=${reg.token}`)).json();
    assert.equal(took.job.id, job.id);
    assert.equal(sched.pending.size, 1);

    await new Promise((r) => setTimeout(r, 300)); // lease expires
    // Any traffic sweeps the lease; the next poll gets the same job back.
    const again = await (await fetch(`${base}/worker/next-job?token=${reg.token}`)).json();
    assert.equal(again.job?.id, job.id, "job re-dispatched after the lease");
  } finally {
    await sched.close();
  }
});

test("earn control plane: wallet -> config -> start -> jobs -> stop, via the app gateway", async () => {
  const { createCore } = require("../server");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-earnui-"));
  // Pre-place the dev model so no download happens; fake engine binary.
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const core = await createCore({
    dataDir: dir,
    port: 0,
    llamaBin: path.join(__dirname, "fixtures", "fake-llama-server"),
    onEvent: () => {},
  });
  const base = `http://127.0.0.1:${await core.start()}`;
  const sched = new Scheduler({ dataDir: path.join(dir, "sched") });
  const schedPort = await sched.listen();
  const post = async (p, b) => (await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) })).json();

  try {
    let s = await (await fetch(base + "/core/earn")).json();
    assert.equal(s.wallet.exists, false);

    // Guardrails before setup.
    assert.match((await post("/core/earn/start")).error, /Create a wallet/);

    const created = await post("/core/earn/wallet", { password: "correct horse" });
    assert.ok(created.wif, "backup WIF returned once");
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${schedPort}` });
    const started = await post("/core/earn/start");
    assert.equal(started.running, true);

    sched.enqueue({ prompt: "hello", expected: "Hello" });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      s = await (await fetch(base + "/core/earn")).json();
      if (s.worker.receiptsAccepted >= 1) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(s.worker.receiptsAccepted >= 1, `receipt accepted (got ${JSON.stringify(s.worker)})`);
    assert.equal(sched.receipts[0].worker, s.wallet.address);

    const stopped = await post("/core/earn/stop");
    assert.equal(stopped.worker.running, false);
  } finally {
    await core.stop();
    await sched.close();
  }
});
