"use strict";

const crypto = require("crypto");
const { Provider, Contract, Signer, utils } = require("koilib");

/*
 * Koinos chain client for M2 settlement (§20), against the Foundation
 * testnet (koinos/koinos-testnet). Alpha anchoring is contract-free ("v0"):
 * the epoch's Merkle root is committed by transferring 1 satoshi of vKOIN to
 * an address DERIVED FROM THE ROOT (base58check of ripemd160(sha256(root))).
 * Anyone can recompute root -> address and find the transfer on-chain, so
 * the commitment is publicly verifiable with zero deployed contracts. The
 * real KAI token + claim contract replaces this in the next increment; the
 * anchor interface stays the same.
 */

const TESTNET = {
  rpc: "https://testnet.koinosfoundation.org/jsonrpc",
  chainId: "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==",
  koinContract: "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju",
  faucetAccount: "1AvfaswZsCJ4FTaWDengYRj2y3aTnJ4oNo",
  faucet: "https://t.me/KoinosTestnetFaucetBot",
};

/** Deterministic address commitment for a hex Merkle root. */
function rootToAnchorAddress(rootHex) {
  if (!/^[0-9a-f]{64}$/i.test(String(rootHex))) throw new Error("root must be 32 bytes of hex");
  const sha = crypto.createHash("sha256").update(Buffer.from(rootHex, "hex")).digest();
  const h160 = crypto.createHash("ripemd160").update(sha).digest();
  const payload = Buffer.concat([Buffer.from([0x00]), h160]);
  const check = crypto
    .createHash("sha256")
    .update(crypto.createHash("sha256").update(payload).digest())
    .digest()
    .subarray(0, 4);
  return utils.encodeBase58(Buffer.concat([payload, check]));
}

class ChainClient {
  constructor({ rpc, chainId, koinContract, wif, onEvent } = {}) {
    this.rpc = rpc || process.env.KAI_RPC_URL || TESTNET.rpc;
    this.expectedChainId = chainId || TESTNET.chainId;
    this.onEvent = onEvent || (() => {});
    this.provider = new Provider([this.rpc]);
    this.signer = wif ? Signer.fromWif(wif) : null;
    if (this.signer) this.signer.provider = this.provider;
    this.koin = new Contract({
      id: koinContract || TESTNET.koinContract,
      abi: utils.tokenAbi,
      provider: this.provider,
      signer: this.signer ?? undefined,
    });
  }

  get address() {
    return this.signer ? this.signer.getAddress() : null;
  }

  async headInfo() {
    return this.provider.getHeadInfo();
  }

  /** Fails loudly if the RPC is a different chain than configured (§20 safety). */
  async assertChain() {
    const id = await this.provider.getChainId();
    if (id !== this.expectedChainId) {
      throw new Error(`RPC chain id mismatch: got ${id}, expected ${this.expectedChainId}`);
    }
    return id;
  }

  async balanceOf(address) {
    const { result } = await this.koin.functions.balanceOf({ owner: address });
    return BigInt(result?.value ?? 0);
  }

  /**
   * Anchor an epoch root on-chain (v0 address-commitment). Needs a funded
   * operator key — the Telegram faucet dispenses vKOIN (see TESTNET.faucet).
   */
  async anchorRoot(epoch, rootHex) {
    if (!this.signer) throw new Error("Anchoring needs an operator key (KAI_OPERATOR_WIF)");
    await this.assertChain();
    const anchorAddress = rootToAnchorAddress(rootHex);
    const { transaction } = await this.koin.functions.transfer(
      { from: this.signer.getAddress(), to: anchorAddress, value: "1" },
      { rcLimit: "100000000" }
    );
    await transaction.wait("byBlock", 60000).catch(() => {
      /* mined-wait is best effort; the id is valid once accepted */
    });
    const record = { epoch, root: rootHex, anchorAddress, txId: transaction.id, rpc: this.rpc };
    this.onEvent({ type: "settlement:anchored", ...record });
    return record;
  }

  /** Verify an anchor independently: recompute the address, check it holds the dust. */
  async verifyAnchor(rootHex) {
    const anchorAddress = rootToAnchorAddress(rootHex);
    const balance = await this.balanceOf(anchorAddress);
    return { anchorAddress, anchored: balance > 0n, balance: balance.toString() };
  }
}

module.exports = { ChainClient, rootToAnchorAddress, TESTNET };
