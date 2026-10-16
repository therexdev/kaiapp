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
const { ChatFlow } = require("./koin-chat-flow");
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
  const prepaidRoot = path.join(dataDir, "koin-prepaid-v1");
  let root = fs.existsSync(path.join(prepaidRoot, "deployment.json")) ? prepaidRoot : path.join(dataDir, "koin-foundation-test");
  let configFile = path.join(root, "deployment.json"), journals = path.join(root, "journals");
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
  const sessionPair = async wanted => {
    const config = await open().session(wanted); await access.claimHost(); if (!config) return null;
    if (sessionId !== config.session) {
      sessionClient = new FundedSessionClient({ config, mainnetPilot: readConfig(configFile).mode === "mainnet-pilot", file: path.join(root, "session-" + config.session + ".json"),
        authorize: (pin, signal) => access.authorize(pin, signal),
        sign: hash => core.account.wallet.signHash(hash) });
      sessionId = config.session;
      sessionRun = createSessionReview({ client: sessionClient, dialog, testDeployment: true, mainnetPilot: readConfig(configFile).mode === "mainnet-pilot",
        track: controller => { sessionAbort = controller; const release = core.gateway.network.trackShadowRequest(controller); return () => { release(); sessionAbort = null; }; } });
    }
    return { config, client: sessionClient, run: sessionRun };
  };
  const getSession = async () => { const pair = await sessionPair(); if (!pair) throw Error("Reserve a Test session and wait for irreversible confirmation first"); return pair.run; };
  const flow = window => {
    const config = readConfig(configFile), prepaid = config.deployment.product === "prepaid-v1";
    const Type = prepaid ? require("./koin-prepaid-chat").PrepaidChat : ChatFlow;
    return new Type({ file: path.join(root, prepaid ? "prepaid-chat-recovery.json" : "chat-recovery.json"), storage: core.account.safeStorage,
      payments: open(), session: sessionPair, config, access,
      progress: text => { if (!window.isDestroyed()) window.webContents.send("koin:chat-progress", { text }); } });
  };
  const withChatSignal = async (window, run) => {
    chatAbort = new AbortController(); const stop = () => chatAbort?.abort();
    const navigation = (_event, _url, _inPlace, mainFrame) => { if (mainFrame) stop(); };
    for (const event of ["hide", "minimize", "closed"]) window.on(event, stop);
    window.webContents.on("did-start-navigation", navigation); window.webContents.on("render-process-gone", stop);
    const release = core.gateway.network.trackShadowRequest(chatAbort);
    const signal = AbortSignal.any([chatAbort.signal, AbortSignal.timeout(600000)]);
    try { return await run(signal); }
    catch (error) {
      if (signal.aborted && readConfig(configFile).deployment.product === "prepaid-v1") throw Error("Chat stopped. Unused credits become available automatically; any saved answer can be recovered.");
      if (signal.aborted) throw Error(signal.reason?.name === "TimeoutError"
        ? "The network request timed out. Your saved payment and any pending request are preserved. Send the same message again to continue"
        : "Network chat stopped. Your saved payment and any pending request are preserved. Keep the app open and send the same message again to continue");
      throw error;
    }
    finally { release(); for (const event of ["hide", "minimize", "closed"]) window.removeListener(event, stop);
      window.webContents.removeListener("did-start-navigation", navigation); window.webContents.removeListener("render-process-gone", stop); chatAbort = null; }
  };
  ipcMain.handle("koin:test-payments", async (event, action, input) => {
    const window = getMainWindow();
    if (!trustedMainDocument(event, window, origin)) throw Error("Desktop window access denied");
    if (!isTest) return { enabled: false, mode: "test-deployment" };
    if (typeof action !== "string" || Buffer.byteLength(JSON.stringify(input ?? null)) > (action === "chat-completion" ? 26000 : 16384)) throw Error("Invalid Test payment action");
    if (action === "stop") { stopVersion++; payments?.stop(); chatAbort?.abort(); sessionAbort?.abort(); if (workerAbort && !worker?.running) workerAbort.abort(); return { state: "stopped", enabled: true, mode: fs.existsSync(configFile) ? readConfig(configFile).mode : "test-deployment" }; }
    if (action === "worker-stop") {
      if (input !== undefined) throw Error("Provider controls take no arguments");
      workerAbort?.abort(); await worker?.stop(); workerTrack?.(); workerTrack = null; return { state: "test_worker_stopped" };
    }
    if (action === "chat-info") {
      if (!fs.existsSync(configFile)) return { enabled: true, configured: false };
      const config = readConfig(configFile); open(); let blocked = "";
      try { access.authorize(config.schedulerUrl); } catch (e) { blocked = String(e.message).slice(0, 220); }
      const recovery = flow(window).read();
      return { product: config.deployment.product || "legacy-reservations", enabled: true, configured: true, model: config.model, mode: config.mode, maxOutput: config.maxOutput, blocked,
        recoveryAvailable: !blocked && ["pending", "answered"].includes(recovery?.state) };
    }
    if (action === "provider-status") {
      if (!fs.existsSync(configFile) || !worker?.running) return { state: "offline", label: "OFFLINE", detail: "Turn on to provide AI to the network." };
      const config = readConfig(configFile); access.authorize(config.schedulerUrl);
      if (worker.status().backoff) return { state: "paused", label: "PAUSED", detail: worker.status().backoffReason || "This computer is busy." };
      return require("./koin-provider-status").readProviderStatus({ config, access, signal: AbortSignal.timeout(10000) });
    }
    if (busy || disposed) throw Error("Finish the open Test payment action first");
    busy = true; const activeVersion = stopVersion;
    const active = () => activeVersion === stopVersion && !disposed && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
    try {
      if (action === "status" && !fs.existsSync(configFile)) return { enabled: true, configured: false, mode: "test-deployment" };
      if (action === "connect-prepaid") {
        if (purchaseSync) throw Error("Purchase confirmation is finishing. Try connecting again in a moment.");
        if (input !== undefined) throw Error("Choose the prepaid connection with the native picker");
        if (root === prepaidRoot && fs.existsSync(configFile)) throw Error("Your prepaid account is already connected");
        const picked = await dialog.showOpenDialog(window, { title: "Connect prepaid AI credits", filters: [{ name: "JSON", extensions: ["json"] }], properties: ["openFile"] });
        if (picked.canceled) return { state: "cancelled" };
        const next = readConfig(picked.filePaths[0]);
        if (next.deployment.product !== "prepaid-v1" || next.owner !== core.account.wallet.address) throw Error("Prepaid connection must match this wallet");
        const previous = fs.existsSync(configFile) ? readConfig(configFile) : null;
        if (previous && (previous.deployment.credits === next.deployment.credits || previous.deployment.rewards === next.deployment.rewards)) throw Error("Prepaid uses separate contracts; legacy balances must be preserved");
        if (previous) {
          open();
          for (const tx of journal.nonceCoordinator.list().filter(t => ["signing", "signed"].includes(t.state))) await journal.nonceCoordinator.reconcile(tx.id);
          if (journal.nonceCoordinator.list().some(t => ["signing", "signed"].includes(t.state))) throw Error("A previous wallet purchase is still being confirmed. Its records must finish reconciling before switching payment contracts.");
        }
        await new KoinChain(next.deployment).verify();
        const answer = await dialog.showMessageBox(window, { type: "question", title: "Connect prepaid credits", message: "Use the new Buy credits → Chat account?",
          detail: `Wallet: ${next.owner}\nService: ${next.schedulerUrl}\nCredits contract: ${next.deployment.credits}\n\nNew purchases buy nonrefundable credits. Your old KOIN balances and payment records stay in the original account. Connecting does not transfer them or approve any payment.`,
          buttons: ["Cancel", "Connect prepaid credits"], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1 || !active()) return { state: "cancelled" };
        workerAbort?.abort(); await worker?.stop(); workerTrack?.(); workerTrack = null; worker = null;
        payments?.stop(); journal?.close(); payments = journal = sessionClient = sessionRun = access = null; sessionId = null;
        fs.mkdirSync(prepaidRoot, { recursive: true, mode: 0o700 });
        save(path.join(prepaidRoot, "deployment.json"), next);
        root = prepaidRoot; configFile = path.join(root, "deployment.json"); journals = path.join(root, "journals");
        open(); return { enabled: true, configured: true, product: "prepaid-v1", mode: next.mode, state: "prepaid_connected" };
      }
      if (action === "import") {
        if (input !== undefined) throw Error("Choose the manifest with the native file picker");
        if (fs.existsSync(configFile)) throw Error("This Test deployment is already pinned. Use Refresh to reload your existing account. Changing deployments requires reviewed migration");
        const picked = await dialog.showOpenDialog(window, { title: "Choose public Test deployment manifest", filters: [{ name: "JSON", extensions: ["json"] }], properties: ["openFile"] });
        if (picked.canceled) return { state: "cancelled" };
        const config = readConfig(picked.filePaths[0]), client = new KoinChain(config.deployment); await client.verify();
        if (core.account.wallet.address !== config.owner) throw Error("Manifest belongs to a different wallet");
        const review = await dialog.showMessageBox(window, { type: "question", title: "Configure payment testing", message: config.mode === "mainnet-pilot" ? "Use this MAINNET deployment with real KOIN?" : "Use this Foundation testnet deployment?",
          detail: `Test wallet: ${config.owner}\nBackend: ${config.schedulerUrl}\nCredits: ${config.deployment.credits}\nRewards: ${config.deployment.rewards}\nModel: ${config.model}\nChain: ${config.deployment.chainId}\n\n${config.mode === "mainnet-pilot" ? "MAINNET: payments and rewards use real KOIN. Each deposit and spending approval requires a native review." : "Foundation testnet: payments and rewards use test KOIN."} Your existing profile remains in use. No transaction is signed by importing this file.`,
          buttons: ["Cancel", config.mode === "mainnet-pilot" ? "Use mainnet pilot" : "Use Test deployment"], defaultId: 0, cancelId: 0, noLink: true });
        if (review.response !== 1 || !active()) return { state: "cancelled" };
        if (config.deployment.product === "prepaid-v1") { root = prepaidRoot; configFile = path.join(root, "deployment.json"); journals = path.join(root, "journals"); }
        fs.mkdirSync(root, { recursive: true, mode: 0o700 }); save(configFile, config);
        return { enabled: true, configured: true, mode: config.mode, mainnetPaymentsEnabled: config.mode === "mainnet-pilot" };
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
      if (["chat-completion", "chat-ack", "chat-recover"].includes(action)) {
        const config = readConfig(configFile); access.authorize(config.schedulerUrl);
        if (!active()) throw Error("Return to the visible desktop window to chat");
        if (action === "chat-ack") { flow(window).acknowledge(input); return { state: "delivered" }; }
        if (action === "chat-recover") {
          if (input !== undefined) throw Error("Recovery uses the saved request");
          return await withChatSignal(window, signal => flow(window).recover(window, signal));
        }
        // Previous diagnostic requests must be resolved before the normal
        // composer can start a different request against this account.
        for (const name of (config.deployment.product === "prepaid-v1" ? [] : fs.readdirSync(root)).filter(n => /^request-[a-f0-9]{64}\.json$/.test(n) || n === "last-request.json")) {
          const old = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
          if (old.state !== "pending") continue;
          const pair = await sessionPair(P.digest(old.session));
          if (!pair) throw Error("An earlier diagnostic request needs recovery in your network account");
          const result = await pair.client.requestStatus(P.digest(old.id), AbortSignal.timeout(10000));
          if (!["cancelled", "settled"].includes(result.state)) throw Error("An earlier diagnostic request is still pending. Check it under Advanced & recovery before starting a new chat");
          save(path.join(root, name), { ...old, state: result.state });
        }
        return await withChatSignal(window, signal => flow(window).chat(window, input, signal));
      }
      if (action === "worker-start" || action === "worker-stop") {
        if (input !== undefined) throw Error("Test worker controls take no arguments");
        if (action === "worker-stop") { workerAbort?.abort(); await worker?.stop(); workerTrack?.(); workerTrack = null; return { state: "test_worker_stopped" }; }
        if (worker?.running) return { state: "test_worker_running" };
        const config = readConfig(configFile); access.authorize(config.schedulerUrl); await access.claimHost();
        const answer = await dialog.showMessageBox(window, { type: "question", title: "Run Test inference worker", message: "Serve requests for this Test backend?",
          detail: `Backend: ${config.schedulerUrl}\nModel: ${config.model}\nWallet: ${config.owner}\n\nUses your installed models and hardware. Pauses the older earning worker on this computer so only this connection uses its AI capacity. ${config.mode === "mainnet-pilot" ? "MAINNET: funded jobs and rewards use real KOIN." : "Foundation testnet: jobs and rewards use test KOIN."} Rewards are automatic; no payout signature is requested.`,
          buttons: ["Cancel", "Start Test worker"], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1 || !active()) return { state: "cancelled" };
        access.authorize(config.schedulerUrl);
        if (core.gateway.earn?.stop) await core.gateway.earn.stop({ userIntent: true });
        const { Worker } = require("../core/lib/worker");
        worker = new Worker({ schedulerUrl: config.schedulerUrl, wallet: core.account.wallet, runtime: core.runtime, hardware: core.hardware,
          models: core.models, koinFundedRehearsalJobs: config.mode === "test-deployment", koinShadowJobs: false, fundedOnly: true,
          koinMainnetPilotJobs: config.mode === "mainnet-pilot", koinMainnetTarget: { chainId: config.deployment.chainId, credits: config.deployment.credits, creditsHash: config.deployment.creditsHash,
            policyHash: config.policyHash, domain: require("../core/lib/koin-network/payment-mode").testDomain(config.deployment, config.schedulerUrl) } });
        workerAbort = new AbortController(); workerTrack = core.gateway.network.trackShadowRequest(workerAbort);
        workerAbort.signal.addEventListener("abort", () => worker.stop().catch(() => {}), { once: true });
        try {
          const hold = await core.runtime.acquireFor(config.model); hold.release(); workerAbort.signal.throwIfAborted();
          if (!active()) throw Error("Provider startup cancelled; return to the app and turn it on again");
          await worker.start(); workerAbort.signal.throwIfAborted(); return { state: "test_worker_running" };
        }
        catch (e) { await worker.stop(); workerTrack?.(); workerTrack = null; throw e; }
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
        if (!response.ok || value.mode !== config.mode || value.mainnetPaymentsEnabled !== (config.mode === "mainnet-pilot") || !Array.isArray(value.payouts)) throw Error("Test payout status unavailable");
        return { enabled: true, ...value, state: "payout_status" };
      }
      if (action === "status") {
        let accessReady = false;
        try { access.authorize(readConfig(configFile).schedulerUrl); accessReady = true; } catch { /* Missing invitation, locked storage or offline mode. */ }
        const cfg = readConfig(configFile);
        if (cfg.deployment.product === "prepaid-v1" && accessReady) {
          const credit = await flow(window).status();
          return { enabled: true, configured: true, accessReady, product: "prepaid-v1", owner: cfg.owner, mode: cfg.mode,
            mainnetPaymentsEnabled: cfg.mode === "mainnet-pilot", worker: worker?.status() || null, session: null,
            credits: credit.balance, purchases: credit.purchases, usage: credit.usage, purchasePending: !!controller.pendingPurchase() };
        }
        const status = await controller.status();
        return { worker: worker?.status() || null, configured: true, accessReady, ...status, session: await controller.session() };
      }
      if (["session-review", "session-status", "session-retry", "session-revoke"].includes(action)) return (await getSession())(window, action.slice(8));
      if (!["purchase", "purchase-retry", "fund-rewards", "reserve", "refund", "revoke", "release", "check", "resume", "recover", "repair", "correct-mana"].includes(action)) throw Error("Unknown Test payment action");
      if (["purchase", "purchase-retry"].includes(action)) return await withChatSignal(window, async signal => {
        const result = await controller.run(window, action, input); signal.throwIfAborted();
        if (result.state === "cancelled") return result;
        if (readConfig(configFile).deployment.product === "prepaid-v1") {
          if (result.deposit?.txId) await flow(window).call("purchase", { txId: result.deposit.txId }, signal).catch(() => {});
          return { ...result, product: "prepaid-v1", state: result.status === "cancelled" ? "cancelled" : !result.deposit ? "purchase_unavailable" : "purchase_pending" };
        }
        return await flow(window).confirm(window, result, signal);
      });
      return await controller.run(window, action, input);
    } finally { busy = false; }
  });
  let purchaseSync = false;
  const purchaseTimer = setInterval(async () => {
    if (disposed || busy || purchaseSync || !payments || readConfig(configFile).deployment.product !== "prepaid-v1") return;
    const window = getMainWindow(); if (!window || window.isDestroyed()) return;
    purchaseSync = true; const abort = new AbortController(), untrack = core.gateway.network.trackShadowRequest(abort);
    try {
      access.authorize(readConfig(configFile).schedulerUrl, abort.signal);
      await payments.syncPurchases((txId, signal) => flow(window).call("purchase", { txId }, signal), AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]));
    } catch { /* Existing credits and chat remain independent of RPC recovery. */ }
    finally { untrack(); purchaseSync = false; }
  }, 10000); purchaseTimer.unref();
  return { isProviding: () => !!worker?.running, dispose() { disposed = true; clearInterval(purchaseTimer); payments?.stop(); chatAbort?.abort(); sessionAbort?.abort(); workerAbort?.abort(); workerTrack?.(); /* In-flight signed bytes must finish staging before process exit. */ } };
}
module.exports = { registerTestPaymentIPC, readConfig };
