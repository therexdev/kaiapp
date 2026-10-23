"use strict";

const crypto = require("crypto");

/*
 * Network context protocol 1 (docs/NETWORK_CONTEXT_PROTOCOL.md). Pure helpers
 * shared by the worker, the runtime manager, the gateway and server.js. The
 * constants and both estimators are byte-identical to the production
 * scheduler's copies: a client and a scheduler that disagree about how big a
 * prompt is would refuse, or bill, the same request differently.
 */

const CONTEXT_TIERS = Object.freeze([4096, 16384, 32768]);
const OPT_IN_TIERS = Object.freeze([16384, 32768]); // kaiapp only
const LEGACY_CONTEXT_TOKENS = 4096;
const LEGACY_MAX_TOKENS = 512;
const NETWORK_MAX_OUTPUT_TOKENS = 4096;
const CONTEXT_PROTOCOL = 1;
const CTX_HEADROOM_TOKENS = 512; // existing gateway constant

/** Rough prompt-size estimate (~4 chars/token + per-message overhead).
 *  Deliberately cheap — it gates routing, it does not bill anything.
 *  Multimodal content-parts: text parts count by chars; each image counts a
 *  flat ~800 tokens (typical projector budget), NOT its base64 length —
 *  String()-ing an array would both miscount and crash the gate.
 *  LEGACY: today's gateway estimateMessageTokens (UTF-16 .length), in the
 *  contract's exact text shared with the scheduler. */
function estimateTokensLegacy(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0, n = 0, images = 0;
  for (const m of messages) {
    n += 1;
    const c = m?.content;
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === "image_url") images += 1;
        else chars += String(part?.text ?? "").length;
      }
    } else chars += String(c ?? "").length;
  }
  return Math.ceil(chars / 4) + n * 4 + images * 800;
}

/** V1: content only (no role/name); code points via for..of; ONE global
 *  ceil. Non-ASCII counts a token per code point, so CJK text that the
 *  legacy char/4 rule under-counts can never sneak past a signed window. */
function estimateTokensV1(messages) {
  if (!Array.isArray(messages)) return 0;
  let ascii = 0, other = 0, n = 0, images = 0;
  const count = (s) => { for (const ch of s) { if (ch.codePointAt(0) < 128) ascii += 1; else other += 1; } };
  for (const m of messages) {
    n += 1;
    const c = m?.content;
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === "image_url") images += 1;
        else count(String(part?.text ?? ""));
      }
    } else count(String(c ?? ""));
  }
  return Math.ceil(ascii / 4) + other + n * 4 + images * 800;
}

const tierFor = (required) => CONTEXT_TIERS.find((t) => required <= t) ?? null;

const isPositiveSafeInt = (v) => Number.isSafeInteger(v) && v >= 1;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** §11: a job's terms as this worker will honour them. Garbage degrades to
 *  legacy and never throws — an old scheduler sends no terms at all. */
function normalizeJobTerms(job) {
  const mt = job?.maxTokens;
  const maxTokens = Number.isSafeInteger(mt) && mt >= 1 && mt <= NETWORK_MAX_OUTPUT_TOKENS ? mt : LEGACY_MAX_TOKENS;
  const contextTokens = CONTEXT_TIERS.includes(job?.contextTokens) ? job.contextTokens : LEGACY_CONTEXT_TOKENS;
  return { maxTokens, contextTokens, legacy: contextTokens <= LEGACY_CONTEXT_TOKENS && maxTokens <= LEGACY_MAX_TOKENS };
}

/**
 * §4: one `runtime.modelContext` entry, validated against the catalog.
 * Returns the normalized {contextTokens, maxOutputTokens} or throws an error
 * a person can act on. Never derived from RAM/VRAM: the window comes from
 * the package's published maxContextTokens and the owner's explicit choice.
 */
