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

  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-w-"));
  const ws = new WalletService(wsDir);
  assert.throws(() => ws.create({ password: "trailing space " }), /space/, "whitespace caught at save time");

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

test("wallet: restore from WIF replaces a lost-password keystore, same address", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-w-"));
  const w = new WalletService(dir);
  const { address, wif } = w.create({ password: "forgotten password" });
  w.lock();

  // The password is gone — but the written-down backup code is not. The
  // refusal names the exact file (address + creation time) that rejected it.
  assert.throws(() => w.unlock("what i think it was"), new RegExp(`Incorrect password for wallet ${address}.*file created`));
  assert.throws(() => w.restore({ wif: "garbage", password: "new password 9" }), /Invalid backup code/);

  const r = w.restore({ wif, password: "new password 9" });
  assert.equal(r.address, address, "same key, same address, same balance");
  assert.equal(w.status().unlocked, true, "restored wallet is unlocked");

  w.lock();
  assert.equal(w.unlock("new password 9").address, address, "new password works");
  assert.throws(() => w.unlock("forgotten password"), /Incorrect password/, "old password retired");
  assert.ok(
    fs.readdirSync(dir).some((f) => f.startsWith("wallet.json.bak-")),
    "old keystore set aside, not destroyed"
  );
});

test("wallet: unicode-equivalent and padded passwords open; refusals say what differs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-w-"));
  const w = new WalletService(dir);
  // é typed composed (U+00E9) at save…
  const { address } = w.create({ password: "café volt 42" });
  w.lock();
  // …and decomposed (e + combining accent) at unlock: visually identical.
  assert.equal(w.unlock("café volt 42").address, address, "NFC-equivalent password opens");
  w.lock();
  assert.equal(w.unlock("café volt 42 ").address, address, "trailing space forgiven at unlock");
  w.lock();

  // Wrong length: the error says so, with counts.
  assert.throws(() => w.unlock("café volt 4"), / you typed 11 characters, but this wallet's password has 12/);
  // Right length, wrong character: the error says that instead.
  assert.throws(() => w.unlock("café volt 43"), /same length as the saved password/);
});

test("wallet session: survives a 'restart', refuses wrong secrets and swapped files, ends on lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-w-"));
  const w1 = new WalletService(dir);
  const { address } = w1.create({ password: "correct horse" });
  assert.equal(w1.saveSession("machine-secret"), true);

  // New instance = app restart. Session resumes without the password.
  const w2 = new WalletService(dir);
  assert.equal(w2.status().unlocked, false);
  assert.equal(w2.tryResumeSession("wrong-secret"), false, "wrong machine secret stays locked");
  assert.equal(w2.tryResumeSession("machine-secret"), true);
  assert.equal(w2.address, address);
  const hash = crypto.createHash("sha256").update("x").digest();
  assert.equal(WalletService.recoverAddress(hash, await w2.signHash(hash)), address, "resumed key signs");

  // A swapped wallet file must not be silently overridden by the session.
  const other = new WalletService(fs.mkdtempSync(path.join(os.tmpdir(), "kai-w-")));
  other.create({ password: "correct horse" });
  const mine = fs.readFileSync(path.join(dir, "wallet.json"), "utf8");
  fs.copyFileSync(other.keystorePath, path.join(dir, "wallet.json"));
  const w3 = new WalletService(dir);
  assert.equal(w3.tryResumeSession("machine-secret"), false, "session refuses a foreign keystore");
  fs.writeFileSync(path.join(dir, "wallet.json"), mine);

  // Lock ends the session for good.
  w2.lock();
  const w4 = new WalletService(dir);
  assert.equal(w4.tryResumeSession("machine-secret"), false, "lock cleared the session");
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

