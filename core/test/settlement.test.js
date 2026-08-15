"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const { ChainClient, rootToAnchorAddress, TESTNET } = require("../../server/chain");
const { utils } = require("koilib");

test("rootToAnchorAddress: deterministic, checksum-valid, input-strict", () => {
  const root = crypto.createHash("sha256").update("epoch-1").digest("hex");
  const a1 = rootToAnchorAddress(root);
  assert.equal(rootToAnchorAddress(root), a1, "deterministic");
  assert.notEqual(rootToAnchorAddress(root.replace(/^./, root[0] === "a" ? "b" : "a")), a1);

  // base58check roundtrip: decode, verify the 4-byte double-sha checksum.
  const raw = Buffer.from(utils.decodeBase58(a1));
  assert.equal(raw.length, 25);
  const check = crypto
    .createHash("sha256")
    .update(crypto.createHash("sha256").update(raw.subarray(0, 21)).digest())
    .digest()
    .subarray(0, 4);
  assert.ok(check.equals(raw.subarray(21)), "checksum valid");
  assert.equal(raw[0], 0x00, "mainnet-style version byte");

  assert.throws(() => rootToAnchorAddress("nope"), /32 bytes of hex/);
});

test("live testnet: chain id matches and head advances (skips offline)", async (t) => {
  const chain = new ChainClient({});
  let head;
  try {
    head = await chain.headInfo();
  } catch {
    t.skip("testnet unreachable from this environment");
    return;
  }
  assert.ok(Number(head.head_topology.height) > 0, "has height");
  await chain.assertChain(); // throws on chain-id mismatch
  const faucetBalance = await chain.balanceOf(TESTNET.faucetAccount);
  assert.equal(typeof faucetBalance, "bigint");
});

test("wrong chain id fails closed", async (t) => {
  const chain = new ChainClient({ chainId: "EiDifferentChainIdAAAAAAAAAAAAAAAAAAAAAAAAA=" });
  try {
    await chain.provider.getChainId();
  } catch {
    t.skip("testnet unreachable from this environment");
    return;
  }
  await assert.rejects(() => chain.assertChain(), /chain id mismatch/);
});

// Real on-chain anchoring — runs only with a faucet-funded operator key.
test("anchor an epoch root on testnet (needs KAI_OPERATOR_WIF)", { skip: !process.env.KAI_OPERATOR_WIF }, async () => {
  const chain = new ChainClient({ wif: process.env.KAI_OPERATOR_WIF });
  const root = crypto.createHash("sha256").update(`kai-alpha-${process.env.KAI_ANCHOR_NONCE || "1"}`).digest("hex");
  const record = await chain.anchorRoot(999, root);
  assert.ok(record.txId, "transaction submitted");
  const check = await chain.verifyAnchor(root);
  assert.equal(check.anchorAddress, record.anchorAddress);
  console.log(`anchored: tx ${record.txId} -> ${record.anchorAddress}`);
});
