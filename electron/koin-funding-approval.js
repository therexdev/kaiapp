"use strict";

// Explicit Test or fixture approval. No background retries or mainnet signing.
// Preview receipts are never accepted here.
const { assertPaymentMode } = require("../core/lib/koin-network/payment-mode");
const { intent } = require("../core/lib/koin-network/funding-observer");
const { hash, digest, integer } = require("../core/lib/koin-network/job-protocol");
const { FundingRecovery, FundingRecoveryRunner } = require("./koin-funding-recovery");
const { koin } = require("./koin-review");

function createFundingApproval({ mode, client, journal, dialog, sign, submit, clock = Date.now, timeoutMs = 5000, tr = x => x }) {
  assertPaymentMode(mode, client); const mainnet = mode === "mainnet-pilot";
  if (!(journal instanceof FundingRecovery) || typeof dialog?.showMessageBox !== "function" ||
      typeof sign !== "function" || typeof submit !== "function") throw Error("Explicit isolated funding approval dependencies required");
  journal.assertMode(mode); journal.assertClient(client); integer(timeoutMs, 50, 30000);
  let pending = null;
  const result = (status, id) => ({ status, mode, paymentsEnabled: mainnet, ...(id ? { deposit: journal.status(id) } : {}) });
  const cancel = () => {
    if (!pending) return;
    pending.stopped = true; pending.abort.abort();
    if (pending.id) journal.hold(pending.id);
  };
  async function review(window, id, getRequest, resume) {
    const visible = () => window && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
    if (pending || !visible()) return result("cancelled");
    digest(id);
    const startedAt = integer(clock()), expires = integer(startedAt + 180000);
    const task = pending = { stopped: false, id: null, abort: new AbortController() };
    const valid = () => !task.stopped && visible() && clock() >= startedAt && clock() < expires;
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
    let ownsFence = false;
    try {
      const request = intent(await waiting(Promise.resolve().then(getRequest)));
      if (!valid()) return result("cancelled");
      const saved = journal.saved(id);
      if (saved && JSON.stringify(saved.intent) !== JSON.stringify(request)) throw Error("Cannot replace the saved deposit");
      if (saved && !resume) return result("recover_existing", id);
      if (resume && (!saved || !saved.signed)) return result(saved ? "recover_signing_envelope" : "unavailable", saved ? id : null);
      if (resume && ["funded", "reverted", "conflicted"].includes(saved.state)) return result("complete", id);
      const draft = resume ? saved.draft : await client.prepare(request.kind, request.method, request.args, { actor: request.actor, rcLimit: request.maxRc });
      await client.verifyTransaction(draft, request);
      const config = await client.verify(), policyHash = hash(JSON.stringify(config));
      if (config.paused || (resume && saved.policyHash !== policyHash)) throw Error("Funding policy changed or paused");
      if (!valid()) return result("cancelled");
      const line = (name, value) => `${tr(name)}: ${value}`;
      const { response } = await waiting(dialog.showMessageBox(window, {
        type: "question", title: tr(mainnet ? "Mainnet KOIN funding — real funds" : mode === "test-deployment" ? "Test KOIN funding" : "Isolated KOIN funding rehearsal"),
        message: tr(resume ? "Review the saved deposit for resubmission" : (mainnet ? "Approve this real KOIN deposit" : mode === "test-deployment" ? "Approve this testnet deposit" : "Approve this fixture-wallet deposit")),
        detail: [tr(mainnet ? "MAINNET: This transfers real KOIN to the displayed custody contract. A Test installer does not make these funds test tokens." : mode === "test-deployment" ? "Foundation testnet tokens only. This transfers test KOIN to the displayed custody contract." : "Isolated fixture chain only. This approval cannot enable live payments."), "",
          tr(request.kind === "credits" ? "This deposit backs refundable usage credits." : "This funds provider rewards, not a refundable customer balance."),
          line("Amount", koin(request.args.amount)), line("Wallet and Mana payer", request.actor),
          line("Custody contract", client.d[request.kind]), line("Custody code", client.d[request.kind + "Hash"]),
          line("Native token contract", client.d.token), line("Native token code", client.d.tokenHash), line("Chain", client.d.chainId),
          line("Maximum resource credits", request.maxRc), line("Transaction", draft.id), line("Nonce", draft.header.nonce),
          line("Review expires (UTC)", new Date(expires).toISOString()), "",
          tr("The exact approval and deposit are atomic. Success consumes the whole allowance; failure rolls both back."),
          tr(resume ? "Resume sends only the original saved signature and transaction. It does not sign again or reset retry or daily Mana limits." : "Approval permits one signature for this exact deposit and an attempt to submit it."),
          tr("Stop prevents further sends. A transaction already sent may still be included and confirmed.")].join("\n"),
        buttons: [tr("Cancel"), tr(resume ? "Resume saved deposit" : (mainnet ? "Send real KOIN" : mode === "test-deployment" ? "Approve testnet deposit" : "Approve fixture deposit"))], defaultId: 0, cancelId: 0, noLink: true,
      }));
      if (response !== 1 || !valid()) return result("cancelled");
      if (JSON.stringify(intent(await getRequest())) !== JSON.stringify(request) || !valid()) return result("cancelled");
      const currentConfig = await client.verify(), nextNonce = await client.provider.getNextNonce(request.actor);
      if (!valid() || JSON.stringify(config) !== JSON.stringify(currentConfig) || nextNonce !== draft.header.nonce) return result("cancelled");
      const approval = { txId: draft.id, policyHash, startedAt, expires, holdVersion: saved?.holdVersion };
      task.id = id;
      if (resume) {
        await journal.resumeReviewed(id, approval, valid); ownsFence = true;
      } else {
        const decision = await journal.beginReviewed(id, request, approval, valid);
        if (decision.action !== "prepare_funding") { task.id = null; return result("recover_existing", id); }
        ownsFence = true;
        if (!valid() || journal.status(id).held) { journal.hold(id); return result("stopped", id); }
        // Stage even a late signature. A timeout/Stop holds the durable envelope;
        // only another native review may submit it. A process exit leaves the
        // signing fence for exact-envelope recovery, never another signature.
        let signingTimer;
        const signed = Promise.resolve().then(() => {
          if (!valid() || journal.status(id).held) throw Error("Funding stopped before signing");
          return sign(structuredClone(decision), { signal: task.abort.signal });
        }).then(tx => journal.stage(id, tx));
        try {
          await waiting(Promise.race([signed, new Promise((_, reject) => {
            signingTimer = setTimeout(() => { stop(); reject(Error("Funding signing timed out")); }, timeoutMs);
          })]));
        } finally { clearTimeout(signingTimer); }
      }
      if (!valid() || journal.status(id).held) { journal.hold(id); return result("stopped", id); }
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
    } catch {
      if (ownsFence) journal.hold(id);
      return result(valid() ? "unavailable" : ownsFence ? "stopped" : "cancelled", ownsFence ? id : null);
    } finally {
      clearTimeout(timer); task.abort.abort();
      for (const event of ["hide", "minimize", "closed"]) window.removeListener(event, stop);
      window.webContents.removeListener("did-start-navigation", navigation);
      window.webContents.removeListener("render-process-gone", stop);
      pending = null;
    }
  }
  return { cancel, approve: (window, id, supplier) => review(window, id, supplier, false),
    resume: (window, id, supplier) => review(window, id, supplier, true),
    check: id => journal.advance(id, { allowSubmit: false }) };
}
module.exports = { createFundingApproval };