test("worker survives a scheduler restart: re-registers and keeps earning", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-earn-"));
  const wallet = new WalletService(path.join(dir, "wallet"));
  const { address } = wallet.create({ password: "correct horse" });

  const http = require("http");
  const fakeLlm = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "42" } }] }));
    });
  });
  const llmPort = await new Promise((r) => fakeLlm.listen(0, "127.0.0.1", function () { r(this.address().port); }));
  const runtime = { ensure: async () => `http://127.0.0.1:${llmPort}`, servedModelName: () => null };

  const events = [];
  const sched1 = new Scheduler({ dataDir: path.join(dir, "s1") });
  const port = await sched1.listen();
  const worker = new Worker({
    schedulerUrl: `http://127.0.0.1:${port}`,
    wallet,
    runtime,
    hardware: { capabilities: {} },
    onEvent: (e) => events.push(e.type),
  });

  let sched2 = null;
  try {
    await worker.start();
    sched1.enqueue({ prompt: "first" });
    let deadline = Date.now() + 10000;
    while (sched1.receipts.length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(sched1.receipts.length, 1, "earning against the first scheduler");

    // Redeploy: the scheduler process restarts on the same address and
    // forgets every token. The worker must notice, re-register, and earn on.
    await sched1.close();
    sched2 = new Scheduler({ dataDir: path.join(dir, "s2") });
    await sched2.listen(port);
    sched2.enqueue({ prompt: "second" });

    deadline = Date.now() + 15000; // worker may be in a 3s outage backoff
    while (sched2.receipts.length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(sched2.receipts.length, 1, `receipt on restarted scheduler (events: ${events.join(",")})`);
    assert.equal(sched2.receipts[0].worker, address);
    assert.ok(events.includes("worker:reregistered"), "worker re-registered itself");
  } finally {
    await worker.stop();
    await sched1.close().catch(() => {});
    if (sched2) await sched2.close();
    fakeLlm.close();
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

test("epoch close nets VALUED consumption against earnings (§15/§23): spend in KAI, claim the rest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-earn-"));
  const sched = new Scheduler({ dataDir: path.join(dir, "sched"), epoch: 9 });
  // W served 6 receipts; spent 0.9 KAI of earnings on network chats ->
  // rounds up to 1 receipt -> net claim 5.
  for (let i = 0; i < 6; i++) sched.receipts.push({ worker: "W", honest: true });
  sched.spentSat.W = "90000000";
  // C served nothing but somehow spent 2.5 KAI (anomaly) -> debt of 3 receipts.
  sched.spentSat.C = "250000000";

  const s = sched.closeEpoch();
  assert.equal(s.totals.W, 5, "claim = served 6 - ceil(0.9 KAI / 1 KAI)");
  assert.equal(s.served.W, 6);
  assert.equal(s.spentKai.W, "0.9", "spend recorded in the epoch summary");
  assert.equal(s.totals.C, undefined, "no earnings, no claim");
  assert.deepEqual(s.debts, { C: 3 }, "anomalous spend recorded, not forgiven");
  assert.equal(s.claims.W.count, 5, "on-chain claim carries the net count");
  assert.ok(s.pricing.kaiPerCu > 0, "pricing snapshot travels with the epoch");
  assert.equal(Object.keys(sched.spentSat).length, 0, "spend meter resets with the epoch");
});

test("consume charge order (§23): free allowance -> deposited KAI credits -> epoch earnings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-earn-"));
  // Chain says this address has deposited 1 KAI in total.
  const settlement = { depositsOf: async () => "100000000", settleEpoch: async () => ({}), kaiBalance: async () => "0" };
  const sched = new Scheduler({ dataDir: path.join(dir, "sched"), settlement });
  const port = await sched.listen();
  try {
    // 1 KAI deposited on-chain -> 10 AI Credits at the $0.01 reference
    // ($0.001/credit) — converted at deposit time, stable thereafter (§23).
    await sched._syncDeposits("Addr", true);
    assert.equal(sched.credits.Addr.credits, "10", "on-chain KAI converted to credits once");
    await sched._syncDeposits("Addr", true);
    assert.equal(sched.credits.Addr.credits, "10", "high-water mark prevents double credit");

    for (let i = 0; i < 5; i++) assert.equal(sched._chargeConsume("Addr"), "free");
    // 10 credits buy 3 chats at 3 credits each…
    for (let i = 0; i < 3; i++) assert.equal(sched._chargeConsume("Addr"), "credits");
    assert.equal(sched.credits.Addr.credits, "1", "1 credit left");
    // …the remainder can't cover a chat, so the next one hits earnings.
    assert.equal(sched._chargeConsume("Addr"), "earnings");
    assert.equal(sched.spentSat.Addr, "30000000");

    // With nothing served, nothing left free, and credits short: unauthorized.
    const cap = sched._consumeCapacity("Addr");
    assert.ok(cap.freeLeft === 0 && cap.credits < cap.costCredits && cap.earningsLeft < cap.costKaiSat);

    // The ledger survives a restart.
    const sched2 = new Scheduler({ dataDir: path.join(dir, "sched"), settlement });
    assert.equal(sched2._creditsOf("Addr"), 1, "credits persisted to disk");

    // A pre-credits ledger (KAI satoshis) migrates in place.
    sched2.credits.Legacy = { creditSat: "200000000", depositHwmSat: "200000000" };
    assert.equal(sched2._creditsOf("Legacy"), 20, "legacy KAI balance became credits");

    // Published pricing carries both layers: §15 KAI settlement, §23 credits.
    const p = await (await fetch(`http://127.0.0.1:${port}/pricing`)).json();
    assert.deepEqual(
      [p.ok, p.cuClass, p.kaiPerCu, p.creditsPerRequest, p.creditsPerKai, p.usdPerCredit, p.freeCuPerEpoch, p.status],
      [true, "LLM-CU", 0.3, 3, 10, 0.001, 5, "PROVISIONAL"]
    );
  } finally {
    await sched.close();
  }
});

