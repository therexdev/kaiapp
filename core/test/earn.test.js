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
    assert.equal(summary.totals[address], "200000000", "2 eval receipts = 2 KAI bootstrap subsidy, in satoshis");
    assert.match(summary.root, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(path.join(dir, "sched", "epoch-1.json")), "epoch persisted");
    // The worker learns its receipt was accepted from the RESPONSE to its
    // result post — which resolves a beat after the scheduler records the
    // receipt. The receipts.length wait above can therefore pass while the
    // worker's own counter is still 1 (CI flake, 2026-08-19): give the
    // counter the same bounded wait the receipts got.
    const counterDeadline = Date.now() + 5000;
    while (worker.status().receiptsAccepted < 2 && Date.now() < counterDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
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

test("epoch close (A1): value-based rewards net EXACTLY against consumer spend, in satoshis", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-earn-"));
  const sched = new Scheduler({ dataDir: path.join(dir, "sched"), epoch: 9 });
  // W: 2 protocol-funded evals (1 KAI bootstrap subsidy each) + one big chat
  // job — 60k in + 10k out = $0.010 of work = 1 KAI at the $0.01 reference.
  sched.receipts.push({ worker: "W", honest: true, jobType: "inference-eval", usage: { prompt_tokens: 20, completion_tokens: 5 } });
  sched.receipts.push({ worker: "W", honest: true, jobType: "inference-eval", usage: { prompt_tokens: 20, completion_tokens: 5 } });
  sched.receipts.push({ worker: "W", honest: true, jobType: "chat", usage: { prompt_tokens: 60000, completion_tokens: 10000 } });
  // W also spent 0.9 KAI of earnings consuming -> net = 3.0 - 0.9 = 2.1 KAI, exact.
  sched.spentSat.W = "90000000";
  // C served nothing but spent 2.5 KAI (anomaly) -> recorded satoshi debt.
  sched.spentSat.C = "250000000";

  const s = sched.closeEpoch();
  assert.equal(s.earnedKai.W, "3", "2 KAI subsidy + 1 KAI chat value");
  assert.equal(s.totals.W, "210000000", "net claim is exact satoshis (2.1 KAI)");
  assert.equal(s.claims.W.amount, "210000000", "claim packet carries the amount");
  assert.equal(s.served.W, 3);
  assert.equal(s.spentKai.W, "0.9");
  assert.equal(s.totals.C, undefined, "no earnings, no claim");
  assert.deepEqual(s.debts, { C: "250000000" }, "anomalous spend recorded in satoshis");
  assert.ok(s.pricing.freeTokensPerEpoch > 0, "pricing snapshot travels with the epoch");
  assert.equal(Object.keys(sched.spentSat).length, 0, "spend meter resets with the epoch");

  // The value leaf verifies exactly the way the contract's claim_value does.
  const leaf = crypto.createHash("sha256").update(`9|W|210000000`).digest();
  assert.equal(s.root, leaf.toString("hex"), "single-leaf root = sha256(epoch|worker|amountSat)");
});

