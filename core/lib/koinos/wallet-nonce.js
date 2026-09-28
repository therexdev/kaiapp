"use strict";
// Explicit isolated rehearsal only; construction never loads a wallet or key.
const fs = require("fs"), path = require("path"), { DatabaseSync } = require("node:sqlite");
const { isDeepStrictEqual } = require("node:util");
const { Transaction, Signer, utils } = require("koilib");
const { KoinChain } = require("../koin-network/chain");
const { hash, digest, integer } = require("../koin-network/job-protocol");
const { uint } = require("../koin-network/policy");
const terminal = state => ["finalized", "reverted"].includes(state);
const purposes = ["funding", "send", "burn", "register", "external", "sponsored", "vault"];
const ownerOf = tx => tx.header.payee || tx.header.payer;
const objectId = v => { if (typeof v !== "string" || !/^0x1220[a-f0-9]{64}$/.test(v)) throw Error("Invalid wallet transaction ID"); return v; };
const response = v => { if (!v || typeof v !== "object" || Array.isArray(v) || v.error || v.rpc_error) throw Error("Invalid wallet nonce RPC response"); return v; };
function nonce(value) {
  if (typeof value !== "string") throw Error("Canonical wallet nonce required");
  const b = Buffer.from(value, "base64url"); let n = 0n;
  if (b.length < 2 || b.length > 11 || b[0] !== 40) throw Error("Invalid wallet nonce");
  for (let i = 1; i < b.length; i++) n |= BigInt(b[i] & 127) << BigInt(7 * (i - 1));
  uint(n); if (!n) throw Error("Positive wallet nonce required");
  let rest = n; const canonical = [40];
  do { const byte = Number(rest & 127n); rest >>= 7n; canonical.push(byte | (rest ? 128 : 0)); } while (rest);
  if (utils.encodeBase64url(Uint8Array.from(canonical)) !== value) throw Error("Noncanonical wallet nonce");
  return n;
}
function unsigned(tx) { return { id: tx.id, header: structuredClone(tx.header), operations: structuredClone(tx.operations), signatures: [] }; }

