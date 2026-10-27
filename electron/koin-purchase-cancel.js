"use strict";
const Cancel = require("../core/lib/koin-network/funding-cancel");
const Price = require("../core/lib/koin-network/purchase-quote");
const { isUsd } = require("../core/lib/koin-network/product");
const { hash } = require("../core/lib/koin-network/job-protocol");
const { simulateCancellation } = require("../core/lib/koin-network/mana-preflight");
const { koin } = require("./koin-review");

async function review(dialog, window, options, signal) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([dialog.showMessageBox(window, options), new Promise((_, reject) => {
      abort = () => reject(Object.assign(Error("Payment review stopped"), { code: "koin_rpc_stopped" }));
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

// Trusted main-process action. The renderer selects recovery, never a target,
// amount, operation, nonce, resource limit, or signature.
async function cancel({ id, journal, client, config, window, dialog, guard, sign, canSign, signal, clock, progress = () => {} }, trace) {
  const report = (stage, detail = {}) => { try { progress(stage, detail); } catch {} };
  const saved = journal.saved(id), nonces = journal.nonceCoordinator;
  if (!isUsd(client.d) || !saved?.signed || saved.intent.kind !== "credits" || saved.intent.method !== "purchase" ||
      saved.intent.actor !== config.owner) throw Error("A saved USD purchase owned by this wallet is required");
  const quote = await Price.verify(client.d, saved.intent.args);
  const result = status => ({ status, deposit: journal.status(id) });
  const settled = async phase => {
    trace.phase = phase;
    await nonces.reconcile(id); guard();
    if (!["finalized", "reverted", "consumed_elsewhere"].includes(nonces.status(id).state)) return false;
    const checked = await journal.advance(id, { allowSubmit: false }); guard();
    return checked.action === "done";
  };
  report("cancellation-confirmation", { txId: saved.txId });
  if (await settled("initial-confirmation")) return result("complete");
  const observed = nonces.confirmation?.(id);
  if (observed?.state === "included") { report("awaiting-confirmation", observed); return result("await_finality"); }
  journal.hold(id);
  let cancellation = nonces.cancellation(id);
  if (cancellation && !cancellation.transaction) {
    // A lost signing result is never signed twice, even after a restart.
    try { await nonces.recoverOriginal(id, cancellation.draft.id); } catch { /* Keep the signing fence. */ }
    guard(); cancellation = nonces.cancellation(id);
    if (!cancellation.transaction) throw Error("The saved cancellation signature needs recovery. It cannot be signed again.");
  }
  if (!cancellation) canSign();
  const draft = cancellation?.draft || await Cancel.prepare(client.d, saved.draft);
  const unchanged = async phase => {
    trace.phase = phase;
    const [policy, next, head] = await Promise.all([client.verify(), client.provider.getNextNonce(config.owner), client.provider.getHeadInfo()]);
    guard();
    const time = Number(head?.head_block_time), now = clock();
    if (!Number.isSafeInteger(time) || time <= 0 || time > now + 60000 || time + 120000 < now) throw Error("A fresh blockchain time is required to recover this purchase");
    if (time <= Number(quote.expires_at)) throw Error("The purchase quote has not expired on the blockchain. Check confirmation again.");
    if (hash(JSON.stringify(policy)) !== saved.policyHash || next !== saved.draft.header.nonce)
      throw Error("The payment policy or wallet nonce changed. Check confirmation before recovery.");
    if (!Cancel.matches(client.d, saved.draft, draft)) throw Error("Cancellation transaction changed");
  };
  await unchanged("initial-policy");
  report("cancellation-approval", { txId: saved.txId });
  const answer = await review(dialog, window, { type: "question", title: "Cancel expired credit purchase",
    message: cancellation ? "Resume this saved payment cancellation?" : "Cancel this expired payment so you can buy credits again?",
    detail: ["KOIN transferred: 0. This transaction only reads your KOIN balance and consumes the old payment's nonce.",
      `Wallet: ${config.owner}`, `Original payment: ${saved.txId}`, `Cancellation: ${draft.id}`,
      `Unchanged nonce: ${draft.header.nonce}`, `Chain: ${draft.header.chain_id}`, `Pinned KOIN contract: ${client.d.token}`,
      `Maximum regenerating Mana: ${koin(draft.header.rc_limit).replace(" KOIN", " Mana")}`,
      "The original payment and cancellation use the same nonce; only one can execute. Both remain saved until irreversible confirmation.",
      "If the original payment already completed, its credits are recovered instead. A fresh purchase stays blocked until this is resolved.",
      cancellation ? "Resends only the saved cancellation. No new signature." : "Approves one signature for this exact zero-transfer cancellation.",
      "Stop prevents further sends but cannot undo a transaction already submitted."].join("\n"),
    buttons: ["Keep pending", cancellation ? "Resume cancellation" : "Cancel expired payment"], defaultId: 0, cancelId: 0, noLink: true }, signal);
  guard(); if (answer.response !== 1) return result("cancelled");
  if (await settled("approved-confirmation")) return result("complete");
  await unchanged("approved-policy");
  if (!cancellation) {
    canSign(); guard();
    const decision = await nonces.reserveCancellation(id, draft, () => { try { guard(); return true; } catch { return false; } });
    if (decision.action === "sign_original") {
      guard(); report("cancellation-signing", { txId: draft.id }); const signed = await sign(draft);
      await nonces.stageCancellation(id, signed); // Preserve a late signature after Stop.
    }
    cancellation = nonces.cancellation(id);
  }
  guard();
  if (!cancellation?.transaction) throw Error("Recover the saved cancellation before continuing");
  trace.phase = "saved-transaction-lookup";
  const lookup = await client.provider.getTransactionsById([cancellation.draft.id]); guard();
  if (!lookup || typeof lookup !== "object" || Array.isArray(lookup) || lookup.error || lookup.rpc_error ||
      (lookup.transactions !== undefined && !Array.isArray(lookup.transactions)) ||
      (lookup.transactions || []).some(r => r?.transaction?.id !== cancellation.draft.id)) throw Error("Cancellation confirmation is unavailable");
  if (lookup.transactions?.length) return result(await settled("seen-confirmation") ? "complete" : "await_finality");
  trace.phase = "simulation"; report("checking-mana", { txId: cancellation.draft.id });
  try { await simulateCancellation(client, cancellation.transaction, saved.draft); }
  catch (error) {
    guard(); journal.recordCancellationIssue(id, error.code === "funding_insufficient_rc" ? "funding_insufficient_rc" : "funding_simulation_failed");
    if (rpcCodes.has(error.code)) throw error;
    return result("await_finality");
  }
  guard(); if (await settled("submission-confirmation")) return result("complete");
  await unchanged("submission-policy");
  const transaction = nonces.authorizeCancellationSubmission(id, { maxRcPerDay: config.maxRcPerDay }); guard();
  report("cancellation-submitting", { txId: transaction.id });
  let issue = null;
  try { await client.provider.call("chain.submit_transaction", { transaction, broadcast: true }, { signal }); }
  catch { issue = "funding_submission_uncertain"; }
  journal.recordCancellationIssue(id, issue); report("cancellation-confirmation", { txId: transaction.id });
  return result("await_finality");
}
const rpcCodes = new Set(["koin_rpc_unavailable", "koin_rpc_rate_limited", "koin_rpc_rejected", "koin_rpc_chain_mismatch", "koin_rpc_stopped"]);
async function cancelExpiredPurchase(options) {
  const trace = { phase: "saved-state" };
  try { return await cancel(options, trace); }
  catch (error) {
    if (!rpcCodes.has(error?.code)) throw error;
    const detail = error.code === "koin_rpc_rate_limited" ? "The RPC endpoint is limiting requests." : error.code === "koin_rpc_stopped" ? "The network check was stopped." : "The RPC check could not be completed.";
    throw Error(`Cancellation stopped during ${trace.phase}. ${detail} Your saved cancellation is preserved. Reference: cancellation/${trace.phase}/${error.code.slice(9)}.`);
  }
}
module.exports = { cancelExpiredPurchase };
