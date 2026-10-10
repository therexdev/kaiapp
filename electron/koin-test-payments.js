"use strict";
// Test-only private controller. Renderer input chooses a narrow action/amount,
// never a transaction, contract, key, RPC endpoint or signing callback.
const crypto = require("crypto");
const { utils, Transaction } = require("koilib");
const { encodedAddress } = require("../core/lib/koin-network/chain");
const { assertPaymentMode, testDomain } = require("../core/lib/koin-network/payment-mode");
const { hash, digest } = require("../core/lib/koin-network/job-protocol");
const { createFundingApproval } = require("./koin-funding-approval");
const { atoms } = require("./koin-test-config");
const { koin } = require("./koin-review");
const { simulateFunding } = require("../core/lib/koin-network/mana-preflight");
const enc = hex => utils.encodeBase64url(Buffer.from(hex, "hex"));
const terminal = s => ["finalized", "reverted", "consumed_elsewhere"].includes(s);
async function submissionResponse(promise, signal) {
  let timer, aborted;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      aborted = () => reject(Error("Submission response unavailable"));
      timer = setTimeout(aborted, 30000);
      if (signal.aborted) aborted(); else signal.addEventListener("abort", aborted, { once: true });
    })]);
  } finally { clearTimeout(timer); signal.removeEventListener("abort", aborted); }
}
class TestPayments {
  #config; #client; #journal; #wallet; #dialog; #funding; #task; #clock; #authorizeHost;
  constructor({ config, client, journal, wallet, dialog, clock = Date.now, authorizeHost = null }) {
    assertPaymentMode(config.mode, client); journal.assertMode(config.mode); journal.assertClient(client);
    if (config.mode !== "isolated-rehearsal" && typeof authorizeHost !== "function") throw Error("Test signing requires a persistent host lease");
    this.#authorizeHost = authorizeHost;
    this.#config = structuredClone(config); this.#client = client; this.#journal = journal; this.#wallet = wallet; this.#dialog = dialog; this.#clock = clock;
    this.#funding = createFundingApproval({ mode: config.mode, client, journal, dialog, clock, timeoutMs: 30000,
      sign: async d => this.#sign(d.transaction), submit: async (d, { signal }) => {
        if (config.mode === "mainnet-pilot") await simulateFunding(client, d.transaction, d.intent);
        signal.throwIfAborted();
        const id = journal.nonceCoordinator.list().find(r => r.txId === d.transaction.id)?.id;
        if (!id) throw Error("Missing Test nonce reservation");
        journal.nonceCoordinator.authorizeSubmission(id, { maxRcPerDay: config.maxRcPerDay });
        return client.submit(d.transaction, d.intent, { signal });
      } });
  }
  #owner() { if (this.#wallet.address !== this.#config.owner) throw Error("Unlock the wallet named in the Test manifest"); return this.#config.owner; }
  async #sign(tx) {
    this.#owner(); const signer = this.#wallet.signer;
    if (signer.getAddress() !== this.#config.owner) throw Error("Test wallet changed");
    const signed = structuredClone(tx); await signer.signTransaction(signed); return signed;
  }
  stop() { if (this.#task) { this.#task.stopped = true; this.#task.abort.abort(); } this.#funding.cancel(); }
  async status() {
    const owner = this.#owner(), config = await this.#client.verify();
    const balances = await this.#client.read("credits", "balances", { account: encodedAddress(owner) });
    return { enabled: true, mode: this.#config.mode, mainnetPaymentsEnabled: this.#config.mode === "mainnet-pilot", owner, paused: !!config.paused,
      balances: { available: balances.balance?.available || "0", reserved: balances.balance?.reserved || "0" },
      deposits: this.#journal.list(), transactions: this.#journal.nonceCoordinator.list(),
      automaticPayouts: true, payoutNotice: "Rewards are sent automatically after the daily review and irreversible confirmation." };
  }
  async #scope(draft) {
    if (draft.operations?.length !== 1 || draft.operations[0].call_contract?.contract_id !== this.#client.d.credits) throw Error("Saved Test credit operation required");
    const op = draft.operations[0].call_contract, abi = require("../core/lib/koin-network/credits-abi.json");
    const method = ["refund", "reserve", "revoke", "release"].find(m => abi.methods[m].entry_point === op.entry_point);
    if (!method) throw Error("Unsupported Test credit action");
    const args = await this.#client.serializer.deserialize(op.args, "koin.Request");
    const request = { kind: "credits", method, args, actor: this.#owner(), maxRc: this.#config.maxRcPerTransaction };
    await this.#client.verifyTransaction(draft, request); return request;
  }
  async session() {
    // Restore session identity and limits from the actual reserved transaction,
    // not a replaceable config or a scheduler-provided transaction template.
    for (const item of this.#journal.nonceCoordinator.list()) if (item.purpose === "credits" && item.state === "finalized") {
      const request = await this.#scope(this.#journal.nonceCoordinator.draft(item.id));
      if (request.method !== "reserve") continue;
      const s = request.args.session, session = Buffer.from(s.id, "base64url").toString("hex");
      const state = await this.#client.read("credits", "get_session", { id: s.id });
      if (!state.session || state.session.closed || BigInt(state.session.revoked_at || "0") > 0n || Number(s.expires) <= this.#clock()) return null;
      return { schedulerUrl: this.#config.schedulerUrl,
        target: { chainId: this.#client.d.chainId, credits: this.#client.d.credits, creditsHash: this.#client.d.creditsHash,
          domain: testDomain(this.#client.d, this.#config.schedulerUrl), policyHash: this.#config.policyHash }, session,
        model: this.#config.model, version: this.#config.version, maxOutput: this.#config.maxOutput,
        amount: s.remaining, perJob: s.per_job, maxJobs: Number(s.max_jobs), expires: Number(s.expires) };
    }
    return null;
  }
  async #request(action, input) {
    const c = this.#config, owner = this.#owner(); let args;
    if (action === "refund") {
      const amount = atoms(input), b = await this.#client.read("credits", "balances", { account: encodedAddress(owner) });
      if (BigInt(amount) > BigInt(b.balance?.available || "0")) throw Error("Refund exceeds available credits. Reserved credits must first be released after the settlement window");
      args = { account: encodedAddress(owner), amount };
    } else if (action === "reserve") {
      if (input !== undefined) throw Error("Session limits come from the Test manifest");
      if (await this.session()) throw Error("Use or revoke the current session before opening another");
      const { config } = await this.#client.read("credits", "config");
      if (String(config?.version) !== String(c.version)) throw Error("Test policy version changed");
      args = { session: { id: enc(crypto.randomBytes(32).toString("hex")), owner: encodedAddress(owner), verifier: encodedAddress(c.deployment.verifier),
        policy_hash: enc(c.policyHash), remaining: c.limits.amount, per_job: c.limits.perJob, max_jobs: String(c.limits.maxJobs), expires: String(this.#clock() + c.limits.durationMs) } };
    } else if (["revoke", "release"].includes(action)) {
      digest(input); const { session } = await this.#client.read("credits", "get_session", { id: enc(input) });
      if (!session || session.owner !== encodedAddress(owner) || session.closed) throw Error("Open session owned by this wallet required");
      if (action === "release" && this.#clock() <= Number(session.settle_until)) throw Error("Wait until the session settlement window ends before releasing credits");
      args = { id: enc(input) };
    } else throw Error("Unknown Test credit action");
    return { kind: "credits", method: action, args, actor: owner, maxRc: c.maxRcPerTransaction };
  }
  async #correctMana(window, id, guard) {
    digest(id);
    const journal = this.#journal, nonces = journal.nonceCoordinator, saved = journal.saved(id);
    if (!saved?.signed || saved.intent.kind !== "credits" || saved.intent.method !== "purchase" ||
        saved.intent.actor !== this.#owner() || BigInt(saved.intent.args.amount) > BigInt(this.#config.limits.amount))
      throw Error("Select the saved credit deposit owned by this wallet");
    const result = (state, extra = {}) => ({ ...nonces.status(id), ...(state ? { state } : {}),
      funding: { state: journal.status(id).state, attempts: journal.status(id).attempts }, ...extra });
    const settled = async () => {
      await nonces.reconcile(id); guard();
      if (!terminal(nonces.status(id).state)) return false;
      await this.#funding.check(id); guard(); return true;
    };
    if (await settled()) return result();
    journal.hold(id);
    let correction = nonces.correction(id);
    if (correction && !correction.transaction)
      throw Error("The Mana correction has a saved signing fence. Check confirmation; signing it again is blocked");
    // A separate native review permits a bounded exception to this deposit's
    // old cap. It does not rewrite the manifest or change any daily policy.
    const ceiling = BigInt(this.#config.maxRcPerDay) < 900000000n ? this.#config.maxRcPerDay : "900000000";
    if (!correction && BigInt(ceiling) <= BigInt(saved.intent.maxRc)) throw Error("No higher Mana cap fits the existing daily limit");
    const draft = correction?.draft || await Transaction.prepareTransaction({
      header: { ...saved.draft.header, rc_limit: ceiling }, operations: structuredClone(saved.draft.operations), signatures: [] });
    const request = { ...saved.intent, maxRc: draft.header.rc_limit };
    await this.#client.verifyTransaction(draft, request);
    const unchanged = async () => {
      const policy = await this.#client.verify();
      if (policy.paused || hash(JSON.stringify(policy)) !== saved.policyHash)
        throw Error("Deposit policy changed or paused; keep the saved transactions for recovery");
      if (await this.#client.provider.getNextNonce(request.actor) !== saved.draft.header.nonce)
        throw Error("The account nonce changed. Check confirmation before continuing");
      const lookup = await this.#client.provider.getTransactionsById([saved.draft.id]);
      if (!lookup || lookup.error || lookup.rpc_error || (lookup.transactions !== undefined && !Array.isArray(lookup.transactions)))
        throw Error("Original transaction lookup is unavailable");
      if ((lookup.transactions || []).some(r => r.transaction?.id === saved.draft.id))
        throw Error("The original deposit is reported by the node. Check confirmation before correcting it");
      guard();
    };
    await unchanged();
    const mainnet = this.#config.mode === "mainnet-pilot";
    const answer = await this.#dialog.showMessageBox(window, { type: "warning", title: "Review deposit Mana correction",
      message: correction ? "Resume this saved Mana correction?" : "Approve a higher Mana cap for this same deposit?",
      detail: [mainnet ? "MAINNET: this deposit uses real KOIN." : "Isolated or testnet deposit.",
        `Unchanged deposit: ${koin(saved.intent.args.amount)}`, `Wallet: ${request.actor}`, `Credits contract: ${this.#client.d.credits}`,
        `Original Mana cap: ${koin(saved.intent.maxRc).replace(" KOIN", " Mana")}`,
        `Corrected Mana cap: ${koin(request.maxRc).replace(" KOIN", " Mana")}`, `Daily resource limit: ${this.#config.maxRcPerDay} resource credits`,
        "The Mana cap is a maximum for regenerating resources, not an additional KOIN transfer or an estimate of the actual cost.",
        `Original transaction: ${saved.draft.id}`, `Corrected transaction: ${draft.id}`, `Unchanged nonce: ${draft.header.nonce}`, `Chain: ${draft.header.chain_id}`,
        "The amount, operations and nonce stay identical. Only one version can execute. Both versions remain saved until irreversible confirmation.",
        correction ? "Resends only the saved correction. No new signature." : "Approves one new signature for this exact correction.",
        "Simulation must succeed with resource headroom before submission. Stop cannot undo a transaction already sent."].join("\n"),
      buttons: ["Cancel", correction ? "Resume saved correction" : "Approve Mana correction"], defaultId: 0, cancelId: 0, noLink: true });
    guard(); if (answer.response !== 1) return result("cancelled");
    if (await settled()) return result();
    await unchanged();
    if (!correction) {
      const decision = await nonces.reserveCorrection(id, draft, () => { try { guard(); return true; } catch { return false; } });
      if (decision.action === "sign_original") {
        guard(); const signed = await this.#sign(draft);
        await nonces.stageCorrection(id, signed); // Persist even if Stop arrived while signing.
      }
      correction = nonces.correction(id);
    }
    guard();
    if (!correction?.transaction) throw Error("Recover the saved correction signature before continuing");
    let simulation;
    try { simulation = await simulateFunding(this.#client, correction.transaction, request); }
    catch (error) {
      guard(); return result("correction_simulation_failed", { reason: error.code === "funding_insufficient_rc" ? "funding_insufficient_rc" : "funding_simulation_failed" });
    }
    guard(); if (await settled()) return result();
    await unchanged();
    const transaction = nonces.authorizeCorrectionSubmission(id, { maxRcPerDay: this.#config.maxRcPerDay });
    guard();
    let reason = null;
    try { await submissionResponse(this.#client.submit(transaction, request, { signal: this.#task.abort.signal }), this.#task.abort.signal); }
    catch { reason = "funding_submission_uncertain"; }
    return result("correction_await_finality", { reason, simulation });
  }
  async run(window, action, input) {
    if (this.#task) throw Error("A Test payment action is already open");
    const visible = () => window && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
    if (!visible()) throw Error("Visible Test window required");
    const task = this.#task = { stopped: false, abort: new AbortController() }, started = this.#clock();
    const stop = () => this.stop(), navigation = (_e, _url, _inPlace, main) => { if (main) stop(); };
    const guard = () => { if (task.stopped || !visible() || this.#clock() < started || this.#clock() >= started + 180000) throw Error("Test payment action stopped"); this.#owner(); };
    const timer = setTimeout(stop, 180000);
    for (const event of ["hide", "minimize", "closed"]) window.on(event, stop);
    window.webContents.on("did-start-navigation", navigation); window.webContents.on("render-process-gone", stop);
    try {
      this.#owner(); guard();
      if (["purchase", "fund-rewards", "reserve", "refund", "revoke", "release", "resume", "correct-mana"].includes(action)) { await this.#authorizeHost?.(); guard(); }
      if (["purchase", "fund-rewards", "reserve", "refund", "revoke", "release"].includes(action) && this.#wallet.signer.getAddress() !== this.#owner()) throw Error("Unlock the configured Test wallet");
      if (action === "purchase" || action === "fund-rewards") {
        const amount = atoms(input), kind = action === "purchase" ? "credits" : "rewards";
        if (BigInt(amount) > BigInt(this.#config.limits.amount)) throw Error("Deposit exceeds the configured Test limit");
        return await this.#funding.approve(window, hash(crypto.randomBytes(32)), () => ({ kind, method: kind === "credits" ? "purchase" : "fund",
          actor: this.#owner(), args: { account: encodedAddress(this.#owner()), amount }, maxRc: this.#config.maxRcPerTransaction }));
      }
      const nonces = this.#journal.nonceCoordinator;
      if (action === "correct-mana") return await this.#correctMana(window, digest(input), guard);
      if (["check", "resume", "recover", "repair"].includes(action)) {
        const id = typeof input === "string" ? input : input?.id; digest(id);
        if (action === "check") {
          const n = await nonces.reconcile(id);
          if (n.purpose === "funding") {
            const checked = await this.#funding.check(id);
            const deposit = this.#journal.status(id);
            return { ...nonces.status(id), funding: { action: checked.action, reason: checked.reason ?? null,
              state: deposit.state, attempts: deposit.attempts } };
          }
          return n;
        }
        if (action === "recover") {
          const n = await nonces.recoverOriginal(id, input.txId); guard();
          if (n.purpose === "funding") await this.#funding.check(id); return n;
        }
        if (action === "repair") {
          const review = await nonces.reviewConsumed(id, input.txId); guard();
          const answer = await this.#dialog.showMessageBox(window, { type: "warning", title: "Repair Test transaction",
            message: "Mark this request as conflicted?", detail: `Another irreversible transaction consumed the reserved nonce. This does not mark the original payment successful.\n\nWallet: ${review.owner}\nOriginal: ${review.originalTxId}\nConsuming transaction: ${review.consumingTxId}\nIrreversible block: ${review.finality.blockId}`,
            buttons: ["Cancel", "Record conflict"], defaultId: 0, cancelId: 0, noLink: true });
          guard(); if (answer.response !== 1) return { state: "cancelled" };
          const n = await nonces.repairConsumed(review); if (n.purpose === "funding") await this.#funding.check(id); return n;
        }
        if (nonces.status(id).purpose === "funding") {
          if (nonces.correction(id)) return await this.#correctMana(window, id, guard);
          return await this.#funding.resume(window, id, () => this.#journal.saved(id).intent);
        }
      }
      let id, draft, request, fresh = action !== "resume";
      if (fresh) {
        request = await this.#request(action, input); guard();
        draft = await this.#client.prepare("credits", request.method, request.args, { actor: request.actor, rcLimit: request.maxRc }); id = hash(draft.id);
      } else {
        id = digest(input); const status = nonces.status(id);
        if (terminal(status.state)) return status;
        if (!nonces.envelope(id)) throw Error("Recover the original signed transaction from chain history; signing again is forbidden");
        draft = nonces.draft(id); request = await this.#scope(draft);
      }
      guard(); const config = await this.#client.verify(); guard();
      const args = request.args, s = args.session, mainnet = this.#config.mode === "mainnet-pilot";
      const display = n => koin(n) + (mainnet ? " (mainnet)" : " (testnet)");
      const detail = [mainnet ? "MAINNET: real KOIN. This approval can spend real funds." : "Foundation testnet tokens only.", `Action: ${request.method}`, `Wallet: ${request.actor}`,
        ...(args.amount ? [`Amount: ${display(args.amount)}`] : []),
        ...(s ? [`Session budget: ${display(s.remaining)}`, `Per request: ${display(s.per_job)}`, `Maximum requests: ${s.max_jobs}`, `Expires: ${new Date(Number(s.expires)).toISOString()}`, `Model: ${this.#config.model}`] : []),
        ...(args.id ? [`Session: ${Buffer.from(args.id, "base64url").toString("hex")}`] : []),
        "Revocation stops new work; reserved credits remain locked through the settlement window.",
        `Chain: ${this.#client.d.chainId}`, `Contract: ${this.#client.d.credits}`, `Code: ${this.#client.d.creditsHash}`,
        `Maximum resource credits: ${request.maxRc}`, `Transaction: ${draft.id}`, `Nonce: ${draft.header.nonce}`,
        fresh ? "Approve one exact signature and submission." : "Resend the saved transaction without signing again.", "Stop cannot undo a transaction already sent."].join("\n");
      const answer = await this.#dialog.showMessageBox(window, { type: "question", title: mainnet ? "Review real KOIN payment" : "Review Test payment", message: `Approve ${mainnet ? "mainnet" : "testnet"} ${request.method}?`, detail,
        buttons: ["Cancel", fresh ? (mainnet ? "Approve mainnet transaction" : "Approve Test transaction") : "Resend saved transaction"], defaultId: 0, cancelId: 0, noLink: true });
      guard(); if (answer.response !== 1) return { state: "cancelled" };
      if (JSON.stringify(config) !== JSON.stringify(await this.#client.verify()) || await this.#client.provider.getNextNonce(request.actor) !== draft.header.nonce) throw Error("Chain policy or wallet nonce changed; refresh the review");
      guard();
      if (fresh) {
        const decision = await nonces.reserve(id, "credits", draft, () => { try { guard(); return true; } catch { return false; } });
        if (decision.action !== "sign_original") return nonces.status(id);
        guard(); const tx = await this.#sign(draft); await nonces.stage(id, tx); // Preserve even a late signature.
      }
      guard(); const tx = nonces.authorizeSubmission(id, { maxRcPerDay: this.#config.maxRcPerDay }); guard();
      try { await this.#client.submit(tx, request); } catch { /* Persisted envelope remains uncertain. */ }
      return nonces.status(id);
    } finally {
      clearTimeout(timer); task.abort.abort(); for (const event of ["hide", "minimize", "closed"]) window.removeListener(event, stop);
      window.webContents.removeListener("did-start-navigation", navigation); window.webContents.removeListener("render-process-gone", stop); this.#task = null;
    }
  }
}
module.exports = { TestPayments };
