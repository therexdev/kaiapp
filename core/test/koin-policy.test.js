"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { Signer } = require("koilib");
const P = require("../lib/koin-network/policy"),
  M = require("../lib/koin-network/merkle");
const address = (i) => Signer.fromSeed("koin-policy-fixture-" + i).getAddress();
const domain = {
  chainId: Buffer.alloc(34, 7).toString("base64"),
  contract: address(99),
  epoch: 1,
  version: 1,
};
test("KOIN budgets exclude committed funds, prorate late opening, and conserve revenue at uint64 limits", () => {
  assert.equal(
    P.dailyBudget({
      balance: "100000000000",
      liabilities: "10000000000",
      openedAt: P.DAY,
    }).total,
    "4500000000",
  );
  assert.equal(
    P.dailyBudget({ balance: "100000000000", openedAt: P.DAY * 1.5 }).total,
    "2500000000",
  );
  for (const n of [0n, 1n, 11n, 100000000000n, P.MAX]) {
    const split = P.revenueSplit(n);
    assert.equal(
      Object.values(split).reduce((n, v) => n + BigInt(v), 0n),
      n,
    );
  }
  assert.throws(() =>
    P.dailyBudget({ balance: "1", liabilities: "2", openedAt: 0 }),
  );
  assert.throws(() => P.uint(1));
  assert.throws(() => P.uint("1e8"));
  assert.throws(() => P.add(P.MAX, 1n));
});
test("availability uses contemporaneous supply, unique verified slots, and retains unearned work", () => {
  const budget = P.dailyBudget({ balance: "100000000000", openedAt: P.DAY });
  const slot = (i, weight) => ({
    address: address(i),
    capacityId: "slot-" + i,
    verified: true,
    eligible: true,
    modelWeight: weight,
    coverageBps: 10000,
    reliabilityBps: 10000,
  });
  const a = slot(1, "12"),
    b = slot(2, "12"),
    c = slot(3, "96");
  const intervals = [
    { start: P.DAY, end: 1.5 * P.DAY, slots: [a, b] },
    { start: 1.5 * P.DAY, end: 2 * P.DAY, slots: [a, b, c] },
  ];
  const result = P.allocate({ budget, intervals, work: [] });
  assert.equal(
    result.allocations.find((x) => x.address === a.address).availability,
    "1050000000",
  );
  assert.equal(result.unused, "1500000000");
  assert.throws(
    () =>
      P.allocate({
        budget,
        intervals: [{ ...intervals[0], slots: [a, a] }],
        work: [],
      }),
    /Duplicate capacity/,
  );
  assert.throws(
    () =>
      P.allocate({ budget, intervals: [intervals[0], intervals[0]], work: [] }),
    /Overlapping/,
  );
  assert.equal(P.allocate({ budget, intervals: [], work: [] }).committed, "0");
});
test("paid-work cap rejects the quiet-day self-work windfall and duplicate receipts", () => {
  const budget = P.dailyBudget({ balance: "100000000000", openedAt: P.DAY });
  const job = {
    address: address(1),
    jobId: "j",
    epoch: 1,
    verified: true,
    finalized: true,
    points: "100000000",
    charged: "100000000",
  };
  const result = P.allocate({ budget, intervals: [], work: [job] });
  assert.equal(result.allocations[0].work, "80000000");
  assert.throws(
    () => P.allocate({ budget, intervals: [], work: [job, job] }),
    /Duplicate/,
  );
  assert.equal(
    P.allocate({ budget, intervals: [], work: [{ ...job, free: true }] })
      .committed,
    "0",
  );
});
test("reliability starts neutral and bounded; model coverage moves at most ten percent", () => {
  assert.equal(P.reliability([], P.DAY), 9500);
  const success = Array.from({ length: 100 }, () => ({ at: 0, success: true }));
  assert.ok(P.reliability(success, 0) > 9900);
  assert.ok(P.reliability(success, 28 * P.DAY) < P.reliability(success, 0));
  assert.equal(P.coverage(2, 0, 10000), 11000);
  assert.equal(P.coverage(2, 100, 10000), 9000);
  assert.equal(P.modelWeight(4), 10000);
});
test("Merkle-sum proofs conserve odd-sized trees and bind amounts, identity and deployment", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    address: address(i),
    availability: String(i + 1),
    work: String((i + 1) * 10),
  }));
  const tree = M.build(domain, rows);
  assert.equal(tree.root.availability, "15");
  assert.equal(tree.root.work, "150");
  for (const c of tree.claims) {
    assert.ok(M.verify(domain, c, tree.root));
    assert.equal(M.verify({ ...domain, epoch: 2 }, c, tree.root), false);
    assert.equal(
      M.verify({ ...domain, contract: address(98) }, c, tree.root),
      false,
    );
    assert.equal(
      M.verify(domain, { ...c, work: String(BigInt(c.work) + 1n) }, tree.root),
      false,
    );
  }
  assert.equal(
    M.verify(domain, tree.claims[0], { ...tree.root, availability: "14" }),
    false,
  );
  assert.throws(() => M.build(domain, [rows[0], rows[0]]), /duplicate/);
});