class WalletNonceCoordinator {
  #db; #client; #clock; #identity;
  constructor(directory, { mode, client, clock = Date.now }) {
    if (mode !== "isolated-rehearsal" || !(client instanceof KoinChain) || client.d.network !== "isolated") throw Error("Explicit isolated wallet nonce client required");
    this.#client = client; this.#clock = clock;
    this.#identity = JSON.stringify({ schema: 1, mode, chainId: client.d.chainId, rpc: client.d.rpc });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "wallet-nonces.sqlite"); this.#db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
    try {
      this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, clock INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL, tx_id TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS active_wallet ON reservations(owner) WHERE state IN ('signing','signed');`);
      this.#db.exec("BEGIN IMMEDIATE");
      const saved = this.#db.prepare("SELECT data FROM identity WHERE id=1").get();
      if (saved && saved.data !== this.#identity) throw Error("Wallet nonce chain identity changed");
      if (!saved) {
        if (this.#db.prepare("SELECT 1 FROM reservations LIMIT 1").get()) throw Error("Missing wallet nonce identity");
        this.#db.prepare("INSERT INTO identity VALUES(1,?,?)").run(this.#identity, integer(clock()));
      }
      this.#db.exec("COMMIT");
      if (this.#db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw Error("Corrupt wallet nonce journal");
    } catch (e) { this.#db.close(); throw e; }
  }
  assertClient(client) { if (client !== this.#client) throw Error("Wallet nonce client mismatch"); }
  assertProvider(provider) { if (provider !== this.#client.provider) throw Error("Wallet nonce provider mismatch"); }
  #now() {
    const r = this.#db.prepare("SELECT * FROM identity WHERE id=1").get(), now = integer(this.#clock());
    if (r?.data !== this.#identity || now < r.clock) throw Error("Wallet nonce identity or clock changed");
    return now;
  }
  #tx(fn) {
    this.#db.exec("BEGIN IMMEDIATE");
    try { this.#db.prepare("UPDATE identity SET clock=? WHERE id=1").run(this.#now()); const r = fn(); this.#db.exec("COMMIT"); return r; }
    catch (e) { this.#db.exec("ROLLBACK"); throw e; }
  }
  #save(r) {
    r.updatedAt = this.#now(); const data = JSON.stringify(r);
    this.#db.prepare("INSERT INTO reservations VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,hash=excluded.hash,data=excluded.data")
      .run(r.id, r.owner, r.state, r.draft.id, hash(data), data);
  }
  #row(id) {
    digest(id); this.#now(); const saved = this.#db.prepare("SELECT * FROM reservations WHERE id=?").get(id);
    if (!saved || saved.hash !== hash(saved.data)) throw Error("Missing or damaged wallet nonce reservation");
    const r = JSON.parse(saved.data);
    if (r.id !== id || r.owner !== saved.owner || r.state !== saved.state || r.draft.id !== saved.tx_id ||
        r.owner !== ownerOf(r.draft) || r.draft.header.chain_id !== this.#client.d.chainId ||
        !purposes.includes(r.purpose) || (r.remote !== undefined && r.remote !== true) || (r.remote && r.purpose !== "vault") ||
        !["signing", "signed", "finalized", "reverted"].includes(r.state) || r.draftHash !== hash(JSON.stringify(r.draft)) ||
        (r.transaction && (r.transactionHash !== hash(JSON.stringify(r.transaction)) || !this.#matches(r, r.transaction))) ||
        (!r.transaction && r.state !== "signing")) throw Error("Damaged wallet nonce binding");
    nonce(r.draft.header.nonce); objectId(r.draft.id); integer(r.createdAt); integer(r.updatedAt, r.createdAt);
    return r;
  }
  status(id) { const r = this.#row(id); return { id, owner: r.owner, payer: r.draft.header.payer, purpose: r.purpose, state: r.state, txId: r.transaction?.id || (r.remote ? null : r.draft.id), nonce: r.draft.header.nonce, finality: structuredClone(r.finality) }; }
  pending(owner, purpose) {
    if (!utils.isChecksumAddress(owner) || !purposes.includes(purpose)) throw Error("Invalid pending wallet request");
    return this.#db.prepare("SELECT id FROM reservations WHERE owner=? AND state IN ('signing','signed')").all(owner)
      .map(r => this.status(r.id)).filter(r => r.purpose === purpose);
  }
  remoteRequest(id) {
    const r = this.#row(id); if (!r.remote) throw Error("Remote wallet reservation required");
    return { ...this.status(id), operations: structuredClone(r.draft.operations), maxRc: r.draft.header.rc_limit };
  }
  #matches(r, tx) {
    const draft = unsigned(tx);
    if (r.remote) {
      if (!uint(tx.header.rc_limit) || uint(tx.header.rc_limit) > uint(r.draft.header.rc_limit)) return false;
      draft.header.rc_limit = r.draft.header.rc_limit; draft.id = r.draft.id;
      return isDeepStrictEqual(draft, r.draft);
    }
    return hash(JSON.stringify(draft)) === r.draftHash;
  }
  envelope(id) { return structuredClone(this.#row(id).transaction); }
  assertReservation(id, tx) {
    const r = this.#row(id);
    if (!this.#matches(r, tx)) throw Error("Wallet reservation requires the original transaction");
    return this.status(id);
  }
  async #verify(tx) {
    if (!tx || Object.keys(tx).some(k => !["id", "header", "operations", "signatures"].includes(k)) ||
        !tx.header || !["chain_id,nonce,operation_merkle_root,payer,rc_limit", "chain_id,nonce,operation_merkle_root,payee,payer,rc_limit"].includes(Object.keys(tx.header).sort().join()) ||
        tx.header.chain_id !== this.#client.d.chainId || !utils.isChecksumAddress(tx.header.payer) ||
        (tx.header.payee !== undefined && (!utils.isChecksumAddress(tx.header.payee) || tx.header.payee === tx.header.payer)) ||
        typeof tx.header.rc_limit !== "string" || !uint(tx.header.rc_limit) ||
        !Array.isArray(tx.operations) || !tx.operations.length || tx.operations.length > 16 ||
        tx.operations.some(o => !o || Object.keys(o).join() !== "call_contract" || !o.call_contract ||
          Object.keys(o.call_contract).sort().join() !== "args,contract_id,entry_point" || !utils.isChecksumAddress(o.call_contract.contract_id) ||
          !Number.isInteger(o.call_contract.entry_point) || o.call_contract.entry_point < 0 || o.call_contract.entry_point > 4294967295 ||
          typeof o.call_contract.args !== "string" || o.call_contract.args.length > 65536) ||
        (tx.signatures !== undefined && !Array.isArray(tx.signatures))) throw Error("Exact wallet transaction required");
    nonce(tx.header.nonce); objectId(tx.id);
    if ((await Transaction.prepareTransaction(structuredClone(tx))).id !== tx.id) throw Error("Wallet transaction commitment changed");
  }
  async reserve(id, purpose, transaction, active = () => true) {
    if (purpose === "vault") throw Error("Use the remote wallet reservation boundary");
    return this.#reserve(id, purpose, transaction, active, false);
  }
  async reserveRemote(id, { owner, payer, operations, maxRc }, active = () => true) {
    const p = this.#client.provider;
    const tx = new Transaction({ provider: p, options: { payer, payee: owner, rcLimit: maxRc } });
    for (const op of structuredClone(operations)) await tx.pushOperation(op);
    await tx.prepare({ chainId: this.#client.d.chainId, nonce: await p.getNextNonce(owner) });
    return this.#reserve(id, "vault", tx.transaction, active, true);
  }
  async #reserve(id, purpose, transaction, active, remote) {
    digest(id); if (!purposes.includes(purpose)) throw Error("Unknown wallet purpose");
    const tx = structuredClone(transaction); await this.#verify(tx);
    if (purpose === "funding" && tx.header.payee !== undefined) throw Error("Funding requires owner-paid transactions");
    if (tx.signatures?.length) throw Error("Reserve the wallet nonce before exposing a signing request");
    const draft = unsigned(tx), owner = ownerOf(tx);
    if (await this.#client.provider.getChainId() !== this.#client.d.chainId || await this.#client.provider.getNextNonce(owner) !== tx.header.nonce) throw Error("Wallet chain or nonce changed");
    return this.#tx(() => {
      if (!active()) throw Error("Wallet signing request stopped");
      if (this.#db.prepare("SELECT 1 FROM reservations WHERE id=?").get(id)) {
        const r = this.#row(id); this.assertReservation(id, draft);
        if (r.purpose !== purpose || !!r.remote !== remote || r.draftHash !== hash(JSON.stringify(draft))) throw Error("Cannot replace wallet transaction purpose or policy");
        return { action: "recover_existing", ...this.status(id) };
      }
      if (this.#db.prepare("SELECT 1 FROM reservations WHERE owner=? AND state IN ('signing','signed')").get(owner)) throw Error("Another transaction owns this wallet nonce; recover it first");
      for (const prior of this.#db.prepare("SELECT id FROM reservations WHERE owner=?").all(owner))
        if (nonce(tx.header.nonce) <= nonce(this.#row(prior.id).draft.header.nonce)) throw Error("Wallet nonce did not advance");
      this.#save({ id, owner, purpose, state: "signing", draft, draftHash: hash(JSON.stringify(draft)), transaction: null,
        transactionHash: null, createdAt: this.#now(), finality: null, ...(remote ? { remote: true } : {}) });
      return { action: "sign_original", ...this.status(id) };
    });
  }
  async stage(id, transaction) {
    const tx = structuredClone(transaction); await this.#verify(tx); this.assertReservation(id, tx);
    this.#signatures(tx, this.#row(id).remote);
    return this.#tx(() => {
      const r = this.#row(id);
      if (r.transaction) {
        if (r.transactionHash === hash(JSON.stringify(tx))) return this.status(id);
        if (terminal(r.state) || r.remote || r.transaction.id !== tx.id || r.transaction.signatures.length >= tx.signatures.length ||
            r.transaction.signatures.some(sig => !tx.signatures.includes(sig))) throw Error("Cannot replace wallet signature");
      }
      r.transaction = tx; r.transactionHash = hash(JSON.stringify(tx)); r.state = "signed"; this.#save(r); return this.status(id);
    });
  }
  #signatures(tx, complete = false) {
    const owner = ownerOf(tx), allowed = new Set([owner, tx.header.payer]), signers = new Set();
    if (!tx.signatures?.length || tx.signatures.length > allowed.size) throw Error("Original wallet owner signature required");
    for (const sig of tx.signatures) {
      if (typeof sig !== "string" || Buffer.from(sig, "base64url").length !== 65 || utils.encodeBase64url(Buffer.from(sig, "base64url")) !== sig) throw Error("Invalid wallet signature");
      const address = Signer.recoverAddress(Buffer.from(tx.id.slice(6), "hex"), Buffer.from(sig, "base64url"));
      if (!allowed.has(address) || signers.has(address)) throw Error("Unexpected or duplicate wallet signature");
      signers.add(address);
    }
    if (!signers.has(owner) || (complete && signers.size !== allowed.size)) throw Error("Original wallet owner and payer signatures required");
  }
  async observeRemote(id, txId) {
    objectId(txId); const r = this.#row(id);
    if (!r.remote) throw Error("Remote wallet reservation required");
    if (r.transaction && r.transaction.id !== txId) throw Error("Cannot replace remote wallet transaction");
    const p = this.#client.provider;
    if (await p.getChainId() !== this.#client.d.chainId) throw Error("Wallet nonce chain changed");
    const records = response(await p.getTransactionsById([txId])).transactions ?? [];
    if (!Array.isArray(records)) throw Error("Invalid wallet transaction lookup");
    const matching = records.filter(v => v.transaction?.id === txId);
    if (matching.length > 1) throw Error("Ambiguous wallet transaction lookup");
    if (matching.length) await this.stage(id, matching[0].transaction);
    return this.reconcile(id);
  }
  // Read-only reconciliation. Only this observer can release a reservation;
  // elapsed time, acknowledgments, user Stop and a later tip nonce cannot.
  async reconcile(id) {
    const r = this.#row(id); if (terminal(r.state) || !r.transaction) return this.status(id);
    const tx = r.transaction, p = this.#client.provider;
    if (await p.getChainId() !== this.#client.d.chainId) throw Error("Wallet nonce chain changed");
    const lookup = response(await p.getTransactionsById([tx.id])).transactions ?? [];
    if (!Array.isArray(lookup)) throw Error("Invalid wallet transaction lookup");
    const records = lookup.filter(v => v.transaction?.id === tx.id);
    if (!records.length) return this.status(id);
    if (records.length !== 1) throw Error("Ambiguous wallet transaction lookup");
    const verify = async v => { await this.#verify(v); this.#signatures(v, true); if (v.id !== tx.id) throw Error("Wallet finality transaction changed"); };
    await verify(records[0].transaction);
    const containing = records[0].containing_blocks ?? [];
    if (!Array.isArray(containing) || containing.length > 100) throw Error("Invalid wallet containing blocks");
    containing.forEach(objectId);
    const head = response(await p.getHeadInfo()), height = uint(head.head_topology?.height), lib = uint(head.last_irreversible_block), time = uint(head.head_block_time);
    const headId = objectId(head.head_topology.id), now = this.#now();
    if (!height || height > BigInt(Number.MAX_SAFE_INTEGER) || lib > height || time > BigInt(now) + 60000n || time + 120000n < BigInt(now)) throw Error("Stale wallet nonce head");
    const blocks = response(await p.getBlocksById(containing, { returnBlock: false, returnReceipt: false })).block_items ?? [];
    if (!Array.isArray(blocks)) throw Error("Invalid wallet blocks");
    for (const b of blocks) {
      if (!containing.includes(b.block_id)) throw Error("Unexpected wallet block");
      const h = uint(b.block_height); if (!h || h > lib) continue;
      const [main] = await p.getBlocks(Number(h), 1, headId, { returnBlock: true, returnReceipt: true });
      if (!main || main.block_id !== b.block_id) continue;
      if (main.block?.id !== b.block_id || uint(main.block_height) !== h || uint(main.block.header?.height) !== h ||
          main.receipt?.id !== b.block_id || uint(main.receipt.height) !== h) throw Error("Inconsistent irreversible wallet block");
      const included = main.block.transactions?.filter(v => v.id === tx.id), receipts = main.receipt.transaction_receipts?.filter(v => v.id === tx.id);
      if (included?.length !== 1 || receipts?.length !== 1) throw Error("Missing irreversible wallet receipt");
      await verify(included[0]); const receipt = receipts[0];
      if (receipt.rpc_error || receipt.payer !== tx.header.payer || ![undefined, false, true].includes(receipt.reverted) || uint(receipt.rc_used ?? "0") > uint(tx.header.rc_limit)) throw Error("Invalid wallet receipt");
      if (await p.getChainId() !== this.#client.d.chainId) throw Error("Wallet chain changed during finality");
      return this.#tx(() => {
        if (this.#now() < now || this.#now() - now > 5000) throw Error("Stale wallet finality evidence");
        const current = this.#row(id); current.state = receipt.reverted ? "reverted" : "finalized";
        current.finality = { txId: tx.id, blockId: b.block_id, height: h.toString(), irreversibleHeight: lib.toString() };
        this.#save(current); return this.status(id);
      });
    }
    return this.status(id);
  }
  close() { this.#db.close(); }
}
module.exports = { WalletNonceCoordinator, nonce };