function validateModelContext(catalog, alias, entry) {
  const name = String(alias ?? "");
  const aliases = isPlainObject(catalog?.aliases) ? catalog.aliases : {};
  const packages = isPlainObject(catalog?.packages) ? catalog.packages : {};
  if (!name || !Object.hasOwn(aliases, name)) {
    throw new Error(`Unknown model "${name}" — only catalog models can use a larger context`);
  }
  const a = aliases[name];
  if (a?.dev || a?.custom || name.startsWith("dev-")) {
    throw new Error(`"${name}" is not a network model, so it always runs at ${LEGACY_CONTEXT_TOKENS} tokens`);
  }
  if (!isPlainObject(entry)) throw new Error("Context settings must look like {\"contextTokens\": 16384}");
  const ctx = entry.contextTokens;
  if (!OPT_IN_TIERS.includes(ctx)) {
    throw new Error(`contextTokens must be ${OPT_IN_TIERS.join(" or ")} (or ${LEGACY_CONTEXT_TOKENS}/null to switch it off)`);
  }
  const pkg = Object.hasOwn(packages, a?.package) ? packages[a.package] : null;
  const max = Number.isSafeInteger(pkg?.maxContextTokens) ? pkg.maxContextTokens : LEGACY_CONTEXT_TOKENS;
  if (ctx > max) throw new Error(`${name} supports at most ${max} tokens of context`);
  const cap = Math.min(NETWORK_MAX_OUTPUT_TOKENS, ctx / 2);
  let out = entry.maxOutputTokens;
  if (out == null) out = LEGACY_MAX_TOKENS;
  else if (!Number.isSafeInteger(out) || out < LEGACY_MAX_TOKENS || out > cap) {
    throw new Error(`maxOutputTokens must be a whole number from ${LEGACY_MAX_TOKENS} to ${cap} for a ${ctx}-token context`);
  }
  return { contextTokens: ctx, maxOutputTokens: out };
}

/** Stored settings are re-validated on every read: an entry the current
 *  catalog no longer allows is dropped, never trusted. */
function sanitizeContextSettings(catalog, raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const alias of Object.keys(raw)) {
    try {
      out[alias] = validateModelContext(catalog, alias, raw[alias]);
    } catch {
      /* invalid for this catalog — dropped */
    }
  }
  return out;
}

const V1_ROLES = new Set(["system", "user", "assistant"]);
const onlyKeys = (o, allowed) => Object.keys(o).every((k) => allowed.includes(k));
/** v1 is TEXT-ONLY: a part is exactly {type: "text", text: string}. Images
 *  stay off the larger-context lane (a flat per-image estimate cannot back an
 *  honest capacity refusal), and so does any extra or nested field. */
const isV1Part = (p) => isPlainObject(p) && onlyKeys(p, ["type", "text"]) && p.type === "text" && typeof p.text === "string";

/** §7/§13: v1 messages are plain TEXT role/content turns (tools and images
 *  stay off network jobs on this lane). Returns the turns mapped to exactly
 *  {role, content}, or null when any message has another shape — the caller
 *  keeps the legacy lane when the request fits it, else refuses locally. */
function v1Messages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const out = [];
  for (const m of messages) {
    if (!isPlainObject(m) || !onlyKeys(m, ["role", "content"]) || !V1_ROLES.has(m.role)) return null;
    const c = m.content;
    if (!(typeof c === "string" || (Array.isArray(c) && c.every(isV1Part)))) return null;
    out.push({ role: m.role, content: c });
  }
  return out;
}

/** §7 v1 signed hash: the billable terms (model, max_tokens) are inside
 *  the signature, so a captured request cannot be re-spent on other terms. */
function consumeV1Hash({ address, ts, model, max_tokens, messages }) {
  return crypto
    .createHash("sha256")
    .update(`consume-v1|${JSON.stringify([address, ts, model, max_tokens, messages])}`, "utf8")
    .digest();
}

/** §7 legacy signed hash — unchanged since FIND-NET-001. */
function legacyConsumeHash(address, ts, messages) {
  return crypto.createHash("sha256").update(`consume|${address}|${ts}|${JSON.stringify(messages)}`).digest();
}

module.exports = {
  CONTEXT_TIERS,
  OPT_IN_TIERS,
  LEGACY_CONTEXT_TOKENS,
  LEGACY_MAX_TOKENS,
  NETWORK_MAX_OUTPUT_TOKENS,
  CONTEXT_PROTOCOL,
  CTX_HEADROOM_TOKENS,
  estimateTokensLegacy,
  estimateTokensV1,
  tierFor,
  isPositiveSafeInt,
  normalizeJobTerms,
  validateModelContext,
  sanitizeContextSettings,
  v1Messages,
  consumeV1Hash,
  legacyConsumeHash,
};
