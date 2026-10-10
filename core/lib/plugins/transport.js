"use strict";
// A host-created capability channel for trusted bundled code. Possession of its
// transferable port is authority; this is not hostile-code identity attestation.
const { MessageChannel } = require("node:worker_threads");
const { record, integer, fail } = require("./validation");
function createPluginTransport({ host, installation, review }) {
  const snapshot = record(review, ["installation", "scope", "limits", "expiresAt"]);
  if (host.inspect(installation) !== snapshot.installation) fail();
  const client = host.connect(installation);
  const grantId = host.approveConsent(review); // One-use trusted owner action only.
  const { port1: server, port2: port } = new MessageChannel();
  let closed = false, busy = false, lastId = 0;
  function close() {
    if (closed) return;
    closed = true;
    try { host.revoke(grantId); } catch { /* host already closed/revoked */ }
    server.close();
  }
  function deny(id = 0) {
    if (!closed) server.postMessage(JSON.stringify({ id, ok: false, error: "Plugin request denied" }));
    close();
  }
  server.on("close", close);
  server.on("messageerror", () => close());
  server.on("message", async raw => {
    if (closed) return;
    let id = 0;
    try {
      // JSON string only; structured-clone objects never select host operations.
      if (typeof raw !== "string" || Buffer.byteLength(raw) > 128 * 1024) fail();
      const input = record(JSON.parse(raw), ["id", "prompt", "maxOutputTokens"]);
      integer(input.id, 1, Number.MAX_SAFE_INTEGER);
      id = input.id;
      if (busy || id <= lastId) fail();
      lastId = id; busy = true;
      const text = await client.infer({ grantId, resource: snapshot.scope.resource,
        prompt: input.prompt, maxOutputTokens: input.maxOutputTokens });
      if (closed) return;
      const response = JSON.stringify({ id, ok: true, text });
      if (Buffer.byteLength(response) > 1024 * 1024) fail();
      server.postMessage(response);
    } catch { deny(id); }
    finally { busy = false; }
  });
  return Object.freeze({ port, close }); // Never expose host, handle or grant ID.
}
module.exports = { createPluginTransport };
