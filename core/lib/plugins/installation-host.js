"use strict";
// Trusted owner control plane only. Nothing here is an IPC/message router.
const crypto = require("node:crypto");
const { createPermissionHost, validateManifest } = require("./permissions");
const { record, list, name, fail } = require("./validation");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function envelope(manifest, publisher, artifactSha256) {
  return Buffer.from(JSON.stringify({ domain: "kai.plugin-install/1", manifest, publisher, artifactSha256 }));
}
function createInstallationHost({ publishers, store, localInference }) {
  // Publisher keys come from trusted owner configuration, never package metadata.
  const keys = new Map();
  for (const [id, pem] of publishers) {
    name(id); const key = crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519" || keys.has(id)) fail();
    keys.set(id, key);
  }
  const policy = createPermissionHost({ localInference });
  const entries = new Map(), handles = new WeakMap(), tickets = new WeakMap();
  let closed = false;
  function verified(input) {
    const row = record(input, ["manifest", "publisher", "artifactSha256", "signature", "installationId"]);
    const manifest = validateManifest(row.manifest);
    name(row.publisher);
    if (typeof row.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.artifactSha256) ||
        typeof row.installationId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.installationId) ||
        typeof row.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(row.signature)) fail();
    const key = keys.get(row.publisher);
    if (!key || !crypto.verify(null, envelope(manifest, row.publisher, row.artifactSha256), key, Buffer.from(row.signature, "base64"))) fail();
    return Object.freeze({ manifest, publisher: row.publisher, artifactSha256: row.artifactSha256,
      signature: row.signature, installationId: row.installationId });
  }
  function activate(row) {
    const handle = Object.freeze({});
    const entry = { row, handle, digest: policy.install(row.manifest) };
    entries.set(row.manifest.id, entry); handles.set(handle, entry);
    return handle;
  }
  function current(handle) {
    const entry = handles.get(handle);
    if (closed || !entry || entries.get(entry.row.manifest.id) !== entry) fail();
    return entry;
  }
  function close() {
    closed = true;
    for (const id of entries.keys()) policy.uninstall(id);
  }
  function persist(rows) {
    // Synchronous atomic store contract. A failure disables this host, revoking
    // live authority. Store persists signed inventory only, never grants/tickets.
    try {
      const result = store.save({ schemaVersion: 1, installations: rows });
      if (result && typeof result.then === "function") { Promise.resolve(result).catch(() => {}); fail(); }
    } catch { close(); fail(); }
  }
  const saved = store.load();
  if (saved && typeof saved.then === "function") { Promise.resolve(saved).catch(() => {}); fail(); }
  if (saved !== null) {
    const state = record(saved, ["schemaVersion", "installations"]);
    if (state.schemaVersion !== 1) fail();
    const rows = list(state.installations, 100).map(verified);
    if (new Set(rows.map(r => r.manifest.id)).size !== rows.length ||
        new Set(rows.map(r => r.installationId)).size !== rows.length) fail();
    for (const row of rows) activate(row);
  }
  return Object.freeze({
    install(input) {
      if (closed) fail();
      input = record(input, ["manifest", "publisher", "artifact", "signature"]);
      if (!Buffer.isBuffer(input.artifact) || input.artifact.length > 16 * 1024 * 1024) fail();
      const row = verified({ manifest: input.manifest, publisher: input.publisher, signature: input.signature,
        artifactSha256: hash(input.artifact), installationId: crypto.randomUUID() });
      const rows = [...entries.values()].filter(e => e.row.manifest.id !== row.manifest.id).map(e => e.row);
      if (rows.length >= 100) fail();
      // Every explicit install gets a fresh identity, even identical reinstall.
      persist([...rows, row]); policy.uninstall(row.manifest.id);
      return activate(row);
    },
    uninstall(handle) {
      const entry = current(handle), id = entry.row.manifest.id;
      policy.uninstall(id); // Revocation happens even if durable removal fails.
      persist([...entries.values()].filter(e => e !== entry).map(e => e.row));
      entries.delete(id);
    },
    lookup(id) { if (closed || !entries.has(id)) fail(); return entries.get(id).handle; },
    inspect(handle) { return current(handle).row; },
    connect(handle) {
      const entry = current(handle), client = policy.connect(entry.row.manifest.id);
      return Object.freeze({ async infer(input) { current(handle); return client.infer(input); } });
    },
    prepareConsent(handle, input) {
      const entry = current(handle);
      input = record(input, ["scope", "expiresAt", "limits"]);
      // A ticket snapshots all reviewed fields; no mutable plugin input survives.
      const scope = record(input.scope, ["kind", "resource", "action"]);
      const limits = record(input.limits, ["calls", "inputChars", "outputTokens"]);
      const review = Object.freeze({ installation: entry.row, scope, limits, expiresAt: input.expiresAt });
      tickets.set(review, { entry, input: { caller: entry.row.manifest.id, manifestDigest: entry.digest,
        scope, limits, expiresAt: input.expiresAt } });
      return review;
    },
    approveConsent(review) {
      const ticket = tickets.get(review);
      if (!ticket) fail();
      tickets.delete(review); // One use; consumed before any approval work.
      if (current(ticket.entry.handle) !== ticket.entry) fail();
      return policy.approve(ticket.input);
    },
    revoke(grantId) { if (closed) fail(); return policy.revoke(grantId); },
    close,
  });
}
module.exports = { createInstallationHost, envelope };
