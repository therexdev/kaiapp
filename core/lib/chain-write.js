"use strict";

const { Contract, Transaction } = require("koilib");
const { ChainRead, rpcError } = require("./chain-read");
const POB_ABI = require("./abi/pob-abi.json");
const TOKEN_ABI = require("./abi/token-abi.json");

/*
 * The signing half of the Koinos node tools — stage 2.
 *
 * SCOPE, and the reason for it: this file can burn KOIN into VHP and register
 * a block-production key. Neither moves value to anybody else. Burning
 * converts your KOIN into your own VHP at your own address; registering a key
 * moves nothing at all. That is precisely why they ship before sending, and
 * why reburn can run unattended: the owner's rule is that the password
 * authorises value LEAVING the wallet, and nothing here does that.
 *
 * There is still no transfer() in this codebase. Sending is stage 3.
 *
 * Every method takes an explicit signer and NEVER reaches for
 * core/lib/wallet.js's unlocked singleton. Callers must pass one derived from
 * the password via wallet.signerFor(password) — a fresh object nothing else
 * holds, because koilib's Contract assigns signer.provider and the singleton
 * is what the earn worker signs receipts with.
 *
 * Mana, ported from koinos-node's chain.js: a KCS-4 KOIN burn requires
 * mana >= amount, and one sized at exactly the limit reverts on chain with an
 * opaque "could not burn KOIN". The cushion is not belt-and-braces; it is the
 * difference between a clear refusal here and a confusing failure there.
 */

const RC_LIMIT_CAP = 1000000000n; // never request more than 10 KOIN of mana
const MIN_MANA = 5000000n;        // below 0.05 KOIN of mana, nothing will confirm
const MANA_CUSHION = 100000000n;  // 1 KOIN of headroom for the tx's own cost

const cmp = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

class ChainWrite {
  constructor(settings, read = null) {
    this.settings = settings;
    this.read = read || new ChainRead(settings);
  }

  /** How much can actually be burned right now, given mana and its cushion. */
  burnableFromMana(manaSat) {
    const mana = BigInt(String(manaSat || "0"));
    const spare = mana - MANA_CUSHION;
    return spare > 0n ? spare.toString() : "0";
  }

  _assertMana(amountSat, manaSat) {
    const burnable = this.burnableFromMana(manaSat);
    if (cmp(amountSat, burnable) > 0) {
      const fmt = (s) => (Number(BigInt(s)) / 1e8).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
      throw new Error(
        `Not enough mana to burn ${fmt(amountSat)} KOIN — about ${fmt(burnable)} KOIN is available right now. ` +
          "Burning spends mana, which refills over about five days. Burn a smaller amount, or wait."
      );
    }
  }

  async _rcLimit(provider, address) {
    let rc = 0n;
    try {
      rc = BigInt((await provider.getAccountRc(address)) || "0");
    } catch {
      /* unreachable RC is treated as zero and refused below */
    }
    if (rc < MIN_MANA) {
      throw new Error("Not enough mana to send a transaction. Keep a little KOIN in the wallet and let mana recharge.");
    }
    return (rc < RC_LIMIT_CAP ? rc : RC_LIMIT_CAP).toString();
  }

  async _contract(kind, provider, signer) {
    const addrs = await this.read.resolveContracts(provider);
    return new Contract({ id: addrs[kind], abi: kind === "pob" ? POB_ABI : TOKEN_ABI, provider, signer });
  }

  /** KCS-4 tokens are pulled by the spender through an allowance, so a burn
   *  needs an approve in the same transaction. Older deployments have no
   *  allowance method at all — probe once and remember. */
  async _needsApprove(provider, signer) {
    if (this._allowance !== undefined) return this._allowance;
    try {
      const koin = await this._contract("koin", provider, signer);
      const addrs = await this.read.resolveContracts(provider);
      await koin.functions.allowance({ owner: addrs.pob, spender: addrs.pob });
      this._allowance = true;
    } catch {
      this._allowance = false;
    }
    return this._allowance;
  }

  /**
   * Burn KOIN into VHP at the SAME address.
   *
   * burn_address and vhp_address are both the signer's own — deliberately not
   * parameterised. The moment VHP could be minted to someone else this would
   * be a transfer wearing a different name, and would need the send rules.
   *
   * dryRun builds and signs the transaction but never broadcasts it, which is
   * how the call shapes and the mana maths are tested without spending.
   */
  async burn(signer, amountSat, { dryRun = false } = {}) {
    const address = signer.getAddress();
    if (cmp(amountSat, "0") <= 0) throw new Error("Enter an amount greater than zero");
    const { sats } = await this.read.balances(address);
    if (cmp(amountSat, sats.koin) > 0) throw new Error("That is more KOIN than this wallet holds");
    this._assertMana(amountSat, sats.mana);

    const provider = this.read.provider();
    const rcLimit = await this._rcLimit(provider, address);
    const addrs = await this.read.resolveContracts(provider);
    const needsApprove = await this._needsApprove(provider, signer);
    try {
      const koin = await this._contract("koin", provider, signer);
      const pob = await this._contract("pob", provider, signer);
      const tx = new Transaction({ signer, provider, options: { rcLimit } });
      if (needsApprove) {
        await tx.pushOperation(koin.functions.approve, { owner: address, spender: addrs.pob, value: String(amountSat) });
      }
      await tx.pushOperation(pob.functions.burn, {
        token_amount: String(amountSat),
        burn_address: address,
        vhp_address: address,
      });
      if (dryRun) {
        await tx.prepare();
        return { dryRun: true, operations: tx.transaction.operations.length, rcLimit, address, amountSat: String(amountSat) };
      }
      await tx.send();
      return { txId: tx.id, address, amountSat: String(amountSat), rcLimit };
    } catch (e) {
      throw rpcError(e);
    }
  }

  /** Register the block-signing key a running node writes to public.key.
   *  Moves no value; it only says "this key produces for this address". */
  async registerProducerKey(signer, publicKeyB64url, { dryRun = false } = {}) {
    const address = signer.getAddress();
    const key = String(publicKeyB64url || "").trim();
    if (!key) throw new Error("Paste the public key your node created");
    if (!/^[A-Za-z0-9_-]{20,}={0,2}$/.test(key)) throw new Error("That does not look like a node public key");
    const provider = this.read.provider();
    const rcLimit = await this._rcLimit(provider, address);
    try {
      const pob = await this._contract("pob", provider, signer);
      const tx = new Transaction({ signer, provider, options: { rcLimit } });
      await tx.pushOperation(pob.functions.register_public_key, { producer: address, public_key: key });
      if (dryRun) {
        await tx.prepare();
        return { dryRun: true, operations: tx.transaction.operations.length, rcLimit, address };
      }
      await tx.send();
      return { txId: tx.id, address };
    } catch (e) {
      throw rpcError(e);
    }
  }
}

module.exports = { ChainWrite, MANA_CUSHION, MIN_MANA, RC_LIMIT_CAP };
