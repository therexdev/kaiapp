"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const crypto = require("crypto");
const { Signer } = require("koilib");

const { Worker } = require("../lib/worker");

/*
 * FIND-NET-001, client half. The scheduler used to take `address` on trust,
 * so anyone who could reach it could register as somebody else's wallet and
 * take that wallet's jobs and its place on the payout roster. The app now
 * signs sha256("register|<address>|<ts>") with the wallet key.
 *
 * These tests use a REAL key and recover the address from the signature the
 * app actually sent, rather than asserting that some signature field is
 * non-empty — a stub that returns the string "sig" would satisfy that, and
 * so would signing the wrong bytes.
 */

/** Stand up a scheduler stub and return the register body the worker posted. */
async function registerWith(wallet) {
  let body = null;
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith("/worker/register")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        body = JSON.parse(raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, token: "wt_test" }));
      });
      return;
    }
    res.writeHead(204);
    res.end();
  });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", function () { r(this.address().port); }));
  const events = [];
  try {
    const worker = new Worker({
      schedulerUrl: `http://127.0.0.1:${port}`,
      wallet,
      runtime: { ensure: async () => "http://127.0.0.1:1" },
      hardware: { ramBytes: 8e9 },
      models: { aliases: () => [{ alias: "koinos-fast", status: "ready", minRamGb: 4 }] },
      onEvent: (e) => events.push(e),
    });
    await worker._register();
  } finally {
    srv.close();
  }
  return { body, events };
}

test("registration carries a proof that recovers to the wallet address", async () => {
  const signer = Signer.fromSeed(crypto.randomBytes(32).toString("hex"));
  const address = signer.getAddress();
  const { body } = await registerWith({
    address,
    signHash: async (h) => Buffer.from(await signer.signHash(h)).toString("base64"),
  });

  assert.equal(body.address, address);
  assert.ok(Number.isFinite(body.ts), "a timestamp rides along");
  assert.ok(Math.abs(Date.now() - body.ts) < 60000, "the timestamp is fresh");

  // The signature must be over the exact bytes the scheduler will rebuild.
  const hash = crypto.createHash("sha256").update(`register|${address}|${body.ts}`).digest();
  const recovered = Signer.recoverAddress(hash, Buffer.from(String(body.signature), "base64"));
  assert.equal(recovered, address, "the proof recovers to the address being claimed");
});

test("the proof is domain-separated from a consume signature", async () => {
  /*
   * A network chat request signs "consume|<address>|<ts>|<messages>" with this
   * same key and hands it to this same server on every paid request. If the
   * two domains shared a prefix, every paying client would be broadcasting a
   * reusable registration proof for its own wallet. Signing the consume bytes
   * must NOT produce the registration signature.
   */
  const signer = Signer.fromSeed(crypto.randomBytes(32).toString("hex"));
  const address = signer.getAddress();
  const { body } = await registerWith({
    address,
    signHash: async (h) => Buffer.from(await signer.signHash(h)).toString("base64"),
  });

  const consumeHash = crypto.createHash("sha256").update(`consume|${address}|${body.ts}|[]`).digest();
  const consumeSig = Buffer.from(await signer.signHash(consumeHash)).toString("base64");
  assert.notEqual(body.signature, consumeSig, "registration and consume must not sign the same bytes");

  // And the registration signature must not verify as a consume signature.
  assert.notEqual(
    Signer.recoverAddress(consumeHash, Buffer.from(String(body.signature), "base64")),
    address,
    "the registration proof must not check out against the consume message",
  );
});

test("a wallet that cannot sign still registers, and says so", async () => {
  /*
   * Earning must not stop the day this ships. While the scheduler is in
   * shadow mode an unsigned registration is still accepted, so a signing
   * failure is reported and stepped over rather than thrown — the scheduler's
   * own refusal is what makes it unmissable once proofs are required.
   */
  const { body, events } = await registerWith({
    address: "1TestAddr",
    signHash: async () => { throw new Error("wallet is locked"); },
  });

  assert.equal(body.address, "1TestAddr");
  assert.equal(body.signature, undefined, "no signature field rather than a junk one");
  assert.equal(body.ts, undefined);
  const told = events.find((e) => e.type === "worker:proof-failed");
  assert.ok(told, "the failure is surfaced as an event");
  assert.match(told.message, /wallet is locked/);
});
