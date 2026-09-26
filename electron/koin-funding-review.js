"use strict";

// In-process rehearsal only. No IPC registration, key access, signer or submitter.
// A preview result is not permission to spend or to reuse a transaction later.
const { KoinChain, fundingRequest } = require("../core/lib/koin-network/chain");
const { uint } = require("../core/lib/koin-network/policy");
const { koin } = require("./koin-review");

function request(value) {
  const r = structuredClone(value);
  if (!r || Object.keys(r).some(k => !["kind", "method", "args", "actor", "payer", "rcLimit"].includes(k)))
    throw Error("Invalid local funding request");
  fundingRequest(r.kind, r.method, r.args, r.actor);
  if (typeof r.rcLimit !== "string" || r.rcLimit.length > 20 || uint(r.rcLimit) === 0n)
    throw Error("Positive resource limit required");
  return { kind: r.kind, method: r.method, args: { account: r.args.account, amount: r.args.amount },
    actor: r.actor, payer: r.payer ?? r.actor, rcLimit: r.rcLimit };
}

function createFundingReview({ client, dialog, clock = Date.now, tr = x => x }) {
  if (!(client instanceof KoinChain)) throw Error("Pinned KOIN chain client required");
  let pending = false, generation = 0;
  const result = status => ({ status, mode: "funding-preview", paymentsEnabled: false });
  return {
    cancel() { generation++; },
    // The supplier belongs to trusted main-process code; never accept scheduler
    // drafts, renderer-selected deployment pins or arbitrary serialized bytes.
    async review(window, getRequest) {
      const visible = () => window && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
      if (pending || !visible()) return result("cancelled");
      pending = true;
      const epoch = generation, started = clock(), expires = started + 180000;
      const valid = () => epoch === generation && visible() && clock() >= started && clock() < expires;
      const stop = () => { generation++; };
      const navigation = (_event, _url, _inPlace, mainFrame) => { if (mainFrame) stop(); };
      for (const event of ["hide", "minimize", "closed"]) window.on(event, stop);
      window.webContents.on("did-start-navigation", navigation);
      window.webContents.on("render-process-gone", stop);
      try {
        if (!Number.isSafeInteger(started) || started < 0 || !Number.isSafeInteger(expires)) throw Error("Invalid review clock");
        const r = request(await getRequest());
        if (!valid()) return result("cancelled");
        const tx = await client.prepare(r.kind, r.method, r.args, r);
        const intent = { ...r, maxRc: r.rcLimit };
        await client.verifyTransaction(tx, intent);
        const state = await client.verify();
        if (state.paused) throw Error("Funding is paused");
        if (!valid()) return result("cancelled");
        const line = (name, value) => `${tr(name)}: ${value}`;
        const { response } = await dialog.showMessageBox(window, {
          type: "question", title: tr("KOIN funding review preview"),
          message: tr(r.kind === "credits" ? "Review a usage-credit deposit" : "Review reward-pool funding"),
          detail: [tr("Preview only. No KOIN will be spent and no transaction will be signed."), "",
            tr(r.kind === "credits" ? "This deposit backs your refundable usage credits." : "This funds provider rewards. It does not create customer credits or a refundable customer balance."),
            line("Amount", koin(r.args.amount)), line("Wallet", r.actor), line("Custody contract", client.d[r.kind]),
            line("Native token contract", client.d.token), line("Chain", client.d.chainId),
            line("Mana payer", r.payer), line("Maximum resource credits", tx.header.rc_limit),
            line("Transaction", tx.id), line("Nonce", tx.header.nonce),
            line("Review expires (UTC)", new Date(expires).toISOString()), "",
            tr("One transaction approves exactly this amount to this custody contract, then deposits it. A successful deposit consumes the entire approval. If the deposit fails, the approval rolls back too."),
            tr("This review does not authorize a separate token approval or transfer.")].join("\n"),
          buttons: [tr("Cancel"), tr("Mark preview reviewed")], defaultId: 0, cancelId: 0, noLink: true,
        });
        if (response !== 1 || !valid()) return result("cancelled");
        const current = request(await getRequest());
        if (!valid() || JSON.stringify(current) !== JSON.stringify(r)) return result("cancelled");
        const currentState = await client.verify();
        const nonce = await client.provider.getNextNonce(r.actor);
        if (!valid() || JSON.stringify(state) !== JSON.stringify(currentState) || nonce !== tx.header.nonce)
          return result("cancelled");
        await client.verifyTransaction(tx, intent);
        if (!valid()) return result("cancelled");
        // Only a receipt of the preview leaves this function, never signed bytes
        // or a reusable approval capability.
        return { ...result("reviewed"), txId: tx.id };
      } catch {
        return result(valid() ? "unavailable" : "cancelled");
      } finally {
        for (const event of ["hide", "minimize", "closed"]) window.removeListener(event, stop);
        window.webContents.removeListener("did-start-navigation", navigation);
        window.webContents.removeListener("render-process-gone", stop);
        pending = false;
      }
    },
  };
}
module.exports = { createFundingReview };
