"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), P = require("../core/lib/koin-network/job-protocol");
const { PrepaidChat } = require("./koin-prepaid-chat");
function creditAtoms(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,13})(\.\d{1,5})?$/.test(value)) throw Error("Enter a positive total run budget in credits, with up to five decimal places");
  const [whole, part = ""] = value.split("."), atoms = BigInt(whole) * 100000n + BigInt(part.padEnd(5, "0"));
  if (atoms <= 0n || atoms > (1n << 64n) - 1n) throw Error("Invalid total run budget"); return String(atoms);
}
function save(file, value) {
  const fd = fs.openSync(file + ".tmp", "w", 0o600); try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(file + ".tmp", file);
}
class CreditRuns {
  constructor(service) { this.service = service; }
  directory(c, id) { P.digest(id); return path.join(c.directory, "runs", id); }
  locate(c, id) {
    const matches = (c.contexts || [c]).filter(context => fs.existsSync(path.join(this.directory(context, id), "run.json")));
    if (matches.length !== 1) throw Error("Saved run is unavailable or ambiguous for this account");
    return { ...c, config: matches[0].config, directory: matches[0].directory };
  }
  read(c, id) {
    const dir = this.directory(c, id), file = path.join(dir, "run.json");
    if (fs.lstatSync(dir).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 4096) throw Error("Invalid saved run");
    const run = JSON.parse(fs.readFileSync(file, "utf8"));
    if (run.schema !== 1 || run.id !== id || run.context !== P.hash(JSON.stringify(c.config)) || run.paidFirst !== undefined && typeof run.paidFirst !== "boolean" || run.paidFirst && run.freeOnly) throw Error("Saved run belongs to another account or network");
    return run;
  }
  flow(c, run, callId) {
    if (c.auth?.sessionOnly) throw Error("Temporary network access supports free chat only. Reconnect with secure storage for advanced runs");
    P.digest(callId);
    return new PrepaidChat({ config: c.config, file: path.join(this.directory(c, run.id), callId + ".json"), storage: this.service.storage,
      access: { authorize: (pin, signal) => { signal?.throwIfAborted(); this.service.account.assertCreditAuthorization(c.auth, pin); return c.auth; } },
      fetchImpl: this.service.fetchImpl, progress: value => this.service.progress(typeof value === "object" ? { ...value, runId: run.id, callId } : value) });
  }
  async open(c, input, signal) {
    if (c.auth?.sessionOnly) throw Error("Temporary network access supports free chat only. Reconnect with secure storage for advanced runs");
    if (!input || Object.keys(input).filter(k => !["model", "paidFirst"].includes(k)).sort().join() !== "budget,freeOnly,mode" || !["research", "agent", "team", "agents"].includes(input.mode) || typeof input.freeOnly !== "boolean") throw Error("Choose a supported mode, total run budget and paid-continuation preference");
    if ((input.paidFirst !== undefined && typeof input.paidFirst !== "boolean") || (input.paidFirst && input.freeOnly)) throw Error("Invalid paid-first preference");
    if (input.paidFirst) await c.flow.requireCreditPriority(signal);
    const selected = input.model === undefined ? c.config.model : input.model;
    if (typeof selected !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(selected)) throw Error("Choose an approved model for this run");
    const catalog = await c.flow.models(signal);
    const chosen = catalog?.models.find(m => m.model === selected);
    if (!chosen?.available) throw Error("This network model is unavailable. Choose an available model for this run");
    const run = { schema: 1, id: crypto.randomBytes(32).toString("hex"), context: P.hash(JSON.stringify(c.config)), mode: input.mode,
      model: selected, maxOutput: chosen.maxOutput, maxTotal: creditAtoms(input.budget), freeOnly: input.freeOnly, ...(input.paidFirst ? { paidFirst: true } : {}), createdAt: Date.now() };
    const directory = this.directory(c, run.id); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); save(path.join(directory, "run.json"), run);
    // Persist before requesting admission so an uncertain response has an ID.
    const result = await c.flow.call("run-open", { runId: run.id, mode: run.mode, model: run.model, maxTotal: run.maxTotal, freeOnly: run.freeOnly, ...(run.paidFirst ? { paidFirst: true } : {}) }, signal);
    if (result.run?.id !== run.id || result.run.model !== run.model || result.run.maxTotal !== run.maxTotal || result.run.freeOnly !== run.freeOnly || (result.run.paidFirst === true) !== (run.paidFirst === true)) throw Error("Run approval could not be verified");
    return { run: result.run };
  }
  async chat(c, input, signal) {
    if (c.auth?.sessionOnly) throw Error("Temporary network access supports free chat only. Reconnect with secure storage for advanced runs");
    if (!input || Object.keys(input).sort().join() !== "callId,request,runId") throw Error("Exact advanced model call required");
    const run = this.read(c, input.runId), flow = this.flow(c, run, input.callId);
    if (input.request?.model !== "koinos-network" && input.request?.model !== "koinos-network:" + run.model) throw Error("Run model changed");
    const request = { ...input.request, model: "koinos-network:" + run.model, runId: run.id, freeOnly: run.freeOnly, paidFirst: run.paidFirst === true };
    const result = await flow.chat(null, request, signal);
    return result; // Keep encrypted sub-results for useful partial-run recovery.
  }
  async status(c, id, signal) {
    c = this.locate(c, id);
    const run = this.read(c, id); await c.flow.call("run-status", { runId: id }, signal);
    const steps = [];
    for (const file of fs.readdirSync(this.directory(c, id)).filter(f => /^[a-f0-9]{64}\.json$/.test(f)).slice(0, 128)) {
      const callId = file.slice(0, -5), flow = this.flow(c, run, callId); let record = flow.read();
      if (record?.state === "pending") {
        // Read-only recovery: never retry an unfinished model call merely
        // because the user opened the saved-results view.
        const saved = await flow.call("result", { requestId: record.id }, signal);
        if (saved.completion) {
          const input = JSON.parse(this.service.storage.decryptString(Buffer.from(record.input, "base64")));
          const answer = flow.verify(saved.completion, flow.input(input, record), record.id);
          record = { ...record, state: "answered", answer: this.service.storage.encryptString(JSON.stringify(answer)).toString("base64") }; flow.save(record);
        }
      }
      if (record?.state === "answered") {
        const answer = JSON.parse(this.service.storage.decryptString(Buffer.from(record.answer, "base64")));
        const input = JSON.parse(this.service.storage.decryptString(Buffer.from(record.input, "base64")));
        const checked = flow.verify(answer, flow.input(input, record), record.id);
        steps.push({ callId, id: checked.id, text: checked.choices[0].message.content, credits: checked.koin.receipt.usage.amount });
      }
    }
    return { ...await c.flow.call("run-status", { runId: id }, signal), steps };
  }
  list(c) {
    return (c.contexts || [c]).flatMap(context => {
      const root = path.join(context.directory, "runs"); if (!fs.existsSync(root)) return [];
      return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && /^[a-f0-9]{64}$/.test(e.name)).slice(-256).map(e => this.read(context, e.name));
    }).sort((a, b) => b.createdAt - a.createdAt).slice(0, 256);
  }
  async stop(c, id, signal) { this.read(this.locate(c, id), id); return c.flow.call("run-stop", { runId: id }, signal); }
}
module.exports = { CreditRuns, creditAtoms };