test("§20 splits: role division is exact, treasury/royalty settle as claims, default stays pass-through", () => {
  const { MODEL_RATES } = require("../../server/scheduler");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-earn-"));
  // 60k in + 10k out at koinos-fast rates = $0.010 = exactly 1 KAI (1e8 sat).
  const chat = { worker: "W", honest: true, jobType: "chat", usage: { prompt_tokens: 60000, completion_tokens: 10000 } };
  const evalJob = { worker: "W", honest: true, jobType: "inference-eval", usage: { prompt_tokens: 20, completion_tokens: 5 } };

  // No treasury configured -> bit-identical to the alpha full pass-through.
  const plain = new Scheduler({ dataDir: path.join(dir, "plain"), epoch: 20 });
  plain.receipts.push({ ...chat }, { ...evalJob });
  const p = plain.closeEpoch();
  assert.equal(p.totals.W, "200000000", "1 KAI chat value + 1 KAI subsidy, all to the worker");
  assert.equal(p.splits.active, false);
  assert.deepEqual(p.splits.totals, { compute: "100000000", royalty: "0", verification: "0", protocol: "0" });

  // Treasury set -> verification 3% + protocol 7% divert; evals stay whole.
  const split = new Scheduler({ dataDir: path.join(dir, "split"), epoch: 21, splits: { treasury: "T" } });
  split.receipts.push({ ...chat }, { ...evalJob });
  const s = split.closeEpoch();
  assert.equal(s.totals.W, "190000000", "worker keeps 90% of chat value + full eval subsidy");
  assert.equal(s.totals.T, "10000000", "treasury claims verification + protocol shares");
  assert.deepEqual(s.splits.totals, { compute: "90000000", royalty: "0", verification: "3000000", protocol: "7000000" });
  assert.ok(s.claims.T && s.claims.T.amount === "10000000", "treasury leaf is an ordinary claim_value claim");
  // The treasury leaf verifies exactly the way the contract does.
  let h = crypto.createHash("sha256").update(`21|T|10000000`).digest();
  let idx = s.claims.T.index;
  for (const sib of s.claims.T.proof.map((x) => Buffer.from(x, "hex"))) {
    h = idx % 2 === 0
      ? crypto.createHash("sha256").update(Buffer.concat([h, Buffer.from(sib)])).digest()
      : crypto.createHash("sha256").update(Buffer.concat([Buffer.from(sib), h])).digest();
    idx = Math.floor(idx / 2);
  }
  assert.equal(h.toString("hex"), s.root, "treasury claim proof verifies against the epoch root");

  // Per-model royalty is honored but CLAMPED to the §28 bound (25% -> 10%).
  MODEL_RATES["cc-royalty-test"] = { inMicroPerM: 100000, outMicroPerM: 400000, royaltyBps: 2500, royaltyAddr: "R" };
  try {
    const roy = new Scheduler({ dataDir: path.join(dir, "roy"), epoch: 22, splits: { treasury: "T" } });
    roy.receipts.push({ ...chat, modelClass: "cc-royalty-test" });
    const r = roy.closeEpoch();
    assert.deepEqual(r.splits.totals, { compute: "80000000", royalty: "10000000", verification: "3000000", protocol: "7000000" });
    assert.equal(r.totals.R, "10000000", "creator royalty settles as its own claim");
    assert.equal(r.totals.W, "80000000");
    assert.equal(r.totals.T, "10000000");
  } finally {
    delete MODEL_RATES["cc-royalty-test"];
  }

  // Rounding: at unit satoshi granularity the floor-divided shares under-fill
  // and compute absorbs the remainder — the buckets still sum exactly.
  const unit = new Scheduler({ dataDir: path.join(dir, "unit"), epoch: 23, splits: { treasury: "T" } });
  unit.price = { ...unit.price, satPerMicro: 1n };
  const odd = unit._splitValueSat(15n, "koinos-fast"); // 150 in-tokens = 15 µ$ at 1 sat/µ$
  assert.equal(odd.valueSat, 15n, "15 µ$ at 1 sat/µ$");
  assert.equal(odd.verifySat, 0n, "3% of 15 floors to zero");
  assert.equal(odd.protocolSat, 1n, "7% of 15 floors to one");
  assert.equal(odd.computeSat, 14n, "compute takes the remainder");
  assert.equal(odd.computeSat + odd.royaltySat + odd.verifySat + odd.protocolSat, odd.valueSat);

  // Treasury spends like anyone else: its accrual nets against its spend.
  const netted = new Scheduler({ dataDir: path.join(dir, "net"), epoch: 24, splits: { treasury: "T" } });
  netted.receipts.push({ ...chat });
  netted.spentSat.T = "4000000";
  const n = netted.closeEpoch();
  assert.equal(n.totals.T, "6000000", "treasury claim = 10% share minus its own spend");

  // Misconfigured shares fail fast at startup, not at settlement time.
  assert.throws(
    () => new Scheduler({ dataDir: path.join(dir, "bad"), splits: { verifyBps: 6000, protocolBps: 4000, royaltyMaxBps: 1000 } }),
    /exceed 100%/
  );
});