test("closed epochs settle on-chain and /balance serves KAI + pending receipts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-earn-"));
  const settled = [];
  const settlement = {
    settleEpoch: async (summary) => {
      settled.push(summary.epoch);
      return { rootTx: "0xroot", claims: { W1: { tx: "0xclaim" } }, settledAt: "t" };
    },
    kaiBalance: async () => "800000000", // 8 KAI in satoshis
  };
  const sched = new Scheduler({ dataDir: path.join(dir, "sched"), epoch: 7, settlement });
  const port = await sched.listen();
  try {
    // Receipts in the open epoch show up as pending before any settlement.
    sched.receipts.push({ worker: "W1", honest: true }, { worker: "W1", honest: true });
    let b = await (await fetch(`http://127.0.0.1:${port}/balance?address=W1`)).json();
    assert.deepEqual([b.ok, b.kai, b.pendingReceipts], [true, "8", 2]);

    const summary = sched.closeEpoch();
    const result = await sched.settleClosedEpoch(summary);
    assert.equal(result.rootTx, "0xroot");
    assert.deepEqual(settled, [7]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "sched", "epoch-7.json"), "utf8"));
    assert.equal(onDisk.summary.settlement.rootTx, "0xroot", "settlement recorded in the epoch file");
    assert.equal(onDisk.receipts.length, 2, "receipt detail preserved");

    // The operator retry lane re-runs settlement idempotently.
    const again = await (
      await fetch(`http://127.0.0.1:${port}/operator/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ epoch: 7 }),
      })
    ).json();
    assert.equal(again.ok, true);
    assert.deepEqual(settled, [7, 7]);

    // Without settlement configured, /balance says so instead of guessing.
    const bare = new Scheduler({ dataDir: path.join(dir, "bare") });
    const p2 = await bare.listen();
    const nb = await (await fetch(`http://127.0.0.1:${p2}/balance?address=W1`)).json();
    assert.equal(nb.ok, false);
    await bare.close();
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
    sessionSecret: "machine-secret",
    onEvent: () => {},
  });
  const base = `http://127.0.0.1:${await core.start()}`;
  const sched = new Scheduler({
    dataDir: path.join(dir, "sched"),
    // Short lease: if a dispatch lands on a silently-dead socket (no RST —
    // the one unsignalled case), the requeue backstop kicks in fast enough
    // for this test to see recovery instead of timing out.
    leaseMs: 3000,
    settlement: { settleEpoch: async () => ({}), kaiBalance: async () => "800000000" },
  });
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
    assert.equal(s.earnings?.kai, "8", "on-chain KAI balance surfaces through the app gateway");

    const stopped = await post("/core/earn/stop");
    assert.equal(stopped.worker.running, false);

    // Restart drill: leave earning ON, replace the whole core (= app restart)
    // with the same machine secret — the wallet resumes unlocked and the
    // worker re-registers and earns again without any password or clicks.
    await post("/core/earn/start");
    await core.stop();
    const core2 = await createCore({
      dataDir: dir,
      port: 0,
      llamaBin: path.join(__dirname, "fixtures", "fake-llama-server"),
      sessionSecret: "machine-secret",
      onEvent: () => {},
    });
    const base2 = `http://127.0.0.1:${await core2.start()}`;
    try {
      sched.enqueue({ prompt: "after restart" });
      let s2 = null;
      // Worst case by design: dead-socket dispatch + 3s lease + ≤20s poll
      // cycle to the reaper — 30s covers the guarantee with margin.
      const deadline2 = Date.now() + 30000;
      while (Date.now() < deadline2) {
        s2 = await (await fetch(base2 + "/core/earn")).json();
        if (s2.wallet.unlocked && s2.worker.running && s2.worker.receiptsAccepted >= 1) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.equal(s2.wallet.unlocked, true, "wallet resumed without a password");
      assert.equal(s2.worker.running, true, "earning auto-resumed");
      assert.ok(s2.worker.receiptsAccepted >= 1, `worked after restart (${JSON.stringify(s2.worker)})`);
    } finally {
      await core2.stop();
    }
  } finally {
    await core.stop();
    await sched.close();
  }
});
