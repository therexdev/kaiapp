"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { Scheduler } = require("../../server/scheduler");

/*
 * §54 unified bootstrap budget (§51 F3): protocol-funded value — eval
 * subsidies plus the free-allowance fraction of chat receipts — mints only
 * up to a per-worker per-epoch cap. Fresh addresses are free to create, so
 * without this a provider could consume its own free tier from throwaway
 * wallets and mint KAI without bound. PAID chat value is real revenue and
 * never touches the budget.
 *
 * Receipt shapes: 60,000 in + 10,000 out at koinos-fast rates is exactly
 * $0.010 = 1 KAI (100,000,000 sat). freeTok/totalTok are the billing-time
 * stamps; an UNSTAMPED chat receipt was never billed — fully subsidized.
 */

const KAI = 100000000n;
const freeChat = { worker: "W", honest: true, jobType: "chat", usage: { prompt_tokens: 60000, completion_tokens: 10000 }, freeTok: 70000, totalTok: 70000 };
const paidChat = { ...freeChat, freeTok: 0 };
const evalJob = { worker: "W", honest: true, jobType: "inference-eval", usage: { prompt_tokens: 20, completion_tokens: 5 } };

const boot = (name, opts) =>
  new Scheduler({ dataDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kai-cap-")), name), epoch: 30, ...opts });

test("free-tier chat mint is capped per worker; paid chat value never is", () => {
  // Cap of 1.5 KAI, three fully-free 1-KAI chats: 1 + 0.5 + 0 mint.
  const capped = boot("capped", { bootstrapCapSat: (3n * KAI) / 2n });
  capped.receipts.push({ ...freeChat }, { ...freeChat }, { ...freeChat });
  const c = capped.closeEpoch();
  assert.equal(c.totals.W, (KAI + KAI / 2n).toString(), "self-dealt free chats stop minting at the budget");
  assert.equal(c.bootstrap.mintedSat, (KAI + KAI / 2n).toString());
  assert.equal(c.bootstrap.cappedSat, (KAI + KAI / 2n).toString(), "the refused half is reported");

  // Same cap, three PAID 1-KAI chats: all three mint — revenue is uncapped.
  const paid = boot("paid", { bootstrapCapSat: (3n * KAI) / 2n });
  paid.receipts.push({ ...paidChat }, { ...paidChat }, { ...paidChat });
  const p = paid.closeEpoch();
  assert.equal(p.totals.W, (3n * KAI).toString(), "paid value mints in full");
  assert.equal(p.bootstrap.mintedSat, "0");
  assert.equal(p.bootstrap.cappedSat, "0");
});

test("an unstamped chat receipt (never billed) counts as fully subsidized", () => {
  const s = boot("unstamped", { bootstrapCapSat: KAI / 2n });
  const { freeTok, totalTok, ...unstamped } = freeChat;
  s.receipts.push({ ...unstamped });
  const out = s.closeEpoch();
  assert.equal(out.totals.W, (KAI / 2n).toString(), "unbilled value draws on the budget, not on thin air");
});

test("evals and free chat share ONE budget, consumed in receipt order", () => {
  const s = boot("shared", { bootstrapCapSat: 2n * KAI });
  s.receipts.push({ ...evalJob }, { ...evalJob }, { ...freeChat }, { ...evalJob });
  const out = s.closeEpoch();
  // 2 evals fill the budget; the free chat and the third eval mint nothing.
  assert.equal(out.totals.W, (2n * KAI).toString());
  assert.equal(out.bootstrap.cappedSat, (2n * KAI).toString(), "1 KAI chat + 1 KAI eval refused");
});

test("splits divide MINTED value only — capped-away value produces no treasury share", () => {
  // 1-KAI chat, half free (35k of 70k tokens), budget allows only 0.3 KAI
  // of the 0.5-KAI subsidy: minted = 0.5 paid + 0.3 allowed = 0.8 KAI.
  const s = boot("splitcap", { bootstrapCapSat: (3n * KAI) / 10n, splits: { treasury: "T" } });
  s.receipts.push({ ...freeChat, freeTok: 35000 });
  const out = s.closeEpoch();
  const minted = (8n * KAI) / 10n;
  assert.equal(out.splits.totals.compute, ((minted * 9000n) / 10000n).toString(), "worker takes 90% of minted");
  assert.equal(out.totals.T, ((minted * 300n) / 10000n + (minted * 700n) / 10000n).toString(), "treasury takes 10% of minted, not of face value");
  const sum =
    BigInt(out.splits.totals.compute) + BigInt(out.splits.totals.royalty) +
    BigInt(out.splits.totals.verification) + BigInt(out.splits.totals.protocol);
  assert.equal(sum, minted, "split buckets sum to minted value exactly");
});

test("default budget preserves the historical eval-cap behavior bit for bit", () => {
  const s = boot("default", {}); // evalCap 8 -> 8 KAI budget
  for (let i = 0; i < 10; i++) s.receipts.push({ ...evalJob });
  const out = s.closeEpoch();
  assert.equal(out.totals.W, (8n * KAI).toString(), "10 evals still mint exactly the 8-eval budget");
});
