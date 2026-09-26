"use strict";
const P = require("./job-protocol");

function scheduler(value) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash ||
      (u.protocol !== "https:" && !(u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)))) throw Error("HTTPS or loopback scheduler required");
  return u.href.replace(/\/$/, "");
}

async function consume({ schedulerUrl, authorization, messages, model, maxOutput, requestId, signal, fetchImpl = fetch }) {
  const base = scheduler(schedulerUrl), input = P.messages(messages), id = P.digest(requestId);
  if (!authorization?.sessionToken || !authorization.grantId || !authorization.owner) throw Error("An existing account and spending grant are required");
  const response = await fetchImpl(base + "/consume/chat/completions", {
    method: "POST", redirect: "error", headers: { "content-type": "application/json", connection: "close" }, signal,
    body: JSON.stringify({ billing: "koin-shadow", sessionToken: authorization.sessionToken, grantId: authorization.grantId,
      requestId: id, messages: input, model, ...(maxOutput === undefined ? {} : { max_tokens: maxOutput }), stream: false }),
  });
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1500000) throw Error("KOIN rehearsal response is too large");
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!response.ok) throw Error(typeof result.error?.message === "string" ? result.error.message : "KOIN rehearsal request failed");
  const billing = result.koin, receipt = billing?.receipt, output = result.choices?.[0]?.message?.content;
  if (result.id !== id || result.model !== "koinos-network" || result.costUsd !== 0 || billing?.mode !== "shadow" ||
      billing.paymentsEnabled !== false || !["verified", "prepared", "submitted", "settled"].includes(billing.state) || !receipt ||
      typeof output !== "string" || !output.length) throw Error("Invalid KOIN rehearsal response");
  const q = P.validateQuote(billing.quote);
  if (q.requestHash !== P.hash(JSON.stringify(input)) || (model !== "auto" && q.tariff.model !== model) ||
      (maxOutput !== undefined && q.maxOutput !== maxOutput) || result.servedModel !== q.tariff.model ||
      receipt.mode !== "shadow" || receipt.job !== id || receipt.owner !== authorization.owner ||
      receipt.domain !== q.domain || receipt.quoteHash !== q.hash || receipt.policyHash !== q.policyHash ||
      receipt.outputHash !== P.hash(output) || billing.receiptHash !== P.hash(JSON.stringify(receipt))) throw Error("KOIN rehearsal receipt does not match the request");
  P.signatureMatches(P.resultHash(q.domain, id, receipt.attempt, q.hash, output), receipt.signature, receipt.provider);
  const usage = receipt.usage;
  P.integer(usage?.inputTokens, q.inputTokens, q.inputTokens); P.integer(usage.outputTokens, 1, q.maxOutput);
  const charge = (BigInt(usage.inputTokens) * BigInt(q.tariff.inputAtomsPerMillion) +
    BigInt(usage.outputTokens) * BigInt(q.tariff.outputAtomsPerMillion) + 999999n) / 1000000n;
  if (String(charge) !== usage.amount || charge > BigInt(q.maxCharge) || result.usage?.prompt_tokens !== usage.inputTokens ||
      result.usage.completion_tokens !== usage.outputTokens || result.usage.total_tokens !== usage.inputTokens + usage.outputTokens) throw Error("KOIN rehearsal usage mismatch");
  return { ...result, warning: "KOIN rehearsal: this answer used the network, but no KOIN was spent." };
}
module.exports = { scheduler, consume };
