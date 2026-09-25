"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { Signer, Transaction, utils } = require("koilib");
const { KoinChain, encodedAddress } = require("../lib/koin-network/chain");
const address = (n) => Signer.fromSeed("koin-chain-fixture-" + n).getAddress();
function fixture() {
  const d = {
    schema: 1,
    network: "mainnet",
    decimals: 8,
    rpc: ["https://example.invalid"],
    chainId: utils.encodeBase64url(
      Uint8Array.from([18, 32, ...new Array(32).fill(7)]),
    ),
  };
  for (const [i, k] of [
    "token",
    "credits",
    "rewards",
    "admin",
    "verifier",
    "mining",
    "operations",
  ].entries())
    d[k] = address(i);
  for (const k of ["token", "credits", "rewards"])
    d[k + "Hash"] = "0x1220" + "1".repeat(64);
  const config = {
    chain_id: d.chainId,
    token: encodedAddress(d.token),
    credits: encodedAddress(d.credits),
    treasury: encodedAddress(d.rewards),
    admin: encodedAddress(d.admin),
    verifier: encodedAddress(d.verifier),
    mining: encodedAddress(d.mining),
    operations: encodedAddress(d.operations),
    version: "1",
  };
  let client;
  const provider = {
    getChainId: async () => d.chainId,
    getNextNonce: async () => "KAE=",
    invokeGetContractAddress: async () => ({ value: { address: d.token } }),
    invokeGetContractMetadata: async () => ({ value: { hash: d.tokenHash } }),
    readContract: async () => ({
      result: utils.encodeBase64url(
        await client.serializer.serialize({ config }, "koin.Result"),
      ),
    }),
  };
  client = new KoinChain(d, provider);
  return { client, d, provider, config };
}
test("KOIN client rejects wrong chain, counterfeit token, replaced code and changed authorities", async () => {
  const { client, d, provider, config } = fixture();
  await client.verify();
  provider.getChainId = async () => "other";
  await assert.rejects(client.verify(), /chain mismatch/);
  provider.getChainId = async () => d.chainId;
  provider.invokeGetContractAddress = async () => ({
    value: { address: address(90) },
  });
  await assert.rejects(client.verify(), /canonical native/);
  provider.invokeGetContractAddress = async () => ({
    value: { address: d.token },
  });
  provider.invokeGetContractMetadata = async () => ({
    value: { hash: "0x1220" + "2".repeat(64) },
  });
  await assert.rejects(client.verify(), /bytecode/);
  provider.invokeGetContractMetadata = async () => ({
    value: { hash: d.tokenHash, authorizes_call_contract: true },
  });
  await assert.rejects(client.verify(), /authority override/);
  provider.invokeGetContractMetadata = async () => ({
    value: { hash: d.tokenHash },
  });
  config.mining = encodedAddress(address(90));
  await assert.rejects(client.verify(), /mining/);
});
test("KOIN transaction review binds exact account, amount, contract, payer, fees and commitment", async () => {
  const { client, d } = fixture();
  const actor = address(8),
    args = { account: encodedAddress(actor), amount: "100" };
  const tx = await client.prepare("credits", "purchase", args, {
    actor,
    rcLimit: "100",
  });
  const intent = {
    kind: "credits",
    method: "purchase",
    args,
    actor,
    maxRc: "100",
  };
  assert.equal(await client.verifyTransaction(tx, intent), true);
  const change = (f) => {
    const copy = structuredClone(tx);
    f(copy);
    return copy;
  };
  await assert.rejects(
    client.verifyTransaction(
      change((t) => {
        t.header.payer = d.mining;
        t.header.payee = actor;
      }),
      intent,
    ),
    /scope/,
  );
  await assert.rejects(
    client.verifyTransaction(
      change((t) => (t.header.rc_limit = "101")),
      intent,
    ),
    /scope/,
  );
  await assert.rejects(
    client.verifyTransaction(
      change((t) => (t.header.nonce = "KAI=")),
      intent,
    ),
    /commitment/,
  );
  await assert.rejects(
    client.verifyTransaction(
      change((t) => t.operations.push(t.operations[0])),
      intent,
    ),
    /scope/,
  );
  await assert.rejects(
    client.verifyTransaction(
      change((t) => (t.operations[0].call_contract.contract_id = d.rewards)),
      intent,
    ),
    /differs/,
  );
  const other = await Transaction.prepareTransaction(
    change((t) => {
      t.operations[0].call_contract.args = "";
    }),
  );
  await assert.rejects(client.verifyTransaction(other, intent), /differs/);
  await assert.rejects(
    client.operation("credits", "purchase", { ...args, amount: 100 }),
    /atom string/,
  );
  await assert.rejects(
    client.operation("credits", "purchase", { ...args, extra: "1" }),
    /Unknown/,
  );
});
