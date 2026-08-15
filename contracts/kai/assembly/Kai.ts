import { System, Storage, StringBytes, authority, Base58, Crypto } from "@koinos/sdk-as";
import { kai } from "./proto/kai";

// KAI settlement contract — M2 alpha (spec §20/§25 subset).
// Token (KAI test token, 8 decimals) + epoch Merkle roots + proof claims.
// The operator (the account the contract is uploaded to) submits each
// epoch's receipt root; providers (or anyone on their behalf) claim with a
// Merkle proof and are minted KAI per accepted receipt. Roots are immutable
// once set; claims are once per (epoch, worker).

const NAME = "Koinos AI Token";
const SYMBOL = "KAI";
const DECIMALS: u32 = 8;
const REWARD_PER_RECEIPT: u64 = 100000000; // 1 KAI per accepted receipt (alpha rate)

const BALANCES_SPACE: u32 = 0;
const ROOTS_SPACE: u32 = 1;
const CLAIMED_SPACE: u32 = 2;
const SUPPLY_SPACE: u32 = 3;
const DEPOSITS_SPACE: u32 = 4;
const SUPPLY_KEY: Uint8Array = StringBytes.stringToBytes("supply");

function sha256(data: Uint8Array): Uint8Array {
  const h = System.hash(Crypto.multicodec.sha2_256, data)!;
  // System.hash returns a multihash (0x12 0x20 prefix) — strip to raw digest.
  return h.length == 34 ? h.subarray(2) : h;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): bool {
  if (a.length != b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false;
  return true;
}

export class Kai {
  contractId: Uint8Array = System.getContractId();

  balances: Storage.Map<Uint8Array, kai.balance_of_result> = new Storage.Map(
    this.contractId,
    BALANCES_SPACE,
    kai.balance_of_result.decode,
    kai.balance_of_result.encode,
    () => new kai.balance_of_result(0)
  );

  roots: Storage.Map<Uint8Array, kai.get_root_result> = new Storage.Map(
    this.contractId,
    ROOTS_SPACE,
    kai.get_root_result.decode,
    kai.get_root_result.encode,
    () => new kai.get_root_result(new Uint8Array(0))
  );

  claims: Storage.Map<Uint8Array, kai.claimed_result> = new Storage.Map(
    this.contractId,
    CLAIMED_SPACE,
    kai.claimed_result.decode,
    kai.claimed_result.encode,
    () => new kai.claimed_result(false)
  );

  supply: Storage.Map<Uint8Array, kai.total_supply_result> = new Storage.Map(
    this.contractId,
    SUPPLY_SPACE,
    kai.total_supply_result.decode,
    kai.total_supply_result.encode,
    () => new kai.total_supply_result(0)
  );

  deposits: Storage.Map<Uint8Array, kai.deposits_of_result> = new Storage.Map(
    this.contractId,
    DEPOSITS_SPACE,
    kai.deposits_of_result.decode,
    kai.deposits_of_result.encode,
    () => new kai.deposits_of_result(0)
  );

  name(args: kai.name_arguments): kai.name_result {
    return new kai.name_result(NAME);
  }

  symbol(args: kai.symbol_arguments): kai.symbol_result {
    return new kai.symbol_result(SYMBOL);
  }

  decimals(args: kai.decimals_arguments): kai.decimals_result {
    return new kai.decimals_result(DECIMALS);
  }

  total_supply(args: kai.total_supply_arguments): kai.total_supply_result {
    return this.supply.get(SUPPLY_KEY)!;
  }

  balance_of(args: kai.balance_of_arguments): kai.balance_of_result {
    return this.balances.get(args.owner!)!;
  }

  transfer(args: kai.transfer_arguments): kai.transfer_result {
    const from = args.from!;
    const to = args.to!;
    System.require(!bytesEqual(from, to), "cannot transfer to self");
    System.require(
      System.checkAuthority(authority.authorization_type.contract_call, from),
      "'from' has not authorized transfer"
    );
    const fromBal = this.balances.get(from)!;
    System.require(fromBal.value >= args.value, "insufficient balance");
    fromBal.value -= args.value;
    const toBal = this.balances.get(to)!;
    toBal.value += args.value;
    this.balances.put(from, fromBal);
    this.balances.put(to, toBal);
    return new kai.transfer_result();
  }

  private epochKey(epoch: u64): Uint8Array {
    return StringBytes.stringToBytes(epoch.toString());
  }

  submit_root(args: kai.submit_root_arguments): kai.submit_root_result {
    // Only the operator (the contract's own account authority) submits roots.
    System.require(
      System.checkAuthority(authority.authorization_type.contract_call, this.contractId),
      "operator authority required"
    );
    System.require(args.root != null && args.root!.length == 32, "root must be 32 bytes");
    const key = this.epochKey(args.epoch);
    const existing = this.roots.get(key)!;
    System.require(existing.value == null || existing.value!.length == 0, "epoch root already set");
    this.roots.put(key, new kai.get_root_result(args.root!));
    return new kai.submit_root_result();
  }

  get_root(args: kai.get_root_arguments): kai.get_root_result {
    return this.roots.get(this.epochKey(args.epoch))!;
  }

  claim(args: kai.claim_arguments): kai.claim_result {
    const worker = args.worker!;
    const stored = this.roots.get(this.epochKey(args.epoch))!;
    System.require(stored.value != null && stored.value!.length == 32, "unknown epoch");

    const claimKey = StringBytes.stringToBytes(args.epoch.toString() + "|" + worker);
    System.require(!this.claims.get(claimKey)!.value, "already claimed");

    // Leaf format must match the scheduler exactly: sha256("epoch|worker|count").
    let h = sha256(
      StringBytes.stringToBytes(args.epoch.toString() + "|" + worker + "|" + args.count.toString())
    );
    let idx = args.index;
    for (let i = 0; i < args.proof.length; i++) {
      const sib = args.proof[i];
      System.require(sib.length == 32, "bad proof element");
      h = idx % 2 == 0 ? sha256(concat(h, sib)) : sha256(concat(sib, h));
      idx = idx / 2;
    }
    System.require(bytesEqual(h, stored.value!), "invalid Merkle proof");

    this.claims.put(claimKey, new kai.claimed_result(true));

    const minted = args.count * REWARD_PER_RECEIPT;
    const to = Base58.decode(worker);
    const bal = this.balances.get(to)!;
    bal.value += minted;
    this.balances.put(to, bal);
    const s = this.supply.get(SUPPLY_KEY)!;
    s.value += minted;
    this.supply.put(SUPPLY_KEY, s);

    return new kai.claim_result(minted);
  }

  claimed(args: kai.claimed_arguments): kai.claimed_result {
    const key = StringBytes.stringToBytes(args.epoch.toString() + "|" + args.worker!);
    return this.claims.get(key)!;
  }

  // §23 phase A: funding network credits burns KAI from the depositor and
  // records it in a monotonic per-account accumulator. Off-chain schedulers
  // diff deposits_of to credit usage balances — the contract never gives any
  // operator authority over user balances (§44), only the owner can deposit.
  deposit(args: kai.deposit_arguments): kai.deposit_result {
    const from = args.from!;
    System.require(
      System.checkAuthority(authority.authorization_type.contract_call, from),
      "'from' has not authorized deposit"
    );
    System.require(args.value > 0, "deposit must be positive");
    const bal = this.balances.get(from)!;
    System.require(bal.value >= args.value, "insufficient balance");
    bal.value -= args.value;
    this.balances.put(from, bal);

    const s = this.supply.get(SUPPLY_KEY)!;
    s.value -= args.value; // burned: usage ultimately consumes KAI (§25 bounded burn)
    this.supply.put(SUPPLY_KEY, s);

    const d = this.deposits.get(from)!;
    d.value += args.value;
    this.deposits.put(from, d);
    return new kai.deposit_result();
  }

  deposits_of(args: kai.deposits_of_arguments): kai.deposits_of_result {
    return this.deposits.get(args.owner!)!;
  }
}
