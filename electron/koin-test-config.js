"use strict";
const { KoinChain } = require("../core/lib/koin-network/chain");
const { assertPaymentMode } = require("../core/lib/koin-network/payment-mode");
const P = require("../core/lib/koin-network/job-protocol"), D = require("../core/lib/koin-network/session-delegation");
const { scheduler } = require("../core/lib/koin-network/grant-chat");
const { utils } = require("koilib");
function configuration(value) {
  if (!value || Object.keys(value).sort().join() !== "deployment,limits,maxOutput,maxRcPerDay,maxRcPerTransaction,mode,model,owner,policyHash,schedulerUrl,schema,version" ||
      value.schema !== 1 || !["test-deployment", "mainnet-pilot"].includes(value.mode)) throw Error("Exact public Test deployment manifest required");
  const c = structuredClone(value), client = new KoinChain(c.deployment);
  assertPaymentMode(c.mode, client); c.deployment = structuredClone(client.d);
  c.schedulerUrl = scheduler(c.schedulerUrl);
  if (!utils.isChecksumAddress(c.owner)) throw Error("Pin the Test wallet address");
  P.digest(c.policyHash); P.integer(c.version, 1); P.integer(c.maxOutput, 1, 2000000);
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(c.model)) throw Error("Pin the Test model");
  D.amount(c.maxRcPerTransaction); D.amount(c.maxRcPerDay);
  if (BigInt(c.maxRcPerTransaction) > BigInt(c.maxRcPerDay)) throw Error("Transaction resource limit exceeds daily limit");
  if (!c.limits || Object.keys(c.limits).sort().join() !== "amount,durationMs,maxJobs,perJob") throw Error("Explicit Test spending limits required");
  D.amount(c.limits.amount); D.amount(c.limits.perJob); P.integer(c.limits.maxJobs, 1, 10000); P.integer(c.limits.durationMs, 60000, 86400000);
  if (BigInt(c.limits.perJob) > BigInt(c.limits.amount)) throw Error("Request limit exceeds session limit");
  return c;
}
function atoms(text) {
  if (typeof text !== "string" || !/^(0|[1-9]\d{0,11})(\.\d{1,8})?$/.test(text)) throw Error("Enter a positive KOIN amount with at most eight decimal places");
  const [whole, part = ""] = text.split("."), n = (BigInt(whole) * 100000000n + BigInt(part.padEnd(8, "0"))).toString();
  return D.amount(n);
}
module.exports = { configuration, atoms };
