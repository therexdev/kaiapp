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

test("merkleProof verifies exactly the way the contract does", () => {
  const { merkleRoot, merkleProof } = require("../../server/scheduler");
  const leaves = ["a", "b", "c", "d", "e"].map((s) => crypto.createHash("sha256").update(s).digest());
  const root = merkleRoot(leaves);
  for (let index = 0; index < leaves.length; index++) {
    // Contract's verify: idx even -> H(h||sib), odd -> H(sib||h), idx >>= 1.
    let h = leaves[index];
    let idx = index;
    for (const sib of merkleProof(leaves, index)) {
      h = idx % 2 === 0
        ? crypto.createHash("sha256").update(Buffer.concat([h, sib])).digest()
        : crypto.createHash("sha256").update(Buffer.concat([sib, h])).digest();
      idx = Math.floor(idx / 2);
    }
    assert.ok(h.equals(root), `leaf ${index} proof verifies`);
  }
});

test("sponsored deposit co-sign gate refuses everything but a real deposit (skips offline)", async (t) => {
  const { makeSettlement } = require("../../server/chain");
  const s = makeSettlement({
    // Operator authority isn't needed for rejection paths, any key works —
    // the gate must throw BEFORE any signing or sending happens.
    wif: "5KJvsngHeMpm884wtkJNzQGaCErckhHJBGFsvd3VyK5qMZXj3hS",
    contractId: "149YvYQfj4MNaFecd7Rm3Z2rK6y2fkPYXz",
    abiPath: require("path").join(__dirname, "..", "..", "contracts", "kai", "abi", "kai-abi.json"),
  });
  try {
    await s.depositsOf("1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK"); // also proves the read path
  } catch {
    t.skip("testnet unreachable from this environment");
    return;
  }

  const USER = "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK";
  const goodOp = async () => {
    const tx = await s.prepareDeposit(USER, "100000000");
    assert.equal(tx.operations.length, 1, "prepare builds a single-op tx");
    return tx;
  };

  // Two operations smuggled in.
  let tx = await goodOp();
  tx.operations.push(tx.operations[0]);
  await assert.rejects(() => s.submitDeposit(tx, USER), /exactly one operation/);

  // Deposit claimed for a different account than the requester.
  tx = await goodOp();
  await assert.rejects(() => s.submitDeposit(tx, "1DifferentAddrxxxxxxxxxxxxxxxxxxxx"), /does not match/);

  // Amount over the sponsorship cap.
  tx = await s.prepareDeposit(USER, (2000n * 100000000n).toString());
  await assert.rejects(() => s.submitDeposit(tx, USER), /out of range/);

  // Wrong target contract.
  tx = await goodOp();
  tx.operations[0].call_contract.contract_id = "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju";
  await assert.rejects(() => s.submitDeposit(tx, USER), /not a KAI contract call|not a deposit/);
});