test("token-metered billing (amendment A1): free tokens -> prepaid USD -> epoch earnings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-earn-"));
  // Chain says this address has deposited 1 KAI -> $0.01 prepaid at reference.
  const settlement = { depositsOf: async () => "100000000", settleEpoch: async () => ({}), kaiBalance: async () => "0" };
  const sched = new Scheduler({ dataDir: path.join(dir, "sched"), settlement });
  const port = await sched.listen();
  const A = "Addr";
  try {
    await sched._syncDeposits(A, true);
    assert.equal(sched.balances[A].balanceMicro, "10000", "1 KAI became $0.010000 prepaid");
    await sched._syncDeposits(A, true);
    assert.equal(sched.balances[A].balanceMicro, "10000", "high-water mark prevents double funding");

    // A small chat fits entirely in the 25k-token free allowance.
    let r = sched._chargeUsage(A, { prompt_tokens: 20000, completion_tokens: 5000 });
    assert.deepEqual([r.paidWith, Number(r.costMicro)], ["free", 0]);

    // Free exhausted: 10k in + 5k out = $0.001 + $0.002 = $0.003 off prepaid.
    r = sched._chargeUsage(A, { prompt_tokens: 10000, completion_tokens: 5000 });
    assert.deepEqual([r.paidWith, Number(r.costMicro)], ["balance", 3000]);
    assert.equal(sched.balances[A].balanceMicro, "7000", "$0.007 left");

    // A big-document request overflows the balance into epoch earnings:
    // 60k in + 10k out = $0.010 -> $0.007 prepaid + $0.003 of earnings
    // = 0.3 KAI at the $0.01 reference.
    r = sched._chargeUsage(A, { prompt_tokens: 60000, completion_tokens: 10000 });
    assert.equal(r.paidWith, "balance+earnings");
    assert.equal(sched.balances[A].balanceMicro, "0");
    assert.equal(sched.spentSat[A], "30000000", "0.3 KAI charged to earnings");

    // Usage meter accumulated the truth.
    assert.deepEqual(sched.usage[A], { inTok: 90000, outTok: 20000, costMicro: 13000 });

    // Everything empty and nothing served -> the authorization gate closes.
    const cap = sched._consumeCapacity(A);
    assert.ok(cap.freeTokensLeft === 0 && cap.balanceMicro === 0n && cap.earningsLeftSat <= 0n);

    // The ledger survives a restart; older denominations migrate in place.
    const sched2 = new Scheduler({ dataDir: path.join(dir, "sched"), settlement });
    assert.equal(sched2._balanceMicroOf(A), 0n, "balance persisted");
    sched2.balances.LegacyCredits = { credits: "10", depositHwmSat: "0" };
    assert.equal(sched2._balanceMicroOf("LegacyCredits"), 10000n, "v0.5.1 credits -> µ$");
    sched2.balances.LegacySat = { creditSat: "200000000", depositHwmSat: "0" };
    assert.equal(sched2._balanceMicroOf("LegacySat"), 20000n, "v0.5.0 KAI sat -> µ$");

    // Published pricing is per-model token rates (OpenAI-style).
    const p = await (await fetch(`http://127.0.0.1:${port}/pricing`)).json();
    assert.equal(p.ok, true);
    assert.deepEqual(p.models["koinos-fast"], { usdPerMInputTokens: 0.1, usdPerMOutputTokens: 0.4, cuClass: "LLM-CU", ctxTokens: 4096, royaltyBps: 0 });
    assert.deepEqual([p.freeTokensPerEpoch, p.kaiRefUsd, p.status], [25000, 0.01, "PROVISIONAL"]);
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
