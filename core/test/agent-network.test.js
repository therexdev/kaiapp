"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const P = require("../lib/agent-network/protocol"), { Store } = require("../lib/agent-network/store"), { AgentNetwork } = require("../lib/agent-network/network"), { Relay } = require("../lib/agent-network/relay"), { Transport } = require("../lib/agent-network/transport");
const storage = { isEncryptionAvailable: () => true, encryptString: x => Buffer.from(x), decryptString: x => x.toString() };
function fixture(t, options = {}) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-agent-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); const store = new Store(path.join(dir, "state.json"), storage), network = new AgentNetwork({ store, models: () => [{ alias: "local", status: "ready" }], runLocal: async () => "A private answer", transport: new Transport({ allowLoopback: true }), ...options }); network.settings({ enabled: true, endpoints: [] }); network.stop(); t.after(() => network.stop()); return { network, store, dir }; }
async function pump(networks, condition, iterations = 30) { for (let i = 0; i < iterations; i++) { for (const n of networks) await n.tick(); await new Promise(r => setTimeout(r, 10)); if (condition()) return; } assert.fail("Job did not reach the expected state: " + JSON.stringify(networks.map(n => ({ error: n.store.data.lastError, jobs: n.store.data.jobs.map(j => ({ role: j.role, status: j.status, error: j.error, workflow: j.workflow?.runs })) })))); }
test("agent protocol signs exact domains, rejects changed fields and duplicate JSON keys", async () => { const key = P.identity(), s = await P.sign("quote", { amount: "100" }, key); assert.equal(P.verify(s, "quote").amount, "100"); assert.throws(() => P.verify(s, "manifest"), /domain/); assert.throws(() => P.verify(s, "quote", { ...P.PRIVATE, chain_id: "other" }), /domain/); s.payload.amount = "101"; assert.throws(() => P.verify(s, "quote"), /Signature/); assert.throws(() => P.parse('{"x":1,"x":2}'), /canonical/); assert.throws(() => P.uint("01")); assert.throws(() => P.uint("18446744073709551616")); });
test("encrypted messages bind metadata and reject the wrong recipient", () => { const a = P.identity(), b = P.identity(), packet = P.seal({ secret: "dentist appointment" }, a.encryption_public, { id: "one" }); assert.doesNotMatch(JSON.stringify(packet), /dentist/); assert.equal(P.open(packet, a.encryption_private).secret, "dentist appointment"); assert.throws(() => P.open(packet, b.encryption_private)); packet.header.id = "changed"; assert.throws(() => P.open(packet, a.encryption_private)); });
test("local agent job uses the real graph engine, pins a version and produces a reviewable free result", async t => { const { network: n } = fixture(t); const card = await n.save({ template: "echo", name: "Echo", description: "Connection check" }); n.accepting(card.payload.agent_id, true); const id = await n.quote(card, "selected input only"); await pump([n], () => n.store.data.jobs.find(j => j.id === id && j.role === "buyer").status === "quoted"); await n.submit(id); await pump([n], () => n.store.data.jobs.find(j => j.id === id && j.role === "buyer").status === "delivered"); const j = n.store.data.jobs.find(j => j.id === id && j.role === "buyer"); assert.equal(j.output, "selected input only"); await n.jobAction(id, "accept"); await pump([n], () => n.store.data.jobs.find(j => j.id === id && j.role === "host").status === "accepted"); assert.equal(n.status().paid, false); });
test("two installations exchange private jobs through two replaceable relays", async t => {
 const a = fixture(t), b = fixture(t), r1 = fixture(t), r2 = fixture(t);
 const servers = await Promise.all([r1, r2].map(r => new Relay({ store: r.store }).listen())); t.after(async () => { for (const s of servers) await new Promise(r => s.close(r)); });
 const endpoints = servers.map(s => "http://127.0.0.1:" + s.address().port);
 for (const n of [a.network, b.network]) { n.settings({ enabled: true, endpoints }); n.stop(); }
 const card = await a.network.save({ template: "echo", name: "Private echo", description: "Fixture" }); a.network.accepting(card.payload.agent_id, true); await a.network.publish(card.payload.agent_id);
 await b.network.discover(); assert.equal(b.network.status().cards.length, 1);
 const id = await b.network.quote(card, "never visible to the relay"); await pump([a.network, b.network], () => b.store.data.jobs[0].status === "quoted");
 await b.network.submit(id); await pump([a.network, b.network], () => b.store.data.jobs[0].status === "delivered"); assert.equal(b.store.data.jobs[0].output, "never visible to the relay");
 assert.doesNotMatch(JSON.stringify(r1.store.data), /never visible to the relay/); assert.equal(a.store.data.jobs.filter(j => j.id === id).length, 1);
 await b.network.jobAction(id, "accept"); await pump([a.network, b.network], () => a.store.data.jobs[0].status === "accepted");
});
test("service packages reject ambient account, memory and private provider access", async t => { const { network: n } = fixture(t), { template } = require("../lib/agent-network/runtime"); for (const type of ["memory", "tool_call", "http_request", "sub_workflow"]) { const definition = template("echo"); definition.graph.nodes[1].type = type; await assert.rejects(n.save({ definition }), /public services|required|Choose|Unsupported|HTTPS/); } await assert.rejects(n.save({ template: "summary", model: "desktop:anthropic:x" }), /local models/); await assert.rejects(n.save({ amount_atoms: "1" }), /contracts/); });
test("event index replay, restart and reversible rollback preserve one economic event", t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-agent-index-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); const { EventIndexer } = require("../lib/agent-network/indexer"), file = path.join(dir, "events.db"), domain = { chain: "fixture", contract: "fixture" }; let index = new EventIndexer(file, domain); const event = { tx: "tx1", name: "funded", data: { amount: "100" } }; index.ingest({ height: 1, id: "b1", parent: "genesis" }, [event], 1); index.ingest({ height: 1, id: "b1", parent: "genesis" }, [event], 1); assert.equal(index.ledger().length, 1); index.ingest({ height: 2, id: "old", parent: "b1" }, [{ ...event, tx: "oldtx" }], 1); index.close(); index = new EventIndexer(file, domain); index.ingest({ height: 2, id: "new", parent: "b1" }, [{ ...event, tx: "newtx" }], 2); assert.deepEqual(index.ledger().map(e => e.tx), ["tx1", "newtx"]); assert.throws(() => index.ingest({ height: 1, id: "bad", parent: "genesis" }, [], 0), /irreversible/); index.close(); });
test("paused local tests work but a paused remote service refuses new quotes", async t => { const { network: n } = fixture(t); const card = await n.save({ template: "echo" }); const id = await n.quote(card, "local test"); await pump([n], () => n.store.data.jobs.find(j => j.id === id).status === "quoted"); const attacker = P.identity(); await assert.rejects(n.handle({ type: "quote_request", job_id: P.random(), agent_id: card.payload.agent_id, service_version_hash: P.hash(card), input_commitment: P.hash("input"), reply_key: attacker.encryption_public, reply_endpoints: [], buyer: attacker.address }, attacker.address), /paused/); });
test("signed message replay deduplicates and changed ciphertext is rejected", async t => { const { network: n } = fixture(t); const card = await n.save({ template: "echo" }), id = await n.quote(card, "input"); await pump([n], () => n.store.data.jobs.find(j => j.id === id).status === "quoted"); const quote = n.store.data.jobs.find(j => j.id === id).quote, packet = await n.packet(n.identity().address, n.identity().encryption_public, { type: "quote", signed: quote }); await n.receive(packet); const before = n.store.data.inbox.length; await n.receive(packet); assert.equal(n.store.data.inbox.length, before); packet.payload.ciphertext += "AAAA"; await assert.rejects(n.receive(packet), /Signature/); });
test("sponsor verifies actor, full operation commitment and pending RC before signing", async t => {
 const { ChainClient, SponsorPolicy, FOUNDATION, addressBytes } = require("../lib/agent-network/chain"), { Signer, Transaction } = require("koilib");
 const owner = Signer.fromWif(P.identity().wif), sponsor = Signer.fromWif(P.identity().wif), target = P.identity().address, token = P.identity().address;
 const deployment = { network: "foundation-testnet", chain_id: FOUNDATION, rpc: "https://example.com", contract: target, contract_code_hash: "0x1220" + "a".repeat(64), token, token_code_hash: "0x1220" + "b".repeat(64), decimals: 8, fee_to: owner.getAddress(), fee_bps: 200, job_cap_atoms: "10000000000", irreversible_start: "1" };
 const client = new ChainClient(deployment, { getAccountRc: async () => "10000" }); client.verifyDeployment = async () => ({ verified: true });
 const tx = await Transaction.prepareTransaction({ header: { chain_id: FOUNDATION, payer: sponsor.getAddress(), payee: owner.getAddress(), nonce: "KAE=", rc_limit: "100" }, operations: [{ call_contract: await client.operation("deposit_vault", { account: addressBytes(owner.getAddress()), amount: "1" }) }], signatures: [] }); await owner.signTransaction(tx);
 const { store } = fixture(t), policy = new SponsorPolicy({ client, store, signer: sponsor, maxRc: "200", globalRc: "200", exitReserve: "50" });
 const signed = await policy.authorize(tx); assert.equal(signed.signatures.length, 2); await assert.rejects(policy.authorize(tx), /already reserved/);
 const changed = structuredClone(tx); changed.operations.push({ call_contract: changed.operations[0].call_contract }); await assert.rejects(client.verifyTransaction(changed), /operation count/);
 const tampered = structuredClone(tx); tampered.header.rc_limit = "101"; await assert.rejects(client.verifyTransaction(tampered), /commitment/);
 const wrong = await Transaction.prepareTransaction({ header: { ...tx.header, nonce: "KAI=" }, operations: [{ call_contract: await client.operation("deposit_vault", { account: addressBytes(sponsor.getAddress()), amount: "1" }) }], signatures: [] }); await owner.signTransaction(wrong); await assert.rejects(policy.authorize(wrong), /does not control/);
});
test("host cancellation reaches the buyer and cannot be resumed", async t => {
 const { network: n } = fixture(t), M = require("../../ui/workflow-model");
 const nodes = [M.node("trigger", "input"), M.node("approval", "review"), M.node("output", "result", { x: 600, y: 80 }, { text: "=input" })];
 const card = await n.save({ definition: { name: "Approval service", graph: { version: 1, nodes, edges: [M.edge("input", "review"), M.edge("review", "result", "approved")] } } });
 const id = await n.quote(card, "selected input"); await pump([n], () => n.store.data.jobs.find(j => j.role === "buyer").status === "quoted"); await n.submit(id);
 await pump([n], () => n.store.data.jobs.find(j => j.role === "buyer").status === "waiting");
 await n.jobAction(id, "cancel", "host"); await pump([n], () => n.store.data.jobs.find(j => j.role === "buyer").status === "cancelled");
 await n.jobAction(id, "resume", "host"); assert.equal(n.store.data.jobs.find(j => j.role === "host").status, "cancelled");
});
test("restart preserves an uncertain step and refuses automatic replay", async t => {
 const { network: n, store } = fixture(t), card = await n.save({ template: "echo" }), id = await n.quote(card, "input");
 await pump([n], () => store.data.jobs.find(j => j.role === "buyer").status === "quoted"); await n.submit(id); await pump([n], () => store.data.jobs.find(j => j.role === "buyer").status === "delivered"); n.stop();
 store.change(d => { const j = d.jobs.find(j => j.role === "host"); j.status = "running"; j.workflow.runs[0].status = "running"; j.workflow.runs[0].inFlight = { tokens: ["unfinished-step"] }; });
 const recovered = new AgentNetwork({ store }); t.after(() => recovered.stop()); assert.equal(recovered.status().jobs.find(j => j.role === "host").status, "interrupted");
 await assert.rejects(recovered.jobAction(id, "resume", "host"), /stopped during a step/); assert.equal(store.data.jobs.find(j => j.role === "host").workflow.runs.length, 1);
});
test("step budgets stop execution and Local-Only blocks relay egress", async t => {
 const { network: n } = fixture(t), card = await n.save({ template: "echo", limits: { input_bytes: 100, output_bytes: 100, steps: 1, model_calls: 1, seconds: 10 } });
 const id = await n.quote(card, "input"); await pump([n], () => n.store.data.jobs.find(j => j.role === "buyer").status === "quoted"); await n.submit(id); await pump([n], () => n.store.data.jobs.find(j => j.role === "buyer").status === "failed");
 assert.match(n.store.data.jobs.find(j => j.role === "buyer").error, /step limit/);
 await assert.rejects(new Transport({ privacyMode: () => "local-only" }).request("https://example.org", "/agent-network/v1/config"), /Local-Only/);
 for (const url of ["https://user:password@example.org", "https://127.0.0.1", "https://169.254.169.254", "https://example.org/private"]) await assert.rejects(new Transport().request(url, "/agent-network/v1/config"));
});
test("headless CLI runs the desktop job with encrypted state and separate identity", async t => {
 const { execFileSync } = require("child_process"), dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-agent-cli-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 const cli = path.resolve(__dirname, "../../cli/kai-agent.js"), call = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args, "--data", dir], { encoding: "utf8", timeout: 15000 }));
 const init = call("init"), card = call("create", "--template", "echo"), file = path.join(dir, "input.txt"); fs.writeFileSync(file, "A headless private result");
 assert.equal(card.signer, init.address); const { job_id } = call("quote", "--id", card.payload.agent_id, "--input", file); call("poll");
 const result = call("submit", "--id", job_id, "--wait", "true"); assert.equal(result.status, "delivered"); assert.equal(result.output, "A headless private result");
 assert.doesNotMatch(fs.readFileSync(path.join(dir, "agent-network.json"), "utf8"), /A headless private result/); call("job", "--id", job_id, "--action", "accept");
 assert.equal(call("jobs").find(j => j.role === "buyer").status, "accepted");
});
test("published protocol vector verifies across clients", async () => {
 const vector = require("../../docs/agent-network/protocol-vector.json"), { Signer } = require("koilib"), signer = new Signer({ privateKey: vector.test_private_key_hex });
 assert.equal(P.hash(vector.signed), vector.sha256); assert.equal(P.canonical(vector.signed), vector.canonical);
 assert.deepEqual(P.verify(vector.signed, "fixture"), vector.signed.payload);
 assert.deepEqual(await P.sign("fixture", vector.signed.payload, { wif: signer.getPrivateKey("wif") }), vector.signed);
});
test("funding finality requires successful canonical inclusion below LIB", async () => {
 const { ChainClient, FOUNDATION } = require("../lib/agent-network/chain"), address = P.identity().address;
 const deployment = { network: "foundation-testnet", chain_id: FOUNDATION, rpc: "https://example.org", contract: address, contract_code_hash: "0x1220" + "a".repeat(64), token: address, token_code_hash: "0x1220" + "b".repeat(64), decimals: 8, fee_to: address, fee_bps: 200, job_cap_atoms: "100", irreversible_start: "1" };
 let lib = "4", block = "canonical", reverted = false;
 const provider = { getTransactionsById: async () => ({ transactions: [{ transaction: { id: "tx" }, containing_blocks: ["canonical"] }] }), getHeadInfo: async () => ({ last_irreversible_block: lib, head_topology: { id: "head", height: "10" } }), getBlocksById: async () => ({ block_items: [{ block_id: "canonical", block_height: "5" }] }), getBlocks: async () => [{ block_id: block, receipt: { transaction_receipts: [{ id: "tx", reverted }] } }] };
 const client = new ChainClient(deployment, provider); client.verifyDeployment = async () => ({ verified: true });
 assert.equal((await client.finality("tx")).confidence, "included"); lib = "5"; assert.equal((await client.finality("tx")).confidence, "irreversible");
 block = "other"; assert.equal((await client.finality("tx")).confidence, "submitted"); block = "canonical"; reverted = true; await assert.rejects(client.finality("tx"), /reverted/);
});

test("service deliveries retain structured values and text beyond the preview limit", async t => {
  for (const input of ["x".repeat(20000), { title: "Complete result", count: 2 }, [1, 2, 3], true, 42]) {
    const { network: n } = fixture(t);
    const schema = typeof input === "string" ? { type: "string", maxLength: 32000 } : Array.isArray(input) ? { type: "array", items: { type: "integer" } } : typeof input === "object" ? { type: "object", properties: { title: { type: "string" }, count: { type: "integer" } }, required: ["title", "count"] } : { type: typeof input === "number" ? "integer" : "boolean" };
    const card = await n.save({ template: "echo", input_schema: schema, output_schema: schema });
    const id = await n.quote(card, input);
    await pump([n], () => n.store.data.jobs.find(j => j.id === id && j.role === "buyer").status === "quoted");
    await n.submit(id);
    await pump([n], () => n.store.data.jobs.find(j => j.id === id && j.role === "buyer").status === "delivered");
    assert.deepEqual(n.store.data.jobs.find(j => j.id === id && j.role === "buyer").output, input);
  }
});
