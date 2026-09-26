"use strict";

// In-process shadow review only. This module has no transport, wallet, signer
// or persistent approval. A reviewed result is never a spending authorization.
const P = require("../core/lib/koin-network/job-protocol");
const { utils } = require("koilib");
const { trustedMainDocument } = require("./window-security");

function atoms(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > (1n << 64n) - 1n) throw Error("Invalid atom amount");
  return BigInt(value);
}
function koin(value) {
  const n = atoms(value);
  return `${n / 100000000n}.${String(n % 100000000n).padStart(8, "0")} KOIN`;
}

function validateReview(value, now) {
  const { quote, session: s, expected: e } = structuredClone(value);
  const q = P.validateQuote(quote);
  P.integer(now);
  if (!s || !e || q.domain !== e.domain || q.policyHash !== e.policyHash || q.requestHash !== e.requestHash ||
      q.tariff.model !== e.model || q.tariff.version !== e.tariffVersion || q.maxOutput !== e.maxOutput ||
      s.mode !== "shadow" || s.paymentsEnabled !== false || s.id !== e.session || s.owner !== e.owner ||
      s.policyHash !== q.policyHash) throw Error("Review terms changed");
  P.digest(s.id);
  if (typeof s.owner !== "string" || !utils.isChecksumAddress(s.owner)) throw Error("Invalid owner");
  P.integer(s.openedAt); P.integer(s.expires, s.openedAt + 1);
  P.integer(s.maxJobs, 1, 10000); P.integer(s.remainingJobs, 1, s.maxJobs);
  if (now < q.at || now >= q.expires || now < s.openedAt || now >= s.expires || s.revokedAt !== null) throw Error("Review expired or revoked");
  if (atoms(s.spent) + atoms(s.held) + atoms(s.available) !== atoms(s.amount) ||
      atoms(s.perJob) > atoms(s.amount) || atoms(q.maxCharge) > atoms(s.perJob) ||
      atoms(q.maxCharge) > atoms(s.available)) throw Error("Session spending limit");
  // Normalize all displayed and authority-bearing fields for the post-dialog
  // comparison. Even a larger budget or a different owner needs a fresh review.
  return { quote: q, session: { id: s.id, owner: s.owner, amount: s.amount, spent: s.spent,
    held: s.held, available: s.available, perJob: s.perJob, maxJobs: s.maxJobs,
    remainingJobs: s.remainingJobs, openedAt: s.openedAt, expires: s.expires } };
}

function createShadowReview({ dialog, clock = Date.now, tr = text => text }) {
  let pending = false, generation = 0;
  const result = status => ({ status, mode: "shadow", paymentsEnabled: false });
  return {
    cancel() { generation++; },
    // getTerms is a trusted in-process supplier, never a renderer capability.
    async review(window, getTerms, { example = false } = {}) {
      const visible = () => window && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
      if (pending || !visible()) return result("cancelled");
      const epoch = generation;
      pending = true;
      const cancel = () => { generation++; };
      const navigation = (_event, _url, _inPlace, mainFrame) => { if (mainFrame) cancel(); };
      for (const event of ["hide", "minimize", "closed"]) window.on(event, cancel);
      window.webContents.on("did-start-navigation", navigation);
      window.webContents.on("render-process-gone", cancel);
      try {
        const reviewed = validateReview(await getTerms(), clock());
        if (epoch !== generation || !visible()) return result("cancelled");
        const { quote: q, session: s } = reviewed;
        const line = (label, value) => `${tr(label)}: ${value}`;
        const detail = [
          tr(example ? "Example prices only. No KOIN will be spent." : "Simulation only. No KOIN will be spent."),
          "",
          line("Model", q.tariff.model),
          line("Tariff version", q.tariff.version),
          line("Input tokens", q.inputTokens),
          line("Maximum output tokens", q.maxOutput),
          line("Maximum request cost", koin(q.maxCharge)),
          line("Per-request limit", koin(s.perJob)),
          line("Session available", koin(s.available)),
          line("Session total limit", koin(s.amount)),
          line("Requests remaining", `${s.remainingJobs} / ${s.maxJobs}`),
          line("Review expires (UTC)", new Date(Math.min(q.expires, s.expires)).toISOString()),
          line("Wallet", s.owner),
          line("Session", s.id),
          line("Quote", q.hash),
          "", tr("Reviewing does not sign or submit a request."),
        ].join("\n");
        const { response } = await dialog.showMessageBox(window, {
          type: "question", title: tr("KOIN · Review preview"), message: tr("Review one simulated request"),
          detail, buttons: [tr("Cancel"), tr("Mark example reviewed")], defaultId: 0, cancelId: 0, noLink: true,
        });
        if (response !== 1 || epoch !== generation || !visible()) return result("cancelled");
        const current = validateReview(await getTerms(), clock());
        if (epoch !== generation || !visible() || JSON.stringify(current) !== JSON.stringify(reviewed)) return result("cancelled");
        return result("reviewed");
      } catch {
        // Invalid/stale terms and native-dialog failures cannot become approvals.
        return result("unavailable");
      } finally {
        for (const event of ["hide", "minimize", "closed"]) window.removeListener(event, cancel);
        window.webContents.removeListener("did-start-navigation", navigation);
        window.webContents.removeListener("render-process-gone", cancel);
        pending = false;
      }
    },
  };
}

function exampleTerms(now = Date.now()) {
  // Deliberately synthetic: not a live model, tariff, wallet or funded session.
  const tariff = Object.fromEntries(Object.entries({ version: 1, model: "example-model", modelHash: P.hash("example-model"),
    tokenizerHash: P.hash("example-tokenizer"), templateHash: P.hash("example-template"), contextTokens: 4096,
    maxOutputTokens: 1024, maxLatencyMs: 30000, inputAtomsPerMillion: "100000000", outputAtomsPerMillion: "200000000",
  }).sort(([a], [b]) => a.localeCompare(b)));
  const quote = { schema: 2, mode: "shadow", domain: "shadow:desktop-preview", policyHash: P.hash("example-policy"), tariff,
    requestHash: P.hash("example-request"), promptHash: P.hash("example-prompt"), inputIdsHash: P.hash("example-input-ids"),
    inputTokens: 128, maxOutput: 256, maxCharge: "64000", at: now, expires: now + 300000 };
  quote.hash = P.hash(JSON.stringify(quote));
  const session = { mode: "shadow", paymentsEnabled: false, id: P.hash("example-session"),
    owner: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", policyHash: quote.policyHash, amount: "10000000", perJob: "1000000",
    spent: "1000000", held: "1000000", available: "8000000", maxJobs: 10, remainingJobs: 8,
    openedAt: now, expires: now + 900000, revokedAt: null };
  return { quote, session, expected: { domain: quote.domain, policyHash: quote.policyHash, requestHash: quote.requestHash,
    model: tariff.model, tariffVersion: tariff.version, maxOutput: quote.maxOutput, session: session.id, owner: session.owner } };
}

function registerKoinReviewIPC({ ipcMain, dialog, getMainWindow, origin, tr, clock = Date.now }) {
  const review = createShadowReview({ dialog, clock, tr });
  ipcMain.handle("koin:preview-review", async (event, ...args) => {
    const window = getMainWindow();
    if (!trustedMainDocument(event, window, origin)) throw Error("Desktop window access denied");
    if (args.length) throw Error("Preview takes no arguments");
    const terms = exampleTerms(clock());
    return review.review(window, () => terms, { example: true });
  });
  return review;
}
module.exports = { koin, validateReview, createShadowReview, exampleTerms, registerKoinReviewIPC };
