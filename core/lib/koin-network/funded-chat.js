"use strict";
const P = require("./job-protocol"), D = require("./session-delegation"), F = require("./funded-protocol");
const { scheduler } = require("./grant-chat");
function verify(result, { terms, messages, model, maxOutput, requestId }) {
  const t = D.terms(terms), id = P.digest(requestId), input = P.messages(messages);
  const k = result.koin, r = k?.receipt, output = result.choices?.[0]?.message?.content;
  if (result.id !== id || result.model !== "koinos-network" || result.costUsd !== 0 || k?.mode !== "funded-rehearsal" ||
      k.paymentsEnabled !== false || !["verified", "prepared", "submitted", "settled"].includes(k.state) ||
      k.delegationId !== D.id(t) || JSON.stringify(D.target(k.target)) !== JSON.stringify(t.target) ||
      typeof output !== "string" || !output.length || !r ||
      Object.keys(r).sort().join() !== "attempt,completedAt,dispatchedAt,id,mode,outputHash,provider,quoteHash,session,signature,usage" ||
      !r.usage || Object.keys(r.usage).sort().join() !== "amount,inputTokens,outputTokens") throw Error("Invalid funded rehearsal response");
  const q = P.validateQuote(k.quote), tariff = D.tariff(t, k.tariffs);
  if (JSON.stringify(q.tariff) !== JSON.stringify(tariff) || q.domain !== t.target.domain || q.policyHash !== t.target.policyHash ||
      q.requestHash !== P.hash(JSON.stringify(input)) || (model !== "auto" && model !== t.model) ||
      q.maxOutput !== (maxOutput ?? t.maxOutput) || q.maxOutput > t.maxOutput || BigInt(q.maxCharge) > BigInt(t.perJob) ||
      result.servedModel !== t.model || r.mode !== "funded-rehearsal" || r.id !== id || r.session !== t.session ||
      r.quoteHash !== q.hash || r.outputHash !== P.hash(output) || r.provider === t.owner ||
      k.receiptHash !== P.hash(JSON.stringify(r))) throw Error("Funded receipt differs from approved request");
  P.integer(r.dispatchedAt, Math.max(t.issuedAt, q.at), Math.min(t.expires, q.expires) - 1);
  P.integer(r.completedAt, r.dispatchedAt, r.dispatchedAt + q.tariff.maxLatencyMs);
  P.signatureMatches(F.fundedResultHash(t.target, { ...r, quote: q }, output), r.signature, r.provider);
  const u = r.usage;
  P.integer(u?.inputTokens, q.inputTokens, q.inputTokens); P.integer(u.outputTokens, 1, q.maxOutput);
  const amount = (BigInt(u.inputTokens) * BigInt(q.tariff.inputAtomsPerMillion) + BigInt(u.outputTokens) * BigInt(q.tariff.outputAtomsPerMillion) + 999999n) / 1000000n;
  if (String(amount) !== u.amount || amount > BigInt(q.maxCharge) || result.usage?.prompt_tokens !== u.inputTokens ||
      result.usage.completion_tokens !== u.outputTokens || result.usage.total_tokens !== u.inputTokens + u.outputTokens) throw Error("Funded rehearsal usage mismatch");
  const settlement = k.settlement;
  if (settlement?.state === "prepared" && Object.keys(settlement).sort().join() === "hash,intent,state") {
    const c = settlement.intent;
    if (!c || Object.keys(c).sort().join() !== "amount,dispatched_at,id,nonce,policy_hash,provider,receipt_hash,session_id" ||
        c.id !== id || c.session_id !== t.session || c.provider !== r.provider || c.policy_hash !== t.target.policyHash ||
        c.receipt_hash !== k.receiptHash || c.amount !== u.amount || c.dispatched_at !== String(r.dispatchedAt) ||
        settlement.hash !== P.hash(JSON.stringify(c))) throw Error("Invalid prepared settlement");
    D.amount(c.nonce);
  } else if (settlement?.state !== "waiting" || Object.keys(settlement).join() !== "state" || k.state !== "verified") throw Error("Invalid settlement state");
  // Construct the public response, never spread unrecognized remote fields.
  return { id, object: "chat.completion", model: "koinos-network", servedModel: t.model,
    choices: [{ index: 0, message: { role: "assistant", content: output }, finish_reason: "stop" }],
    usage: { prompt_tokens: u.inputTokens, completion_tokens: u.outputTokens, total_tokens: u.inputTokens + u.outputTokens }, costUsd: 0,
    koin: { mode: "funded-rehearsal", paymentsEnabled: false, state: k.state, delegationId: k.delegationId,
      quote: q, receipt: r, receiptHash: k.receiptHash, settlement },
    warning: "KOIN rehearsal: this answer used the network. The charge is reserved for accounting tests; no KOIN was spent." };
}
async function consume({ schedulerUrl, authorization, terms, observationId, messages, model, maxOutput, requestId, signal, fetchImpl = fetch }) {
  const t = D.terms(terms), input = P.messages(messages), id = P.digest(requestId);
  if (!authorization?.sessionToken || authorization.accountId !== t.accountId || authorization.grantId !== t.grantId || authorization.owner !== t.owner) throw Error("Session account changed");
  if (model !== "auto" && model !== t.model) throw Error("Selected model exceeds session approval");
  if (maxOutput !== undefined) P.integer(maxOutput, 1, t.maxOutput);
  const response = await fetchImpl(scheduler(schedulerUrl) + "/consume/chat/completions", {
    method: "POST", redirect: "error", signal, headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ billing: "koin-funded-rehearsal", sessionToken: authorization.sessionToken, grantId: t.grantId,
      delegationId: D.id(t), observationId: P.digest(observationId), requestId: id, messages: input, model,
      ...(maxOutput === undefined ? {} : { max_tokens: maxOutput }), stream: false }),
  });
  let size = 0; const chunks = [];
  for await (const chunk of response.body) { size += chunk.length; if (size > 1500000) throw Error("Funded response too large"); chunks.push(chunk); }
  const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!response.ok) throw Error(typeof result.error?.message === "string" ? result.error.message.split(authorization.sessionToken).join("[redacted]").slice(0, 220) : "Funded rehearsal failed");
  return verify(result, { terms: t, messages: input, model, maxOutput, requestId: id });
}
module.exports = { consume, verify };
