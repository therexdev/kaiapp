"use strict";
const https = require("https"), http = require("http"), dns = require("dns").promises;
const { assertPublicTarget } = require("../websearch"), P = require("./protocol");
class Transport {
  constructor({ allowLoopback = false, privacyMode = () => "local-first" } = {}) { this.allowLoopback = allowLoopback; this.privacyMode = privacyMode; }
  async request(endpoint, route, signed) {
    if (this.privacyMode() === "local-only") P.fail("PERMISSION_REQUIRED", "Local-Only is enabled. Network services cannot connect.");
    const base = new URL(endpoint);
    const local = this.allowLoopback && base.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(base.hostname);
    if (base.username || base.password || base.search || base.hash || base.pathname !== "/" || !local && base.protocol !== "https:") P.fail("INVALID_ENDPOINT", "Use an HTTPS origin without credentials or a path.");
    if (!local) await assertPublicTarget(base.href);
    const answers = local ? null : await dns.lookup(base.hostname, { all: true, verbatim: true });
    // Validate exactly the addresses passed to the socket; redirects are never followed.
    if (!local) await assertPublicTarget(base.href, { lookup: async () => answers });
    const raw = signed ? P.canonical(signed) : null;
    if (raw && Buffer.byteLength(raw) > P.MAX_BYTES) P.fail("SIZE_LIMIT", "Request is too large.");
    return new Promise((resolve, reject) => {
      const req = (local ? http : https).request(new URL(route, base), { method: signed ? "POST" : "GET", headers: { accept: "application/json", ...(raw ? { "content-type": "application/json", "content-length": Buffer.byteLength(raw) } : {}) }, timeout: 15000,
        ...(answers ? { lookup: (_host, opts, callback) => opts.all ? callback(null, answers) : callback(null, answers[0].address, answers[0].family) } : {}) }, res => {
        const chunks = []; let size = 0;
        res.on("data", chunk => { size += chunk.length; if (size > P.MAX_BYTES) req.destroy(new P.AgentError("SIZE_LIMIT", "Response is too large.")); else chunks.push(chunk); });
        res.on("end", () => { try { const data = P.parse(Buffer.concat(chunks).toString()); if (res.statusCode !== 200) throw new P.AgentError(data.code || "SERVICE_ERROR", data.message || "Service request failed."); resolve(data); } catch (e) { reject(e); } });
        res.on("error", reject);
      }); req.on("timeout", () => req.destroy(new P.AgentError("TIMEOUT", "Service timed out.", true))); req.on("error", reject); req.end(raw);
    });
  }
  async auth(endpoint, route, body, identity, domain = P.PRIVATE) {
    const request = await P.sign("http", { method: "POST", path: route, nonce: P.random(), expires_at: String(Date.now() + 60000), body }, identity, domain);
    return this.request(endpoint, route, request);
  }
}
module.exports = { Transport };
