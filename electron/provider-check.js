"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const MAX_PACK = 2000000, MAX_REPORT = 4000000, MAX_RESPONSE = 1500000, MAX_MODEL = 32 * 1024 ** 3;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = code => Object.assign(new Error(code), { code });
const TEXT = {
  model_not_running: "No local model is running. Start earning prepares an installed model automatically; no chat message is needed.",
  model_loading: "The local model is still loading. Let loading finish before checking again.",
  model_load_failed: "The local model could not finish loading. Open Chat to see the model's loading error.",
  model_identity_unavailable: "The local engine is running, but the app could not identify its active model. This state has been kept in the report for review.",
  model_not_prepared: "This model does not have a prepared local check yet. The report records that limitation.",
  model_not_approved: "Choose an approved public local model in Chat before checking this computer.",
  model_busy: "This computer is answering a request. Let it finish, then check again.",
  runtime_unsupported: "This check requires the app's managed llama.cpp engine.",
  runtime_changed: "The model or runtime changed during the check. The incomplete report has been kept.",
  wallet_changed: "The public wallet changed during the check. The incomplete report has been kept.",
  model_file_invalid: "The installed model file could not be safely verified.",
  model_hash_mismatch: "The installed model file does not match the approved package.",
  model_file_changed: "The model file changed during verification. The check stopped.",
  tokenizer_mismatch: "The running model's tokenizer differs from the prepared reference. The check stopped.",
  runtime_response_invalid: "The local engine returned an invalid or oversized answer. The check stopped.",
  runtime_request_failed: "The local engine did not complete the request. The incomplete report has been kept.",
  cancelled: "Local check cancelled. Completed measurements are available in the report.",
  timeout: "The local check reached its time limit. Completed measurements are available in the report.",
  pack_unavailable: "The app's local measurement pack is unavailable. Update the app and try again.",
  report_too_large: "The report reached its size limit. A bounded incomplete summary has been kept.",
};
function endpoint(value) {
  if (typeof value !== "string" || !/^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}\/?$/.test(value)) throw fail("runtime_unsupported");
  const u = new URL(value); if (!u.port || Number(u.port) > 65535) throw fail("runtime_unsupported"); return u.origin;
}
function validatePack(value) {
  if (!value || value.schema !== 1 || value.status !== "candidate-not-approved" || !/^[a-f0-9]{40}$/.test(value.source?.backendCommit || "") ||
      !digest(value.source.suiteSha256) || !Array.isArray(value.models) || value.models.length > 64 || Buffer.byteLength(JSON.stringify(value)) > MAX_PACK) throw fail("pack_unavailable");
  const names = new Set();
  for (const m of value.models) {
    if (!m || !/^[a-zA-Z0-9._-]{1,100}$/.test(m.model || "") || names.has(m.model) || typeof m.package !== "string" || m.package.length > 160 ||
        ![m.modelHash, m.tokenizerHash, m.configHash, m.templateHash, m.manifestSha256].every(digest) || !Number.isSafeInteger(m.at) || m.at < 0 || m.at > 253402300799999 ||
        !Array.isArray(m.vectors) || m.vectors.length < 3 || m.vectors.length > 128 || !Array.isArray(m.cases) || m.cases.length !== 12) throw fail("pack_unavailable");
    names.add(m.model); const ids = new Set();
    for (const v of m.vectors) {
      if (!v || typeof v.id !== "string" || v.id.length > 100 || ids.has(v.id) || typeof v.text !== "string" || Buffer.byteLength(v.text) > 65536 ||
          !Number.isSafeInteger(v.count) || v.count < 0 || v.count > 100000 || !digest(v.idsHash)) throw fail("pack_unavailable");
      ids.add(v.id);
    }
    ids.clear();
    for (const c of m.cases) {
      if (!c || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.id || "") || ids.has(c.id) || typeof c.prompt !== "string" || Buffer.byteLength(c.prompt) > 65536 || hash(c.prompt) !== c.promptHash ||
          !digest(c.inputIdsHash) || !Number.isSafeInteger(c.inputTokens) || c.inputTokens < 1 || c.inputTokens > 100000 ||
          !Number.isSafeInteger(c.maxOutput) || c.maxOutput < 1 || c.maxOutput > 4096 || !Array.isArray(c.expected) || !c.expected.length || c.expected.length > 8 ||
          c.expected.some(s => typeof s !== "string" || !s.trim() || s !== s.trim() || Buffer.byteLength(s) > 65536) ||
          !Array.isArray(c.messages) || !c.messages.length || c.messages.length > 8 || c.messages.some(x => !x || !["user", "assistant", "system"].includes(x.role) || typeof x.content !== "string" || Buffer.byteLength(x.content) > 4096)) throw fail("pack_unavailable");
      ids.add(c.id);
    }
  }
  return structuredClone(value);
}
function loadPack() {
  try {
    const file = path.join(__dirname, "../core/provider-check/candidates.json"), stat = fs.statSync(file);
    if (stat.size > MAX_PACK) throw fail("pack_unavailable");
    const bytes = fs.readFileSync(file); if (bytes.length > MAX_PACK) throw fail("pack_unavailable");
    return { value: validatePack(JSON.parse(bytes)), sha256: hash(bytes) };
  } catch { throw fail("pack_unavailable"); }
}
const safeText = (s, max = 128) => typeof s === "string" ? s.replace(/[\x00-\x1f]/g, "").slice(0, max) : null;
const natural = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
function hardware(h = {}) {
  return { platform: safeText(h.platform, 20), arch: safeText(h.arch, 20), ramBytes: natural(h.ramBytes),
    cpu: { model: safeText(h.cpu?.model), cores: natural(h.cpu?.cores) },
    gpus: (Array.isArray(h.gpus) ? h.gpus.slice(0, 8) : []).map(g => ({ vendor: safeText(g.vendor, 32), name: safeText(g.name), vramMb: natural(g.vramMb) })) };
}
function wallet(core) { const address = core.account?.wallet?.address; return typeof address === "string" && /^[1-9A-HJ-NP-Za-km-z]{25,50}$/.test(address) ? address : null; }
function localState(core, pack, snapshot) {
  // Keep the distinction between installed, selected and actually running
  // models in evidence. Never export custom aliases, paths or engine errors.
  const approved = new Set(pack.models.filter(m => {
    const a = core.models.catalog.aliases[m.model], p = a && core.models.catalog.packages[a.package];
    return a && !a.custom && !a.dev && p && !p.custom && a.package === m.package && p.sha256 === m.modelHash && !core.models.quarantineOf(a.package);
  }).map(m => m.model));
  let installedApprovedModels = null;
  try { if (typeof core.models.aliases === "function") installedApprovedModels = core.models.aliases().filter(a => approved.has(a.alias) && a.status === "ready").length; } catch {}
  return { loading: !!snapshot.loading, activeModel: approved.has(snapshot.activeAlias) ? snapshot.activeAlias : null,
    running: !!snapshot.runtime?.running, engine: snapshot.runtime ? ["llamacpp", "ollama"].includes(snapshot.runtime.kind) ? snapshot.runtime.kind : "other" : null,
    lastLoadFailed: !!snapshot.lastLoadError, installedApprovedModels };
}
async function hashModel(file, expected, signal, progress = () => {}) {
  let handle;
  try {
    if (!path.isAbsolute(file)) throw fail("model_file_invalid");
    const link = await fs.promises.lstat(file);
    if (!link.isFile() || link.isSymbolicLink()) throw fail("model_file_invalid");
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_MODEL) throw fail("model_file_invalid");
    const h = crypto.createHash("sha256"), buffer = Buffer.alloc(1024 * 1024); let total = 0, count;
    do {
      signal.throwIfAborted(); ({ bytesRead: count } = await handle.read(buffer, 0, buffer.length, null)); total += count;
      if (total > MAX_MODEL) throw fail("model_file_invalid");
      if (count) h.update(buffer.subarray(0, count)); progress(total, before.size);
    } while (count);
    signal.throwIfAborted(); const after = await handle.stat(), sha256 = h.digest("hex");
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw fail("model_file_changed");
    if (sha256 !== expected) throw fail("model_hash_mismatch");
    return { sha256, sizeBytes: total, hashVerified: true };
  } catch (e) { if (signal.aborted) throw e; throw Object.hasOwn(TEXT, e.code) ? e : fail("model_file_invalid"); }
  finally { await handle?.close(); }
}
async function readJson(response) {
  if (!response.ok || !response.body) { try { await response.body?.cancel(); } catch {} throw fail("runtime_request_failed"); }
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_RESPONSE) throw fail("runtime_response_invalid"); parts.push(Buffer.from(value)); }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))); } catch { throw fail("runtime_response_invalid"); }
  } finally { try { await reader.cancel(); } catch {} }
}
class LocalProviderCheck {
  constructor({ core, appVersion, channel = "test", pack, fetchImpl = fetch, onProgress = () => {}, clock = Date.now }) {
    Object.assign(this, { core, fetchImpl, onProgress, clock }); this.app = { version: safeText(appVersion, 80), channel: safeText(channel, 20) };
    this.packInput = pack; this.report = null; this.current = { state: "idle", stage: "", detail: "Check the current local model without using credits or changing sharing.", completed: 0, total: 0, passed: null, reportAvailable: false, model: null };
  }
  status() { return structuredClone(this.current); }
  update(change) { Object.assign(this.current, change); try { this.onProgress(this.status()); } catch {} }
  start() {
    if (this.current.state === "running") return this.status();
    this.report = null; this.controller = new AbortController();
    this.update({ state: "running", stage: "Preparing", detail: "Reading the current local model.", completed: 0, total: 0, passed: null, reportAvailable: false, model: null });
    this.task = this.run(this.controller.signal); return this.status();
  }
  cancel() { this.controller?.abort(fail("cancelled")); return this.status(); }
  dispose() { this.cancel(); }
  async run(signal) {
    let hold, networkPause, timer, snapshot, completed = 0;
    const report = this.report = { schema: 1, kind: "local-provider-candidate-check", status: "candidate-not-approved", signed: false, providerEligibilityCreated: false,
      networkReady: false, startedAt: this.clock(), completedAt: null, app: this.app, publicWallet: wallet(this.core), hardware: hardware(this.core.hardware),
      model: null, runtime: null, modelFile: null, calibration: { complete: false, vectors: [] }, measurement: { complete: false, results: [] },
      limits: ["A local candidate measurement creates no network eligibility or reward entitlement.",
        "The current model file is hashed and the app-managed process is observed; already-loaded weight bytes are not cryptographically attested.",
        "This check sends fixed public test prompts to the local engine only. No account credentials, private chats, logs or keys are exported.",
        "Timing can include runtime warm-up and competing local work; no admission or latency threshold is inferred."] };
    try {
      const loaded = this.packInput ? { value: validatePack(this.packInput), sha256: hash(JSON.stringify(this.packInput)) } : loadPack(), pack = loaded.value;
      report.source = { backendCommit: pack.source.backendCommit, packSha256: loaded.sha256 };
      for (const key of ["suiteSha256", "catalogSha256", "indexSha256", "generatorSha256", "tokenizerSourceSha256"]) if (digest(pack.source[key])) report.source[key] = pack.source[key];
      signal.throwIfAborted();
      if (typeof this.core.runtime.pauseNetworkWork === "function") {
        this.update({ stage: "Waiting for network work", detail: "Finishing assigned network work before the local check. Sharing resumes automatically afterward." });
        const deadline = AbortSignal.timeout(120000);
        try { networkPause = await this.core.runtime.pauseNetworkWork(AbortSignal.any([signal, deadline])); }
        catch (error) { if (deadline.aborted && !signal.aborted) throw fail("model_busy"); throw error; }
      }
      snapshot = this.core.runtime.status();
      report.localState = { initial: localState(this.core, pack, snapshot), current: null, waitedForLoad: false };
      // A click during an existing warm start or Chat load must not instantly
      // become "model not running". Observe that load without ensuring,
      // downloading, switching, or cancelling the underlying runtime.
      if (snapshot.loading) {
        report.localState.waitedForLoad = true;
        this.update({ stage: "Waiting for local model", detail: "The app is already loading a local model. This check will continue when it is ready." });
        const deadline = AbortSignal.timeout(120000);
        while (snapshot.loading) {
          if (deadline.aborted) throw fail("model_loading");
          await delay(250, undefined, { signal });
          snapshot = this.core.runtime.status();
          report.localState.current = localState(this.core, pack, snapshot);
        }
      }
      report.localState.current = localState(this.core, pack, snapshot);
      if (!snapshot.runtime?.running) throw fail(snapshot.lastLoadError ? "model_load_failed" : "model_not_running");
      if (!snapshot.activeAlias) throw fail("model_identity_unavailable");
      const alias = this.core.models.catalog.aliases[snapshot.activeAlias], pkg = alias && this.core.models.catalog.packages[alias.package];
      if (!alias || alias.custom || alias.dev || !pkg || pkg.custom || !digest(pkg.sha256) || this.core.models.quarantineOf(alias.package)) throw fail("model_not_approved");
      const m = pack.models.find(x => x.model === snapshot.activeAlias && x.package === alias.package && x.modelHash === pkg.sha256);
      if (!m) throw fail("model_not_prepared");
      if (snapshot.runtime.kind !== "llamacpp" || !Number.isSafeInteger(snapshot.runtime.pid) || snapshot.runtime.pid < 1 || typeof this.core.runtime.acquireCurrent !== "function") throw fail("runtime_unsupported");
      const base = endpoint(snapshot.runtime.endpoint), file = this.core.models.packagePath(alias.package);
      if (path.resolve(snapshot.runtime.model || "") !== path.resolve(file)) throw fail("runtime_changed");
      if (this.core.runtime.busy()) throw fail("model_busy");
      hold = this.core.runtime.acquireCurrent(m.model);
      if (endpoint(hold.endpoint) !== base) throw fail("runtime_changed");
      const guard = () => {
        signal.throwIfAborted(); const now = this.core.runtime.status();
        if (now.loading || now.activeAlias !== m.model || !now.runtime?.running || now.runtime.kind !== "llamacpp" || now.runtime.pid !== snapshot.runtime.pid ||
            now.runtime.endpoint !== snapshot.runtime.endpoint || now.runtime.model !== snapshot.runtime.model || this.core.models.quarantineOf(alias.package) ||
            this.core.models.catalog.aliases[m.model]?.package !== m.package || this.core.models.catalog.packages[m.package]?.sha256 !== m.modelHash) throw fail("runtime_changed");
        if (wallet(this.core) !== report.publicWallet) throw fail("wallet_changed");
      };
      guard(); timer = setTimeout(() => this.controller.abort(fail("timeout")), 10 * 60 * 1000);
      report.model = { id: m.model, label: safeText(alias.label || m.model), package: m.package, modelHash: m.modelHash, tokenizerHash: m.tokenizerHash,
        configHash: m.configHash, templateHash: m.templateHash, manifestSha256: m.manifestSha256, referenceAt: m.at };
      // Null means the full observation did not finish; only an observed
      // runtime change proves instability, and only a completed check proves
      // the process remained the same throughout this measurement.
      report.runtime = { kind: "llamacpp", pid: snapshot.runtime.pid, identity: "managed-process-observed", stable: null };
      this.update({ model: { id: m.model, label: report.model.label }, total: 1 + m.vectors.length + m.cases.length, stage: "Checking model file", detail: "Verifying the installed model against its exact approved package." });
      let lastPercent = -1;
      report.modelFile = await hashModel(file, m.modelHash, signal, (bytes, total) => { const p = Math.floor(bytes * 100 / total); if (p !== lastPercent) { lastPercent = p; this.update({ detail: `Verifying model file: ${p}%.` }); } });
      guard(); this.update({ completed: ++completed, stage: "Checking tokenizer", detail: "Comparing the running model with pinned reference tokens." });
      const post = async (route, body) => {
        guard(); const deadline = AbortSignal.timeout(120000), requestSignal = AbortSignal.any([signal, deadline]);
        let answer;
        try { answer = await readJson(await this.fetchImpl(base + route, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: requestSignal })); }
        catch (error) { if (signal.aborted) throw signal.reason; if (deadline.aborted) throw fail("timeout"); throw Object.hasOwn(TEXT, error.code) ? error : fail("runtime_request_failed"); }
        guard(); return answer;
      };
      const tokenize = async (text, count, idsHash) => {
        const value = await post("/tokenize", { content: text, add_special: false, parse_special: true });
        if (!Array.isArray(value.tokens) || value.tokens.length > 100000 || value.tokens.some(x => !Number.isSafeInteger(x) || x < 0)) throw fail("runtime_response_invalid");
        const actualHash = hash(JSON.stringify(value.tokens));
        return { ids: value.tokens, result: { count: value.tokens.length, idsHash: actualHash, passed: value.tokens.length === count && actualHash === idsHash } };
      };
      for (const v of m.vectors) {
        const { result } = await tokenize(v.text, v.count, v.idsHash); report.calibration.vectors.push({ id: v.id, textHash: hash(v.text), expectedCount: v.count, expectedIdsHash: v.idsHash, ...result });
        if (!result.passed) throw fail("tokenizer_mismatch"); this.update({ completed: ++completed });
      }
      report.calibration.complete = true;
      this.update({ stage: "Checking answers", detail: "Running 12 fixed local checks. These are candidate measurements, not network approval.", passed: 0 });
      for (const c of m.cases) {
        const { ids, result: tokens } = await tokenize(c.prompt, c.inputTokens, c.inputIdsHash);
        const item = { id: c.id, promptHash: c.promptHash, referenceAt: m.at, inputTokens: c.inputTokens,
          inputIdsHash: c.inputIdsHash, tokenizer: tokens, expected: c.expected, maxOutput: c.maxOutput, passed: false };
        report.measurement.results.push(item);
        if (!tokens.passed) throw fail("tokenizer_mismatch");
        // A string prompt is tokenized again with add_special=true by llama.cpp.
        // Passing the already-verified IDs prevents a second BOS/EOS insertion.
        item.inferenceInput = { format: "token-ids", count: ids.length, idsHash: tokens.idsHash };
        const at = performance.now(), result = await post("/completion", { prompt: ids, n_predict: c.maxOutput, temperature: 0, stream: false, cache_prompt: false });
        const terminal = result.stop === true || [result.stopped_eos, result.stopped_word, result.stopped_limit].includes(true) || ["eos", "word", "limit"].includes(result.stop_type);
        if (typeof result.content !== "string" || Buffer.byteLength(result.content) > 65536 || result.truncated === true || result.stop === false || !terminal) throw fail("runtime_response_invalid");
        item.elapsedMs = Math.round(performance.now() - at); item.output = result.content; item.outputHash = hash(result.content);
        item.stoppedByLimit = result.stopped_limit === true || result.stop_type === "limit";
        item.passed = !item.stoppedByLimit && c.expected.includes(result.content.trim());
        this.update({ completed: ++completed, passed: report.measurement.results.filter(x => x.passed).length });
      }
      guard(); report.runtime.stable = true; report.measurement.complete = true; report.outcome = { state: "complete", code: null };
      this.update({ state: "complete", stage: "Local check complete", detail: `Measured ${this.current.passed} of 12 exact answers. Copy or save the report for review; this does not turn the provider ONLINE.` });
    } catch (error) {
      const code = signal.aborted ? signal.reason?.code === "timeout" ? "timeout" : "cancelled" : Object.hasOwn(TEXT, error.code) ? error.code : "runtime_request_failed";
      if (code === "runtime_changed" && report.runtime) report.runtime.stable = false;
      report.outcome = { state: completed ? "incomplete" : "unavailable", code };
      const installed = report.localState?.current?.installedApprovedModels;
      const detail = code === "model_not_running" && installed > 0 ? `${installed} approved local model${installed === 1 ? " is" : "s are"} installed. ${TEXT[code]}` : TEXT[code];
      this.update({ state: report.outcome.state, stage: code === "cancelled" ? "Check cancelled" : "Check incomplete", detail });
    } finally {
      clearTimeout(timer); hold?.release(); networkPause?.release(); report.completedAt = this.clock();
      try { this.reportText(); } catch {
        this.report = { schema: 1, kind: report.kind, status: report.status, signed: false, providerEligibilityCreated: false, networkReady: false,
          app: this.app, startedAt: report.startedAt, completedAt: report.completedAt, outcome: { state: "incomplete", code: "report_too_large" }, resultsOmitted: true };
        this.update({ state: "incomplete", stage: "Check incomplete", detail: TEXT.report_too_large });
      }
      this.update({ reportAvailable: true });
    }
  }
  reportText() { if (!this.report || this.current.state === "running") throw Error("Finish the local check before exporting its report"); const text = JSON.stringify(this.report, null, 2) + "\n"; if (Buffer.byteLength(text) > MAX_REPORT) throw fail("report_too_large"); return text; }
}
module.exports = { LocalProviderCheck, validatePack, hashModel, endpoint, MAX_PACK, MAX_REPORT, MAX_RESPONSE };
