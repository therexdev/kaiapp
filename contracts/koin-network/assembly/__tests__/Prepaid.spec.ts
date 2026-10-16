import { Prepaid } from "../Prepaid";
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
function settle(c: Prepaid): void {
  allow(verifier);
  MockVM.setCallContractResults([balance(10000), ok(), balance(7600), balance(7600), ok(), balance(6600), balance(6600), ok(), balance(6000), balance(6000)]);
  c.settle(buyer, usage());
}
describe("nonrefundable prepaid service credits", () => {
  it("records purchases without sessions or reserved balances", () => {
    const c = bought(); const a = c.accounts.get(buyer)!;
    expect(a.purchased).toBe(10000); expect(a.consumed).toBe(0); expect(c.totals.get(KEY)!.value).toBe(10000);
    MockVM.setCallContractResults([balance(10000)]); const r = new K.Request(); r.account = buyer;
    const view = c.run(E.balances, r); expect(view.balance!.available).toBe(10000); expect(view.balance!.reserved).toBe(0);
  });
  it("settles verified consumption once and splits only actual revenue", () => {
    const c = bought(); settle(c);
    expect(c.accounts.get(buyer)!.consumed).toBe(4000); expect(c.totals.get(KEY)!.value).toBe(6000);
    expect(c.paid.get(periodAccount(1, provider))!.value).toBe(4000);
    expect(c.charges.get(jobid)!.value).toBe(4000);
  });
  it("has no customer expiry and permits delayed backend settlement", () => {
    const c = bought(); clock(90 * DAY); settle(c);
    expect(c.accounts.get(buyer)!.purchased - c.accounts.get(buyer)!.consumed).toBe(6000);
    expect(c.paid.get(periodAccount(90, provider))!.value).toBe(4000);
  });
  it("rejects duplicate charges", () => { expect(() => { const c = bought(); settle(c); c.settle(buyer, usage()); }).toThrow(); });
  it("rejects usage above purchased credits", () => { expect(() => { const c = bought(); allow(verifier); const u = usage(); u.amount = 10001; c.settle(buyer, u); }).toThrow(); });
  it("requires verifier authority", () => { expect(() => { const c = bought(); allow(buyer); c.settle(buyer, usage()); }).toThrow(); });
  it("rejects self-served work", () => { expect(() => { const c = bought(); allow(verifier); const u = usage(); u.provider = buyer; c.settle(buyer, u); }).toThrow(); });
  it("rejects zero credit purchases", () => { expect(() => { const c = setup(); allow(buyer); c.purchase(buyer, 0); }).toThrow(); });
  it("has no refund or reservation entry point", () => {
    expect(() => { const c = bought(); const r = new K.Request(); r.account = buyer; r.amount = 1; c.run(E.refund, r); }).toThrow();
    expect(() => { const c = bought(); c.run(E.reserve, new K.Request()); }).toThrow();
  });
  it("pausing new purchases preserves already earned usage settlement", () => {
    const c = bought(); c.totals.put(PAUSE, new K.Amount(1)); settle(c);
    expect(c.accounts.get(buyer)!.consumed).toBe(4000);
  });
});
