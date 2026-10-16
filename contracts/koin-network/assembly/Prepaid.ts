import { Storage, System } from "@koinos/sdk-as";
import { koin as K } from "./proto/koin";
import { Base, KEY, PAUSE, DAY, addr, digest, equal, add, sub, part, now, auth, key, periodAccount } from "./Common";
import * as E from "./entries";

// NEW deployment only. Never upload over the refundable Credits contract.
// A purchase buys a nontransferable service entitlement, not refundable custody.
// The service accounts for consumption immediately; this contract settles it
// asynchronously. There are no customer sessions, reservations or expiry dates.
export class Prepaid extends Base {
  accounts: Storage.Map<Uint8Array, K.PrepaidAccount> = new Storage.Map(this.id, 20,
    K.PrepaidAccount.decode, K.PrepaidAccount.encode, () => new K.PrepaidAccount());
  charges: Storage.Map<Uint8Array, K.Amount> = new Storage.Map(this.id, 21, K.Amount.decode, K.Amount.encode);
  paid: Storage.Map<Uint8Array, K.Amount> = new Storage.Map(this.id, 22, K.Amount.decode, K.Amount.encode, () => new K.Amount());
  sealed: Storage.Map<Uint8Array, K.Amount> = new Storage.Map(this.id, 23, K.Amount.decode, K.Amount.encode, () => new K.Amount());
  purchase(owner: Uint8Array, n: u64): void {
    this.running(); this.deposit(owner, n);
    const a = this.accounts.get(owner)!;
    a.purchased = add(a.purchased, n); this.accounts.put(owner, a);
    this.liability(n, true); this.invariant();
  }
  settle(owner: Uint8Array, c: K.Charge): void {
    const cfg = this.config(); auth(cfg.verifier!);
    digest(c.id); digest(c.receipt_hash); digest(c.policy_hash); addr(c.provider);
    System.require(!equal(owner, c.provider), "self-served work is ineligible");
    System.require(this.charges.get(c.id!) === null && c.amount > 0, "duplicate or empty usage");
    // Settlement is intentionally independent of customer online state and age.
    // A delayed payout does not lock a customer's remaining service credits.
    const a = this.accounts.get(owner)!;
    System.require(c.amount <= sub(a.purchased, a.consumed), "usage exceeds purchased credits");
    const epoch = now() / DAY;
    System.require(this.sealed.get(key(epoch))!.value == 0, "charge period sealed");
    a.consumed = add(a.consumed, c.amount); this.accounts.put(owner, a);
    this.charges.put(c.id!, new K.Amount(c.amount)); this.liability(c.amount, false);
    const pk = periodAccount(epoch, c.provider!), p = this.paid.get(pk)!, total = this.paid.get(key(epoch))!;
    p.value = add(p.value, c.amount); total.value = add(total.value, c.amount);
    this.paid.put(pk, p); this.paid.put(key(epoch), total);
    const reward = part(c.amount, cfg.reward_bps), mining = part(c.amount, cfg.mining_bps);
    this.transfer(cfg.treasury!, reward); this.transfer(cfg.mining!, mining);
    this.transfer(cfg.operations!, c.amount - reward - mining); this.invariant();
  }
  run(method: u32, r: K.Request): K.Result {
    const out = new K.Result();
    if (method == E.initialize) {
      System.require(r.config !== null, "config required"); this.initialize(r.config!, true); return out;
    }
    this.config();
    if (method == E.config) { out.product_version = 1; out.config = this.config(); out.paused = this.totals.get(PAUSE)!.value != 0; return out; }
    if (method == E.schedule_policy) { System.require(r.config !== null, "config required"); this.schedule(r.config!); return out; }
    if (method == E.activate_policy) { this.activate(); return out; }
    if (method == E.set_paused) { this.pause(r.paused); return out; }
    if (method == E.purchase) this.purchase(addr(r.account), r.amount);
    else if (method == E.settle_usage) { System.require(r.charge !== null, "usage required"); this.settle(addr(r.account), r.charge!); }
    else if (method == E.get_charge) { const c = this.charges.get(digest(r.id)); out.amount = c === null ? 0 : c!.value; return out; }
    else if (method == E.get_spend) {
      out.amount = this.paid.get(r.account !== null && r.account!.length > 0 ? periodAccount(r.epoch, addr(r.account)) : key(r.epoch))!.value; return out;
    } else if (method == E.seal_day) {
      System.require(equal(System.getCaller().caller, this.config().treasury), "treasury caller required");
      System.require(r.epoch < now() / DAY, "current charge period cannot seal");
      this.sealed.put(key(r.epoch), new K.Amount(1)); return out;
    } else System.require(method == E.balances, "unknown prepaid method");
    if (r.account !== null && r.account!.length > 0) {
      const a = this.accounts.get(addr(r.account))!; out.prepaid = a;
      out.balance = new K.Balance(sub(a.purchased, a.consumed), 0);
    }
    out.liabilities = this.totals.get(KEY)!.value; out.liquid = this.invariant(); return out;
  }
}
