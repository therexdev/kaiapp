"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const http = require("http");

const { Worker } = require("../lib/worker");

/*
 * §7.4 anti-Sybil signal #3 — the device fingerprint the worker sends with
 * registration. Shadow-only: the scheduler surfaces collisions, nothing is
 * gated on it yet.
 */

const HW = {
  platform: "win32",
  arch: "x64",
  cpu: { model: "Intel Core Ultra 7 255H", cores: 16 },
  ramBytes: 34_000_000_000,
  gpus: [{ name: "Intel Arc 140T" }],
  capabilities: { cudaEligible: false },
};

test("fingerprint: deterministic across runs and byte-level RAM wobble", () => {
  const a = Worker.fingerprint(HW);
  assert.match(a, /^[0-9a-f]{16}$/, "16 hex chars — shaped for the scheduler's validator");
  assert.strictEqual(a, Worker.fingerprint({ ...HW }), "same facts, same print");
  // Firmware carve-outs wobble byte counts between boots; the print must not.
  assert.strictEqual(a, Worker.fingerprint({ ...HW, ramBytes: 34_200_000_000 }));
});

test("fingerprint: different hardware prints differently, same device prints the same for any wallet", () => {
  const a = Worker.fingerprint(HW);
  assert.notStrictEqual(a, Worker.fingerprint({ ...HW, gpus: [{ name: "RTX 4090" }] }));
  assert.notStrictEqual(a, Worker.fingerprint({ ...HW, cpu: { model: "AMD Ryzen 9", cores: 16 } }));
  // The wallet plays no part — that is the whole point of the signal.
  assert.strictEqual(a, Worker.fingerprint(HW));
  // GPU order is not identity.
  const twoGpus = { ...HW, gpus: [{ name: "A" }, { name: "B" }] };
  const swapped = { ...HW, gpus: [{ name: "B" }, { name: "A" }] };
  assert.strictEqual(Worker.fingerprint(twoGpus), Worker.fingerprint(swapped));
});

test("fingerprint: rides the register payload to the scheduler", async () => {
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
  const worker = new Worker({
    schedulerUrl: `http://127.0.0.1:${server.address().port}`,
    wallet: { address: "1BoZ4CTTQGUpmwSnaR1RgHbzcZTSf8bFYo" },
    runtime: {},
    hardware: HW,
    models: null,
    onEvent: () => {},
  });
  await worker._register();
  server.close();
  assert.ok(seen, "registration reached the scheduler");
  assert.strictEqual(seen.fingerprint, Worker.fingerprint(HW), "…carrying this device's fingerprint");
});
