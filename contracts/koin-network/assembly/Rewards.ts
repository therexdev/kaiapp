import { Storage, System, Protobuf, StringBytes } from "@koinos/sdk-as";
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
  join,
  integer,
  hash,
} from "./Common";
import * as E from "./entries";
export function leaf(
  chain: Uint8Array,
  contract: Uint8Array,
  epoch: K.Epoch,
  account: Uint8Array,
  a: u64,
  w: u64,
): K.Node {
  let b = join(
    new Uint8Array(1),
    // SDK stringToBytes treats NUL as a terminator. Append the domain byte
    // explicitly so the compiled contract matches the JavaScript encoder.
    join(StringBytes.stringToBytes("KAI-KOIN-REWARDS-V1"), new Uint8Array(1)),
  );
  b = join(b, chain);
  b = join(b, contract);
  b = join(b, integer(epoch.id));
  b = join(b, integer(epoch.version));
  b = join(b, account);
  b = join(b, integer(a));
  b = join(b, integer(w));
  return new K.Node(hash(b), a, w);
}
export function parent(a: K.Node, b: K.Node): K.Node {
  const prefix = new Uint8Array(1);
  prefix[0] = 1;
  let v = join(prefix, digest(a.hash));
  v = join(v, integer(a.availability));
  v = join(v, integer(a.work));
  v = join(v, digest(b.hash));
  v = join(v, integer(b.availability));
  v = join(v, integer(b.work));
  return new K.Node(
    hash(v),
    add(a.availability, b.availability),
    add(a.work, b.work),
  );
}
export class Rewards extends Base {
  epochs: Storage.Map<Uint8Array, K.Epoch> = new Storage.Map(
    this.id,
    2,
    K.Epoch.decode,
    K.Epoch.encode,
  );
  claims: Storage.Map<Uint8Array, K.Amount> = new Storage.Map(
    this.id,
    3,
    K.Amount.decode,
    K.Amount.encode,
  );
  open(): K.Epoch {
    this.running();
    const c = this.config(),
      time = now(),
      id = time / DAY;
    System.require(this.epochs.get(key(id)) === null, "epoch already opened");
    const e = new K.Epoch();
    e.id = id;
    e.opened_at = time;
    e.version = c.version;
    e.credits = c.credits;
    e.verifier = c.verifier;
    e.work_cap_bps = c.work_cap_bps;
    e.budget = part(
      part(sub(this.invariant(), this.totals.get(KEY)!.value), c.daily_bps),
      DAY - (time % DAY),
      DAY,
    );
    e.availability_budget = part(e.budget, c.availability_bps);
    e.work_budget = e.budget - e.availability_budget;
    this.liability(e.budget, true);
    this.epochs.put(key(id), e);
    return e;
  }
  creditCall(e: K.Epoch, method: u32, r: K.Request): K.Result {
    const out = System.call(
      e.credits!,
      method,
      Protobuf.encode(r, K.Request.encode),
    );
    System.require(out.code == 0, "credits call failed");
    return Protobuf.decode<K.Result>(out.res.object!, K.Result.decode);
  }
  propose(id: u64, root: K.Node): void {
    this.running();
    const e = this.epochs.get(key(id));
    System.require(
      e !== null && !e!.expired && !e!.finalized && e!.root === null,
      "epoch not open for commitment",
    );
    auth(e!.verifier!);
    digest(root.hash);
    System.require(
      now() / DAY > id &&
        root.availability <= e!.availability_budget &&
        root.work <= e!.work_budget &&
        !root.left,
      "invalid epoch allocation",
    );
    const req = new K.Request();
    req.epoch = id;
    this.creditCall(e!, E.seal_day, req);
    const charged = this.creditCall(e!, E.get_spend, req).amount;
    System.require(
      root.work <= part(charged, e!.work_cap_bps),
      "work exceeds paid-usage cap",
    );
    e!.root = root;
    e!.review_until = add(now(), DAY);
    this.epochs.put(key(id), e!);
    this.invariant();
  }
  finalize(id: u64): void {
    const e = this.epochs.get(key(id));
    System.require(
      e !== null &&
        !e!.expired &&
        !e!.finalized &&
        e!.root !== null &&
        now() >= e!.review_until,
      "root not ready",
    );
    this.running();
    const total = add(e!.root!.availability, e!.root!.work);
    this.liability(sub(e!.budget, total), false);
    e!.finalized = true;
    this.epochs.put(key(id), e!);
    this.invariant();
  }
  cancel(id: u64): void {
    auth(this.config().admin!);
    const e = this.epochs.get(key(id));
    System.require(
      e !== null && !e!.expired && !e!.finalized && e!.root !== null,
      "root cannot be cancelled",
    );
    e!.root = null;
    e!.review_until = 0;
    this.epochs.put(key(id), e!);
  }
  expire(id: u64): void {
    const e = this.epochs.get(key(id));
    System.require(
      e !== null &&
        !e!.expired &&
        !e!.finalized &&
        e!.root === null &&
        now() > add((id + 1) * DAY, 3 * DAY),
      "epoch cannot expire",
    );
    this.liability(e!.budget, false);
    e!.expired = true;
    this.epochs.put(key(id), e!);
    this.invariant();
  }
  claim(r: K.Request): void {
    const to = addr(r.account),
      e = this.epochs.get(key(r.epoch));
    System.require(
      e !== null && e!.finalized && !e!.expired && e!.root !== null,
      "epoch not finalized",
    );
    const ck = periodAccount(r.epoch, to);
    System.require(
      this.claims.get(ck) === null && r.proof.length <= 16,
      "duplicate claim or invalid proof",
    );
    let n = leaf(
      this.config().chain_id!,
      this.id,
      e!,
      to,
      r.availability,
      r.work,
    );
    for (let i = 0; i < r.proof.length; i++)
      n = r.proof[i].left ? parent(r.proof[i], n) : parent(n, r.proof[i]);
    System.require(
      equal(n.hash, e!.root!.hash) &&
        n.availability == e!.root!.availability &&
        n.work == e!.root!.work,
      "invalid sum proof",
    );
    if (r.work > 0) {
      const q = new K.Request();
      q.account = to;
      q.epoch = r.epoch;
      const charged = this.creditCall(e!, E.get_spend, q).amount;
      System.require(
        r.work <= part(charged, e!.work_cap_bps),
        "provider work exceeds paid cap",
      );
    }
    const amount = add(r.availability, r.work);
    System.require(amount > 0, "zero claim");
    e!.paid = add(e!.paid, amount);
    System.require(
      e!.paid <= add(e!.root!.availability, e!.root!.work),
      "epoch exhausted",
    );
    this.claims.put(ck, new K.Amount(amount));
    this.epochs.put(key(r.epoch), e!);
    this.liability(amount, false);
    this.transfer(to, amount);
    this.invariant();
  }
  run(method: u32, r: K.Request): K.Result {
    const out = new K.Result();
    if (method == E.initialize) {
      System.require(r.config !== null, "config required");
      this.initialize(r.config!, false);
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
    if (method == E.fund) this.deposit(addr(r.account), r.amount);
    else if (method == E.open_epoch) {
      out.epoch = this.open();
      return out;
    } else if (method == E.propose_root) {
      System.require(r.root !== null, "root required");
      this.propose(r.epoch, r.root!);
    } else if (method == E.finalize_root) this.finalize(r.epoch);
    else if (method == E.cancel_root) this.cancel(r.epoch);
    else if (method == E.expire_epoch) this.expire(r.epoch);
    else if (method == E.claim) this.claim(r);
    else if (method == E.get_epoch) {
      out.epoch = this.epochs.get(key(r.epoch));
      return out;
    } else if (method == E.claimed) {
      out.claimed =
        this.claims.get(periodAccount(r.epoch, addr(r.account))) !== null;
      return out;
    } else if (method == E.withdraw_free) {
      auth(this.config().admin!);
      System.require(
        r.amount > 0 &&
          r.amount <= sub(this.invariant(), this.totals.get(KEY)!.value),
        "committed funds cannot withdraw",
      );
      this.transfer(addr(r.account), r.amount);
    } else System.require(method == E.balances, "unknown treasury method");
    out.liabilities = this.totals.get(KEY)!.value;
    out.liquid = this.invariant();
    out.amount = sub(out.liquid, out.liabilities);
    return out;
  }
}
