import { Storage, System, Protobuf, StringBytes, Crypto } from "@koinos/sdk-as";
import { Prepaid } from "./Prepaid";
import { koin as K } from "./proto/koin";
import { KEY, DAY, addr, digest, equal, add, sub, ratio, now, auth, key, periodAccount, join } from "./Common";
import * as E from "./entries";

// A fresh deployment. Never reinterpret old KOIN-denominated balances as USD.
// Purchase revenue belongs to the Master Node immediately. Service credits are
// nonrefundable USD entitlements; reward funding is independent of consumption.
export class PrepaidUsd extends Prepaid {
  sponsored: Storage.Map<Uint8Array, K.Amount> = new Storage.Map(this.id, 25, K.Amount.decode, K.Amount.encode);
  sponsorSpent: Storage.Map<Uint8Array, K.Amount> = new Storage.Map(this.id, 26, K.Amount.decode, K.Amount.encode, () => new K.Amount());
  // Unified service usage: charge.amount is delivered USD usage; paid is the
  // purchased portion. The remainder is an explicitly recorded service grant,
  // never a purchase, a customer balance, or a KOIN transfer.
  settleCreditUsage(owner: Uint8Array | null, identity: Uint8Array, paid: u64, c: K.Charge): void {
    const cfg = this.config(); auth(cfg.verifier!);
    System.require(cfg.reward_basis == 1, "USD usage policy required");
    digest(identity); digest(c.id); digest(c.receipt_hash); digest(c.policy_hash); addr(c.provider);
    System.require(c.amount > 0 && paid <= c.amount && this.charges.get(c.id!) === null, "duplicate or invalid usage");
    if (owner !== null && owner!.length > 0) {
      addr(owner); System.require(!equal(owner, c.provider), "self-served work is ineligible");
    } else System.require(paid == 0, "purchased usage requires a wallet");
    const epoch = now() / DAY;
    System.require(this.sealed.get(key(epoch))!.value == 0, "charge period sealed");
    const free = c.amount - paid, sponsorTotal = this.sponsorSpent.get(key(epoch))!, accountKey = periodAccount(epoch, identity), accountTotal = this.sponsorSpent.get(accountKey)!;
    if (free > 0) System.require(add(sponsorTotal.value, free) <= cfg.sponsor_daily_limit &&
      add(accountTotal.value, free) <= cfg.sponsor_account_daily_limit, "sponsor ceiling exceeded");
    if (paid > 0) {
      const a = this.accounts.get(owner!)!;
      System.require(paid <= sub(a.purchased, a.consumed), "usage exceeds purchased credits");
      a.consumed = add(a.consumed, paid); this.accounts.put(owner!, a);
    }
    this.charges.put(c.id!, new K.Amount(c.amount)); this.sponsored.put(c.id!, new K.Amount(c.amount - paid));
    if (free > 0) {
      sponsorTotal.value = add(sponsorTotal.value, free); accountTotal.value = add(accountTotal.value, free);
      this.sponsorSpent.put(key(epoch), sponsorTotal); this.sponsorSpent.put(accountKey, accountTotal);
    }
    const pk = periodAccount(epoch, c.provider!), p = this.paid.get(pk)!, total = this.paid.get(key(epoch))!;
    p.value = add(p.value, c.amount); total.value = add(total.value, c.amount);
    this.paid.put(pk, p); this.paid.put(key(epoch), total);
  }
  purchases: Storage.Map<Uint8Array, K.PurchaseQuote> = new Storage.Map(this.id, 24,
    K.PurchaseQuote.decode, K.PurchaseQuote.encode);
  quoteDigest(q: K.PurchaseQuote): Uint8Array {
    const cfg = this.config();
    let b = join(StringBytes.stringToBytes("KAI-USD-PURCHASE-V1"), new Uint8Array(1));
    b = join(b, cfg.chain_id!); b = join(b, this.id); b = join(b, cfg.master_node!);
    return System.hash(Crypto.multicodec.sha2_256, join(b, Protobuf.encode(q, K.PurchaseQuote.encode)))!;
  }
  buy(q: K.PurchaseQuote, signature: Uint8Array): void {
    this.running(); const cfg = this.config(), time = now(), buyer = addr(q.account);
    System.require(cfg.reward_basis == 1, "USD purchase policy required");
    auth(buyer); digest(q.id);
    System.require(q.amount > 0 && q.usd_per_koin > 0 && q.credits > 0 &&
      q.credits == ratio(q.amount, q.usd_per_koin, 100000000), "invalid USD conversion");
    System.require(q.policy_version == cfg.version && q.issued_at <= add(time, 30000) &&
      q.expires_at > q.issued_at && q.expires_at <= add(q.issued_at, 300000) && time <= q.expires_at,
      "purchase quote expired or changed");
    System.require(signature.length == 65, "price signature required");
    const publicKey = System.recoverPublicKey(signature, this.quoteDigest(q));
    System.require(publicKey !== null && equal(Crypto.addressFromPublicKey(publicKey!), cfg.verifier), "invalid price signer");
    System.require(this.purchases.get(q.id!) === null, "purchase already credited");
    System.require(!equal(buyer, cfg.master_node) && !equal(buyer, this.id), "invalid purchase account");
    const a = this.accounts.get(buyer)!;
    a.purchased = add(a.purchased, q.credits);
    const before = this.nativeBalanceOf(cfg.master_node!);
    System.require(this.nativeTransfer(buyer, cfg.master_node!, q.amount), "KOIN purchase failed");
    System.require(this.nativeBalanceOf(cfg.master_node!) == add(before, q.amount), "Master Node payment mismatch");
    this.accounts.put(buyer, a); this.purchases.put(q.id!, q);
    System.event("kai.prepaid_usd_purchase", Protobuf.encode(q, K.PurchaseQuote.encode), [buyer, cfg.master_node!]);
  }
  // USD usage is recorded for accounting and relative work scoring only.
  // It never moves customer KOIN or funds the rewards contract.
  settle(owner: Uint8Array, c: K.Charge): void {
    const cfg = this.config(); auth(cfg.verifier!);
    digest(c.id); digest(c.receipt_hash); digest(c.policy_hash); addr(c.provider);
    System.require(!equal(owner, c.provider), "self-served work is ineligible");
    System.require(this.charges.get(c.id!) === null && c.amount > 0, "duplicate or empty usage");
    const a = this.accounts.get(owner)!;
    System.require(c.amount <= sub(a.purchased, a.consumed), "usage exceeds purchased credits");
    const epoch = now() / DAY;
    System.require(this.sealed.get(key(epoch))!.value == 0, "charge period sealed");
    a.consumed = add(a.consumed, c.amount); this.accounts.put(owner, a);
    this.charges.put(c.id!, new K.Amount(c.amount));
    const pk = periodAccount(epoch, c.provider!), p = this.paid.get(pk)!, total = this.paid.get(key(epoch))!;
    p.value = add(p.value, c.amount); total.value = add(total.value, c.amount);
    this.paid.put(pk, p); this.paid.put(key(epoch), total);
  }
  run(method: u32, r: K.Request): K.Result {
    if (method == E.settle_credit_usage) {
      System.require(r.charge !== null, "usage required");
      this.settleCreditUsage(r.account, digest(r.id), r.amount, r.charge!);
      System.event("kai.prepaid_usd_usage", Protobuf.encode(r, K.Request.encode), [r.charge!.provider!]);
      const result = new K.Result(); result.amount = r.charge!.amount; return result;
    }
    if (method == E.get_sponsored_charge) {
      this.config(); const result = new K.Result(), value = this.sponsored.get(digest(r.id)); result.amount = value === null ? 0 : value!.value; return result;
    }
    if (method == E.initialize) {
      System.require(r.config !== null && r.config!.reward_basis == 1, "USD reward policy required");
    }
    if (method == E.purchase) {
      System.require(r.purchase_quote !== null && r.price_signature !== null &&
        equal(r.account, r.purchase_quote!.account) && r.amount == r.purchase_quote!.amount, "exact purchase quote required");
      this.buy(r.purchase_quote!, r.price_signature!);
      return super.run(E.balances, r);
    }
    if (method == E.get_purchase) {
      this.config(); const out = new K.Result(); out.purchase = this.purchases.get(digest(r.id)); return out;
    }
    const out = super.run(method, r);
    if (method == E.config) out.product_version = 2;
    return out;
  }
}
