"use strict";
const { utils } = require("koilib");
const { uint } = require("./policy");

// This selects a ceiling for the existing native payment review. It never
// reserves a nonce, signs, simulates, submits, or changes the daily policy.
// The chain admits against the signed ceiling; actual irreversible receipt
// costs release its unused headroom through the wallet nonce coordinator.
const MAX_PURCHASE_RC = 900000000n;
function limits({ owner, maxRcPerTransaction, maxRcPerDay }) {
  if (!utils.isChecksumAddress(owner)) throw Error("Valid payment wallet required");
  const minimum = uint(maxRcPerTransaction), daily = uint(maxRcPerDay);
  if (!minimum || !daily || minimum > daily || minimum > MAX_PURCHASE_RC)
    throw Error("Invalid purchase Mana limits");
  return { minimum, daily };
}
async function purchaseMana(options) {
  const { client, nonces, owner, maxRcPerDay, signal } = options;
  const { minimum } = limits(options);
  signal?.throwIfAborted();
  const remaining = uint(nonces.availableSubmissionRc(owner, maxRcPerDay));
  if (remaining < minimum) throw Error("Today's payment Mana allowance is exhausted. No new payment was signed.");
  const value = await client.provider.getAccountRc(owner);
  signal?.throwIfAborted();
  if (typeof value !== "string") throw Error("Available payment Mana could not be verified");
  const available = uint(value);
  if (available < minimum) throw Error("Your wallet needs more available Mana to buy credits. No new payment was signed.");
  // The daily remainder can change while the network read is in flight.
  const current = uint(nonces.availableSubmissionRc(owner, maxRcPerDay));
  const ceiling = [remaining, current, available, MAX_PURCHASE_RC].reduce((a, b) => a < b ? a : b);
  if (ceiling < minimum) throw Error("Today's payment Mana allowance is exhausted. No new payment was signed.");
  return String(ceiling);
}
async function assertPurchaseMana(options, reviewedRc) {
  const { minimum } = limits(options), approved = uint(reviewedRc);
  if (approved < minimum || approved > MAX_PURCHASE_RC) throw Error("Invalid reviewed purchase Mana limit");
  if (approved > uint(await purchaseMana(options)))
    throw Error("The reviewed payment Mana is no longer available. No new payment was signed.");
  return reviewedRc;
}
module.exports = { purchaseMana, assertPurchaseMana };
