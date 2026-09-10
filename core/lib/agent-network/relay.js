"use strict";
const http = require("http"), P = require("./protocol");
class Relay {
  constructor({ store, domain = P.PRIVATE, name = "Independent KAI relay" }) { this.store = store; this.domain = domain; this.name = name; }
  publicConfig() { return { protocol: P.VERSION, domain: this.domain, name: this.name, paid: false, ranking: "name-v1", limits: { body_bytes: P.MAX_BYTES, cards: 500, mailbox: 200 } }; }
  authenticate(raw, route) {
    const signed = P.parse(raw), request = P.verify(signed, "http", this.domain);
    P.fields(request, ["method", "path", "nonce", "expires_at", "body"]); P.uint(request.expires_at); P.text(request.nonce, 64);
    if (request.method !== "POST" || request.path !== route || Number(request.expires_at) < Date.now() || Number(request.expires_at) > Date.now() + 120000) P.fail("INVALID_SIGNATURE", "Request is expired or bound to another endpoint.");
    this.store.change(d => { d.requests = (d.requests || []).filter(x => x.expires > Date.now()); if (d.requests.some(x => x.nonce === request.nonce && x.signer === signed.signer)) P.fail("REPLAY", "This request was already processed."); if (d.requests.length >= 10000 || d.requests.filter(x => x.signer === signed.signer).length >= 300) P.fail("RATE_LIMIT", "Relay request quota reached."); d.requests.push({ signer: signed.signer, nonce: request.nonce, expires: Number(request.expires_at) }); });
    return { signer: signed.signer, body: request.body };
  }
  async dispatch(method, route, raw) {
    const url = new URL(route, "http://relay.invalid"), pathname = url.pathname;
    if (method === "GET" && pathname === "/agent-network/v1/config") return this.publicConfig();
    if (method === "GET" && pathname === "/agent-network/v1/agents") {
      const query = (url.searchParams.get("q") || "").toLowerCase().slice(0, 100), cursor = Number(url.searchParams.get("cursor") || 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) P.fail("INVALID_SCHEMA", "Invalid cursor.");
      const cards = this.store.data.cards.filter(s => Number(s.payload.expires_at) > Date.now() && (s.payload.name + " " + s.payload.description + " " + s.payload.capabilities.join(" ")).toLowerCase().includes(query)).sort((a, b) => a.payload.name.localeCompare(b.payload.name) || a.payload.agent_id.localeCompare(b.payload.agent_id));
      return { source: this.name, ranking: "name-v1", registry_verified: false, items: cards.slice(cursor, cursor + 40), next: cards.length > cursor + 40 ? cursor + 40 : null };
    }
    if (method !== "POST") P.fail("NOT_FOUND", "Endpoint not found.");
    const { signer, body } = this.authenticate(raw, pathname);
    if (pathname === "/agent-network/v1/publish") {
      const card = P.validateCard(body.card, this.domain); if (card.owner !== signer) P.fail("FORBIDDEN", "Only the owner can publish a card.");
      this.store.change(d => {
        d.cards = d.cards.filter(x => Number(x.payload.expires_at) > Date.now());
        const old = d.cards.find(x => x.payload.agent_id === card.agent_id);
        if (old && (BigInt(old.payload.sequence) > BigInt(card.sequence) || old.payload.sequence === card.sequence && P.hash(old) !== P.hash(body.card))) P.fail("STALE_AGENT_VERSION", "Publication sequence must increase.");
        if (!old && (d.cards.length >= 500 || d.cards.filter(x => x.signer === signer).length >= 20)) P.fail("RATE_LIMIT", "Directory publication quota reached.");
        d.cards = d.cards.filter(x => x.payload.agent_id !== card.agent_id); d.cards.push(body.card);
      }); return { accepted: true };
    }
    if (pathname === "/agent-network/v1/retire") { this.store.change(d => { d.cards = d.cards.filter(x => !(x.payload.agent_id === body.id && x.signer === signer)); }); return { accepted: true }; }
    if (pathname === "/agent-network/v1/messages") {
      const packet = P.verify(body.packet, "message", this.domain, signer), h = packet.header;
      P.fields(h, ["id", "from", "to", "sequence", "expires_at"]); P.text(h.id, 64); P.text(h.to, 100); P.uint(h.sequence); P.uint(h.expires_at);
      if (h.from !== signer || Number(h.expires_at) <= Date.now() || Number(h.expires_at) > Date.now() + 86400000) P.fail("MESSAGE_EXPIRED", "Invalid message lifetime.");
      this.store.change(d => { d.mail ||= []; d.mail = d.mail.filter(x => Number(x.payload.header.expires_at) > Date.now()); const old = d.mail.find(x => x.payload.header.id === h.id && x.signer === signer); if (old) { if (P.hash(old) !== P.hash(body.packet)) P.fail("REPLAY", "Message ID reused with different content."); return; } if (d.mail.length >= 3000 || d.mail.filter(x => x.payload.header.to === h.to).length >= 200 || d.mail.filter(x => x.signer === signer).length >= 200) P.fail("RATE_LIMIT", "Mailbox is full."); d.mail.push(body.packet); });
      return { accepted: true, delivered: false, id: h.id };
    }
    if (pathname === "/agent-network/v1/inbox") return { items: (this.store.data.mail || []).filter(x => x.payload.header.to === signer && Number(x.payload.header.expires_at) > Date.now()).slice(0, 30) };
    if (pathname === "/agent-network/v1/ack") { if (!Array.isArray(body.ids) || body.ids.length > 30) P.fail("INVALID_SCHEMA", "Invalid acknowledgments."); this.store.change(d => { d.mail = (d.mail || []).filter(x => !(x.payload.header.to === signer && body.ids.includes(x.payload.header.id))); }); return { accepted: true }; }
    P.fail("NOT_FOUND", "Endpoint not found.");
  }
  listen(port = 0, host = "127.0.0.1") {
    const server = http.createServer(async (req, res) => {
      const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(P.canonical(body)); };
      try { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > P.MAX_BYTES) { reply(413, { code: "SIZE_LIMIT", message: "Request is too large." }); req.destroy(); return; } chunks.push(chunk); } reply(200, await this.dispatch(req.method, req.url, Buffer.concat(chunks).toString())); }
      catch (e) { reply(e.code === "NOT_FOUND" ? 404 : 400, { code: e.code || "SERVICE_ERROR", message: e instanceof P.AgentError ? e.message : "Relay request failed." }); }
    }); server.requestTimeout = 20000; server.headersTimeout = 10000;
    return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { server.removeListener("error", reject); resolve(server); }); });
  }
}
module.exports = { Relay };
