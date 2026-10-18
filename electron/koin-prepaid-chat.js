"use strict";
const { isPrepaid, isUsd } = require("../core/lib/koin-network/product");
const crypto = require("crypto"), P = require("../core/lib/koin-network/job-protocol");
const { ChatFlow, request } = require("./koin-chat-flow"), { fundedResultHash } = require("../core/lib/koin-network/funded-protocol");
const { testDomain } = require("../core/lib/koin-network/payment-mode"), { protocol } = require("../core/lib/koin-network/payment-network");
const price = (t, input, output) => String((BigInt(input) * BigInt(t.inputAtomsPerMillion) + BigInt(output) * BigInt(t.outputAtomsPerMillion) + 999999n) / 1000000n);
// Only the private main-process IPC owns credentials and these requests.
class PrepaidChat extends ChatFlow {
  constructor(options) {
    super(options); this.access = options.access; this.fetch = options.fetchImpl || fetch;
    const d = this.config.deployment;
    if (!isPrepaid(d)) throw Error("Prepaid account required");
    this.product = d.product;
    this.target = { chainId: d.chainId, credits: d.credits, creditsHash: d.creditsHash, domain: testDomain(d, this.config.schedulerUrl), policyHash: this.config.policyHash };
  }
  async call(action, body = {}, signal = AbortSignal.timeout(10000), onCompletion) {
    const a = this.access.authorize(this.config.schedulerUrl, signal);
    const route = action === "chat" ? "/consume/chat/completions" : "/koin/prepaid/" + action;
    const response = await this.fetch(this.config.schedulerUrl + route, { method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, sessionToken: a.sessionToken }) });
    if (action === "chat" && response.ok && (response.headers.get("content-type") || "").includes("text/event-stream")) {
      let buffer = "", last, done = false, frames = 0; const decoder = new TextDecoder(), wire = protocol(this.target);
      for await (const part of response.body) {
        signal.throwIfAborted(); this.access.authorize(this.config.schedulerUrl, signal);
        buffer += decoder.decode(part, { stream: true });
        if (Buffer.byteLength(buffer) > 1600000) throw Error("Credit stream frame too large");
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (!frame.startsWith("data: ")) throw Error("Invalid credit stream frame");
          const data = frame.slice(6); if (data === "[DONE]") { done = true; continue; }
          if (done || ++frames > 4098) throw Error("Invalid credit stream sequence");
          const value = JSON.parse(data);
          if (!value.ok) throw Error(value.error || "Network stream interrupted");
          if (value.product !== this.product || value.mode !== wire.mode || value.paymentsEnabled !== wire.paymentsEnabled) throw Error("Credit stream identity changed");
          await onCompletion?.(value.completion); last = value;
        }
      }
      if (!done || !last || buffer.trim()) throw Error("Network stream interrupted. Your saved reply can be recovered without another charge.");
      return last;
    }
    let size = 0; const parts = [];
    for await (const part of response.body) { signal.throwIfAborted(); size += part.length; if (size > 1600000) throw Error("Credit response too large"); parts.push(part); }
    const value = JSON.parse(Buffer.concat(parts).toString("utf8")), wire = protocol(this.target);
    this.access.authorize(this.config.schedulerUrl, signal);
    if (value.product !== this.product || value.mode !== wire.mode || value.paymentsEnabled !== wire.paymentsEnabled || value.owner && value.owner !== this.config.owner) throw Error("Credit account identity changed");
    if (!response.ok || value.ok !== true) throw Error(value.error || "The network is unavailable. Please try again.");
    return value;
  }
  verify(result, input, id) {
    const k = result?.koin, q = k?.quote, r = k?.receipt, output = result?.choices?.[0]?.message?.content;
    if (result?.id !== id || k?.product !== this.product || JSON.stringify(k.target) !== JSON.stringify(this.target) ||
        !["ready", "charged", "streaming"].includes(k.state) || r?.product !== this.product || r.job !== id || r.owner !== this.config.owner || r.provider === this.config.owner ||
        k.session !== P.hash("prepaid-account:" + this.config.owner) || r.quoteHash !== q?.hash || r.outputHash !== P.hash(output || "") ||
        k.receiptHash !== P.hash(JSON.stringify(r))) throw Error("The network answer could not be verified. Retry this message to recover its saved answer.");
    P.validateQuote(q);
    if (q.domain !== this.target.domain || q.policyHash !== this.target.policyHash || q.tariff.model !== input.model ||
        q.tariff.version !== this.config.version || q.requestHash !== P.hash(JSON.stringify(input.messages)) || q.maxOutput !== input.maxOutput ||
        P.hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", q.tariff])) !== this.target.policyHash ||
        r.usage.inputTokens !== q.inputTokens || !Number.isSafeInteger(r.usage.outputTokens) || r.usage.outputTokens < 1 || r.usage.outputTokens > q.maxOutput ||
        r.usage.amount !== price(q.tariff, r.usage.inputTokens, r.usage.outputTokens) || BigInt(r.usage.amount) > BigInt(q.maxCharge)) throw Error("The answer differs from the approved credit price");
    const job = { id, session: k.session, attempt: r.attempt, quote: q };
    P.signatureMatches(r.sequence === undefined ? fundedResultHash(this.target, job, output) : require("../core/lib/koin-network/funded-protocol").fundedChunkHash(this.target, job, output, r.sequence), r.signature, r.provider);
    return { id, object: "chat.completion", model: "koinos-network", servedModel: input.model,
      choices: [{ index: 0, message: { role: "assistant", content: output }, finish_reason: k.state === "streaming" ? null : "stop" }],
      usage: { prompt_tokens: r.usage.inputTokens, completion_tokens: r.usage.outputTokens, total_tokens: r.usage.inputTokens + r.usage.outputTokens }, costUsd: isUsd(this.product) ? Number(r.usage.amount) / 1e8 : 0,
      koin: { product: this.product, state: k.state, target: this.target, session: k.session, quote: q, receipt: r, receiptHash: k.receiptHash } };
  }
  async status() { return this.call("status"); }
  async estimate(value, signal) {
    const input = request(value, this.config);
    const result = await this.call("estimate", { model: input.model, messages: input.messages, max_tokens: input.maxOutput, freeOnly: input.freeOnly === true }, signal);
    const e = result.estimate;
    if (!e || e.model !== input.model || e.unit !== (isUsd(this.product) ? "USD-1e-8" : "legacy-KOIN-1e-8") || typeof e.allowed !== "boolean" ||
        ![e.maxCharge, e.maxFree, e.maxPaid].every(n => typeof n === "string" && /^(0|[1-9]\d{0,19})$/.test(n)) || BigInt(e.maxFree) + BigInt(e.maxPaid) !== BigInt(e.maxCharge)) throw Error("Credit estimate could not be verified");
    if (this.config.limits?.perJob && BigInt(e.maxCharge) > BigInt(this.config.limits.perJob)) throw Error("This message exceeds your saved per-request credit limit. Shorten it or choose a local model.");
    return e;
  }
  async chat(window, value, signal) {
    signal.throwIfAborted();
    if (!this.storage?.isEncryptionAvailable?.()) throw Error("Unlock secure storage to chat");
    const input = request(value, this.config), requestHash = P.hash(JSON.stringify(input));
    let record = this.read();
    if (record && ["pending", "answered"].includes(record.state) && record.requestHash !== requestHash) {
      // A different prompt may proceed. Cancelling an old request cannot undo a
      // charge, and its bounded hold also expires if the cancellation is lost.
      await this.call("cancel", { requestId: record.id }, signal); record = null;
    }
    if (record?.requestHash === requestHash && record.state === "answered") {
      const answer = this.verify(JSON.parse(this.storage.decryptString(Buffer.from(record.answer, "base64"))), input, record.id);
      // Locally saved delivery survives an acknowledgement response loss.
      await this.call("acknowledge", { requestId: record.id, receiptHash: answer.koin.receiptHash }, signal).catch(() => {});
      return answer;
    }
    if (record?.state === "pending") {
      const old = await this.call("result", { requestId: record.id }, signal);
      if (old.completion) {
        const answer = this.verify(old.completion, input, record.id);
        this.save({ ...record, state: "answered", answer: this.storage.encryptString(JSON.stringify(answer)).toString("base64") });
        await this.call("acknowledge", { requestId: record.id, receiptHash: answer.koin.receiptHash }, signal).catch(() => {});
        return answer;
      }
      // A new explicit Send after an interruption cancels that unfinished
      // attempt and immediately starts afresh. It cannot charge a late result.
      await this.call("cancel", { requestId: record.id }, signal); record = null;
    }
    if (!record || record.state !== "pending") {
      const estimate = await this.estimate(value, signal);
      if (!estimate.allowed) throw Error(input.freeOnly ? "Free only is on. This request exceeds your available free credits." : "Not enough credits for this request. Buy credits or choose a local model.");
      const credits = require("../core/lib/koin-network/purchase-quote").credits;
      this.progress(`Maximum ${credits(estimate.maxCharge)} credits · free first (${credits(estimate.maxFree)}) · up to ${credits(estimate.maxPaid)} purchased credits`);
      record = { schema: 1, owner: this.config.owner, deployment: P.hash(JSON.stringify(this.config)), id: crypto.randomBytes(32).toString("hex"),
        session: P.hash("prepaid-account:" + this.config.owner), requestHash, state: "pending", maxPaid: estimate.maxPaid, costEstimate: estimate, input: this.storage.encryptString(JSON.stringify(value)).toString("base64") };
      this.save(record);
    }
    this.progress(record.costEstimate ? `Generating your answer · maximum ${require("../core/lib/koin-network/purchase-quote").credits(record.costEstimate.maxCharge)} credits · up to ${require("../core/lib/koin-network/purchase-quote").credits(record.maxPaid)} purchased credits after free credits` : "Generating your answer…");
    try {
      let prefix = "", sequence = 0, amount = 0n;
      const delivered = completion => {
        const answer = this.verify(completion, input, record.id), next = answer.choices[0].message.content, receipt = answer.koin.receipt;
        if (!next.startsWith(prefix) || BigInt(receipt.usage.amount) < amount || (receipt.sequence !== undefined && receipt.sequence < sequence)) throw Error("Network stream prefix changed");
        const delta = next.slice(prefix.length); prefix = next; sequence = receipt.sequence ?? sequence; amount = BigInt(receipt.usage.amount);
        this.save({ ...record, state: "answered", answer: this.storage.encryptString(JSON.stringify(answer)).toString("base64") });
        if (delta) this.progress({ requestId: record.id, delta, servedModel: input.model, creditsAtoms: receipt.usage.amount });
      };
      const response = await this.call("chat", { billing: "koin-" + this.product, requestId: record.id, model: input.model, messages: input.messages, max_tokens: input.maxOutput,
        stream: value.stream !== false, ...(record.maxPaid !== undefined ? { maxPaid: record.maxPaid } : {}), ...(input.freeOnly !== undefined ? { freeOnly: input.freeOnly } : {}) }, signal, delivered);
      const answer = this.verify(response.completion, input, record.id);
      // Persist the verified answer before displaying it. The service has already
      // recorded this one usage charge and retains an encrypted recovery copy.
      this.save({ ...record, state: "answered", answer: this.storage.encryptString(JSON.stringify(answer)).toString("base64") });
      signal.throwIfAborted();
      await this.call("acknowledge", { requestId: record.id, receiptHash: answer.koin.receiptHash }, signal).catch(() => {});
      return answer;
    } catch (e) {
      if (this.read()?.state === "pending" && !signal.aborted) {
        await this.call("cancel", { requestId: record.id }, signal).catch(() => {});
        // Preserve the request ID: the server may have committed an answer
        // before a lost response. Retry retrieves it without another debit.
      }
      throw e;
    }
  }
}
module.exports = { PrepaidChat };
