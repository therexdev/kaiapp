import { Credits } from "../Credits";
import { Rewards, leaf, parent } from "../Rewards";
import { KEY, DAY, PAUSE, key, periodAccount, part, equal } from "../Common";
import { koin as K } from "../proto/koin";
import * as E from "../entries";
import {
  MockVM,
  Protobuf,
  authority,
  protocol,
  system_calls,
  token,
  chain as C,
} from "@koinos/sdk-as";
function bytes(size: i32, n: u8): Uint8Array {
  const b = new Uint8Array(size);
  b.fill(n);
  return b;
}
const credit = bytes(25, 1),
  treasury = bytes(25, 2),
  asset = bytes(25, 3),
  owner = bytes(25, 4),
  verifier = bytes(25, 5),
  buyer = bytes(25, 6),
  provider = bytes(25, 7),
  mining = bytes(25, 8),
  operations = bytes(25, 9),
  chain = bytes(34, 10),
  policy = bytes(32, 11),
  sid = bytes(32, 12),
  jobid = bytes(32, 13);
function clock(t: u64): void {
  const b = new protocol.block();
  b.header = new protocol.block_header();
  b.header!.timestamp = t;
  MockVM.setBlock(b);
}
function allow(a: Uint8Array): void {
  MockVM.setAuthorities([
    new MockVM.MockAuthority(
      authority.authorization_type.contract_call,
      a,
      true,
    ),
  ]);
}
function result(b: Uint8Array): system_calls.exit_arguments {
  return new system_calls.exit_arguments(0, new C.result(b));
}
function balance(n: u64): system_calls.exit_arguments {
  return result(
    Protobuf.encode(
      new token.balance_of_result(n),
      token.balance_of_result.encode,
    ),
  );
}
function answer(n: u64): system_calls.exit_arguments {
  const r = new K.Result();
  r.amount = n;
  return result(Protobuf.encode(r, K.Result.encode));
}
function ok(): system_calls.exit_arguments {
  return result(new Uint8Array(0));
}
function config(): K.Config {
  const c = new K.Config();
  c.chain_id = chain;
  c.token = asset;
  c.admin = owner;
  c.verifier = verifier;
  c.credits = credit;
  c.treasury = treasury;
  c.mining = mining;
  c.operations = operations;
  c.version = 1;
  c.daily_bps = 500;
  c.availability_bps = 7000;
  c.reward_bps = 6000;
  c.mining_bps = 2500;
  c.operations_bps = 1500;
  c.work_cap_bps = 8000;
  return c;
}
function setupCredits(): Credits {
  MockVM.reset();
  MockVM.setContractId(credit);
  MockVM.setChainId(chain);
  clock(DAY);
  const c = new Credits();
  c.configs.put(KEY, config());
  return c;
}
function setupRewards(): Rewards {
  MockVM.reset();
  MockVM.setContractId(treasury);
  MockVM.setChainId(chain);
  clock(DAY);
  const r = new Rewards();
  r.configs.put(KEY, config());
  return r;
}
function bought(): Credits {
  const c = setupCredits();
  allow(buyer);
  MockVM.setCallContractResults([
    balance(0),
    ok(),
    balance(10000),
    balance(10000),
  ]);
  c.purchase(buyer, 10000);
  return c;
}
function reserved(): Credits {
  const c = bought(),
    s = new K.Session();
  s.id = sid;
  s.owner = buyer;
  s.verifier = verifier;
  s.policy_hash = policy;
  s.remaining = 8000;
  s.per_job = 5000;
  s.max_jobs = 10;
  s.expires = DAY + 10000;
  MockVM.setCallContractResults([balance(10000)]);
  c.reserve(s);
  return c;
}
function charge(): K.Charge {
  const j = new K.Charge();
  j.id = jobid;
  j.session_id = sid;
  j.provider = provider;
  j.policy_hash = policy;
  j.receipt_hash = bytes(32, 14);
  j.amount = 4000;
  j.dispatched_at = DAY + 1;
  j.nonce = 1;
  return j;
}
function settle(c: Credits): void {
  clock(DAY + 100);
  allow(verifier);
  MockVM.setCallContractResults([
    balance(10000),
    ok(),
    balance(7600),
    balance(7600),
    ok(),
    balance(6600),
    balance(6600),
    ok(),
    balance(6000),
    balance(6000),
  ]);
  c.settle(charge());
}
function opened(): Rewards {
  const r = setupRewards();
  MockVM.setCallContractResults([balance(100000)]);
  r.open();
  return r;
}
function publish(r: Rewards, a: u64 = 3000, w: u64 = 1000): K.Node {
  clock(2 * DAY);
  allow(verifier);
  const e = r.epochs.get(key(1))!,
    n = leaf(chain, treasury, e, provider, a, w);
  MockVM.setCallContractResults([answer(0), answer(10000), balance(100000)]);
  r.propose(1, n);
  return n;
}
describe("KOIN credit custody", () => {
  it("rejects backdated dispatch before the grant and never extends its settlement deadline", () => {
    expect(() => {
      const c = reserved(), j = charge(); j.dispatched_at = DAY - 1;
      clock(DAY + 100); allow(verifier); c.settle(j);
    }).toThrow();
    const c = reserved(), deadline = c.sessions.get(sid)!.settle_until;
    clock(3 * DAY); allow(buyer); c.revoke(sid);
    expect(c.sessions.get(sid)!.settle_until).toBe(deadline);
  });
  it("keeps prepaid funds reserved until consumed; splits only the actual charge", () => {
    const c = reserved();
    expect(c.totals.get(KEY)!.value).toBe(10000);
    expect(c.balances.get(buyer)!.available).toBe(2000);
    settle(c);
    expect(c.totals.get(KEY)!.value).toBe(6000);
    expect(c.sessions.get(sid)!.remaining).toBe(4000);
    expect(c.paid.get(periodAccount(1, provider))!.value).toBe(4000);
  });
  it("refunds only available principal, preserves reservations", () => {
    const c = reserved();
    allow(buyer);
    MockVM.setCallContractResults([
      balance(10000),
      ok(),
      balance(8000),
      balance(8000),
    ]);
    c.refund(buyer, 2000);
    expect(c.totals.get(KEY)!.value).toBe(8000);
    expect(c.balances.get(buyer)!.reserved).toBe(8000);
  });
  it("rejects refunding reserved principal and unauthorized settlements", () => {
    expect(() => {
      const c = reserved();
      c.refund(buyer, 3000);
    }).toThrow();
    expect(() => {
      const c = reserved();
      clock(DAY + 100);
      allow(buyer);
      c.settle(charge());
    }).toThrow();
  });
  it("rejects repeated jobs, nonce replay and charge above the approved maximum", () => {
    expect(() => {
      const c = reserved();
      settle(c);
      c.settle(charge());
    }).toThrow();
    expect(() => {
      const c = reserved();
      const j = charge();
      j.nonce = 2;
      allow(verifier);
      clock(DAY + 100);
      c.settle(j);
    }).toThrow();
    expect(() => {
      const c = reserved();
      const j = charge();
      j.amount = 6000;
      allow(verifier);
      clock(DAY + 100);
      c.settle(j);
    }).toThrow();
  });
  it("preserves unused funds after revoke and releases them only after settlement deadline", () => {
    const c = reserved();
    clock(DAY + 100);
    allow(buyer);
    c.revoke(sid);
    clock(2 * DAY + 101);
    MockVM.setCallContractResults([balance(10000)]);
    c.release(sid);
    expect(c.balances.get(buyer)!.available).toBe(10000);
    expect(c.balances.get(buyer)!.reserved).toBe(0);
    expect(c.sessions.get(sid)!.closed).toBe(true);
  });
  it("rejects post-revocation dispatch and late settlement", () => {
    expect(() => {
      const c = reserved();
      clock(DAY + 100);
      c.revoke(sid);
      clock(DAY + 200);
      allow(verifier);
      const j = charge();
      j.dispatched_at = DAY + 150;
      c.settle(j);
    }).toThrow();
    expect(() => {
      const c = reserved();
      clock(3 * DAY);
      allow(verifier);
      c.settle(charge());
    }).toThrow();
  });
  it("rejects a changed tariff commitment and wrong chain", () => {
    expect(() => {
      const c = reserved();
      clock(DAY + 100);
      allow(verifier);
      const j = charge();
      j.policy_hash = bytes(32, 99);
      c.settle(j);
    }).toThrow();
    expect(() => {
      const c = bought();
      MockVM.setChainId(bytes(34, 99));
      c.config();
    }).toThrow();
  });
});
describe("KOIN reward treasury", () => {
  it("cannot withdraw committed funds and releases abandoned days without removing claims", () => {
    expect(() => {
      const r = opened(), q = new K.Request(); q.amount = 96000; q.account = owner;
      allow(owner); MockVM.setCallContractResults([balance(100000)]); r.run(E.withdraw_free, q);
    }).toThrow();
    const r = opened(); clock(6 * DAY); MockVM.setCallContractResults([balance(100000)]); r.expire(1);
    expect(r.totals.get(KEY)!.value).toBe(0);
    expect(r.epochs.get(key(1))!.expired).toBe(true);
  });
  it("rejects a provider's work payout above its own paid charge even inside a valid root", () => {
    expect(() => {
      const r = opened(); publish(r); clock(3 * DAY);
      MockVM.setCallContractResults([balance(100000)]); r.finalize(1);
      const q = new K.Request(); q.epoch = 1; q.account = provider; q.availability = 3000; q.work = 1000;
      MockVM.setCallContractResults([answer(100)]); r.claim(q);
    }).toThrow();
  });
  it("reserves five percent once, excludes older liabilities and prorates late openings", () => {
    const r = opened();
    expect(r.epochs.get(key(1))!.budget).toBe(5000);
    expect(r.totals.get(KEY)!.value).toBe(5000);
    clock(2 * DAY + DAY / 2);
    MockVM.setCallContractResults([balance(100000)]);
    const e = r.open();
    expect(e.budget).toBe(2375);
    expect(e.availability_budget).toBe(1662);
  });
  it("rejects duplicate epoch opening", () => {
    expect(() => {
      const r = opened();
      r.open();
    }).toThrow();
  });
  it("cannot commit unbacked or oversized work allocations", () => {
    expect(() => {
      const r = opened();
      publish(r, 4000, 0);
    }).toThrow();
    expect(() => {
      const r = opened();
      clock(2 * DAY);
      allow(verifier);
      MockVM.setCallContractResults([answer(0), answer(1)]);
      r.propose(
        1,
        leaf(chain, treasury, r.epochs.get(key(1))!, provider, 1000, 1000),
      );
    }).toThrow();
  });
  it("holds funds through review, then releases only unused budget", () => {
    const r = opened();
    publish(r);
    clock(3 * DAY);
    MockVM.setCallContractResults([balance(100000)]);
    r.finalize(1);
    expect(r.totals.get(KEY)!.value).toBe(4000);
    expect(r.epochs.get(key(1))!.finalized).toBe(true);
  });
  it("pays a fixed provider once and conserves every reserved atom", () => {
    const r = opened();
    publish(r);
    clock(3 * DAY);
    MockVM.setCallContractResults([balance(100000)]);
    r.finalize(1);
    const q = new K.Request();
    q.epoch = 1;
    q.account = provider;
    q.availability = 3000;
    q.work = 1000;
    MockVM.setCallContractResults([
      answer(10000),
      balance(100000),
      ok(),
      balance(96000),
      balance(96000),
    ]);
    r.claim(q);
    expect(r.totals.get(KEY)!.value).toBe(0);
    expect(r.epochs.get(key(1))!.paid).toBe(4000);
    expect(r.claims.get(periodAccount(1, provider))!.value).toBe(4000);
  });
  it("rejects early finalization, wrong recipient and repeat claims", () => {
    expect(() => {
      const r = opened();
      publish(r);
      r.finalize(1);
    }).toThrow();
    expect(() => {
      const r = opened();
      publish(r);
      clock(3 * DAY);
      MockVM.setCallContractResults([balance(100000)]);
      r.finalize(1);
      const q = new K.Request();
      q.epoch = 1;
      q.account = buyer;
      q.availability = 3000;
      q.work = 1000;
      r.claim(q);
    }).toThrow();
    expect(() => {
      const r = opened();
      publish(r);
      clock(3 * DAY);
      MockVM.setCallContractResults([balance(100000)]);
      r.finalize(1);
      r.claims.put(periodAccount(1, provider), new K.Amount(4000));
      const q = new K.Request();
      q.epoch = 1;
      q.account = provider;
      r.claim(q);
    }).toThrow();
  });
  it("owner may cancel pending roots but cannot erase finalized claims", () => {
    const r = opened();
    publish(r);
    allow(owner);
    r.cancel(1);
    expect(r.totals.get(KEY)!.value).toBe(5000);
    expect(r.epochs.get(key(1))!.root === null).toBe(true);
  });
  it("Merkle sum binds the two categories and deployment domain", () => {
    const r = opened(),
      e = r.epochs.get(key(1))!;
    const a = leaf(chain, treasury, e, provider, 3000, 1000),
      b = leaf(chain, treasury, e, buyer, 500, 200),
      p = parent(a, b);
    expect(p.availability).toBe(3500);
    expect(p.work).toBe(1200);
    expect(
      equal(a.hash, leaf(chain, credit, e, provider, 3000, 1000).hash),
    ).toBe(false);
  });
  it("policy changes require owner authority and a full notice period", () => {
    expect(() => {
      const r = opened(),
        c = config();
      c.version = 2;
      c.effective_at = 2 * DAY;
      allow(owner);
      r.schedule(c);
    }).toThrow();
    const r = opened(),
      c = config();
    c.version = 2;
    c.effective_at = 3 * DAY;
    allow(owner);
    r.schedule(c);
    clock(3 * DAY);
    r.activate();
    expect(r.config().version).toBe(2);
  });
  it("uint64 proportional arithmetic avoids multiplying the full balance", () => {
    expect(part(u64.MAX_VALUE, 10000)).toBe(u64.MAX_VALUE);
    expect(part(u64.MAX_VALUE, 500)).toBe(u64.MAX_VALUE / 20);
  });
});
