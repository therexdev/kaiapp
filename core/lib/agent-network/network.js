"use strict";
const P = require("./protocol"), { clone } = require("./store"), { JobRuntime, packageDefinition, template } = require("./runtime"), { Transport } = require("./transport");
const TERMINAL = ["accepted", "cancelled", "failed", "rejected"];
class AgentNetwork {
  constructor({ store, models = () => [], runLocal, privacyMode, transport }) {
    this.store = store; this.models = models; this.domain = P.PRIVATE; this.transport = transport || new Transport({ privacyMode });
    this.runtime = new JobRuntime({ store, models, runLocal: runLocal || (() => P.fail("MODEL_UNAVAILABLE", "Configure an installed local model.")) });
    this.timer = null; this.busy = false; this.receiving = Promise.resolve();
    if (!store.locked && store.available()) store.change(d => { for (const j of d.jobs.filter(j => j.role === "host" && !TERMINAL.includes(j.status))) if (j.workflow?.runs.some(r => r.status === "running")) { j.status = "interrupted"; j.error = "Host restarted. Review and resume this job."; } });
  }
  enabled() { this.store.requireStorage(); if (!this.store.data.enabled) P.fail("FEATURE_DISABLED", "Enable Agent Network in its settings first."); }
  identity() { this.enabled(); if (!this.store.data.identity) this.store.change(d => { d.identity = P.identity(); }); return this.store.data.identity; }
  activity(type, id, detail) { this.store.change(d => { d.activity.unshift({ id: P.random(), at: Date.now(), type, subject: id, detail }); d.activity = d.activity.slice(0, 500); }); }
  status() {
    this.store.requireStorage(); const d = this.store.data;
    return { enabled: d.enabled, address: d.identity?.address || null, endpoints: d.endpoints, paid: false, deployment: "Private services · not registered on-chain", models: this.models().filter(x => x.status === "ready"),
      agents: d.agents.map(({ definition, ...a }) => ({ ...a, definition })), cards: d.cards,
      jobs: d.jobs.map(j => ({ id: j.id, agentId: j.agentId, name: j.name, role: j.role, status: j.status, at: j.at, output: j.output, input: j.input, error: j.error || null, modelCalls: j.modelCalls || 0, quote: j.quote || null, resultHash: j.resultHash || null, steps: j.workflow?.runs[0]?.steps?.map(({ label, status, durationMs }) => ({ label, status, durationMs })) || [], pending: j.workflow?.runs[0]?.pending || null })), activity: d.activity,
      pendingMessages: d.outbox.length, lastError: d.lastError || null };
  }
  settings(input) {
    if (input.endpoints && (!Array.isArray(input.endpoints) || input.endpoints.length > 3)) P.fail("INVALID_ENDPOINT", "Choose at most three independent relays.");
    for (const e of input.endpoints || []) { const u = new URL(e); if (u.username || u.password || u.search || u.hash || u.pathname !== "/" || u.protocol !== "https:" && !(this.transport.allowLoopback && u.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(u.hostname))) P.fail("INVALID_ENDPOINT", "Enter an HTTPS origin without paths or credentials."); }
    this.store.change(d => { d.enabled = input.enabled === true; if (input.endpoints) d.endpoints = [...new Set(input.endpoints.map(e => new URL(e).origin))]; });
    if (!input.enabled) this.stop(); else { this.identity(); this.start(); } return this.status();
  }
  async save(input) {
    this.enabled(); if (input.amount_atoms && input.amount_atoms !== "0") P.fail("DEPLOYMENT_REQUIRED", "Paid publication needs the validated Agent Network testnet contracts.");
    const old = input.id ? this.store.data.agents.find(a => a.id === input.id) : null;
    if (input.id && !old) P.fail("NOT_FOUND", "Agent no longer exists.");
    if (!old && this.store.data.agents.length >= 20) P.fail("SIZE_LIMIT", "Maximum 20 local agents.");
    const definition = packageDefinition(input.definition || template(input.template || "summary", input.model || "")), key = this.identity();
    for (const node of definition.graph.nodes.filter(n => n.type === "agent")) {
      const alias = node.config.model || definition.model;
      if (!alias || !this.models().some(m => m.alias === alias && m.status === "ready")) P.fail("MODEL_UNAVAILABLE", "Choose an installed, ready local model for every reasoning step.");
    }
    const nonce = old?.nonce || P.random(), id = P.agentId(key.address, nonce, this.domain);
    const card = { agent_id: id, owner: key.address, nonce, sequence: String(BigInt(old?.card.payload.sequence || "0") + 1n), control_version: old?.card.payload.control_version || "1", name: P.text(input.name || definition.name, 80), description: P.text(input.description || "A private, owner-hosted KAI service.", 1000), capabilities: (input.capabilities || [input.template || "workflow"]).map(x => P.text(x, 60)), definition_hash: P.hash(definition), input_schema: input.input_schema || { type: "string", maxLength: 32000 }, output_schema: input.output_schema || { type: "string", maxLength: 64000 }, encryption_public: key.encryption_public, endpoints: [...this.store.data.endpoints], amount_atoms: "0", limits: input.limits || { input_bytes: 32000, output_bytes: 64000, steps: 40, model_calls: 12, seconds: 300 }, expires_at: String(Date.now() + 7 * 86400000), license: input.license || "Private service" };
    const signed = await P.sign("manifest", card, key, this.domain); P.validateCard(signed, this.domain);
    this.store.change(d => { const a = { id, nonce, card: signed, definition, accepting: false, published: false, createdAt: old?.createdAt || Date.now() }; d.agents = d.agents.filter(x => x.id !== id); d.agents.push(a); });
    this.activity("saved", id, card.name + " · version " + card.sequence); return signed;
  }
  async publish(id) {
    this.enabled(); const agent = this.store.data.agents.find(a => a.id === id); if (!agent) P.fail("NOT_FOUND", "Choose an agent.");
    const card = P.validateCard(agent.card, this.domain);
    if (!this.store.data.endpoints.length) P.fail("ENDPOINT_REQUIRED", "Add a relay in Agent Network settings, or export the signed card for a private invitation.");
    if (P.canonical(card.endpoints) !== P.canonical(this.store.data.endpoints)) P.fail("STALE_AGENT_VERSION", "Save a new agent version with the current relay addresses before publishing.");
    const outcomes = await Promise.allSettled(card.endpoints.map(e => this.transport.auth(e, "/agent-network/v1/publish", { card: agent.card }, this.identity(), this.domain)));
    if (!outcomes.some(x => x.status === "fulfilled")) throw outcomes[0].reason;
    this.store.change(d => { d.agents.find(a => a.id === id).published = true; }); this.activity("published", id, card.name); return { published: true, copies: outcomes.filter(x => x.status === "fulfilled").length };
  }
  async retire(id) {
    const a = this.store.data.agents.find(a => a.id === id); if (!a) P.fail("NOT_FOUND", "Choose an agent.");
    this.store.change(d => { const x = d.agents.find(x => x.id === id); x.accepting = false; x.published = false; });
    await Promise.allSettled(a.card.payload.endpoints.map(e => this.transport.auth(e, "/agent-network/v1/retire", { id }, this.identity(), this.domain)));
    this.activity("retired", id, "New jobs disabled; current jobs remain available.");
  }
  accepting(id, enabled) { this.enabled(); this.store.change(d => { const a = d.agents.find(x => x.id === id); if (!a) P.fail("NOT_FOUND", "Choose an agent."); P.validateCard(a.card, this.domain); a.accepting = enabled === true; }); }
  importCard(signed) {
    const c = P.validateCard(signed, this.domain); this.store.change(d => { const old = d.cards.find(x => x.payload.agent_id === c.agent_id); if (old && (BigInt(old.payload.sequence) > BigInt(c.sequence) || old.payload.sequence === c.sequence && P.hash(old) !== P.hash(signed))) P.fail("STALE_AGENT_VERSION", "An older or conflicting version cannot replace this card."); if (!old && d.cards.length >= 500) P.fail("SIZE_LIMIT", "Directory cache is full."); d.cards = d.cards.filter(x => x.payload.agent_id !== c.agent_id); d.cards.push(signed); }); return signed;
  }
  async discover(query = "") {
    this.enabled(); let successes = 0;
    for (const endpoint of this.store.data.endpoints) {
      try { let cursor = 0; for (let page = 0; page < 13 && cursor !== null; page++) { const result = await this.transport.request(endpoint, "/agent-network/v1/agents?q=" + encodeURIComponent(query.slice(0, 100)) + "&cursor=" + cursor); for (const signed of result.items || []) { try { this.importCard(signed); } catch { /* reject invalid and stale cards */ } } cursor = result.next; } successes++; } catch (e) { this.store.change(d => { d.lastError = e.message; }); }
    }
    if (this.store.data.endpoints.length && !successes) P.fail("DIRECTORY_UNAVAILABLE", "The configured directories could not be reached. Saved cards remain available.");
    return this.status().cards;
  }
  async packet(to, encryptionPublic, body) {
    const key = this.identity(); let sequence;
    this.store.change(d => { d.sequence = String(BigInt(d.sequence || "0") + 1n); sequence = d.sequence; });
    const header = { id: P.random(), from: key.address, to, sequence, expires_at: String(Date.now() + 86400000) };
    return P.sign("message", P.seal(body, encryptionPublic, header), key, this.domain);
  }
  async send(to, encryptionPublic, endpoints, body) {
    const packet = await this.packet(to, encryptionPublic, body);
    this.store.change(d => { if (d.outbox.length >= 200) P.fail("RATE_LIMIT", "Outgoing mailbox is full. Reconnect your relays."); d.outbox.push({ packet, endpoints: [...new Set(endpoints)].slice(0, 3), sent: [] }); }); return packet;
  }
  async quote(signed, input) {
    this.enabled(); const c = P.validateCard(signed, this.domain), salt = P.random(); P.validateSchema(c.input_schema, input);
    if (Buffer.byteLength(P.canonical(input)) > c.limits.input_bytes) P.fail("SIZE_LIMIT", "Input exceeds the service limit.");
    const id = P.random(), key = this.identity();
    if (c.owner !== key.address && !this.store.data.endpoints.length) P.fail("ENDPOINT_REQUIRED", "Add a relay for the host to return your quote and delivery.");
    this.store.change(d => { if (d.jobs.length >= 100) P.fail("SIZE_LIMIT", "Save results and remove finished local receipts before starting more jobs."); d.jobs.unshift({ id, role: "buyer", agentId: c.agent_id, name: c.name, at: Date.now(), status: "requesting_quote", card: c, signedCard: signed, input, salt, buyer: key.address, output: null, error: null }); });
    await this.send(c.owner, c.encryption_public, c.endpoints, { type: "quote_request", job_id: id, agent_id: c.agent_id, service_version_hash: P.hash(signed), input_commitment: P.hash({ input, salt }), reply_key: key.encryption_public, reply_endpoints: [...this.store.data.endpoints], buyer: key.address });
    await this.tick(); return id;
  }
  async submit(id) {
    const j = this.store.data.jobs.find(j => j.id === id && j.role === "buyer"); if (!j?.quote || j.status !== "quoted") P.fail("QUOTE_REQUIRED", "Wait for an exact service quote.");
    const q = this.verifyQuote(j.quote, j.card.owner);
    if (q.amount_atoms !== "0") P.fail("DEPLOYMENT_REQUIRED", "Paid escrow is not enabled in this deployment.");
    await this.send(j.card.owner, j.card.encryption_public, j.card.endpoints, { type: "dispatch", quote: j.quote, input: j.input, salt: j.salt });
    this.store.change(d => { d.jobs.find(j => j.id === id && j.role === "buyer").status = "submitted"; }); await this.tick();
  }
  verifyQuote(signed, expected) {
    const q = P.verify(signed, "quote", this.domain, expected);
    P.fields(q, ["job_id", "buyer", "agent_id", "service_version_hash", "definition_hash", "input_commitment", "amount_atoms", "quote_expiry", "delivery_seconds", "nonce"]); P.uint(q.amount_atoms); P.uint(q.quote_expiry); P.digest(q.input_commitment); P.digest(q.definition_hash); P.digest(q.service_version_hash);
    if (Number(q.quote_expiry) < Date.now()) P.fail("QUOTE_EXPIRED", "Request a fresh quote."); return q;
  }
  async receive(signed) { const next = this.receiving.then(() => this.receiveOne(signed)); this.receiving = next.catch(() => {}); return next; }
  async receiveOne(signed) {
    const packet = P.verify(signed, "message", this.domain), h = packet.header, key = this.identity();
    P.fields(h, ["id", "from", "to", "sequence", "expires_at"]); P.uint(h.sequence); P.uint(h.expires_at); P.text(h.id, 64);
    if (h.from !== signed.signer || h.to !== key.address || Number(h.expires_at) < Date.now() || Number(h.expires_at) > Date.now() + 86400000) P.fail("FORBIDDEN", "Invalid recipient or expired message.");
    const fingerprint = P.hash(signed), old = this.store.data.inbox.find(x => x.from === h.from && (x.id === h.id || x.sequence === h.sequence));
    if (old) { if (old.hash !== fingerprint) P.fail("REPLAY", "Message sequence reused."); return; }
    const body = P.open(packet, key.encryption_private);
    try { await this.handle(body, h.from); }
    catch (error) {
      const saved = body.type === "dispatch" ? this.store.data.quotes.find(q => P.hash(q.signed) === P.hash(body.quote)) : null;
      const replyKey = body.type === "quote_request" && body.buyer === h.from ? body.reply_key : saved?.reply_key;
      const endpoints = body.type === "quote_request" ? body.reply_endpoints : saved?.reply_endpoints;
      if (!replyKey || !Array.isArray(endpoints) || endpoints.length > 3 || !(error instanceof P.AgentError)) throw error;
      await this.send(h.from, replyKey, endpoints, { type: "error", job_id: body.job_id || body.quote.payload.job_id, code: error.code, message: error.message });
    }
    this.store.change(d => { d.inbox = d.inbox.filter(x => x.expires > Date.now()); if (d.inbox.length >= 4000) P.fail("RATE_LIMIT", "Received-message quota reached."); d.inbox.push({ id: h.id, from: h.from, sequence: h.sequence, hash: fingerprint, expires: Number(h.expires_at) }); });
  }
  async handle(body, sender) {
    P.text(body.type, 40);
    const shapes = { quote_request: ["job_id", "agent_id", "service_version_hash", "input_commitment", "reply_key", "reply_endpoints", "buyer"], quote: ["signed"], dispatch: ["quote", "input", "salt"], progress: ["job_id", "quote_hash", "status", "error"], delivery: ["job_id", "quote_hash", "output", "salt", "result_hash"], cancel: ["job_id", "quote_hash", "result_hash"], accept: ["job_id", "quote_hash", "result_hash"], reject: ["job_id", "quote_hash", "result_hash"], error: ["job_id", "code", "message"] };
    if (!Object.hasOwn(shapes, body.type)) P.fail("INVALID_SCHEMA", "Unsupported task message.");
    P.fields(body, ["type", ...shapes[body.type]]);
    if (body.type === "error") {
      const j = this.store.data.jobs.find(j => j.id === body.job_id && j.role === "buyer");
      if (!j || j.card.owner !== sender) P.fail("FORBIDDEN", "Error does not belong to this job.");
      if (!TERMINAL.includes(j.status) && j.status !== "delivered") this.store.change(d => { const x = d.jobs.find(x => x.id === j.id && x.role === "buyer"); x.status = "failed"; x.error = String(body.message).slice(0, 500); }); return;
    }
    if (body.type === "quote_request") {
      P.fields(body, ["type", "job_id", "agent_id", "service_version_hash", "input_commitment", "reply_key", "reply_endpoints", "buyer"]);
      if (!Array.isArray(body.reply_endpoints) || body.reply_endpoints.length > 3 || body.reply_endpoints.some(e => typeof e !== "string" || e.length > 500)) P.fail("INVALID_ENDPOINT", "Invalid reply endpoints.");
      P.text(body.reply_key, 500);
      if (body.buyer !== sender) P.fail("FORBIDDEN", "Quote buyer does not match sender."); P.text(body.job_id, 64); P.digest(body.input_commitment);
      const a = this.store.data.agents.find(a => a.id === body.agent_id);
      if (!a || (!a.accepting && sender !== this.identity().address) || P.hash(a.card) !== body.service_version_hash) P.fail("STALE_AGENT_VERSION", "The host is paused or the service version changed."); P.validateCard(a.card, this.domain);
      let saved = this.store.data.quotes.find(q => q.signed.payload.job_id === body.job_id && q.signed.payload.buyer === sender);
      if (saved && (saved.signed.payload.input_commitment !== body.input_commitment || saved.signed.payload.service_version_hash !== body.service_version_hash)) P.fail("REPLAY", "Job identifier already has different terms.");
      if (!saved) {
        const signed = await P.sign("quote", { job_id: body.job_id, buyer: sender, agent_id: a.id, service_version_hash: P.hash(a.card), definition_hash: a.card.payload.definition_hash, input_commitment: body.input_commitment, amount_atoms: "0", quote_expiry: String(Date.now() + 900000), delivery_seconds: a.card.payload.limits.seconds, nonce: P.random() }, this.identity(), this.domain);
        saved = { signed, definition: clone(a.definition), card: clone(a.card.payload), reply_key: body.reply_key, reply_endpoints: body.reply_endpoints };
        this.store.change(d => { d.quotes = d.quotes.filter(q => Number(q.signed.payload.quote_expiry) >= Date.now()); if (d.quotes.length >= 200) P.fail("RATE_LIMIT", "Too many pending quotes."); d.quotes.push(saved); });
      }
      await this.send(sender, saved.reply_key, saved.reply_endpoints, { type: "quote", signed: saved.signed }); return;
    }
    if (body.type === "quote") {
      const q = this.verifyQuote(body.signed, sender), j = this.store.data.jobs.find(j => j.id === q.job_id && j.role === "buyer");
      if (!j || j.card.owner !== sender || q.buyer !== j.buyer || q.agent_id !== j.agentId || q.service_version_hash !== P.hash(j.signedCard) || q.definition_hash !== j.card.definition_hash || q.amount_atoms !== j.card.amount_atoms || q.input_commitment !== P.hash({ input: j.input, salt: j.salt })) P.fail("INVALID_QUOTE", "Quote differs from the selected service and input.");
      if (j.status === "requesting_quote") this.store.change(d => { const x = d.jobs.find(x => x.id === j.id && x.role === "buyer"); x.quote = body.signed; x.status = "quoted"; }); return;
    }
    if (body.type === "dispatch") {
      const q = this.verifyQuote(body.quote, this.identity().address);
      if (q.buyer !== sender || q.amount_atoms !== "0") P.fail("FUNDING_NOT_FINAL", "Only an authorized free quote can dispatch without finalized escrow.");
      const old = this.store.data.jobs.find(j => j.id === q.job_id && j.role === "host"); if (old) { if (P.hash(old.quote) !== P.hash(body.quote)) P.fail("REPLAY", "Job already exists with different terms."); return; }
      const saved = this.store.data.quotes.find(x => P.hash(x.signed) === P.hash(body.quote));
      if (!saved || (!this.store.data.agents.find(a => a.id === q.agent_id)?.accepting && sender !== this.identity().address)) P.fail("STALE_AGENT_VERSION", "The host is no longer accepting this job.");
      if (q.input_commitment !== P.hash({ input: body.input, salt: body.salt })) P.fail("INVALID_INPUT", "Input does not match the quote."); P.validateSchema(saved.card.input_schema, body.input);
      if (Buffer.byteLength(P.canonical(body.input)) > saved.card.limits.input_bytes) P.fail("SIZE_LIMIT", "Input exceeds service limit.");
      this.store.change(d => {
        if (d.jobs.length >= 100 || d.jobs.filter(j => j.role === "host" && ["running", "waiting", "interrupted"].includes(j.status)).length >= 2) P.fail("HOST_BUSY", "The host's two job slots are occupied.");
        d.jobs.unshift({ id: q.job_id, role: "host", agentId: q.agent_id, name: saved.card.name, card: saved.card, quote: body.quote, at: Date.now(), deadline: Date.now() + saved.card.limits.seconds * 1000, buyer: sender, reply_key: saved.reply_key, reply_endpoints: saved.reply_endpoints, input: body.input, output: null, status: "running", modelCalls: 0, runId: null,
          workflow: { workflows: [{ ...saved.definition, id: q.job_id, revision: 1, draft: false, enabled: false, schedule: { kind: "manual" } }], runs: [], notes: [], goals: [], sources: [], connections: [] } });
      });
      try { this.runtime.start(q.job_id); this.activity("started", q.job_id, saved.card.name); }
      catch (error) { this.store.change(d => { const j = d.jobs.find(j => j.id === q.job_id && j.role === "host"); j.status = "failed"; j.error = String(error.message).slice(0, 500); }); }
      return;
    }
    if (["progress", "delivery"].includes(body.type)) {
      const j = this.store.data.jobs.find(j => j.id === body.job_id && j.role === "buyer"); if (!j || j.card.owner !== sender || body.quote_hash !== P.hash(j.quote)) P.fail("FORBIDDEN", "Status does not belong to this service job.");
      if (TERMINAL.includes(j.status) || j.status === "delivered") return;
      if (body.type === "delivery") {
        if (P.hash({ output: body.output, salt: body.salt }) !== body.result_hash) P.fail("ARTIFACT_UNAVAILABLE", "Delivered result failed its integrity check."); P.validateSchema(j.card.output_schema, body.output);
        if (Buffer.byteLength(P.canonical(body.output)) > j.card.limits.output_bytes) P.fail("SIZE_LIMIT", "Delivered output is too large.");
        this.store.change(d => { const x = d.jobs.find(x => x.id === j.id && x.role === "buyer"); x.output = body.output; x.resultHash = body.result_hash; x.status = "delivered"; });
      } else { if (!["running", "waiting", "interrupted", "failed", "cancelled"].includes(body.status)) P.fail("INVALID_SCHEMA", "Invalid job status."); this.store.change(d => { const x = d.jobs.find(x => x.id === j.id && x.role === "buyer"); x.status = body.status; x.error = String(body.error || "").slice(0, 500); }); } return;
    }
    if (["cancel", "accept", "reject"].includes(body.type)) {
      const j = this.store.data.jobs.find(j => j.id === body.job_id && j.role === "host"); if (!j || j.buyer !== sender || body.quote_hash !== P.hash(j.quote)) P.fail("FORBIDDEN", "This is not your service job.");
      if (TERMINAL.includes(j.status)) return;
      if (body.type === "cancel") { this.runtime.cancel(j.id); this.store.change(d => { d.jobs.find(x => x.id === j.id && x.role === "host").status = "cancelled"; }); }
      else { if (j.status !== "delivered" || body.result_hash !== j.resultHash) P.fail("ARTIFACT_UNAVAILABLE", "Review the delivered result first."); this.store.change(d => { d.jobs.find(x => x.id === j.id && x.role === "host").status = body.type === "accept" ? "accepted" : "rejected"; }); }
      this.activity(body.type, j.id, "Free service · no paid reputation or KAI transfer"); return;
    }
    P.fail("INVALID_SCHEMA", "Unsupported task message.");
  }
  async jobAction(id, action, role = "buyer") {
    this.enabled(); const j = this.store.data.jobs.find(j => j.id === id && j.role === role); if (!j) P.fail("NOT_FOUND", "Choose a job.");
    if (action === "remove") {
      if (!TERMINAL.includes(j.status)) P.fail("INVALID_STATE", "Finish or cancel the job before removing its local receipt.");
      if (Number(j.quote?.payload.quote_expiry || 0) >= Date.now() || this.runtime.runners.get(id)?.active.size) P.fail("REPLAY_WINDOW", "Keep this receipt until its quote expires (15 minutes after issue) to prevent duplicate execution. Save the result before removing it.");
      this.store.change(d => { d.jobs = d.jobs.filter(x => x.id !== id || x.role !== role); }); this.runtime.runners.delete(id); return;
    }
    if (role === "host") {
      if (TERMINAL.includes(j.status)) return;
      if (action === "cancel") { this.runtime.cancel(id); this.store.change(d => { d.jobs.find(x => x.id === id && x.role === role).status = "cancelled"; }); }
      else if (action === "resume") { if (j.status !== "interrupted") P.fail("INVALID_STATE", "Only an interrupted job can resume."); if (j.deadline <= Date.now()) P.fail("DELIVERY_TOO_LATE", "The execution deadline passed."); this.runtime.start(id); this.store.change(d => { d.jobs.find(x => x.id === id && x.role === role).status = "running"; }); }
      else if (action === "approve") { if (j.status !== "waiting") P.fail("INVALID_STATE", "This job has no pending approval."); this.runtime.decision(id, true); }
      else P.fail("INVALID_SCHEMA", "Unsupported host action.");
    } else {
      if (!["cancel", "accept", "reject"].includes(action)) P.fail("INVALID_SCHEMA", "Unsupported job action.");
      if (action !== "cancel" && j.status !== "delivered") P.fail("ARTIFACT_UNAVAILABLE", "Wait for a verified delivery before reviewing it.");
      if (TERMINAL.includes(j.status)) return;
      await this.send(j.card.owner, j.card.encryption_public, j.card.endpoints, { type: action, job_id: id, quote_hash: P.hash(j.quote), result_hash: j.resultHash || null });
      this.store.change(d => { d.jobs.find(x => x.id === id && x.role === role).status = action === "cancel" ? "cancelled" : action === "accept" ? "accepted" : "rejected"; });
    }
    await this.tick();
  }
  async monitor() {
    for (const j of this.store.data.jobs.filter(j => j.role === "host" && j.runId && !TERMINAL.includes(j.status) && j.status !== "delivered")) {
      const r = j.workflow.runs.find(r => r.id === j.runId); if (!r) continue;
      if (Date.now() >= j.deadline && ["running", "waiting", "interrupted"].includes(r.status)) { this.runtime.cancel(j.id); this.store.change(d => { const x = d.jobs.find(x => x.id === j.id && x.role === "host"); x.status = "failed"; x.error = "Service time limit reached."; }); }
      else if (r.status === "completed") {
        try { const output = r.previous; P.validateSchema(j.card.output_schema, output); if (Buffer.byteLength(P.canonical(output)) > j.card.limits.output_bytes) P.fail("SIZE_LIMIT", "Service output limit reached."); const salt = P.random(), resultHash = P.hash({ output, salt });
          await this.send(j.buyer, j.reply_key, j.reply_endpoints, { type: "delivery", job_id: j.id, quote_hash: P.hash(j.quote), output, salt, result_hash: resultHash });
          this.store.change(d => { const x = d.jobs.find(x => x.id === j.id && x.role === "host"); x.status = "delivered"; x.output = output; x.resultHash = resultHash; }); this.activity("delivered", j.id, j.name); continue;
        } catch (e) { this.store.change(d => { const x = d.jobs.find(x => x.id === j.id && x.role === "host"); x.status = "failed"; x.error = e.message; }); }
      } else if (r.status !== j.status) this.store.change(d => { const x = d.jobs.find(x => x.id === j.id && x.role === "host"); x.status = r.status; x.error = r.error || null; });
      const updated = this.store.data.jobs.find(x => x.id === j.id && x.role === "host"), key = updated.status + (updated.error || "");
      if (updated.lastNotice !== key) { await this.send(j.buyer, j.reply_key, j.reply_endpoints, { type: "progress", job_id: j.id, quote_hash: P.hash(j.quote), status: updated.status, error: updated.error || null }); this.store.change(d => { d.jobs.find(x => x.id === j.id && x.role === "host").lastNotice = key; }); }
    }
    // A host can cancel before a run exists, or fail while starting it. Persist
    // terminal notices separately so those paths survive restarts and relay outages.
    for (const j of this.store.data.jobs.filter(j => j.role === "host" && ["failed", "cancelled"].includes(j.status))) {
      const key = j.status + (j.error || ""); if (j.lastNotice === key) continue;
      await this.send(j.buyer, j.reply_key, j.reply_endpoints, { type: "progress", job_id: j.id, quote_hash: P.hash(j.quote), status: j.status, error: j.error || null });
      this.store.change(d => { d.jobs.find(x => x.id === j.id && x.role === "host").lastNotice = key; });
    }
  }
  async tick() {
    if (this.busy || !this.store.data.enabled || this.store.locked) return; this.busy = true;
    try {
      await this.monitor();
      for (const outgoing of [...this.store.data.outbox]) {
        const packet = outgoing.packet, h = packet.payload.header;
        if (Number(h.expires_at) <= Date.now()) { this.store.change(d => { d.lastError = "An outgoing message expired. Review the affected job before retrying."; d.outbox = d.outbox.filter(x => x.packet.payload.header.id !== h.id); }); continue; }
        if (h.to === this.identity().address) { await this.receive(packet); this.store.change(d => { d.outbox = d.outbox.filter(x => x.packet.payload.header.id !== h.id); }); continue; }
        let success = 0;
        for (const e of outgoing.endpoints) { try { await this.transport.auth(e, "/agent-network/v1/messages", { packet }, this.identity(), this.domain); success++; } catch (e) { this.store.change(d => { d.lastError = e.message; }); } }
        if (success) this.store.change(d => { d.outbox = d.outbox.filter(x => x.packet.payload.header.id !== h.id); });
      }
      for (const e of this.store.data.endpoints) {
        try { const inbox = await this.transport.auth(e, "/agent-network/v1/inbox", {}, this.identity(), this.domain); const ids = []; for (const packet of inbox.items || []) { try { await this.receive(packet); } catch (error) { this.store.change(d => { d.lastError = error.message; }); } ids.push(packet.payload.header.id); } if (ids.length) await this.transport.auth(e, "/agent-network/v1/ack", { ids }, this.identity(), this.domain); }
        catch (e) { this.store.change(d => { d.lastError = e.message; }); }
      }
    } finally { this.busy = false; }
  }
  start() { if (this.timer || !this.store.data.enabled) return; this.timer = setInterval(() => void this.tick().catch(e => { try { this.store.change(d => { d.lastError = e.message; }); } catch {} }), 2500); this.timer.unref?.(); }
  stop() { clearInterval(this.timer); this.timer = null; this.runtime.stop(); }
}
module.exports = { AgentNetwork, TERMINAL };
