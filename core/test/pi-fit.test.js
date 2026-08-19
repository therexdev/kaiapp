"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const path = require("path");

const { Worker } = require("../lib/worker");

/*
 * Pi field finding 2026-08-19: a "4 GB" Raspberry Pi reports ~3.4 GB usable
 * after the GPU/kernel reserve, and the old koinos-fast minRamGb of 4 kept
 * the network's SMALLEST model off the exact machine it exists for — the
 * worker sat online advertising nothing, and nothing in the app said why.
 *
 * Pins here:
 *  - koinos-fast fits a 3 GB-reporting machine (catalog minRamGb is now 3)
 *  - the worker records a per-model gate verdict, visible via status()
 *  - a machine where nothing fits raises the no-servable-models event with
 *    the concrete numbers, not a shrug
 */

// A 4 GB Pi as the OS actually reports it: 3.4 GB after the carve-outs.
const PI_HW = {
  platform: "linux",
  arch: "arm64",
  cpu: { model: "Cortex-A76", cores: 4 },
  ramBytes: 3_400_000_000,
  gpus: [],
  capabilities: {},
};

const CATALOG = JSON.parse(
  require("fs").readFileSync(path.join(__dirname, "..", "models", "catalog.json"), "utf8")
);

/** ModelManager stand-in: only aliases() is consulted at registration. */
const managerWith = (aliases) => ({ aliases: () => aliases });

const fakeScheduler = async () => {
  let seen = null;
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (req.url === "/worker/register") seen = JSON.parse(b);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, token: "wt_test", epoch: 1 }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, payload: () => seen };
};

test("catalog: koinos-fast is reachable by a 3 GB-reporting machine", () => {
  assert.strictEqual(CATALOG.aliases["koinos-fast"].minRamGb, 3, "minRamGb must stay 3 — 4 locked out real 4 GB Pis");
});

test("a Pi with koinos-fast downloaded advertises it, with the verdict recorded", async () => {
  const { server, payload } = await fakeScheduler();
  const worker = new Worker({
    schedulerUrl: `http://127.0.0.1:${server.address().port}`,
    wallet: { address: "1BoZ4CTTQGUpmwSnaR1RgHbzcZTSf8bFYo" },
    runtime: {},
    hardware: PI_HW,
    models: managerWith([
      { alias: "koinos-fast", status: "ready", custom: false, dev: false, minRamGb: CATALOG.aliases["koinos-fast"].minRamGb },
      { alias: "gemma3-4b", status: "ready", custom: false, dev: false, minRamGb: CATALOG.aliases["gemma3-4b"].minRamGb },
    ]),
    onEvent: () => {},
  });
  await worker._register();
  server.close();
  assert.deepStrictEqual(payload().models, ["koinos-fast"], "the small model rides, the 8 GB one does not");
  assert.strictEqual(payload().capabilities.ramGb, 3, "the scheduler sees the same rounded RAM the gate used");
  const gate = worker.status().modelGate;
  assert.strictEqual(gate.find((g) => g.alias === "koinos-fast").advertised, true);
  const held = gate.find((g) => g.alias === "gemma3-4b");
  assert.strictEqual(held.advertised, false);
  assert.match(held.reason, /needs 8 GB RAM — this machine reports 3 GB/, "the verdict names the rule that fired");
});

test("nothing fits -> the event says which model needs what", async () => {
  const { server } = await fakeScheduler();
  const events = [];
  const worker = new Worker({
    schedulerUrl: `http://127.0.0.1:${server.address().port}`,
    wallet: { address: "1BoZ4CTTQGUpmwSnaR1RgHbzcZTSf8bFYo" },
    runtime: {},
    hardware: PI_HW,
    models: managerWith([
      { alias: "gemma3-12b", status: "ready", custom: false, dev: false, minRamGb: 16 },
    ]),
    onEvent: (e) => events.push(e),
  });
  await worker._register();
  server.close();
  const ev = events.find((e) => e.type === "worker:no-servable-models");
  assert.ok(ev, "the silent-earning-nothing state announces itself");
  assert.match(ev.message, /gemma3-12b \(needs 16 GB RAM — this machine reports 3 GB\)/, "with the concrete numbers");
});

test("private imports stay private, and the verdict says so", async () => {
  const { server, payload } = await fakeScheduler();
  const worker = new Worker({
    schedulerUrl: `http://127.0.0.1:${server.address().port}`,
    wallet: { address: "1BoZ4CTTQGUpmwSnaR1RgHbzcZTSf8bFYo" },
    runtime: {},
    hardware: PI_HW,
    models: managerWith([
      { alias: "my-import", status: "ready", custom: true, dev: false, minRamGb: 2 },
      { alias: "koinos-fast", status: "ready", custom: false, dev: false, minRamGb: 3 },
    ]),
    onEvent: () => {},
  });
  await worker._register();
  server.close();
  assert.deepStrictEqual(payload().models, ["koinos-fast"]);
  const mine = worker.status().modelGate.find((g) => g.alias === "my-import");
  assert.strictEqual(mine.advertised, false);
  assert.match(mine.reason, /private import/);
});
