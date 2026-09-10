"use strict";
const P = require("./protocol");
// A rebuildable event view. It never authorizes a payment or supplies a spendable balance.
class EventIndexer {
  constructor(file, domain) {
    const { DatabaseSync } = require("node:sqlite"); this.db = new DatabaseSync(file); this.domain = domain;
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS blocks(height INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,parent TEXT NOT NULL,final INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,block TEXT NOT NULL,height INTEGER NOT NULL,tx TEXT NOT NULL,position INTEGER NOT NULL,name TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS event_height ON events(height);");
    const stored = this.db.prepare("SELECT value FROM metadata WHERE key='domain'").get();
    if (stored && stored.value !== P.canonical(domain)) P.fail("WRONG_CHAIN", "Indexer belongs to another deployment.");
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES('domain',?)").run(P.canonical(domain));
  }
  cursor() { return this.db.prepare("SELECT * FROM blocks ORDER BY height DESC LIMIT 1").get() || null; }
  ingest(block, events, irreversible) {
    if (!Number.isSafeInteger(block.height) || block.height < 1 || !Number.isSafeInteger(irreversible) || irreversible < 0 || !Array.isArray(events) || events.length > 1000) P.fail("INVALID_BLOCK", "Invalid index block.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM blocks WHERE height=?").get(block.height);
      if (existing && existing.id !== block.id) {
        if (this.db.prepare("SELECT 1 FROM blocks WHERE height>=? AND final=1 LIMIT 1").get(block.height)) P.fail("FINALITY_CONFLICT", "Cannot roll back irreversible history.");
        this.db.prepare("DELETE FROM events WHERE height>=?").run(block.height); this.db.prepare("DELETE FROM blocks WHERE height>=?").run(block.height);
      }
      const tip = this.cursor(); if (tip && tip.id !== block.id && (block.height !== tip.height + 1 || block.parent !== tip.id)) P.fail("CHAIN_GAP", "Fetch the missing common ancestor before indexing.");
      this.db.prepare("INSERT OR IGNORE INTO blocks VALUES(?,?,?,0)").run(block.height, block.id, block.parent);
      for (const [i, event] of events.entries()) { const id = P.hash({ ...this.domain, block: block.id, tx: event.tx, index: i }); const data = P.canonical(event.data); const old = this.db.prepare("SELECT data FROM events WHERE id=?").get(id); if (old && old.data !== data) P.fail("EVENT_CONFLICT", "Conflicting event replay."); this.db.prepare("INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?,?)").run(id, block.id, block.height, event.tx, i, event.name, data); }
      this.db.prepare("UPDATE blocks SET final=1 WHERE height<=?").run(irreversible); this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  ledger({ cursor = 0, limit = 50 } = {}) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) P.fail("INVALID_SCHEMA", "Invalid ledger cursor."); limit = Math.min(100, Math.max(1, Number(limit) || 50));
    return this.db.prepare("SELECT e.*,b.final FROM events e JOIN blocks b ON e.block=b.id ORDER BY e.height,e.position LIMIT ? OFFSET ?").all(limit, cursor).map(e => ({ ...e, data: JSON.parse(e.data), confidence: e.final ? "irreversible" : "included" }));
  }
  async sync(client, maxBlocks = 100) {
    await client.verifyDeployment(); const head = await client.provider.getHeadInfo(), irreversible = Number(head.last_irreversible_block), top = Number(head.head_topology.height);
    // Start from the verified deployment block. Tentative forks are reconciled before advancing.
    let tip = this.cursor();
    if (tip) { const canonical = (await client.provider.getBlocks(tip.height, 1, head.head_topology.id, { returnBlock: true, returnReceipt: true }))[0]; if (!canonical) P.fail("BLOCK_UNAVAILABLE", "Cannot verify the indexed tip."); if (canonical.block_id !== tip.id) { if (tip.final) P.fail("FINALITY_CONFLICT", "RPC conflicts with indexed irreversible history."); const last = this.db.prepare("SELECT height FROM blocks WHERE final=1 ORDER BY height DESC LIMIT 1").get(); if (last) { const anchor = (await client.provider.getBlocks(last.height, 1, head.head_topology.id, { returnBlock: true, returnReceipt: true }))[0]; const saved = this.db.prepare("SELECT id FROM blocks WHERE height=?").get(last.height); if (!anchor || anchor.block_id !== saved.id) P.fail("FINALITY_CONFLICT", "RPC conflicts with the irreversible anchor."); } const from = last ? last.height + 1 : Number(client.deployment.irreversible_start); this.db.exec("BEGIN IMMEDIATE"); try { this.db.prepare("DELETE FROM events WHERE height>=?").run(from); this.db.prepare("DELETE FROM blocks WHERE height>=?").run(from); this.db.exec("COMMIT"); } catch (e) { this.db.exec("ROLLBACK"); throw e; } tip = this.cursor(); } }
    for (let h = tip ? tip.height + 1 : Number(client.deployment.irreversible_start), n = 0; h <= top && n < maxBlocks; h++, n++) {
      const b = (await client.provider.getBlocks(h, 1, head.head_topology.id, { returnBlock: true, returnReceipt: true }))[0]; if (!b?.block || !b.receipt) P.fail("BLOCK_UNAVAILABLE", "Block and execution receipt are required."); const events = [];
      for (const tx of b.receipt.transaction_receipts || []) if (!tx.reverted) for (const event of tx.events || []) if (event.source === client.deployment.contract && event.name.startsWith("kai.agent.v1.")) events.push({ tx: tx.id, name: event.name, data: await client.serializer.deserialize(event.data, "network.Result") });
      this.ingest({ height: h, id: b.block_id, parent: b.block.header.previous }, events, irreversible);
    }
    return this.cursor();
  }
  close() { this.db.close(); }
}
module.exports = { EventIndexer };
