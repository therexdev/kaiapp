"use strict";
const crypto = require("crypto");
const { Signer } = require("koilib");
const VERSION = "kai.agent/1", PRIVATE = Object.freeze({ chain_id: "kai-agent-private-v1", registry_address: "unregistered" });
const MAX_BYTES = 1024 * 1024, MAX_U64 = (1n << 64n) - 1n;
class AgentError extends Error { constructor(code, message, retryable = false) { super(message); this.code = code; this.retryable = retryable; } }
const fail = (code, message) => { throw new AgentError(code, message); };
function canonical(value, depth = 0) {
  if (depth > 40) fail("INVALID_SCHEMA", "Object nesting exceeds 40 levels.");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return "[" + value.map(x => canonical(x, depth + 1)).join(",") + "]";
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return "{" + Object.keys(value).sort().map(k => {
      if (["__proto__", "prototype", "constructor"].includes(k)) fail("INVALID_SCHEMA", "Reserved object field.");
      return JSON.stringify(k) + ":" + canonical(value[k], depth + 1);
    }).join(",") + "}";
  }
  fail("INVALID_SCHEMA", "Only JSON values and safe integer numbers are supported.");
}
function parse(raw, max = MAX_BYTES) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > max) fail("SIZE_LIMIT", "Protocol message is too large.");
  let value; try { value = JSON.parse(raw); } catch { fail("INVALID_SCHEMA", "Invalid JSON."); }
  if (canonical(value) !== raw) fail("NONCANONICAL", "Use canonical JSON; duplicate keys and noncanonical encodings are rejected.");
  return value;
}
const hash = x => crypto.createHash("sha256").update(typeof x === "string" ? x : canonical(x)).digest("hex");
const random = () => crypto.randomBytes(16).toString("hex");
function fields(obj, required, optional = []) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || required.some(k => !Object.hasOwn(obj, k)) || Object.keys(obj).some(k => !required.includes(k) && !optional.includes(k))) fail("INVALID_SCHEMA", "Missing or unknown protocol field.");
}
function text(v, max = 200, label = "Text") { if (typeof v !== "string" || !v.trim() || v.length > max) fail("INVALID_SCHEMA", `${label} is required (maximum ${max} characters).`); return v; }
function uint(v, max = MAX_U64) { if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(v) || BigInt(v) > max) fail("INVALID_AMOUNT", "Use an unsigned base-unit integer string."); return BigInt(v); }
function digest(v) { if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) fail("INVALID_SCHEMA", "Invalid SHA-256 commitment."); return v; }
function identity() {
  const signer = new Signer({ privateKey: crypto.randomBytes(32).toString("hex") });
  const keys = crypto.generateKeyPairSync("x25519");
  return { wif: signer.getPrivateKey("wif"), address: signer.getAddress(), encryption_private: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), encryption_public: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
}
function signingBytes(purpose, payload, domain) { fields(domain, ["chain_id", "registry_address"]); return Buffer.from(hash({ protocol: VERSION, purpose, domain, payload }), "hex"); }
async function sign(purpose, payload, key, domain = PRIVATE) {
  const signer = Signer.fromWif(key.wif);
  return { protocol: VERSION, purpose, domain: { ...domain }, payload, signer: signer.getAddress(), signature: Buffer.from(await signer.signHash(signingBytes(purpose, payload, domain))).toString("base64") };
}
function verify(signed, purpose, domain = PRIVATE, expected) {
  fields(signed, ["protocol", "purpose", "domain", "payload", "signer", "signature"]);
  if (signed.protocol !== VERSION || signed.purpose !== purpose || canonical(signed.domain) !== canonical(domain) || expected && signed.signer !== expected) fail("INVALID_SIGNATURE", "Wrong signing domain or identity.");
  try {
    const sig = Buffer.from(signed.signature, "base64");
    if (sig.length !== 65 || sig.toString("base64") !== signed.signature || Signer.recoverAddress(signingBytes(purpose, signed.payload, domain), sig) !== signed.signer) throw new Error();
  } catch { fail("INVALID_SIGNATURE", "Signature does not match this content."); }
  return signed.payload;
}
function agentId(owner, nonce, domain = PRIVATE) { return hash({ ...domain, owner, nonce }); }
function validateSchema(schema, value, path = "input", depth = 0) {
  if (depth > 12) fail("INVALID_SCHEMA", "Schema nesting is too deep.");
  fields(schema, ["type"], ["properties", "required", "items", "maxLength", "maxItems", "additionalProperties"]);
  const types = ["string", "object", "array", "integer", "boolean"];
  if (!types.includes(schema.type)) fail("INVALID_SCHEMA", "Unsupported schema type.");
  if (schema.maxLength !== undefined && (!Number.isSafeInteger(schema.maxLength) || schema.maxLength < 1 || schema.maxLength > 64000)) fail("INVALID_SCHEMA", "Invalid schema text limit.");
  if (schema.maxItems !== undefined && (!Number.isSafeInteger(schema.maxItems) || schema.maxItems < 1 || schema.maxItems > 100)) fail("INVALID_SCHEMA", "Invalid schema array limit.");
  if (schema.properties && (typeof schema.properties !== "object" || Array.isArray(schema.properties) || Object.keys(schema.properties).length > 40)) fail("INVALID_SCHEMA", "Invalid schema properties.");
  if (schema.required && (!Array.isArray(schema.required) || schema.required.length > 40 || schema.required.some(k => typeof k !== "string" || !schema.properties?.[k]))) fail("INVALID_SCHEMA", "Invalid required schema fields.");
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") fail("INVALID_SCHEMA", "Invalid additional-properties policy.");
  if (value === undefined) { if (schema.properties) for (const s of Object.values(schema.properties)) validateSchema(s, undefined, path, depth + 1); if (schema.items) validateSchema(schema.items, undefined, path, depth + 1); return; }
  const valid = schema.type === "array" ? Array.isArray(value) : schema.type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : schema.type === "integer" ? Number.isSafeInteger(value) : typeof value === schema.type;
  if (!valid) fail("INVALID_INPUT", `${path} must be ${schema.type}.`);
  if (typeof value === "string" && value.length > (schema.maxLength ?? 32000)) fail("SIZE_LIMIT", `${path} is too long.`);
  if (Array.isArray(value)) { if (value.length > (schema.maxItems ?? 100)) fail("SIZE_LIMIT", `${path} has too many items.`); if (schema.items) value.forEach((v, i) => validateSchema(schema.items, v, `${path}[${i}]`, depth + 1)); }
  if (schema.type === "object") {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail("INVALID_INPUT", `${path}.${key} is required.`);
    for (const [k, v] of Object.entries(value)) { if (!schema.properties?.[k]) { if (schema.additionalProperties !== true) fail("INVALID_INPUT", `Unknown field ${path}.${k}.`); } else validateSchema(schema.properties[k], v, `${path}.${k}`, depth + 1); }
  }
}
function validateCard(signed, domain = PRIVATE, now = Date.now()) {
  const c = verify(signed, "manifest", domain);
  fields(c, ["agent_id", "owner", "nonce", "sequence", "control_version", "name", "description", "capabilities", "definition_hash", "input_schema", "output_schema", "encryption_public", "endpoints", "amount_atoms", "limits", "expires_at", "license"]);
  if (c.owner !== signed.signer || c.agent_id !== agentId(c.owner, c.nonce, domain)) fail("INVALID_SIGNATURE", "Agent identity does not match its owner.");
  uint(c.sequence); uint(c.control_version); uint(c.amount_atoms); uint(c.expires_at);
  if (!/^[a-f0-9]{32}$/.test(c.nonce) || c.sequence === "0" || c.control_version === "0") fail("INVALID_SCHEMA", "Invalid identity nonce or version.");
  if (BigInt(c.expires_at) <= BigInt(now)) fail("STALE_AGENT_VERSION", "This agent card has expired. Refresh its publication.");
  if (BigInt(c.expires_at) > BigInt(now + 7 * 86400000)) fail("INVALID_SCHEMA", "Service cards expire within seven days.");
  text(c.name, 80); text(c.description, 1000); text(c.license, 100); digest(c.definition_hash);
  if (!Array.isArray(c.capabilities) || c.capabilities.length > 12) fail("INVALID_SCHEMA", "At most 12 capabilities."); c.capabilities.forEach(v => text(v, 60));
  if (!Array.isArray(c.endpoints) || c.endpoints.length > 3) fail("INVALID_SCHEMA", "At most three endpoints."); c.endpoints.forEach(v => text(v, 500));
  validateSchema(c.input_schema); validateSchema(c.output_schema);
  const limits = { input_bytes: 32000, output_bytes: 64000, steps: 40, model_calls: 12, seconds: 600 };
  fields(c.limits, Object.keys(limits));
  for (const [k, max] of Object.entries(limits)) if (!Number.isSafeInteger(c.limits[k]) || c.limits[k] < 1 || c.limits[k] > max) fail("INVALID_SCHEMA", `Invalid ${k} limit.`);
  try { if (crypto.createPublicKey(c.encryption_public).asymmetricKeyType !== "x25519") throw new Error(); } catch { fail("INVALID_SCHEMA", "Invalid encryption key."); }
  return c;
}
function seal(body, recipientKey, header) {
  const pair = crypto.generateKeyPairSync("x25519"), salt = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const ephemeral = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const key = crypto.hkdfSync("sha256", crypto.diffieHellman({ privateKey: pair.privateKey, publicKey: crypto.createPublicKey(recipientKey) }), salt, Buffer.from("kai.agent/1 message"), 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(canonical(header)));
  const data = Buffer.concat([cipher.update(canonical(body)), cipher.final()]);
  return { header, ephemeral, salt: salt.toString("base64"), iv: iv.toString("base64"), ciphertext: data.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
function open(box, privateKey) {
  fields(box, ["header", "ephemeral", "salt", "iv", "ciphertext", "tag"]);
  try {
    const key = crypto.hkdfSync("sha256", crypto.diffieHellman({ privateKey: crypto.createPrivateKey(privateKey), publicKey: crypto.createPublicKey(box.ephemeral) }), Buffer.from(box.salt, "base64"), Buffer.from("kai.agent/1 message"), 32);
    const cipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64")); cipher.setAAD(Buffer.from(canonical(box.header))); cipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return parse(Buffer.concat([cipher.update(Buffer.from(box.ciphertext, "base64")), cipher.final()]).toString());
  } catch { fail("INVALID_CIPHERTEXT", "Encrypted message could not be authenticated."); }
}
module.exports = { VERSION, PRIVATE, MAX_BYTES, MAX_U64, AgentError, fail, canonical, parse, hash, random, fields, text, uint, digest, identity, sign, verify, agentId, validateSchema, validateCard, seal, open };
