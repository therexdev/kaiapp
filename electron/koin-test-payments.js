"use strict";
const { isPrepaid, isUsd } = require("../core/lib/koin-network/product");
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
  #config; #client; #journal; #wallet; #dialog; #funding; #task; #clock; #authorizeHost; #purchaseQuote; #syncing = false; #syncAbort; #registeredPurchases = new Set();
  constructor({ config, client, journal, wallet, dialog, clock = Date.now, authorizeHost = null, purchaseQuote = null }) {
    assertPaymentMode(config.mode, client); journal.assertMode(config.mode); journal.assertClient(client);
    if (config.mode !== "isolated-rehearsal" && typeof authorizeHost !== "function") throw Error("Test signing requires a persistent host lease");
    this.#authorizeHost = authorizeHost; this.#purchaseQuote = purchaseQuote;
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
  stop() { this.#syncAbort?.abort(); if (this.#task) { this.#task.stopped = true; this.#task.abort.abort(); } this.#funding.cancel(); }
  #creditStatus(status, reason) {
    if (status.purpose !== "credits") return status;
    const draft = this.#journal.nonceCoordinator.draft(status.id), op = draft.operations?.length === 1 && draft.operations[0].call_contract;
    const methods = require("../core/lib/koin-network/credits-abi.json").methods;
    const creditAction = op?.contract_id === this.#client.d.credits &&
      ["refund", "reserve", "revoke", "release"].find(method => methods[method].entry_point === op.entry_point);
    return { ...status, ...(creditAction ? { creditAction } : {}), ...(reason ? { reason } : {}) };
  }
  async #checkCredit(id, guard) {
    const nonces = this.#journal.nonceCoordinator, p = this.#client.provider;
    let reason;
    try {
      const status = await nonces.reconcile(id); guard();
      if (status.state !== "signed") return this.#creditStatus(status);
      // This is a recovery hint, not proof that the nonce is free. Resuming
      // still requires native review and the original nonce/policy checks.
      const generation = p.readGeneration, lookup = await p.getTransactionsById([status.txId]); guard();
      if (!lookup || typeof lookup !== "object" || Array.isArray(lookup) || lookup.error || lookup.rpc_error ||
          (lookup.transactions !== undefined && !Array.isArray(lookup.transactions))) throw Error("Unavailable transaction lookup");
      const records = lookup.transactions || [];
      if (records.length > 1 || records.some(record => record?.transaction?.id !== status.txId)) throw Error("Unexpected transaction lookup");
      if (records.length) reason = "credit_await_finality";
      else reason = await p.getNextNonce(status.owner) === status.nonce ? "credit_saved_review_required" : "credit_nonce_changed";
      guard();
      if (p.readGeneration !== generation) throw Error("RPC changed during confirmation reads");
    } catch {
      guard(); reason = "credit_confirmation_unavailable";
    }
    return this.#creditStatus(nonces.status(id), reason);
  }
  async status() {
    const owner = this.#owner(), config = await this.#client.verify();
    const balances = await this.#client.read("credits", "balances", { account: encodedAddress(owner) });
    const expiredReservations = !isPrepaid(this.#client.d) && BigInt(balances.balance?.reserved || "0") > 0n ? await this.#expiredReservations() : [];
    return { product: this.#client.d.product || "legacy-reservations", enabled: true, mode: this.#config.mode, mainnetPaymentsEnabled: this.#config.mode === "mainnet-pilot", owner, paused: !!config.paused,
      balances: { available: balances.balance?.available || "0", reserved: balances.balance?.reserved || "0" },
      expiredReservations,
      deposits: this.#journal.list(), transactions: this.#journal.nonceCoordinator.list().map(status => this.#creditStatus(status)),
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
  async #expiredReservations() {
    const result = [], owner = encodedAddress(this.#owner()), now = this.#clock();
    for (const item of this.#journal.nonceCoordinator.list()) {
      if (item.purpose !== "credits" || item.state !== "finalized") continue;
      const request = await this.#scope(this.#journal.nonceCoordinator.draft(item.id)), original = request.args.session;
      if (request.method !== "reserve" || Number(original.expires) > now) continue;
      const { session: s } = await this.#client.read("credits", "get_session", { id: original.id });
      if (!s) throw Error("The reserved session could not be checked. Refresh your account; your saved reservation is preserved");
      if (s.closed) continue;
      const remaining = s.remaining ?? "0";
      if (["id", "owner", "verifier", "policy_hash", "expires", "per_job", "max_jobs"].some(k => s[k] !== original[k]) || s.owner !== owner ||
          !/^\d+$/.test(remaining) || BigInt(remaining) > BigInt(original.remaining) ||
          !Number.isSafeInteger(Number(s.settle_until)) || Number(s.settle_until) <= 0)
        throw Error("The reserved session differs from its saved approval. Keep it for review");
      if (BigInt(remaining) === 0n) continue;
      result.push({ session: Buffer.from(s.id, "base64url").toString("hex"), remaining, releaseAfter: Number(s.settle_until) });
    }
    if (!result.length) return result;
    const head = await this.#client.provider.getHeadInfo(), chainTime = Number(head?.head_block_time);
    if (!Number.isSafeInteger(chainTime) || chainTime <= 0) throw Error("The blockchain release time could not be checked. Refresh your account");
    return result.sort((a, b) => a.releaseAfter - b.releaseAfter).map(r => ({ ...r, canRelease: now > r.releaseAfter && chainTime > r.releaseAfter }));
  }
  async session(wanted) {
    if (isPrepaid(this.#client.d)) return null;
    // Restore session identity and limits from the actual reserved transaction,
    // not a replaceable config or a scheduler-provided transaction template.
    for (const item of this.#journal.nonceCoordinator.list()) if (item.purpose === "credits" && item.state === "finalized") {
      const request = await this.#scope(this.#journal.nonceCoordinator.draft(item.id));
      if (request.method !== "reserve") continue;
      const s = request.args.session, session = Buffer.from(s.id, "base64url").toString("hex");
      if (wanted && session !== wanted) continue;
      const state = await this.#client.read("credits", "get_session", { id: s.id });
      if (!state.session) continue;
      if (!wanted && (state.session.closed || BigInt(state.session.revoked_at || "0") > 0n || Number(s.expires) <= this.#clock() ||
          BigInt(state.session.remaining) === 0n || BigInt(state.session.jobs || "0") >= BigInt(s.max_jobs))) continue;
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
      const { balance } = await this.#client.read("credits", "balances", { account: encodedAddress(owner) });
      const available = BigInt(balance?.available || "0"), ceiling = BigInt(c.limits.amount);
      if (available <= 0n) throw Error("Add KOIN to your network balance before chatting");
      const budget = available < ceiling ? available : ceiling;
      args = { session: { id: enc(crypto.randomBytes(32).toString("hex")), owner: encodedAddress(owner), verifier: encodedAddress(c.deployment.verifier),
        policy_hash: enc(c.policyHash), remaining: String(budget), per_job: String(budget < BigInt(c.limits.perJob) ? budget : BigInt(c.limits.perJob)), max_jobs: String(c.limits.maxJobs), expires: String(this.#clock() + c.limits.durationMs) } };
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
  pendingPurchase() {
    this.#owner();
    return this.#journal.list().find(p => p.kind === "credits" && !["funded", "reverted", "conflicted"].includes(p.state)) || null;
  }
  async syncPurchases(register, signal) {
    if (!isPrepaid(this.#client.d) || this.#syncing || this.#task) return;
    this.#syncing = true; this.#syncAbort = new AbortController();
    const combined = AbortSignal.any([signal, this.#syncAbort.signal]);
    const run = async () => {
      this.#owner();
      for (const p of this.#journal.list().filter(p => p.kind === "credits" && !["reverted", "conflicted"].includes(p.state))) {
        combined.throwIfAborted();
        const correction = this.#journal.nonceCoordinator.correction(p.id);
        const txId = correction?.transaction?.id || p.txId;
        if (!this.#registeredPurchases.has(txId)) { await register(txId, combined); this.#registeredPurchases.add(txId); }
        combined.throwIfAborted();
        if (p.state === "funded") continue;
        await this.#journal.nonceCoordinator.reconcile(p.id); combined.throwIfAborted();
        const decision = await this.#journal.advance(p.id, { allowSubmit: false });
        if (decision.action === "done") continue;
        // Read-only recovery is automatic. Re-broadcast is kept within the
        // original visible purchase action; no background signing is possible.
      }
    };
    try { return await (this.#client.provider.withSignal ? this.#client.provider.withSignal(combined, run) : run()); }
    finally { this.#syncing = false; this.#syncAbort = null; }
  }
  async run(window, action, input, signal) {
    signal?.throwIfAborted();
    this.#syncAbort?.abort();
    if (isPrepaid(this.#client.d) && ["reserve", "refund", "revoke", "release"].includes(action)) throw Error("Purchased credits are used directly in Chat");
    if (this.#task) throw Error("A Test payment action is already open");
    const visible = () => window && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
    if (!visible()) throw Error("Visible Test window required");
    const task = this.#task = { stopped: false, abort: new AbortController() }, started = this.#clock();
    const stop = () => this.stop(), navigation = (_e, _url, _inPlace, main) => { if (main) stop(); };
    const guard = () => { if (task.stopped || !visible() || this.#clock() < started || this.#clock() >= started + 180000) throw Error("Test payment action stopped"); this.#owner(); };
    const timer = setTimeout(stop, 180000);
    for (const event of ["hide", "minimize", "closed"]) window.on(event, stop);
    window.webContents.on("did-start-navigation", navigation); window.webContents.on("render-process-gone", stop);
    signal?.addEventListener("abort", stop, { once: true });
    const execute = async () => {
    try {
      this.#owner(); guard();
      if (["purchase", "purchase-retry", "fund-rewards", "reserve", "refund", "revoke", "release", "resume", "correct-mana"].includes(action)) { await this.#authorizeHost?.(); guard(); }
      if (["purchase", "fund-rewards", "reserve", "refund", "revoke", "release"].includes(action) && this.#wallet.signer.getAddress() !== this.#owner()) throw Error("Unlock the configured Test wallet");
      if (["purchase", "purchase-retry"].includes(action) && isPrepaid(this.#client.d)) {
        const existing = this.pendingPurchase();
        if (existing && action === "purchase") return { status: "await_finality", deposit: existing };
        if (action === "purchase-retry") {
          if (!existing) return { status: "complete" };
          await this.#journal.nonceCoordinator.reconcile(existing.id); guard();
          const checked = await this.#journal.advance(existing.id, { allowSubmit: false }); guard();
          if (checked.action === "done") return { status: "complete", deposit: this.#journal.status(existing.id) };
          if (this.#journal.nonceCoordinator.correction(existing.id)) return await this.#correctMana(window, existing.id, guard);
          return await this.#funding.resume(window, existing.id, () => this.#journal.saved(existing.id).intent);
        }
      }
      if (action === "purchase" || action === "fund-rewards") {
        const amount = atoms(input), kind = action === "purchase" ? "credits" : "rewards";
        if (BigInt(amount) > BigInt(this.#config.limits.amount)) throw Error("Deposit exceeds the configured Test limit");
        if (action === "purchase" && isPrepaid(this.#client.d) && this.#config.mode === "mainnet-pilot") {
          // Reject an underfunded resource ceiling before reserving a nonce or
          // creating a signature. A failed precheck cannot strand a purchase.
          await this.#client.verify(); guard();
          const mana = await this.#client.provider.getAccountRc(this.#owner()); guard();
          if (typeof mana !== "string" || !/^(0|[1-9]\d*)$/.test(mana)) throw Error("Could not check this purchase. No KOIN was sent.");
          if (BigInt(mana) < BigInt(this.#config.maxRcPerTransaction)) throw Error("Your wallet needs more available Mana to buy credits. No KOIN was sent. Your existing credits are still usable.");
        }
        let args = { account: encodedAddress(this.#owner()), amount };
        if (kind === "credits" && isUsd(this.#client.d)) {
          if (typeof this.#purchaseQuote !== "function") throw Error("Credit pricing is unavailable. Your existing credits are still usable.");
          args = await this.#purchaseQuote(amount, this.#owner(), task.abort.signal); guard();
          if (args?.account !== encodedAddress(this.#owner()) || args?.amount !== amount) throw Error("Purchase price does not match your request");
          await require("../core/lib/koin-network/purchase-quote").verify(this.#client.d, args, { now: this.#clock(), version: this.#config.version });
        }
        return await this.#funding.approve(window, hash(crypto.randomBytes(32)), () => ({ kind, method: kind === "credits" ? "purchase" : "fund",
          actor: this.#owner(), args, maxRc: this.#config.maxRcPerTransaction }));
      }
      const nonces = this.#journal.nonceCoordinator;
      if (action === "correct-mana") return await this.#correctMana(window, digest(input), guard);
      if (["check", "resume", "recover", "repair"].includes(action)) {
        const id = typeof input === "string" ? input : input?.id; digest(id);
        if (action === "check") {
          if (nonces.status(id).purpose === "credits") return await this.#checkCredit(id, guard);
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
          if (n.purpose === "funding") await this.#funding.check(id); return this.#creditStatus(n);
        }
        if (action === "repair") {
          const review = await nonces.reviewConsumed(id, input.txId); guard();
          const answer = await this.#dialog.showMessageBox(window, { type: "warning", title: "Repair Test transaction",
            message: "Mark this request as conflicted?", detail: `Another irreversible transaction consumed the reserved nonce. This does not mark the original payment successful.\n\nWallet: ${review.owner}\nOriginal: ${review.originalTxId}\nConsuming transaction: ${review.consumingTxId}\nIrreversible block: ${review.finality.blockId}`,
            buttons: ["Cancel", "Record conflict"], defaultId: 0, cancelId: 0, noLink: true });
          guard(); if (answer.response !== 1) return { state: "cancelled" };
          const n = await nonces.repairConsumed(review); if (n.purpose === "funding") await this.#funding.check(id); return this.#creditStatus(n);
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
        if (terminal(status.state)) return this.#creditStatus(status);
        if (!nonces.envelope(id)) throw Error("Recover the original signed transaction from chain history; signing again is forbidden");
        draft = nonces.draft(id); request = await this.#scope(draft);
      }
      guard(); const config = await this.#client.verify(); guard();
      const args = request.args, s = args.session, mainnet = this.#config.mode === "mainnet-pilot";
      const display = n => koin(n) + (mainnet ? " (mainnet)" : " (testnet)");
      const detail = [mainnet ? "MAINNET: real KOIN. This approval can spend real funds." : "Foundation testnet tokens only.", `Action: ${request.method}`, `Wallet: ${request.actor}`,
        ...(request.method === "release" ? ["Release moves unused reserved KOIN back into your available network balance so you can use it for chat again."] : []),
        ...(args.amount ? [`Amount: ${display(args.amount)}`] : []),
        ...(s ? [`Session budget: ${display(s.remaining)}`, `Per request: ${display(s.per_job)}`, `Maximum requests: ${s.max_jobs}`, `Expires: ${new Date(Number(s.expires)).toISOString()}`, `Unused KOIN release: after ${new Date(Number(s.expires) + 86400000).toLocaleString()} and blockchain confirmation (24-hour settlement window).`, `Model: ${this.#config.model}`] : []),
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
        if (decision.action !== "sign_original") return this.#creditStatus(nonces.status(id));
        guard(); const tx = await this.#sign(draft); await nonces.stage(id, tx); // Preserve even a late signature.
      }
      guard(); const tx = nonces.authorizeSubmission(id, { maxRcPerDay: this.#config.maxRcPerDay }); guard();
      let reason = "credit_submission_pending";
      try { await this.#client.submit(tx, request, { signal: task.abort.signal }); }
      catch (error) {
        // Transport messages can contain signed envelopes. Expose only fixed
        // categories and keep the original envelope reserved for recovery.
        reason = error?.code === "koin_rpc_insufficient_rc" ? "credit_insufficient_rc" : "credit_submission_uncertain";
      }
      return this.#creditStatus(nonces.status(id), reason);
    } finally {
      signal?.removeEventListener("abort", stop);
      clearTimeout(timer); task.abort.abort(); for (const event of ["hide", "minimize", "closed"]) window.removeListener(event, stop);
      window.webContents.removeListener("did-start-navigation", navigation); window.webContents.removeListener("render-process-gone", stop); this.#task = null;
    }
    };
    return this.#client.provider.withSignal ? this.#client.provider.withSignal(task.abort.signal, execute) : execute();
  }
}
module.exports = { TestPayments };
