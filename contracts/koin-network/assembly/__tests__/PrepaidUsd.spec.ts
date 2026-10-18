import { PrepaidUsd as Prepaid } from "../PrepaidUsd";
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
  c.version = 1; c.reward_basis = 1; c.master_node = owner; c.sponsor_daily_limit = 10000; c.sponsor_account_daily_limit = 5000;
  c.daily_bps = 500;
  c.availability_bps = 7000;
  c.reward_bps = 6000;
  c.mining_bps = 2500;
  c.operations_bps = 1500;
  c.work_cap_bps = 8000;
  return c;
}
function setup(): Prepaid {
  MockVM.reset(); MockVM.setContractId(credit); MockVM.setChainId(chain); clock(DAY);
  const c = new Prepaid(); c.configs.put(KEY, config()); return c;
}
function bought(): Prepaid {
  const c = setup(); allow(buyer);
  MockVM.setCallContractResults([balance(0), ok(), balance(10000), balance(10000)]);
  c.purchase(buyer, 10000); return c;
}
function usage(): K.Charge {
  const c = new K.Charge(); c.id = jobid; c.provider = provider; c.policy_hash = policy;
  c.receipt_hash = bytes(32, 14); c.amount = 4000; return c;
}

function account(): Prepaid { const c = setup(); c.accounts.put(buyer, new K.PrepaidAccount(10000, 0)); allow(verifier); return c; }
const accountId = bytes(32, 20);
describe("unified USD sponsored usage", () => {
  it("records wallet-free delivered work without minting purchased credits or transferring KOIN", () => {
    const c = account(); c.settleCreditUsage(null, accountId, 0, usage());
    expect(c.sponsored.get(jobid)!.value).toBe(4000);
    expect(c.charges.get(jobid)!.value).toBe(4000);
    expect(c.paid.get(periodAccount(1, provider))!.value).toBe(4000);
    expect(c.accounts.get(buyer)!.purchased).toBe(10000);
    expect(c.accounts.get(buyer)!.consumed).toBe(0);
    expect(c.totals.get(KEY)!.value).toBe(0);
  });
  it("settles one mixed receipt while debiting only its purchased portion", () => {
    const c = account(); c.settleCreditUsage(buyer, accountId, 1500, usage());
    expect(c.sponsored.get(jobid)!.value).toBe(2500);
    expect(c.accounts.get(buyer)!.consumed).toBe(1500);
    expect(c.accounts.get(buyer)!.purchased).toBe(10000);
    expect(c.paid.get(key(1))!.value).toBe(4000);
  });
  it("rejects repeat receipts and collisions with older paid settlement", () => {
    expect(() => { const c = account(); c.settleCreditUsage(buyer, accountId, 1500, usage()); c.settleCreditUsage(buyer, accountId, 1500, usage()); }).toThrow();
    expect(() => { const c = account(); c.settle(buyer, usage()); c.settleCreditUsage(buyer, accountId, 1500, usage()); }).toThrow();
    expect(() => { const c = account(); c.settleCreditUsage(buyer, accountId, 1500, usage()); c.settle(buyer, usage()); }).toThrow();
  });
  it("requires verifier authorization and bounded paid usage", () => {
    expect(() => { const c = account(); allow(buyer); c.settleCreditUsage(buyer, accountId, 1500, usage()); }).toThrow();
    expect(() => { const c = account(); c.settleCreditUsage(buyer, accountId, 4001, usage()); }).toThrow();
    expect(() => { const c = account(); const u = usage(); u.amount = 10001; c.settleCreditUsage(buyer, accountId, 10001, u); }).toThrow();
    expect(() => { const c = account(); c.settleCreditUsage(null, accountId, 1, usage()); }).toThrow();
  });
  it("requires account evidence, excludes self-service and never reopens sealed days", () => {
    expect(() => { const c = account(); c.settleCreditUsage(buyer, bytes(31, 1), 1, usage()); }).toThrow();
    expect(() => { const c = account(); c.settleCreditUsage(provider, accountId, 0, usage()); }).toThrow();
    expect(() => { const c = account(); c.sealed.put(key(1), new K.Amount(1)); c.settleCreditUsage(buyer, accountId, 0, usage()); }).toThrow();
  });
  it("keeps earned settlement available while purchases are paused and exposes sponsorship separately", () => {
    const c = account(); c.totals.put(PAUSE, new K.Amount(1));
    const r = new K.Request(); r.id = accountId; r.account = buyer; r.amount = 1000; r.charge = usage();
    expect(c.run(E.settle_credit_usage, r).amount).toBe(4000);
    const query = new K.Request(); query.id = jobid;
    expect(c.run(E.get_sponsored_charge, query).amount).toBe(3000);
  });
  it("enforces cumulative account and network sponsor ceilings", () => {
    expect(() => { const c = account(); c.settleCreditUsage(null, accountId, 0, usage()); const u = usage(); u.id = bytes(32, 31); c.settleCreditUsage(null, accountId, 0, u); }).toThrow();
    expect(() => { const c = account(); c.settleCreditUsage(null, accountId, 0, usage()); const second = usage(); second.id = bytes(32, 31); c.settleCreditUsage(null, bytes(32, 32), 0, second); const third = usage(); third.id = bytes(32, 33); c.settleCreditUsage(null, bytes(32, 34), 0, third); }).toThrow();
    expect(() => { const c = account(); const cfg = c.config(); cfg.sponsor_daily_limit = 0; cfg.sponsor_account_daily_limit = 0; c.configs.put(KEY, cfg); c.settleCreditUsage(null, accountId, 0, usage()); }).toThrow();
  });
  it("resets ceilings by UTC settlement day without minting or carrying a grant", () => {
    const c = account(); c.settleCreditUsage(null, accountId, 0, usage()); clock(2 * DAY);
    const u = usage(); u.id = bytes(32, 35); c.settleCreditUsage(null, accountId, 0, u);
    expect(c.sponsorSpent.get(key(1))!.value).toBe(4000); expect(c.sponsorSpent.get(key(2))!.value).toBe(4000);
    expect(c.accounts.get(buyer)!.purchased).toBe(10000);
  });
});
