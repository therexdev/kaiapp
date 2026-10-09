"use strict";

// Host-side policy prototype, NOT a loader or an isolation boundary. Keep the
// authority object and adapter private to a trusted host, never inside a plugin.
const { createHash, randomUUID } = require("node:crypto");
const SCOPES = Object.freeze({
  "local-inference": "infer", "background-work": "run", "network-spend": "spend",
  wallet: "sign", "connected-account": "use", "personal-data": "read", plugin: "invoke",
});
const { fail, record, list, integer, name } = require("./validation");
function scope(s) {
  s = record(s, ["resource", "action", "kind"]);
  name(s.resource);
  if (typeof s.kind !== "string" || !Object.hasOwn(SCOPES, s.kind) || SCOPES[s.kind] !== s.action) fail();
  return Object.freeze({ kind: s.kind, resource: s.resource, action: s.action });
}
function validateManifest(m) {
  m = record(m, ["schemaVersion", "id", "version", "permissions"]);
  if (m.schemaVersion !== 1) fail();
  name(m.id);
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+$/.test(m.version) || m.version.length > 40) fail();
  const permissions = list(m.permissions, 32).map(scope).sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (new Set(permissions.map(s => JSON.stringify(s))).size !== permissions.length) fail();
  return Object.freeze({ schemaVersion: 1, id: m.id, version: m.version, permissions: Object.freeze(permissions) });
}
function digest(m) { return createHash("sha256").update(JSON.stringify(m)).digest("hex"); }
function same(a, b) { return a.kind === b.kind && a.resource === b.resource && a.action === b.action; }

function createPermissionHost({ localInference, now = Date.now } = {}) {
  if (typeof localInference !== "function" || typeof now !== "function") fail();
  const installed = new Map(), grants = new Map();
  function revoke(id) {
    const g = grants.get(id);
    if (!g) return false;
    grants.delete(id);
    clearTimeout(g.timer);
    for (const c of g.pending) c.abort();
    return true;
  }
  function invalidate(caller) {
    for (const [id, g] of grants) if (g.caller === caller) revoke(id);
  }
  function install(input) {
    const manifest = validateManifest(input), hash = digest(manifest);
    const previous = installed.get(manifest.id);
    if (previous?.digest !== hash) {
      invalidate(manifest.id);
      installed.set(manifest.id, { manifest, digest: hash, generation: randomUUID() });
    }
    return hash; // Installation grants nothing; same manifest is idempotent.
  }
  function uninstall(caller) { invalidate(caller); return installed.delete(caller); }
  // Only the trusted owner-consent surface may call approve. A boolean sent by
  // plugin code is never owner consent. No delegate or wildcard grant exists.
  function approve(input) {
    input = record(input, ["caller", "manifestDigest", "scope", "expiresAt", "limits"]);
    const current = installed.get(input.caller), requested = scope(input.scope);
    if (!current || current.digest !== input.manifestDigest ||
        !current.manifest.permissions.some(p => same(p, requested))) fail();
    // Other categories are declarative only in v1; no money/signing/data adapters.
    if (requested.kind !== "local-inference") fail();
    const issuedAt = now();
    integer(issuedAt, 0, Number.MAX_SAFE_INTEGER);
    integer(input.expiresAt, issuedAt + 1, issuedAt + 24 * 60 * 60 * 1000);
    const limits = record(input.limits, ["calls", "inputChars", "outputTokens"]);
    integer(limits.calls, 1, 1000);
    integer(limits.inputChars, 1, 100000);
    integer(limits.outputTokens, 1, 32768);
    const id = randomUUID();
    const timer = setTimeout(() => revoke(id), input.expiresAt - issuedAt);
    timer.unref?.();
    grants.set(id, { timer, caller: input.caller, digest: current.digest, scope: requested,
      expiresAt: input.expiresAt, limits, used: 0, pending: new Set() });
    return id;
  }
  function connect(caller) {
    const installation = installed.get(caller);
    if (!installation) fail();
    // Bind identity in the host transport, not to a caller field in an RPC body.
    return Object.freeze({
      async infer(input) {
        input = record(input, ["grantId", "resource", "prompt", "maxOutputTokens"]);
        const g = grants.get(input.grantId), current = installed.get(caller);
        if (g && g.expiresAt <= now()) revoke(input.grantId);
        if (!g || !grants.has(input.grantId) || current !== installation || g.caller !== caller || g.digest !== current.digest ||
            g.scope.resource !== input.resource || g.used >= g.limits.calls) fail();
        if (typeof input.prompt !== "string" || input.prompt.length > g.limits.inputChars) fail();
        integer(input.maxOutputTokens, 1, g.limits.outputTokens);
        g.used++; // Reserve synchronously before any await; failures still consume budget.
        const controller = new AbortController();
        g.pending.add(controller);
        let abort;
        const cancelled = new Promise((_, reject) => {
          abort = () => reject(new Error("Plugin permission denied"));
          controller.signal.addEventListener("abort", abort, { once: true });
        });
        try {
          let operation;
          try {
            operation = Promise.resolve(localInference(Object.freeze({ resource: g.scope.resource, prompt: input.prompt,
              maxOutputTokens: input.maxOutputTokens, signal: controller.signal })));
          } catch { operation = Promise.reject(new Error("Plugin permission denied")); }
          const result = await Promise.race([cancelled, operation]);
          if (g.expiresAt <= now()) revoke(input.grantId);
          if (controller.signal.aborted || grants.get(input.grantId) !== g) fail();
          // Adapter returns text only; never pass runtime/registry/wallet objects.
          if (typeof result !== "string") fail();
          return result;
        } catch { fail(); } finally {
          controller.signal.removeEventListener("abort", abort);
          g.pending.delete(controller);
        }
      },
    });
  }
  return Object.freeze({ install, uninstall, approve, revoke, connect });
}
module.exports = { validateManifest, createPermissionHost };
