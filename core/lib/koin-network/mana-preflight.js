"use strict";
const { Signer, utils } = require("koilib");
const { fundingRequest } = require("./chain");

const MAX_UINT64 = (1n << 64n) - 1n;
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("Funding verification timed out")), 20000);
    })]);
  } finally { clearTimeout(timer); }
}
function amount(value, positive = false) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value) ||
      BigInt(value) > MAX_UINT64 || (positive && value === "0")) return null;
  return BigInt(value);
}
function failure(message, code = "funding_simulation_failed") {
  return Object.assign(new Error(message), { code });
}
function insufficient() {
  return failure("Insufficient Mana for the signed transaction limit and safety margin. No broadcast attempted.", "funding_insufficient_rc");
}
function simulationFailure(error) {
  // Inspect only to choose a fixed category. Never return node logs, signatures,
  // request bodies, credentials, or any other arbitrary transport error text.
  let message = "";
  try { if (typeof error?.message === "string") message = error.message.slice(0, 4096); } catch {}
  return /insufficient rc|insufficient mana|compute bandwidth limit|rc limit/i.test(message)
    ? insufficient() : failure("Funding simulation failed. No broadcast attempted.");
}

// This executes only the exact already-signed envelope as a non-broadcast
// simulation. It neither signs nor adjusts its limit or updates any journal.
async function simulateFunding(client, transaction, request) {
  let tx, intent;
  try {
    tx = structuredClone(transaction); intent = structuredClone(request);
    fundingRequest(intent.kind, intent.method, intent.args, intent.actor);
    if (tx?.header?.chain_id !== client.d.chainId || tx.header.payer !== intent.actor ||
        tx.header.payee !== undefined || !amount(tx.header.rc_limit, true) ||
        !amount(intent.maxRc, true) || amount(tx.header.rc_limit) > amount(intent.maxRc) ||
        !Array.isArray(tx.signatures) || tx.signatures.length !== 1)
      throw Error("Invalid funding simulation scope");
    const signature = tx.signatures[0];
    if (typeof signature !== "string" || Buffer.from(signature, "base64url").length !== 65 ||
        utils.encodeBase64url(Buffer.from(signature, "base64url")) !== signature)
      throw Error("Invalid funding simulation signature");
    await bounded(client.verifyTransaction(structuredClone(tx), structuredClone(intent)));
    if (!(await Signer.recoverAddresses(tx)).includes(intent.actor)) throw Error("Wrong funding signer");
    const config = await bounded(client.verify());
    if (config.paused) throw Error("Funding is paused");
  } catch {
    throw failure("Funding simulation verification failed. Check the network and saved transaction. No broadcast attempted.");
  }

  const limit = amount(tx.header.rc_limit, true);
  async function available() {
    let rc;
    try {
      if (await bounded(client.provider.getChainId()) !== client.d.chainId)
        throw Error("Chain changed");
      rc = amount(await bounded(client.provider.getAccountRc(tx.header.payer)));
      if (rc === null) throw Error("Malformed account Mana");
    } catch {
      throw failure("Funding Mana verification failed. No broadcast attempted.");
    }
    return rc;
  }
  if (await available() < limit) throw insufficient();

  let result;
  try {
    result = await bounded(client.provider.call("chain.submit_transaction", {
      transaction: structuredClone(tx), broadcast: false,
    }));
  } catch (error) { throw simulationFailure(error); }
  if (result?.error || result?.rpc_error) throw simulationFailure(result.error || result.rpc_error);
  const receipt = result?.receipt;
  const used = amount(receipt?.rc_used, true);
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
      receipt.id !== tx.id || (receipt.payer !== undefined && receipt.payer !== tx.header.payer) ||
      receipt.error || receipt.rpc_error || ![undefined, false].includes(receipt.reverted) ||
      used === null || used > limit)
    throw failure("Funding simulation returned an invalid or reverted receipt. No broadcast attempted.");
  const required = (used * 125n + 99n) / 100n + 10000n;
  if (required > limit) throw insufficient();
  // Koinos admits using the signed ceiling, not only the measured cost. Keep
  // that ceiling covered after simulation as well as the cost plus headroom.
  const refreshed = await available();
  if (refreshed < limit || refreshed < required) throw insufficient();
  return { txId: tx.id, rcUsed: receipt.rc_used, requiredRc: String(required),
    rcLimit: tx.header.rc_limit, checkedAt: Date.now() };
}

module.exports = { simulateFunding };
