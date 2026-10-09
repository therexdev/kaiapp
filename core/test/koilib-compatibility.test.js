"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { Contract, Signer, utils } = require("koilib");
const token = "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK";
const owner = Signer.fromSeed("public-koilib-compatibility-owner").getAddress();
const recipient = Signer.fromSeed("public-koilib-compatibility-recipient").getAddress();

// Use the SDK's full ABI, including its FieldOptions extension. The smaller
// app ABIs alone did not catch Koilib 9.3 failing with patched Protobuf.
test("native token Contract resolves descriptors and reads exact balances", async () => {
  let calls = 0;
  const provider = { readContract: async operation => {
    calls++;
    assert.equal(operation.contract_id, token);
    assert.equal(operation.entry_point, 0x5c721497);
    assert.deepEqual(Buffer.from(utils.decodeBase64url(operation.args)), Buffer.concat([
      Buffer.from([0x0a, 25]), Buffer.from(utils.decodeBase58(owner)),
    ]));
    return { result: Buffer.from([0x08, 0x80, 0xc2, 0xd7, 0x2f]).toString("base64url") };
  } };
  const contract = new Contract({ id: token, abi: utils.tokenAbi, provider });
  const response = await contract.functions.balanceOf({ owner });
  assert.equal(response.result.value, "100000000");
  assert.equal(calls, 1);
});

test("native token transfer preserves address and amount wire bytes without signing", async () => {
  const contract = new Contract({ id: token, abi: utils.tokenAbi });
  const { operation } = await contract.functions.transfer({ from: owner, to: recipient, value: "100000000" }, { onlyOperation: true });
  assert.equal(operation.call_contract.contract_id, token);
  assert.equal(operation.call_contract.entry_point, 0x27f576ca);
  assert.deepEqual(Buffer.from(utils.decodeBase64url(operation.call_contract.args)), Buffer.concat([
    Buffer.from([0x0a, 25]), Buffer.from(utils.decodeBase58(owner)),
    Buffer.from([0x12, 25]), Buffer.from(utils.decodeBase58(recipient)),
    Buffer.from([0x18, 0x80, 0xc2, 0xd7, 0x2f]),
  ]));
});
