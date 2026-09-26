import {
  System,
  Storage,
  StringBytes,
  authority,
  Token,
  Crypto,
  Protobuf,
  token,
} from "@koinos/sdk-as";
import { koin as K } from "./proto/koin";
export const DAY: u64 = 86400000;
export const KEY = StringBytes.stringToBytes("v1"),
  PENDING = StringBytes.stringToBytes("pending"),
  PAUSE = StringBytes.stringToBytes("pause");
export function equal(a: Uint8Array | null, b: Uint8Array | null): bool {
  if (a === null || b === null) return a === b;
  if (a.length != b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false;
  return true;
}
export function addr(a: Uint8Array | null): Uint8Array {
  System.require(a !== null && a!.length == 25, "invalid account");
  return a!;
}
export function digest(a: Uint8Array | null): Uint8Array {
  System.require(a !== null && a!.length == 32, "invalid digest");
  return a!;
}
export function add(a: u64, b: u64): u64 {
  System.require(u64.MAX_VALUE - a >= b, "amount overflow");
  return a + b;
}
export function sub(a: u64, b: u64): u64 {
  System.require(a >= b, "amount underflow");
  return a - b;
}
export function part(a: u64, n: u64, d: u64 = 10000): u64 {
  System.require(d > 0 && d <= DAY && n <= d, "invalid proportion");
  return (a / d) * n + ((a % d) * n) / d;
}
export function now(): u64 {
  return System.getBlockField("header.timestamp")!.uint64_value;
}
export function auth(a: Uint8Array): void {
  System.require(
    System.checkAuthority(authority.authorization_type.contract_call, a),
    "authority required",
  );
}
export function key(epoch: u64): Uint8Array {
  return StringBytes.stringToBytes(epoch.toString());
}
export function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
export function integer(a: u64): Uint8Array {
  const b = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    b[i] = <u8>(a & 255);
    a >>= 8;
  }
  return b;
}
export function hash(b: Uint8Array): Uint8Array {
  const h = System.hash(Crypto.multicodec.sha2_256, b)!;
  return h.length == 34 ? h.subarray(2) : h;
}
export function periodAccount(day: u64, account: Uint8Array): Uint8Array {
  return join(integer(day), account);
}
export class Base {
  id: Uint8Array = System.getContractId();
  configs: Storage.Map<Uint8Array, K.Config> = new Storage.Map(
    this.id,
    0,
    K.Config.decode,
    K.Config.encode,
  );
  totals: Storage.Map<Uint8Array, K.Amount> = new Storage.Map(
    this.id,
    1,
    K.Amount.decode,
    K.Amount.encode,
    () => new K.Amount(),
  );
  config(): K.Config {
    const c = this.configs.get(KEY);
    System.require(
      c !== null && equal(c!.chain_id, System.getChainId()),
      "deployment chain mismatch",
    );
    return c!;
  }
  validate(c: K.Config): void {
    addr(c.token);
    addr(c.admin);
    addr(c.verifier);
    addr(c.treasury);
    addr(c.credits);
    addr(c.mining);
    addr(c.operations);
    System.require(
      equal(c.chain_id, System.getChainId()) && c.version > 0,
      "invalid deployment",
    );
    System.require(
      c.daily_bps <= 1000 &&
        c.availability_bps <= 10000 &&
        c.work_cap_bps <= 9000,
      "invalid reward policy",
    );
    System.require(
      c.reward_bps <= 10000 &&
        c.mining_bps <= 10000 &&
        c.operations_bps <= 10000 &&
        c.reward_bps + c.mining_bps + c.operations_bps == 10000,
      "invalid revenue split",
    );
    System.require(
      !equal(c.credits, c.treasury) &&
        !equal(c.credits, c.token) &&
        !equal(c.treasury, c.token),
      "invalid custody accounts",
    );
    System.require(
      !equal(c.mining, c.credits) &&
        !equal(c.operations, c.credits) &&
        !equal(c.mining, c.treasury) &&
        !equal(c.operations, c.treasury),
      "invalid funding destination",
    );
  }
  initialize(c: K.Config, credits: bool): void {
    auth(this.id);
    System.require(this.configs.get(KEY) === null, "already initialized");
    this.validate(c);
    System.require(
      equal(credits ? c.credits : c.treasury, this.id) &&
        c.version == 1 &&
        c.effective_at == 0,
      "wrong contract role",
    );
    System.require(
      new Token(c.token!).decimals() == 8,
      "asset decimals mismatch",
    );
    this.configs.put(KEY, c);
  }
  nativeTransfer(from: Uint8Array, to: Uint8Array, n: u64): bool {
    const out = System.call(this.config().token!, 0x27f576ca,
      Protobuf.encode(new token.transfer_arguments(from, to, n), token.transfer_arguments.encode));
    if (out.code != 0 && out.res.error !== null && out.res.error!.message !== null) {
      System.log(out.res.error!.message!);
    }
    return out.code == 0;
  }
  nativeBalance(): u64 {
    const out = System.call(
      this.config().token!,
      0x5c721497,
      Protobuf.encode(new token.balance_of_arguments(this.id), token.balance_of_arguments.encode),
    );
    System.require(out.code == 0, "failed to retrieve token balance");
    // Native zero balances have an empty protobuf result. sdk-as Token's
    // balanceOf assumes a non-null buffer and traps on that valid response.
    return out.res.object === null ? 0 : Protobuf.decode<token.balance_of_result>(out.res.object!, token.balance_of_result.decode).value;
  }
  liability(n: u64, increase: bool): void {
    const t = this.totals.get(KEY)!;
    t.value = increase ? add(t.value, n) : sub(t.value, n);
    this.totals.put(KEY, t);
  }
  invariant(): u64 {
    const b = this.nativeBalance();
    System.require(b >= this.totals.get(KEY)!.value, "custody underfunded");
    return b;
  }
  running(): void {
    System.require(this.totals.get(PAUSE)!.value == 0, "new activity paused");
  }
  transfer(to: Uint8Array, n: u64): void {
    if (n == 0) return;
    System.require(!equal(to, this.id), "self transfer");
    const before = this.nativeBalance();
    System.require(
      before >= n && this.nativeTransfer(this.id, to, n),
      "KOIN transfer failed",
    );
    System.require(
      this.nativeBalance() == before - n,
      "KOIN transfer mismatch",
    );
  }
  deposit(from: Uint8Array, n: u64): void {
    auth(from);
    System.require(n > 0 && !equal(from, this.id), "invalid funding");
    const before = this.nativeBalance();
    System.require(this.nativeTransfer(from, this.id, n), "KOIN deposit failed");
    System.require(
      this.nativeBalance() == add(before, n),
      "KOIN deposit mismatch",
    );
  }
  schedule(c: K.Config): void {
    const old = this.config();
    auth(old.admin!);
    this.validate(c);
    System.require(
      equal(c.token, old.token) &&
        equal(c.chain_id, old.chain_id) &&
        equal(c.credits, old.credits) &&
        equal(c.treasury, old.treasury),
      "immutable custody domain",
    );
    System.require(
      c.version == add(old.version, 1) &&
        c.effective_at >= add(now(), 2 * DAY) &&
        c.effective_at % DAY == 0,
      "48-hour notice required",
    );
    this.configs.put(PENDING, c);
  }
  activate(): void {
    const c = this.configs.get(PENDING);
    System.require(
      c !== null && now() >= c!.effective_at,
      "policy not effective",
    );
    this.configs.put(KEY, c!);
    this.configs.remove(PENDING);
  }
  pause(value: bool): void {
    auth(this.config().admin!);
    this.totals.put(PAUSE, new K.Amount(value ? 1 : 0));
  }
}
