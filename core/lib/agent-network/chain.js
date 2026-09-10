"use strict";
// Testnet-only integration tooling. This adapter is not enabled by the desktop preview.
const { Provider, Serializer, Transaction, Signer, utils } = require("koilib"), P = require("./protocol"), { clone } = require("./store"), ABI = require("./contract-abi.json");
const FOUNDATION = "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==";
const addressBytes = address => utils.encodeBase64url(utils.decodeBase58(address));
// Match the AssemblyScript proto3 encoder: omit scalar defaults. Keep message
// presence, and reject unknown fields rather than silently changing signed terms.
function protoInput(type, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) P.fail("INVALID_SCHEMA", "Expected a contract message.");
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const field = type.fields[key]; if (!field) P.fail("INVALID_SCHEMA", "Unknown contract field: " + key);
    field.resolve(); if (value == null) continue;
    if (field.resolvedType?.fields) out[key] = protoInput(field.resolvedType, value);
    else if (value !== "" && value !== false && value !== 0 && !(value === "0" && /^(u?int|fixed|sfixed|sint)/.test(field.type))) out[key] = value;
  }
  return out;
}
class ChainClient {
  constructor(deployment, provider) {
    P.fields(deployment, ["network", "chain_id", "rpc", "contract", "contract_code_hash", "token", "token_code_hash", "decimals", "fee_to", "fee_bps", "job_cap_atoms", "irreversible_start"]);
    if (deployment.network !== "foundation-testnet" || deployment.chain_id !== FOUNDATION || deployment.decimals !== 8) P.fail("DEPLOYMENT_REQUIRED", "An explicit foundation-testnet deployment is required.");
    for (const key of ["contract", "token", "fee_to"]) if (utils.decodeBase58(deployment[key]).length !== 25) P.fail("INVALID_SCHEMA", "Invalid deployment address.");
    for (const key of ["contract_code_hash", "token_code_hash"]) if (!/^0x1220[a-f0-9]{64}$/.test(deployment[key])) P.fail("INVALID_SCHEMA", "Pin the complete contract bytecode multihash.");
    P.uint(deployment.job_cap_atoms, 10000000000n); P.uint(deployment.irreversible_start);
    if (!Number.isSafeInteger(deployment.fee_bps) || deployment.fee_bps < 0 || deployment.fee_bps > 10000) P.fail("INVALID_SCHEMA", "Invalid fee rate.");
    this.deployment = clone(deployment); this.provider = provider || new Provider(deployment.rpc); this.serializer = new Serializer(ABI.types); this.verified = false;
  }
  async operation(name, args) {
    const method = ABI.methods[name]; if (!method) P.fail("INVALID_SCHEMA", "Unknown Agent Network contract method.");
    const value = protoInput(this.serializer.root.lookupType(method.argument), args);
    return { contract_id: this.deployment.contract, entry_point: method.entry_point, args: utils.encodeBase64url(await this.serializer.serialize(value, method.argument)) };
  }
  async read(name, args = {}) { if (!ABI.methods[name]?.read_only) P.fail("INVALID_SCHEMA", "Not a read method."); const data = await this.provider.readContract(await this.operation(name, args)); return this.serializer.deserialize(data.result, "network.Result"); }
  async verifyDeployment() {
    const d = this.deployment;
    if (await this.provider.getChainId() !== d.chain_id) P.fail("WRONG_CHAIN", "RPC chain ID differs from the deployment.");
    const [contract, token] = await Promise.all([this.provider.invokeGetContractMetadata(d.contract), this.provider.invokeGetContractMetadata(d.token)]);
    if (contract.value?.hash !== d.contract_code_hash || token.value?.hash !== d.token_code_hash || !contract.value.authorizes_upload_contract || contract.value.authorizes_call_contract || contract.value.authorizes_transaction_application) P.fail("CODE_MISMATCH", "Contract bytecode or authority flags differ from the deployment.");
    const { config } = await this.read("config");
    if (!config || config.token !== addressBytes(d.token) || Buffer.from(config.chain_id, "base64").toString("hex") !== Buffer.from(d.chain_id, "base64").toString("hex") || config.decimals !== d.decimals || config.fee_to !== addressBytes(d.fee_to) || config.fee_bps !== d.fee_bps || String(config.job_cap) !== d.job_cap_atoms) P.fail("CONFIG_MISMATCH", "On-chain settings differ from the deployment record.");
    this.verified = true; return { verified: true, deployment: d };
  }
  async prepare(name, args, { payee, payer = payee, rc_limit }) {
    await this.verifyDeployment(); if (ABI.methods[name]?.read_only || name === "initialize") P.fail("INVALID_SCHEMA", "Choose a service transaction."); P.uint(rc_limit);
    return Transaction.prepareTransaction({ header: { chain_id: this.deployment.chain_id, payer, ...(payee !== payer ? { payee } : {}), rc_limit }, operations: [{ call_contract: await this.operation(name, args) }], signatures: [] }, this.provider);
  }
  async verifyTransaction(tx) {
    P.fields(tx, ["header", "operations", "id", "signatures"]);
    P.fields(tx.header, ["chain_id", "payer", "rc_limit", "nonce", "operation_merkle_root"], ["payee"]);
    if (tx.header.chain_id !== this.deployment.chain_id || tx.operations.length !== 1 || tx.signatures.length > 3 || P.canonical(tx).length > 20000) P.fail("INVALID_TRANSACTION", "Invalid chain or operation count.");
    P.fields(tx.operations[0], ["call_contract"]); const op = tx.operations[0].call_contract; P.fields(op, ["contract_id", "entry_point", "args"]);
    const name = Object.keys(ABI.methods).find(n => ABI.methods[n].entry_point === op.entry_point);
    if (op.contract_id !== this.deployment.contract || !name || ABI.methods[name].read_only || name === "initialize") P.fail("INVALID_TRANSACTION", "Unsupported service operation.");
    const args = await this.serializer.deserialize(op.args, "network.Request");
    if ((await this.operation(name, args)).args !== op.args) P.fail("INVALID_TRANSACTION", "Noncanonical operation encoding.");
    const prepared = await Transaction.prepareTransaction(clone(tx));
    if (prepared.id !== tx.id || P.canonical(prepared.header) !== P.canonical(tx.header)) P.fail("INVALID_TRANSACTION", "Transaction commitment mismatch.");
    const actor = tx.header.payee || tx.header.payer, signers = await Signer.recoverAddresses(tx);
    if (!signers.includes(actor)) P.fail("INVALID_SIGNATURE", "The initiating account must sign the exact transaction.");
    return { name, args, actor, signers };
  }
  async submit(tx) { await this.verifyDeployment(); await this.verifyTransaction(tx); const receipt = await this.provider.call("chain.submit_transaction", { transaction: tx, broadcast: true }); if (receipt.receipt?.reverted || receipt.receipt?.rpc_error) P.fail("TRANSACTION_FAILED", "Transaction was rejected or its outcome is uncertain."); return { id: tx.id, confidence: "submitted" }; }
  async finality(txId) {
    await this.verifyDeployment();
    const d = await this.provider.getTransactionsById([txId]); const record = d.transactions?.find(x => x.transaction?.id === txId || x.id === txId);
    if (!record) return { confidence: "submitted" };
    const head = await this.provider.getHeadInfo(), lib = BigInt(head.last_irreversible_block || "0");
    const candidates = await this.provider.getBlocksById(record.containing_blocks || [], { returnBlock: true, returnReceipt: true });
    for (const candidate of candidates.block_items || []) {
      const height = BigInt(candidate.block_height || "0"); if (!height || height > BigInt(head.head_topology.height)) continue;
      const canonical = (await this.provider.getBlocks(Number(height), 1, head.head_topology.id, { returnBlock: true, returnReceipt: true }))[0];
      if (!canonical || canonical.block_id !== candidate.block_id) continue;
      const receipt = canonical.receipt?.transaction_receipts?.find(r => r.id === txId);
      if (!receipt || receipt.reverted) P.fail("TRANSACTION_FAILED", "The canonical receipt is missing or reverted.");
      return { confidence: height <= lib ? "irreversible" : "included", height: height.toString(), block_id: canonical.block_id, receipt };
    }
    return { confidence: "submitted", orphaned: true };
  }
}
class SponsorPolicy {
  constructor({ client, store, signer, maxRc, globalRc, perActor = 20, exitReserve = "0" }) { this.client = client; this.store = store; this.signer = signer; this.maxRc = P.uint(maxRc); this.globalRc = P.uint(globalRc); this.exitReserve = P.uint(exitReserve); this.perActor = perActor; }
  async authorize(tx) {
    await this.client.verifyDeployment(); const { name, args, actor } = await this.client.verifyTransaction(tx);
    if (tx.header.payer !== this.signer.getAddress() || actor === tx.header.payer || !tx.header.payee) P.fail("SPONSOR_POLICY", "Sponsor requires a separately signed payee.");
    const a = addressBytes(actor), match = x => x === a;
    const rules = { fund_job: () => match(args.job?.buyer), deposit_vault: () => match(args.account), withdraw_vault: () => match(args.account), create_grant: () => match(args.grant?.owner), register_agent: () => match(args.agent?.owner), update_manifest: () => match(args.agent?.owner), expire_job: () => true, withdraw: () => true };
    let permitted = rules[name]?.();
    if (["accept_job", "submit_delivery", "accept_delivery", "cancel_job", "open_dispute", "resolve_job", "publish_review"].includes(name)) { const { job } = await this.client.read("get_job", { id: args.id }); permitted = job && (name === "resolve_job" ? match(job.resolver) : ["accept_job", "submit_delivery"].includes(name) ? match(job.provider) : name === "open_dispute" ? match(job.provider) || match(job.buyer) : match(job.buyer)); }
    if (["rotate_controller", "retire_agent"].includes(name)) { const { agent } = await this.client.read("get_agent", { id: args.id }); permitted = agent && match(agent.owner); }
    if (["reserve_job", "revoke_grant"].includes(name)) { const { grant } = await this.client.read("get_grant", { id: args.id }); permitted = grant && match(name === "reserve_job" ? grant.controller : grant.owner); }
    if (!permitted) P.fail("SPONSOR_POLICY", "The payee does not control this action.");
    const rc = P.uint(tx.header.rc_limit); if (rc === 0n || rc > this.maxRc) P.fail("SPONSOR_CAPACITY", "Transaction exceeds the sponsor RC limit.");
    const exit = ["withdraw", "withdraw_vault", "expire_job", "cancel_job", "open_dispute", "resolve_job", "revoke_grant"].includes(name), available = P.uint(await this.client.provider.getAccountRc(tx.header.payer));
    this.store.change(d => { d.sponsorship ||= []; const old = d.sponsorship.find(x => x.id === tx.id); if (old) P.fail("SPONSOR_PENDING", "This transaction already reserved resources; reconcile it first."); const day = Math.floor(Date.now() / 86400000), pending = d.sponsorship.filter(x => !x.reconciled), sum = pending.reduce((v, x) => v + BigInt(x.rc), 0n); if (pending.length >= 200 || sum + rc > this.globalRc || sum + rc + (exit ? 0n : this.exitReserve) > available || d.sponsorship.filter(x => x.actor === actor && x.day === day).length >= this.perActor) P.fail("SPONSOR_CAPACITY", "Sponsor quota or reserved exit capacity reached."); d.sponsorship.push({ id: tx.id, actor, day, rc: rc.toString(), reconciled: false }); });
    // Reservation remains on signing failure. Release only after explicit chain/nonce reconciliation.
    return this.signer.signTransaction(clone(tx));
  }
}
module.exports = { ChainClient, SponsorPolicy, FOUNDATION, addressBytes };
