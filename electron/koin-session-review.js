"use strict";
const fs = require("fs"), path = require("path");
const { trustedMainDocument } = require("./window-security");
const { koin } = require("./koin-review");
const { FundedSessionClient } = require("./koin-session-client");

function createSessionReview({ client, dialog, track = () => () => {}, tr = x => x }) {
  let pending = false;
  const result = state => ({ enabled: true, mode: "funded-rehearsal", paymentsEnabled: false, state });
  return async function run(window, action) {
    const visible = () => window && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
    if (pending || !visible()) return result("cancelled");
    pending = true;
    const controller = new AbortController(), stop = () => controller.abort(), release = track(controller);
    const navigation = (_event, _url, _inPlace, mainFrame) => { if (mainFrame) stop(); };
    for (const event of ["hide", "minimize", "closed"]) window.on(event, stop);
    window.webContents.on("did-start-navigation", navigation); window.webContents.on("render-process-gone", stop);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
    const guard = () => { signal.throwIfAborted(); if (!visible()) throw Error("Session review stopped"); };
    let changing = false;
    try {
      if (action === "status") return await client.status(signal);
      if (action === "retry") { changing = true; return await client.retry(signal); }
      if (action === "revoke") {
        const state = await client.status(signal); guard();
        const { response } = await dialog.showMessageBox(window, { type: "question", title: tr("KOIN session rehearsal"),
          message: tr("Stop new requests for this session?"),
          detail: `${tr("Dispatched work stays reserved. This does not refund on-chain credits.")}\n\n${state.session}`,
          buttons: [tr("Cancel"), tr("Revoke session approval")], defaultId: 0, cancelId: 0, noLink: true });
        guard(); if (response !== 1) return result("cancelled");
        changing = true; return await client.revoke(signal);
      }
      if (action !== "review") throw Error("Unknown session action");
      const review = await client.prepare(signal); guard();
      const t = review.terms, line = (name, value) => `${tr(name)}: ${value}`;
      const { response } = await dialog.showMessageBox(window, { type: "question", title: tr("KOIN session rehearsal"),
        message: tr("Approve one bounded rehearsal session"),
        detail: [tr("This signs a session approval for accounting tests. No KOIN will be spent."), "",
          line("Model", t.model), line("Tariff version", t.version), line("Maximum output tokens", t.maxOutput),
          line("Input price per 1M tokens", koin(review.tariff.inputAtomsPerMillion)),
          line("Output price per 1M tokens", koin(review.tariff.outputAtomsPerMillion)),
          line("Session total limit", koin(t.amount)), line("Per-request limit", koin(t.perJob)),
          line("Maximum requests", t.maxJobs), line("Session expires (UTC)", new Date(t.expires).toISOString()),
          line("Wallet", t.owner), line("Account", t.accountId), line("Spending grant", t.grantId),
          line("Session", t.session), line("Chain", t.target.chainId), line("Credits contract", t.target.credits),
          line("Contract bytecode", t.target.creditsHash), line("Tariff policy", t.target.policyHash),
          "", tr("Requests within these limits reuse this approval. Revoking it stops new requests."),
          tr("Live payments require a separate authorization and are not enabled by this signature.")].join("\n"),
        buttons: [tr("Cancel"), tr("Approve session rehearsal")], defaultId: 0, cancelId: 0, noLink: true });
      guard(); if (response !== 1) return result("cancelled");
      changing = true; return await client.approve(review, signal);
    } catch (e) {
      const state = signal.aborted ? changing && client.hasSavedApproval?.() ? "uncertain" : "cancelled" : "unavailable";
      return { ...result(state), error: String(e.message).slice(0, 220) };
    }
    finally {
      release(); pending = false;
      for (const event of ["hide", "minimize", "closed"]) window.removeListener(event, stop);
      window.webContents.removeListener("did-start-navigation", navigation); window.webContents.removeListener("render-process-gone", stop);
    }
  };
}
function registerSessionReviewIPC({ ipcMain, dialog, core, getMainWindow, origin, dataDir, tr,
  configPath = process.env.KAI_KOIN_FUNDED_REHEARSAL_CONFIG }) {
  let client, problem;
  if (configPath) {
    try {
      const text = fs.readFileSync(configPath, "utf8"); if (Buffer.byteLength(text) > 16384) throw Error("Rehearsal configuration is too large");
      client = new FundedSessionClient({ config: JSON.parse(text), file: path.join(dataDir, "koin-funded-session-approval.json"),
        authorize: (pin, signal, options) => core.account.shadowAuthorization(pin, signal, options),
        sign: hash => core.account.wallet.signHash(hash) });
    } catch { problem = "Funded session rehearsal configuration is unavailable. Check the configured pins and saved approval."; }
  }
  // A private consume closure reuses the saved certificate. It cannot sign or
  // select new limits, and no public Core endpoint can install/replace it.
  if (configPath) core.gateway.koinFundedConsume = request => {
    if (!client) throw Error(problem);
    return client.consume(request);
  };
  const run = client && createSessionReview({ client, dialog, tr, track: controller => core.gateway.network.trackShadowRequest(controller) });
  for (const action of ["status", "review", "retry", "revoke"]) ipcMain.handle("koin:session-" + action, async (event, ...args) => {
    const window = getMainWindow();
    if (!trustedMainDocument(event, window, origin)) throw Error("Desktop window access denied");
    if (args.length) throw Error("Session controls take no arguments");
    if (!client) return { enabled: !!configPath, mode: "funded-rehearsal", paymentsEnabled: false, state: problem ? "unavailable" : "disabled", ...(problem ? { error: problem } : {}) };
    return run(window, action);
  });
}
module.exports = { createSessionReview, registerSessionReviewIPC };
