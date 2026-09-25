"use strict";
const { DEFAULTS, uint } = require("./policy");
// This release cannot enable payments through settings or a scheduler response.
// Activation requires a new reviewed deployment manifest and wallet flow.
function inactiveStatus(qualification = "unreported") {
  return {
    schema: 1,
    mode: "shadow",
    asset: "KOIN",
    paymentsEnabled: false,
    claimable: null,
    usageCredit: null,
    estimate: null,
    qualification,
    policy: DEFAULTS,
  };
}
function shadowStatus(input, now = Date.now()) {
  const out = inactiveStatus("unavailable");
  if (
    !input ||
    input.schema !== 1 ||
    input.mode !== "shadow" ||
    input.asset !== "KOIN" ||
    !Number.isSafeInteger(input.asOf) ||
    Math.abs(input.asOf - now) > 120000
  )
    return out;
  out.qualification = [
    "qualified-shadow",
    "awaiting-verification",
    "unreported",
  ].includes(input.qualification)
    ? input.qualification
    : "unavailable";
  if (input.estimate?.simulated === true) {
    try {
      out.estimate = {
        availability: uint(input.estimate.availability).toString(),
        work: uint(input.estimate.work).toString(),
        simulated: true,
      };
    } catch {
      /* reject malformed estimate */
    }
  }
  return out;
}
module.exports = { inactiveStatus, shadowStatus };
