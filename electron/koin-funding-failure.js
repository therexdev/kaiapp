"use strict";

// Only fixed public categories leave the funding controller. RPC/native errors
// can contain request bodies, signatures and local paths; never display them.
const stages = Object.freeze({
  request: "checking the purchase request",
  journal: "checking saved payment records",
  prepare: "preparing the payment",
  transaction: "verifying the payment details",
  deployment: "verifying the credit contracts",
  price: "checking the quote",
  dialog: "opening the secure payment window",
  recheck: "rechecking the approved payment",
  reserve: "reserving the wallet transaction",
  sign: "signing the approved payment",
  submit: "submitting the saved payment",
});
const rpcCodes = Object.freeze({
  koin_rpc_unavailable: "rpc-unavailable", koin_rpc_rejected: "rpc-rejected",
  koin_rpc_chain_mismatch: "chain-mismatch", koin_rpc_insufficient_rc: "insufficient-mana",
  koin_rpc_stopped: "stopped",
});
const messages = Object.freeze({
  "rpc-unavailable": "The KOIN network did not respond. Wait a moment, then get a fresh quote.",
  "rpc-rejected": "The KOIN network rejected a required check. Share this message before trying another purchase.",
  "chain-mismatch": "The KOIN network identity did not match. Share this message before trying another purchase.",
  "insufficient-mana": "The KOIN network reported insufficient Mana. Check the wallet's available Mana before trying again.",
  "quote-expired": "The quote is outside its valid time window. Check the computer's date and time, then get a fresh quote.",
  "policy-changed": "The purchase policy changed or is paused. Share this message before trying another purchase.",
  "review-changed": "The reviewed payment changed or expired. Get a fresh quote and review it again.",
  "wallet-busy": "A saved transaction needs attention. Open Balance & activity before trying another purchase.",
  stopped: "The payment check was stopped.",
  unavailable: "Share this message and the app version before trying another purchase.",
});
function fundingFailure(stage, error) {
  let code = Object.hasOwn(rpcCodes, error?.code) ? rpcCodes[error.code] : "unavailable";
  // Match complete locally authored errors, never echo or partially match a
  // remote error string. Unknown errors retain their stage only.
  if (error?.message === "Purchase price expired. Please buy again for a fresh price.") code = "quote-expired";
  else if (["Purchase policy changed", "Funding is paused", "Funding policy changed or paused"].includes(error?.message)) code = "policy-changed";
  else if (error?.message === "Funding review changed or expired") code = "review-changed";
  else if (error?.message === "Another deposit owns this wallet nonce; recover it first") code = "wallet-busy";
  return { stage: Object.hasOwn(stages, stage) ? stage : "request", code };
}
function purchaseFailureMessage(failure, recovery = false) {
  const stage = Object.hasOwn(stages, failure?.stage) ? failure.stage : "request";
  const code = Object.hasOwn(messages, failure?.code) ? failure.code : "unavailable";
  const next = recovery ? "Open Balance & activity to check the original payment before trying another purchase." : messages[code];
  return `Purchase stopped while ${stages[stage]}. ${next} Existing credits remain usable. Reference: ${stage}/${code}.`;
}
module.exports = { fundingFailure, purchaseFailureMessage };
