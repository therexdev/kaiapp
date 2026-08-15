"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { Scheduler } = require("../../server/scheduler");

/*
 * §51 consumption-side Sybil limit: the free allowance is per address and
 * addresses cost nothing, so one origin could farm wallets for unlimited
 * free GPU time. The per-IP ceiling bounds what one origin draws per epoch
 * across ALL its addresses. §28: operator-registered royalty routes send a
 * model's share to a real recipient, still clamped by the §20 bound.
 */

const boot = (name, opts) =>
  new Scheduler({ dataDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kai-free-")), name), epoch: 40, ...opts });

test("per-IP ceiling binds across addresses; other origins are unaffected", () => {
  const s = boot("ip", { freeTokensPerIp: 30000 });
  // Address allowance is 25k each; the shared origin only has 30k total.
  const a = s._chargeUsage("addr1", { prompt_tokens: 0, completion_tokens: 25000 }, "9.9.9.9");
  assert.equal(a.freeTaken, 25000, "first wallet drains its address allowance");
  const b = s._chargeUsage("addr2", { prompt_tokens: 0, completion_tokens: 25000 }, "9.9.9.9");
  assert.equal(b.freeTaken, 5000, "second wallet from the SAME origin only gets what the IP has left");
  assert.ok(b.costMicro > 0n, "the rest is billable, not free");
  const c = s._chargeUsage("addr3", { prompt_tokens: 0, completion_tokens: 1000 }, "7.7.7.7");
  assert.equal(c.freeTaken, 1000, "a different origin still has its own headroom");
  // The 402 gate sees the same arithmetic.
  assert.equal(s._consumeCapacity("addr4", "9.9.9.9").freeTokensLeft, 0, "exhausted origin has no free lane");
  // min(fresh address allowance 25k, origin headroom 29k) = 25k.
  assert.equal(s._consumeCapacity("addr4", "7.7.7.7").freeTokensLeft, 25000, "fresh address on a live origin keeps its allowance");
});

test("per-IP ceiling resets at epoch close and can be disabled", () => {
  const s = boot("reset", { freeTokensPerIp: 10000 });
  s._chargeUsage("a", { prompt_tokens: 0, completion_tokens: 10000 }, "1.1.1.1");
  assert.equal(s._consumeCapacity("b", "1.1.1.1").freeTokensLeft, 0);
  s.closeEpoch();
  assert.equal(s._consumeCapacity("b", "1.1.1.1").freeTokensLeft, 10000, "new epoch, fresh origin budget");

  const off = boot("off", { freeTokensPerIp: 0 });
  off._chargeUsage("a", { prompt_tokens: 0, completion_tokens: 25000 }, "1.1.1.1");
  assert.equal(off._consumeCapacity("b", "1.1.1.1").freeTokensLeft, 25000, "0 disables the origin ceiling");
});

test("x-forwarded-for: the proxy-appended LAST hop wins, not the spoofable first", () => {
  const s = boot("xff", {});
  assert.equal(s._clientIp({ headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" }, socket: {} }), "203.0.113.9");
  assert.equal(s._clientIp({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
});

test("§28 registry routes a model's royalty to a real recipient, clamped by the §20 bound", () => {
  const KAI = 100000000n;
  const chat = { worker: "W", honest: true, jobType: "chat", freeTok: 0, usage: { prompt_tokens: 60000, completion_tokens: 10000 } };
  const s = boot("roy", { splits: { treasury: "T" }, royalties: { "koinos-fast": { bps: 2500, addr: "CREATOR" } } });
  s.receipts.push({ ...chat }); // 1 KAI paid chat
  const out = s.closeEpoch();
  // 25% requested -> clamped to 10%; treasury still takes its 10%.
  assert.equal(out.totals.CREATOR, ((KAI * 1000n) / 10000n).toString(), "creator claim minted at the clamped bound");
  assert.equal(out.totals.T, ((KAI * 300n) / 10000n + (KAI * 700n) / 10000n).toString());
  assert.equal(out.totals.W, ((KAI * 8000n) / 10000n).toString(), "worker keeps the exact remainder");
  assert.equal(out.pricing.models["koinos-fast"].royaltyAddr, "CREATOR", "epoch records the route it settled with");
});
