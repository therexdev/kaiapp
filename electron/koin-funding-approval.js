"use strict";
const { isPrepaid, isUsd } = require("../core/lib/koin-network/product");

// Explicit Test or fixture approval. No background retries or mainnet signing.
// Preview receipts are never accepted here.
const { assertPaymentMode } = require("../core/lib/koin-network/payment-mode");
const { intent } = require("../core/lib/koin-network/funding-observer");
const { hash, digest, integer } = require("../core/lib/koin-network/job-protocol");
const { FundingRecovery, FundingRecoveryRunner } = require("./koin-funding-recovery");
const { koin } = require("./koin-review");
const PriceQuote = require("../core/lib/koin-network/purchase-quote");
const { fundingFailure } = require("./koin-funding-failure");

function createFundingApproval({ mode, client, journal, dialog, sign, submit, preflight = null, clock = Date.now, timeoutMs = 5000, tr = x => x }) {
  assertPaymentMode(mode, client); const mainnet = mode === "mainnet-pilot";
  if (!(journal instanceof FundingRecovery) || typeof dialog?.showMessageBox !== "function" ||
      typeof sign !== "function" || typeof submit !== "function" || (preflight !== null && typeof preflight !== "function")) throw Error("Explicit isolated funding approval dependencies required");
  journal.assertMode(mode); journal.assertClient(client); integer(timeoutMs, 50, 30000);
  let pending = null;
  const staging = new Set();
  const result = (status, id) => ({ status, mode, paymentsEnabled: mainnet, ...(id ? { deposit: journal.status(id) } : {}) });
  const cancel = () => {
    if (!pending) return;
    pending.stopped = true; pending.abort.abort();
    if (pending.id) journal.hold(pending.id);
  };
  async function review(window, id, getRequest, resume) {
    const visible = () => window && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
    if (pending || !visible()) return { ...result("cancelled"), failure: fundingFailure("request", Error("Funding review changed or expired")) };
    digest(id);
    const startedAt = integer(clock()), expires = integer(startedAt + 180000);
    const task = pending = { stopped: false, id: null, abort: new AbortController() };
    const valid = () => !task.stopped && visible() && clock() >= startedAt && clock() < expires;
    // A safety check ending the action is not the user pressing native Cancel.
    // Preserve that distinction so Buy can display why no approval/payment ran.
    const assertCurrentReview = () => { if (!valid()) throw Error("Funding review changed or expired"); };
    const waiting = async promise => {
      let listener;
      try {
        return await Promise.race([promise, new Promise((_, reject) => {
          listener = () => reject(Error("Funding review stopped"));
          if (task.abort.signal.aborted) listener(); else task.abort.signal.addEventListener("abort", listener, { once: true });
        })]);
      } finally { task.abort.signal.removeEventListener("abort", listener); }
    };
    const stop = () => cancel();
    const navigation = (_event, _url, _inPlace, mainFrame) => { if (mainFrame) stop(); };
    for (const event of ["hide", "minimize", "closed"]) window.on(event, stop);
    window.webContents.on("did-start-navigation", navigation);
    window.webContents.on("render-process-gone", stop);
    const timer = setTimeout(stop, 180000);
    let ownsFence = false, stage = "request";
    try {
      const request = intent(await waiting(Promise.resolve().then(getRequest)));
      assertCurrentReview();
      stage = "journal";
      const saved = journal.saved(id);
      if (saved && JSON.stringify(saved.intent) !== JSON.stringify(request)) throw Error("Cannot replace the saved deposit");
      if (saved && !resume) return result("recover_existing", id);
      if (resume && (!saved || !saved.signed)) return result(saved ? "recover_signing_envelope" : "unavailable", saved ? id : null);
      if (resume && ["funded", "reverted", "conflicted"].includes(saved.state)) return result("complete", id);
      stage = "prepare";
      const draft = resume ? saved.draft : await client.prepare(request.kind, request.method, request.args, { actor: request.actor, rcLimit: request.maxRc });
      stage = "transaction";
      await client.verifyTransaction(draft, request);
      stage = "deployment";
      const config = await client.verify(), policyHash = hash(JSON.stringify(config));
      if (config.paused || (resume && saved.policyHash !== policyHash)) throw Error("Funding policy changed or paused");
      assertCurrentReview();
      const usdPurchase = isUsd(client.d) && request.kind === "credits";
      stage = "price";
      if (usdPurchase && !resume) await PriceQuote.verify(client.d, request.args, { now: clock(), version: config.credits.version });
      const line = (name, value) => `${tr(name)}: ${value}`;
      stage = "dialog";
      const { response } = await waiting(dialog.showMessageBox(window, {
        type: "question", title: tr(usdPurchase ? "Buy AI credits" : mainnet ? "Mainnet KOIN funding — real funds" : mode === "test-deployment" ? "Test KOIN funding" : "Isolated KOIN funding rehearsal"),
        message: tr(isPrepaid(client.d) && request.kind === "credits" ? (resume ? "Retry this saved credit purchase" : "Buy AI credits with KOIN") : resume ? "Review the saved deposit for resubmission" : (mainnet ? "Approve this real KOIN deposit" : mode === "test-deployment" ? "Approve this testnet deposit" : "Approve this fixture-wallet deposit")),
        detail: usdPurchase ? [
          line("You receive", PriceQuote.credits(request.args.purchase_quote.credits) + " AI credits"),
          line("You pay", koin(request.args.amount)), line("From wallet", request.actor),
          line("To", client.d.masterNode), line("Network", mainnet ? "Koinos Mainnet" : mode === "test-deployment" ? "Foundation Testnet" : "Isolated test"),
          line("Price valid until", new Date(Number(request.args.purchase_quote.expires_at)).toLocaleString()),
          line("Maximum regenerating Mana", koin(request.maxRc).replace(" KOIN", " Mana")), "",
          tr("Credits do not expire. They are nonrefundable and cannot be transferred. Failed chats do not consume credits."),
          tr(resume ? "Continue the saved payment. This does not create another purchase." : "Confirm to send this exact KOIN payment and add the credits after blockchain confirmation.")
        ].join("\n") : [tr(mainnet ? "MAINNET: This transfers real KOIN to the displayed payment destination. A Test installer does not make these funds test tokens." : mode === "test-deployment" ? "Foundation testnet tokens only. This transfers test KOIN to the displayed payment destination." : "Isolated fixture chain only. This approval cannot enable live payments."), "",
          tr(request.kind === "credits" ? (usdPurchase ? "Buy nonrefundable AI credits at a fixed USD value. 1,000 credits = $1. Credits do not expire and cannot be transferred or withdrawn. Failed chats do not consume credits. Purchase KOIN goes to the Master Node; provider rewards are funded separately." : isPrepaid(client.d) ? "Buy nonrefundable AI credits. 1 KOIN buys 1,000 credits. Credits do not expire and cannot be transferred or withdrawn. Failed chats do not consume credits. The service accounts for usage; KOIN settlement runs in the background." : "This deposit backs refundable usage credits.") : "This funds provider rewards, not a refundable customer balance."),
          ...(usdPurchase ? [line("Credits received", PriceQuote.credits(request.args.purchase_quote.credits)), line("USD credit value", "$" + PriceQuote.dollars(request.args.purchase_quote.credits)), line("Price per KOIN", "$" + PriceQuote.dollars(request.args.purchase_quote.usd_per_koin)), line("Price expires (UTC)", new Date(Number(request.args.purchase_quote.expires_at)).toISOString())] : []),
          line("Payment destination", usdPurchase ? client.d.masterNode : client.d[request.kind]),
          line("Amount", koin(request.args.amount)), line("Wallet and Mana payer", request.actor),
          line("Custody contract", client.d[request.kind]), line("Custody code", client.d[request.kind + "Hash"]),
          line("Native token contract", client.d.token), line("Native token code", client.d.tokenHash), line("Chain", client.d.chainId),
          line("Maximum resource credits", request.maxRc), line("Transaction", draft.id), line("Nonce", draft.header.nonce),
          line("Review expires (UTC)", new Date(expires).toISOString()), "",
          tr("The exact approval and deposit are atomic. Success consumes the whole allowance; failure rolls both back."),
          tr(resume ? "Resume sends only the original saved signature and transaction. It does not sign again or reset retry or daily Mana limits." : "Approval permits one signature for this exact deposit and an attempt to submit it."),
          tr("Stop prevents further sends. A transaction already sent may still be included and confirmed.")].join("\n"),
        buttons: [tr("Cancel"), tr(usdPurchase ? (resume ? "Continue payment" : "Buy credits") : resume ? "Resume saved deposit" : (mainnet ? "Send real KOIN" : mode === "test-deployment" ? "Approve testnet deposit" : "Approve fixture deposit"))], defaultId: 0, cancelId: 0, noLink: true,
      }));
      assertCurrentReview();
      if (response === 0) return result("cancelled");
      if (response !== 1) throw Error("Native payment review returned an invalid response");
      stage = "recheck";
      if (JSON.stringify(intent(await getRequest())) !== JSON.stringify(request)) throw Error("Funding review changed or expired");
      assertCurrentReview();
      const currentConfig = await client.verify(), nextNonce = await client.provider.getNextNonce(request.actor);
      assertCurrentReview();
      if (JSON.stringify(config) !== JSON.stringify(currentConfig) || nextNonce !== draft.header.nonce) throw Error("Funding review changed or expired");
      if (usdPurchase && !resume) await PriceQuote.verify(client.d, request.args, { now: clock(), version: currentConfig.credits.version });
      const approval = { txId: draft.id, policyHash, startedAt, expires, holdVersion: saved?.holdVersion };
      stage = "reserve";
      task.id = id;
      if (resume) {
        await journal.resumeReviewed(id, approval, valid); ownsFence = true;
      } else {
        const decision = await journal.beginReviewed(id, request, approval, valid);
        if (decision.action !== "prepare_funding") { task.id = null; return result("recover_existing", id); }
        ownsFence = true;
        if (!valid() || journal.status(id).held) { journal.hold(id); return result("stopped", id); }
        stage = "sign";
        // Stage even a late signature. A timeout/Stop holds the durable envelope;
        // only another native review may submit it. A process exit leaves the
        // signing fence for exact-envelope recovery, never another signature.
        let signingTimer;
        const signed = Promise.resolve().then(() => {
          if (!valid() || journal.status(id).held) throw Error("Funding stopped before signing");
          return sign(structuredClone(decision), { signal: task.abort.signal });
        }).then(tx => journal.stage(id, tx));
        // Stop may return before the OS signer returns. Keep ownership of this
        // staging task so callers cannot close its journal before exact bytes
        // have been persisted. The durable nonce fence already blocks resigning.
        staging.add(signed); signed.then(() => staging.delete(signed), () => staging.delete(signed));
        try {
          await waiting(Promise.race([signed, new Promise((_, reject) => {
            signingTimer = setTimeout(() => { stop(); reject(Error("Funding signing timed out")); }, timeoutMs);
          })]));
        } finally { clearTimeout(signingTimer); }
      }
      if (!valid() || journal.status(id).held) { journal.hold(id); return result("stopped", id); }
      if (preflight) {
        stage = "preflight";
        try {
          await waiting(preflight({ transaction: journal.nonceCoordinator.envelope(id), intent: request }, { signal: task.abort.signal }));
        } catch (error) {
          const reason = error?.code === "funding_insufficient_rc" ? "funding_insufficient_rc" : "funding_simulation_failed";
          journal.recordSubmissionIssue(id, reason); journal.hold(id);
          return { ...result(valid() ? "await_finality" : "stopped", id), reason };
        }
        if (!valid() || journal.status(id).held) { journal.hold(id); return result("stopped", id); }
      }
      stage = "submit";
      const runner = new FundingRecoveryRunner({ mode, journal, timeoutMs, sign: () => { throw Error("Resigning is forbidden"); },
        submit: async (value, options) => {
          if (!valid() || journal.status(id).held) { journal.hold(id); throw Error("Funding stopped before transport"); }
          return submit(value, { signal: AbortSignal.any([options.signal, task.abort.signal]) });
        } });
      const decision = await runner.tick(id);
      // No unattended retries. A lost response requires read-only reconciliation
      // or a fresh native review before sending the same transaction again.
      journal.hold(id);
      const status = decision.action === "done" ? "complete" : decision.action === "review" ? "review_required" :
        decision.action === "wait" ? "waiting" : "await_finality";
      return { ...result(valid() ? status : "stopped", id), action: decision.action, reason: decision.reason ?? null };
    } catch (error) {
      if (ownsFence) journal.hold(id);
      return { ...result(valid() ? "unavailable" : ownsFence ? "stopped" : "cancelled", ownsFence ? id : null),
        failure: fundingFailure(stage, error) };
    } finally {
      clearTimeout(timer); task.abort.abort();
      for (const event of ["hide", "minimize", "closed"]) window.removeListener(event, stop);
      window.webContents.removeListener("did-start-navigation", navigation);
      window.webContents.removeListener("render-process-gone", stop);
      pending = null;
    }
  }
  return { cancel, drain: () => staging.size ? Promise.allSettled([...staging]) : null, approve: (window, id, supplier) => review(window, id, supplier, false),
    resume: (window, id, supplier) => review(window, id, supplier, true),
    check: id => journal.advance(id, { allowSubmit: false }) };
}
module.exports = { createFundingApproval };
