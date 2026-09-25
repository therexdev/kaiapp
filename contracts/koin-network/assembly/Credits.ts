import { Storage, System } from "@koinos/sdk-as";
import { koin as K } from "./proto/koin";
import {
  Base,
  KEY,
  PAUSE,
  DAY,
  addr,
  digest,
  equal,
  add,
  sub,
  part,
  now,
  auth,
  key,
  periodAccount,
} from "./Common";
import * as E from "./entries";
export class Credits extends Base {
  balances: Storage.Map<Uint8Array, K.Balance> = new Storage.Map(
    this.id,
    2,
    K.Balance.decode,
    K.Balance.encode,
    () => new K.Balance(),
  );
  sessions: Storage.Map<Uint8Array, K.Session> = new Storage.Map(
    this.id,
    3,
    K.Session.decode,
    K.Session.encode,
  );
  charges: Storage.Map<Uint8Array, K.Amount> = new Storage.Map(
    this.id,
    4,
    K.Amount.decode,
    K.Amount.encode,
  );
  paid: Storage.Map<Uint8Array, K.Amount> = new Storage.Map(
    this.id,
    5,
    K.Amount.decode,
    K.Amount.encode,
    () => new K.Amount(),
  );
  sealed: Storage.Map<Uint8Array, K.Amount> = new Storage.Map(
    this.id,
    6,
    K.Amount.decode,
    K.Amount.encode,
    () => new K.Amount(),
  );
  purchase(owner: Uint8Array, n: u64): void {
    this.running();
    this.deposit(owner, n);
    const b = this.balances.get(owner)!;
    b.available = add(b.available, n);
    this.balances.put(owner, b);
    this.liability(n, true);
    this.invariant();
  }
  refund(owner: Uint8Array, n: u64): void {
    auth(owner);
    System.require(n > 0, "zero refund");
    const b = this.balances.get(owner)!;
    b.available = sub(b.available, n);
    this.balances.put(owner, b);
    this.liability(n, false);
    this.transfer(owner, n);
    this.invariant();
  }
  reserve(s: K.Session): void {
    this.running();
    const c = this.config();
    digest(s.id);
    addr(s.owner);
    digest(s.policy_hash);
    auth(s.owner!);
    System.require(
      this.sessions.get(s.id!) === null && equal(s.verifier, c.verifier),
      "invalid session identity",
    );
    System.require(
      s.remaining > 0 &&
        s.per_job > 0 &&
        s.per_job <= s.remaining &&
        s.max_jobs > 0 &&
        s.max_jobs <= 10000,
      "invalid session limits",
    );
    System.require(
      s.expires > now() && s.expires <= add(now(), DAY),
      "invalid session expiry",
    );
    System.require(
      s.jobs == 0 &&
        s.nonce == 0 &&
        s.revoked_at == 0 &&
        !s.closed &&
        s.settle_until == 0 &&
        s.opened_at == 0,
      "noninitial session",
    );
    const b = this.balances.get(s.owner!)!;
    b.available = sub(b.available, s.remaining);
    b.reserved = add(b.reserved, s.remaining);
    s.opened_at = now();
    s.settle_until = add(s.expires, DAY);
    s.treasury = c.treasury;
    s.mining = c.mining;
    s.operations = c.operations;
    s.reward_bps = c.reward_bps;
    s.mining_bps = c.mining_bps;
    s.version = c.version;
    this.sessions.put(s.id!, s);
    this.balances.put(s.owner!, b);
    this.invariant();
  }
  revoke(id: Uint8Array): void {
    const s = this.sessions.get(id);
    System.require(s !== null && !s!.closed, "unknown session");
    auth(s!.owner!);
    if (s!.revoked_at == 0) {
      s!.revoked_at = now();
      s!.settle_until = min(s!.settle_until, add(now(), DAY));
      this.sessions.put(id, s!);
    }
  }
  release(id: Uint8Array): void {
    const s = this.sessions.get(id);
    System.require(
      s !== null && !s!.closed && now() > s!.settle_until,
      "session still reserving",
    );
    const b = this.balances.get(s!.owner!)!;
    b.reserved = sub(b.reserved, s!.remaining);
    b.available = add(b.available, s!.remaining);
    s!.remaining = 0;
    s!.closed = true;
    this.sessions.put(id, s!);
    this.balances.put(s!.owner!, b);
    this.invariant();
  }
  settle(c: K.Charge): void {
    this.running();
    digest(c.id);
    digest(c.session_id);
    digest(c.receipt_hash);
    addr(c.provider);
    const s = this.sessions.get(c.session_id!);
    System.require(s !== null && !s!.closed, "unknown session");
    auth(s!.verifier!);
    System.require(
      this.charges.get(c.id!) === null &&
        equal(c.policy_hash, s!.policy_hash) &&
        c.nonce == add(s!.nonce, 1),
      "duplicate or changed settlement",
    );
    System.require(
      now() <= s!.settle_until &&
        c.dispatched_at >= s!.opened_at &&
        c.dispatched_at <= now() &&
        c.dispatched_at < s!.expires &&
        (s!.revoked_at == 0 || c.dispatched_at < s!.revoked_at),
      "settlement outside authorized time",
    );
    System.require(
      c.amount > 0 &&
        c.amount <= s!.per_job &&
        c.amount <= s!.remaining &&
        s!.jobs < s!.max_jobs,
      "session spending limit",
    );
    const epoch = now() / DAY;
    System.require(
      this.sealed.get(key(epoch))!.value == 0,
      "charge period sealed",
    );
    const b = this.balances.get(s!.owner!)!;
    b.reserved = sub(b.reserved, c.amount);
    s!.remaining -= c.amount;
    s!.nonce = c.nonce;
    s!.jobs++;
    this.balances.put(s!.owner!, b);
    this.sessions.put(c.session_id!, s!);
    this.charges.put(c.id!, new K.Amount(c.amount));
    this.liability(c.amount, false);
    const pkey = periodAccount(epoch, c.provider!),
      p = this.paid.get(pkey)!;
    p.value = add(p.value, c.amount);
    this.paid.put(pkey, p);
    const total = this.paid.get(key(epoch))!;
    total.value = add(total.value, c.amount);
    this.paid.put(key(epoch), total);
    const reward = part(c.amount, s!.reward_bps),
      mining = part(c.amount, s!.mining_bps);
    this.transfer(s!.treasury!, reward);
    this.transfer(s!.mining!, mining);
    this.transfer(s!.operations!, c.amount - reward - mining);
    this.invariant();
  }
  run(method: u32, r: K.Request): K.Result {
    const out = new K.Result();
    if (method == E.initialize) {
      System.require(r.config !== null, "config required");
      this.initialize(r.config!, true);
      return out;
    }
    this.config();
    if (method == E.config) {
      out.config = this.config();
      out.paused = this.totals.get(PAUSE)!.value != 0;
      return out;
    }
    if (method == E.schedule_policy) {
      System.require(r.config !== null, "config required");
      this.schedule(r.config!);
      return out;
    }
    if (method == E.activate_policy) {
      this.activate();
      return out;
    }
    if (method == E.set_paused) {
      this.pause(r.paused);
      return out;
    }
    if (method == E.purchase) this.purchase(addr(r.account), r.amount);
    else if (method == E.refund) this.refund(addr(r.account), r.amount);
    else if (method == E.reserve) {
      System.require(r.session !== null, "session required");
      this.reserve(r.session!);
    } else if (method == E.revoke) this.revoke(digest(r.id));
    else if (method == E.release) this.release(digest(r.id));
    else if (method == E.settle) {
      System.require(r.charge !== null, "charge required");
      this.settle(r.charge!);
    } else if (method == E.get_session) {
      out.session = this.sessions.get(digest(r.id));
      return out;
    } else if (method == E.get_spend) {
      out.amount = this.paid.get(
        r.account !== null && r.account!.length > 0
          ? periodAccount(r.epoch, addr(r.account))
          : key(r.epoch),
      )!.value;
      return out;
    } else if (method == E.seal_day) {
      auth(this.config().treasury!);
      System.require(
        r.epoch < now() / DAY,
        "current charge period cannot seal",
      );
      this.sealed.put(key(r.epoch), new K.Amount(1));
      return out;
    } else System.require(method == E.balances, "unknown credits method");
    if (r.account !== null && r.account!.length > 0)
      out.balance = this.balances.get(addr(r.account));
    out.liabilities = this.totals.get(KEY)!.value;
    out.liquid = this.invariant();
    return out;
  }
}
