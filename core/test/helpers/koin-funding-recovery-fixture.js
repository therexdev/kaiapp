"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), { Signer, Serializer, utils } = require("koilib");
const { KoinChain, encodedAddress } = require("../../lib/koin-network/chain");
const { FundingRecovery, FundingRecoveryRunner } = require("../../../electron/koin-funding-recovery");
const { hash } = require("../../lib/koin-network/job-protocol");
const creditsABI = require("../../lib/koin-network/credits-abi.json"), native = new Serializer(utils.tokenAbi.types);
const blockId = h => "0x1220" + hash("funding-block-" + h);
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-funding-recovery-")), signer = Signer.fromSeed("funding-recovery-owner");
  const d = { schema: 1, network: "isolated", decimals: 8, rpc: ["http://127.0.0.1:48080"],
    chainId: utils.encodeBase64url(Buffer.from("1220" + "6".repeat(64), "hex")) };
  for (const k of ["token", "credits", "rewards", "admin", "verifier", "mining", "operations"]) d[k] = Signer.fromSeed("funding-recovery-" + k).getAddress();
  for (const k of ["token", "credits", "rewards"]) d[k + "Hash"] = "0x1220" + "1".repeat(64);
  if (options.mainnet === true) Object.assign(d, { network: "mainnet", chainId: require("../../lib/koin-network/payment-network").MAINNET_CHAIN, token: require("../../lib/koin-network/payment-network").MAINNET_TOKEN, rpc: ["https://mainnet.invalid"] });
  const config = { chain_id: d.chainId, token: encodedAddress(d.token), credits: encodedAddress(d.credits), treasury: encodedAddress(d.rewards),
    admin: encodedAddress(d.admin), verifier: encodedAddress(d.verifier), mining: encodedAddress(d.mining), operations: encodedAddress(d.operations), version: "1" };
  const state = { now: 1000000, height: 10, lib: 10, nonce: "KAE=", paused: false, record: null, block: null, fork: false, liquid: "0", liabilities: "0", available: "0", allowance: "0", signed: 0, submissions: [] };
  const blockTimes = new Map();
  const headBlock = height => {
    if (!blockTimes.has(height)) blockTimes.set(height, state.now);
    return { block_id: blockId(height), block_height: String(height),
      block: { id: blockId(height), header: { height: String(height), timestamp: String(blockTimes.get(height)) }, transactions: [] } };
  };
  const provider = {
    getChainId: async () => d.chainId, getNextNonce: async () => state.nonce,
    invokeGetContractAddress: async () => ({ value: { address: d.token } }),
    invokeGetContractMetadata: async () => ({ value: { hash: d.tokenHash } }),
    getHeadInfo: async () => ({ head_topology: { id: blockId(state.height), height: String(state.height) }, last_irreversible_block: String(state.lib), head_block_time: headBlock(state.height).block.header.timestamp }),
    getTransactionsById: async () => state.record ? { transactions: [structuredClone(state.record)] } : {},
    getBlocksById: async () => ({ block_items: state.block ? [{ block_id: state.block.block_id, block_height: state.block.block_height }] : [] }),
    getBlocks: async (height, _count, _head, opts) => {
      if (state.fork) return [{ ...headBlock(height), block_id: blockId(999) }];
      return [structuredClone(state.block && height === Number(state.block.block_height) && opts.returnReceipt ? state.block : headBlock(height))];
    },
    readContract: async op => {
      if (op.contract_id === d.token) {
        const value = op.entry_point === utils.tokenAbi.methods.allowance.entry_point ? state.allowance : state.liquid;
        return value === "0" ? {} : { result: utils.encodeBase64url(await native.serialize({ value }, "token.uint64")) };
      }
      if (op.contract_id === d.rewards && op.entry_point === creditsABI.methods.balances.entry_point && op.args !== "")
        throw Error("Reward custody is aggregate; no customer account parameter");
      const value = op.entry_point === creditsABI.methods.config.entry_point ? { config, paused: state.paused } : {
        liquid: state.liquid, liabilities: state.liabilities, balance: { available: state.available, reserved: "0" } };
      return { result: utils.encodeBase64url(await client.serializer.serialize(value, "koin.Result")) };
    },
  };
  const client = new KoinChain(d, provider), request = { kind: "credits", method: "purchase", actor: signer.getAddress(),
    args: { account: encodedAddress(signer.getAddress()), amount: "500000000" }, maxRc: "10000000" };
  const handles = [], open = extra => {
    const j = new FundingRecovery(dir, { mode: options.mainnet ? "mainnet-pilot" : "isolated-rehearsal", client, clock: () => state.now, maxRcPerDay: "20000000", ...options, ...extra }); handles.push(j); return j;
  };
  const id = hash("deposit-one"), journal = open();
  const sign = async d => { state.signed++; const tx = structuredClone(d.transaction); await signer.signTransaction(tx); return tx; };
  const include = async (tx, { reverted = false, irreversible = false } = {}) => {
    state.height++; state.nonce = "KAI=";
    state.record = { transaction: structuredClone(tx), containing_blocks: [blockId(state.height)] };
    state.block = headBlock(state.height); state.block.block.transactions = [structuredClone(tx)];
    const receipt = { id: tx.id, payer: signer.getAddress(), rc_used: "1000", reverted };
    if (!reverted) {
      receipt.events = [{ source: d.token, name: "token.transfer_event", data: utils.encodeBase64url(await native.serialize({ from: request.actor, to: d[request.kind], value: request.args.amount }, "token.transfer_event")) }];
      state.liquid = request.args.amount; state.liabilities = request.kind === "credits" ? request.args.amount : "0"; state.available = state.liabilities;
    }
    state.block.receipt = { id: state.block.block_id, height: String(state.height), transaction_receipts: [receipt] };
    if (irreversible) state.lib = state.height;
  };
  const runner = (j = journal, extras = {}) => new FundingRecoveryRunner({ mode: options.mainnet ? "mainnet-pilot" : "isolated-rehearsal", journal: j, sign,
    submit: async d => { state.submissions.push(d.transaction); }, ...extras });
  t.after(() => { for (const h of handles) { try { h.close(); } catch {} } fs.rmSync(dir, { recursive: true, force: true });
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dir + ".recovery-anchor.sqlite" + suffix, { force: true }); });
  return { dir, d, config, client, provider, state, request, id, journal, open, runner, sign, include, signer };
}
module.exports = { fixture, blockId };
