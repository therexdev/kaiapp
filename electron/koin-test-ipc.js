"use strict";
const fs = require("fs"), path = require("path");
const { trustedMainDocument } = require("./window-security");
const { configuration } = require("./koin-test-config");
const { KoinChain } = require("../core/lib/koin-network/chain");
const { FundingRecovery } = require("./koin-funding-recovery");
const { JournalSet } = require("../core/lib/koin-network/journal-set");
const { TestPayments } = require("./koin-test-payments");
const { TestAccess } = require("./koin-test-access");
const P = require("../core/lib/koin-network/job-protocol");
const crypto = require("crypto");
const { FundedSessionClient } = require("./koin-session-client");
const { createSessionReview } = require("./koin-session-review");
function readConfig(file) {
  if (fs.statSync(file).size > 16384) throw Error("Test manifest is too large");
  return configuration(JSON.parse(fs.readFileSync(file, "utf8")));
}
function save(file, value) {
  const temp = file + ".tmp", fd = fs.openSync(temp, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function registerTestPaymentIPC({ ipcMain, dialog, core, getMainWindow, origin, dataDir, isTest }) {
  const root = path.join(dataDir, "koin-foundation-test"), configFile = path.join(root, "deployment.json"), journals = path.join(root, "journals");
  let journal, payments, sessionClient, sessionId, sessionRun, access, chatAbort, sessionAbort, worker, workerAbort, workerTrack, stopVersion = 0, busy = false, disposed = false;
  const open = () => {
    if (disposed) throw Error("Test payments are closing");
    if (!payments) {
      const config = readConfig(configFile), client = new KoinChain(config.deployment);
      journal = new FundingRecovery(journals, { mode: config.mode, client, maxRcPerDay: config.maxRcPerDay });
      access = new TestAccess({ file: path.join(root, "test-access.enc"), config, wallet: core.account.wallet, settings: core.account.settings, safeStorage: core.account.safeStorage });
      payments = new TestPayments({ config, client, journal, wallet: core.account.wallet, dialog, authorizeHost: () => access.claimHost() });
    }
    return payments;
  };
  const getSession = async () => {
    const config = await open().session(); await access.claimHost(); if (!config) throw Error("Reserve a Test session and wait for irreversible confirmation first");
    if (sessionId !== config.session) {
      sessionClient = new FundedSessionClient({ config, file: path.join(root, "session-" + config.session + ".json"),
        authorize: (pin, signal) => access.authorize(pin, signal),
        sign: hash => core.account.wallet.signHash(hash) });
      sessionId = config.session;
      sessionRun = createSessionReview({ client: sessionClient, dialog, testDeployment: true,
        track: controller => { sessionAbort = controller; const release = core.gateway.network.trackShadowRequest(controller); return () => { release(); sessionAbort = null; }; } });
    }
    return sessionRun;
  };
  ipcMain.handle("koin:test-payments", async (event, action, input) => {
    const window = getMainWindow();
    if (!trustedMainDocument(event, window, origin)) throw Error("Desktop window access denied");
    if (!isTest) return { enabled: false, mode: "test-deployment" };
    if (typeof action !== "string" || JSON.stringify(input ?? null).length > 16384) throw Error("Invalid Test payment action");
    if (action === "stop") { stopVersion++; payments?.stop(); chatAbort?.abort(); sessionAbort?.abort(); return { state: "stopped", enabled: true, mode: "test-deployment" }; }
    if (busy || disposed) throw Error("Finish the open Test payment action first");
    busy = true; const activeVersion = stopVersion;
    const active = () => activeVersion === stopVersion && !disposed && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
    try {
      if (action === "status" && !fs.existsSync(configFile)) return { enabled: true, configured: false, mode: "test-deployment" };
      if (action === "import") {
        if (input !== undefined) throw Error("Choose the manifest with the native file picker");
        if (fs.existsSync(configFile)) throw Error("This Test deployment is already pinned. Changing deployments requires reviewed migration");
        const picked = await dialog.showOpenDialog(window, { title: "Choose public Test deployment manifest", filters: [{ name: "JSON", extensions: ["json"] }], properties: ["openFile"] });
        if (picked.canceled) return { state: "cancelled" };
        const config = readConfig(picked.filePaths[0]), client = new KoinChain(config.deployment); await client.verify();
        if (core.account.wallet.address !== config.owner) throw Error("Manifest belongs to a different wallet");
        const review = await dialog.showMessageBox(window, { type: "question", title: "Configure payment testing", message: "Use this Foundation testnet deployment?",
          detail: `Test wallet: ${config.owner}\nBackend: ${config.schedulerUrl}\nCredits: ${config.deployment.credits}\nRewards: ${config.deployment.rewards}\nModel: ${config.model}\n\nYour existing live profile remains in use. Payment tests use separate testnet contracts and journals. No transaction is signed by importing this file.`,
          buttons: ["Cancel", "Use Test deployment"], defaultId: 0, cancelId: 0, noLink: true });
        if (review.response !== 1 || !active()) return { state: "cancelled" };
        fs.mkdirSync(root, { recursive: true, mode: 0o700 }); save(configFile, config);
        return { enabled: true, configured: true, mode: "test-deployment" };
      }
      if (action === "restore") {
        if (input !== undefined) throw Error("Choose the backup with the native folder picker");
        const picked = await dialog.showOpenDialog(window, { title: "Choose Test journal backup", properties: ["openDirectory"] });
        if (picked.canceled) return { state: "cancelled" };
        const guard = new JournalSet(journals, { maintenance: true });
        try {
          const backup = guard.inspect(picked.filePaths[0]); if (!backup.restorable) throw Error("This backup predates newer activity and cannot safely replace the journals");
          const review = await dialog.showMessageBox(window, { type: "warning", title: "Restore Test journals", message: "Restore this current journal backup?",
            detail: `Backup: ${backup.id}\nCreated: ${new Date(backup.createdAt).toISOString()}\nPending transactions and approvals stay pending. Restore never unlocks or resubmits a payment.`,
            buttons: ["Cancel", "Restore journals"], defaultId: 0, cancelId: 0, noLink: true });
          if (review.response !== 1 || !active()) return { state: "cancelled" };
          payments?.stop(); journal?.close(); journal = null; payments = null;
          return { state: "restored", ...guard.restore(picked.filePaths[0]) };
        } finally { guard.close(); }
      }
      const controller = open();
      if (action === "worker-start" || action === "worker-stop") {
        if (input !== undefined) throw Error("Test worker controls take no arguments");
        if (action === "worker-stop") { workerAbort?.abort(); await worker?.stop(); workerTrack?.(); workerTrack = null; return { state: "test_worker_stopped" }; }
        if (worker?.running) return { state: "test_worker_running" };
        const config = readConfig(configFile); access.authorize(config.schedulerUrl);
        const answer = await dialog.showMessageBox(window, { type: "question", title: "Run Test inference worker", message: "Serve requests for this Test backend?",
          detail: `Backend: ${config.schedulerUrl}\nModel: ${config.model}\nWallet: ${config.owner}\n\nUses your installed models and hardware. Only funded Test jobs are accepted. Rewards are automatic; no payout signature is requested.`,
          buttons: ["Cancel", "Start Test worker"], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1 || !active()) return { state: "cancelled" };
        access.authorize(config.schedulerUrl);
        const { Worker } = require("../core/lib/worker");
        worker = new Worker({ schedulerUrl: config.schedulerUrl, wallet: core.account.wallet, runtime: core.runtime, hardware: core.hardware,
          models: core.models, koinFundedRehearsalJobs: true, koinShadowJobs: false, fundedOnly: true });
        workerAbort = new AbortController(); workerTrack = core.gateway.network.trackShadowRequest(workerAbort);
        workerAbort.signal.addEventListener("abort", () => worker.stop().catch(() => {}), { once: true });
        try { await worker.start(); workerAbort.signal.throwIfAborted(); return { state: "test_worker_running" }; }
        catch (e) { await worker.stop(); workerTrack(); workerTrack = null; throw e; }
      }
      if (action === "access") {
        if (input !== undefined) throw Error("Choose Test access with the native file picker");
        const picked = await dialog.showOpenDialog(window, { title: "Choose private Test access file", filters: [{ name: "JSON", extensions: ["json"] }], properties: ["openFile"] });
        if (picked.canceled) return { state: "cancelled" };
        if (fs.statSync(picked.filePaths[0]).size > 16384) throw Error("Test access file too large");
        return access.install(JSON.parse(fs.readFileSync(picked.filePaths[0], "utf8")));
      }
      if (["chat", "chat-retry", "chat-status"].includes(action)) {
        if (action !== "chat-status" && (typeof input !== "string" || !input.trim() || Buffer.byteLength(input) > 12000)) throw Error("Enter a Test prompt up to 12 KB");
        await getSession();
        const config = await controller.session(), file = path.join(root, "request-" + config.session + ".json");
        // Preserve old pending requests across an explicitly approved new session.
        const legacy = path.join(root, "last-request.json");
        if (!fs.existsSync(file) && fs.existsSync(legacy)) { const old = JSON.parse(fs.readFileSync(legacy, "utf8")); if (old.session === config.session) save(file, old); }
        if (action === "chat-status") {
          const pending = JSON.parse(fs.readFileSync(file, "utf8"));
          if (pending.session !== config.session) throw Error("Pending request belongs to another Test session");
          const result = await sessionClient.requestStatus(pending.id, AbortSignal.timeout(10000));
          if (["cancelled", "settled"].includes(result.state)) save(file, { ...pending, state: result.state });
          return { ...result, state: "request_" + result.state };
        }
        const requestHash = P.hash(input);
        let pending;
        if (action === "chat-retry") {
          pending = JSON.parse(fs.readFileSync(file, "utf8"));
          if (pending.session !== config.session || pending.requestHash !== requestHash) throw Error("Retry requires the original session and exact prompt");
          P.digest(pending.id);
        } else {
          if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).state === "pending") throw Error("Recover the pending request before starting another");
          pending = { id: crypto.randomBytes(32).toString("hex"), session: config.session, requestHash, state: "pending" }; save(file, pending);
        }
        chatAbort = new AbortController(); const stop = () => chatAbort?.abort();
        for (const event of ["hide", "minimize", "closed"]) window.on(event, stop);
        const tracked = core.gateway.network.trackShadowRequest(chatAbort);
        try {
          const answer = await sessionClient.consume({ schedulerUrl: config.schedulerUrl, messages: [{ role: "user", content: input }],
            model: config.model, maxOutput: config.maxOutput, requestId: pending.id, signal: AbortSignal.any([chatAbort.signal, AbortSignal.timeout(180000)]) });
          save(file, { ...pending, state: "complete" });
          return { state: "answered", requestId: pending.id, answer: answer.choices?.[0]?.message?.content || "", usage: answer.usage, koin: answer.koin };
        } finally { tracked(); for (const event of ["hide", "minimize", "closed"]) window.removeListener(event, stop); chatAbort = null; }
      }
      if (action === "backup") {
        if (input !== undefined) throw Error("Choose the backup location with the native folder picker");
        const picked = await dialog.showOpenDialog(window, { title: "Choose Test backup destination", properties: ["openDirectory", "createDirectory"] });
        if (picked.canceled) return { state: "cancelled" };
        const guard = new JournalSet(journals, { maintenance: true });
        try { const m = guard.snapshot(path.join(picked.filePaths[0], "koin-test-backup-" + Date.now())); return { state: "backed_up", id: m.id }; }
        finally { guard.close(); }
      }
      if (action === "payouts") {
        const config = readConfig(configFile), auth = access.authorize(config.schedulerUrl);
        const response = await fetch(config.schedulerUrl + "/koin/test/status", { redirect: "error", signal: AbortSignal.timeout(10000), headers: { authorization: "Bearer " + auth.sessionToken } });
        const chunks = []; let size = 0; for await (const part of response.body) { size += part.length; if (size > 65536) throw Error("Test payout response too large"); chunks.push(part); }
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!response.ok || value.mode !== "test-deployment" || value.mainnetPaymentsEnabled !== false || !Array.isArray(value.payouts)) throw Error("Test payout status unavailable");
        return { enabled: true, ...value, state: "payout_status" };
      }
      if (action === "status") return { worker: worker?.status() || null, configured: true, ...await controller.status(), session: await controller.session() };
      if (["session-review", "session-status", "session-retry", "session-revoke"].includes(action)) return (await getSession())(window, action.slice(8));
      if (!["purchase", "fund-rewards", "reserve", "refund", "revoke", "release", "check", "resume", "recover", "repair"].includes(action)) throw Error("Unknown Test payment action");
      return await controller.run(window, action, input);
    } finally { busy = false; }
  });
  return { dispose() { disposed = true; payments?.stop(); chatAbort?.abort(); sessionAbort?.abort(); workerAbort?.abort(); workerTrack?.(); /* In-flight signed bytes must finish staging before process exit. */ } };
}
module.exports = { registerTestPaymentIPC, readConfig };
