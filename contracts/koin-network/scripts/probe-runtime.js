"use strict";
// Exercise the built WASM entry points, protobuf buffers and persisted custody.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path");
const { MockVM } = require("@koinos/mock-vm"), C = require("@koinos/mock-vm/src/constants");
const { koinos } = require("@koinos/proto-js"), { Serializer, Signer, utils } = require("koilib");
const { normalize } = require("../../../core/lib/koin-network/chain");
const abi = require("../abi/credits.json"), serializer = new Serializer(abi.types);
const addr = i => utils.decodeBase58(Signer.fromSeed("koin-wasm-fixture-" + i).getAddress());
const b64 = x => utils.encodeBase64url(x), chain = Uint8Array.from([18, 32, ...new Array(32).fill(7)]);
const config = { chain_id: b64(chain), token: b64(addr(1)), credits: b64(addr(2)), treasury: b64(addr(3)),
  admin: b64(addr(4)), verifier: b64(addr(5)), mining: b64(addr(6)), operations: b64(addr(7)),
  version: "1", daily_bps: 500, availability_bps: 7000, reward_bps: 6000, mining_bps: 2500, operations_bps: 1500, work_cap_bps: 8000 };
function put(vm, key, value) { vm.db.putObject(C.METADATA_SPACE, C[key], value); }
function authority(vm, account) { put(vm, "AUTHORITY_KEY", koinos.chain.list_type.encode({ values: [{ bool_value: true, bytes_value: account, int32_value: koinos.chain.authorization_type.contract_call }] }).finish()); }
function calls(vm, results) { put(vm, "CALL_CONTRACT_RESULTS_KEY", koinos.chain.list_type.encode({ values: results.map(object => ({ bytes_value: koinos.chain.exit_arguments.encode({ code: 0, res: { object } }).finish() })) }).finish()); }
const amount = async value => serializer.serialize({ value }, "koin.Amount");
async function run(vm, kind, method, args = {}, raw) {
  const a = require("../abi/" + kind + ".json");
  put(vm, "ENTRY_POINT_KEY", koinos.chain.value_type.encode({ int32_value: a.methods[method].entry_point }).finish());
  put(vm, "CONTRACT_ARGUMENTS_KEY", raw || await serializer.serialize(normalize(serializer.root.lookupType("koin.Request"), args), "koin.Request"));
  const imports = vm.getImports(), invoke = imports.invoke_system_call;
  imports.invoke_system_call = (id, rp, rl, ap, al, size) => {
    const result = invoke(id, rp, rl, ap, al, size);
    if (new DataView(vm.memory.buffer).getUint32(size, true) > rl) throw Error("VM return buffer overflow");
    return result;
  };
  const module = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, "../build/release", kind + ".wasm")));
  const instance = new WebAssembly.Instance(module, { env: imports }); vm.setInstance(instance); vm.db.commitTransaction();
  try { instance.exports._start(); assert.fail("WASM never entered the contract"); } catch (e) { if (e.code !== 0) throw e; }
  return serializer.deserialize(vm.db.getObject(C.METADATA_SPACE, C.CONTRACT_RESULT_KEY).value, "koin.Result");
}
async function initialized(kind) {
  const vm = new MockVM(true), id = kind === "credits" ? addr(2) : addr(3);
  // MockVM 1.0 stores views into WASM memory. The chain stores owned bytes;
  // copy writes so allocator reuse cannot mutate persisted records in tests.
  const write = vm.db.putObject.bind(vm.db);
  vm.db.putObject = (space, key, value) => write(space, key, Uint8Array.from(value));
  put(vm, "CONTRACT_ID_KEY", id); put(vm, "CHAIN_ID_KEY", chain); authority(vm, id);
  calls(vm, [Uint8Array.from([8, 8])]); // native-token decimals()
  await run(vm, kind, "initialize", { config }); return vm;
}
for (const kind of ["credits", "rewards"]) test(kind + " shipped WASM initializes, dispatches reads, rejects noncanonical and oversized requests", async () => {
  const vm = await initialized(kind), result = await run(vm, kind, "config");
  assert.equal(result.config.token, config.token); assert.equal(result.config.version, "1");
  await assert.rejects(run(vm, kind, "config", {}, Buffer.from([32, 0])), /noncanonical/);
  await assert.rejects(run(vm, kind, "config", {}, Buffer.alloc(16385)), /request too large/);
});
test("credits WASM preserves principal after a failed transfer and permits refunds while paused", async () => {
  const vm = await initialized("credits"), buyer = addr(8), account = b64(buyer);
  authority(vm, buyer); calls(vm, [await amount("0"), Buffer.alloc(0), await amount("100"), await amount("100"), await amount("100")]);
  await run(vm, "credits", "purchase", { account, amount: "100" });
  // Simulate a token that claims success without the expected balance delta.
  calls(vm, [await amount("100"), Buffer.alloc(0), await amount("100")]);
  await assert.rejects(run(vm, "credits", "refund", { account, amount: "50" }), /transfer mismatch/);
  calls(vm, [await amount("100")]);
  const state = await run(vm, "credits", "balances", { account });
  assert.equal(state.balance.available, "100"); assert.equal(state.liabilities, "100");
  authority(vm, addr(4)); await run(vm, "credits", "set_paused", { paused: true });
  authority(vm, buyer); calls(vm, [await amount("100"), Buffer.alloc(0), await amount("50"), await amount("50"), await amount("50")]);
  const refunded = await run(vm, "credits", "refund", { account, amount: "50" });
  assert.equal(refunded.balance.available, "50"); assert.equal(refunded.liabilities, "50");
});
test("JavaScript Merkle-sum allocation settles through compiled rewards WASM and cannot be claimed twice", async () => {
  const vm = await initialized("rewards"), DAY = 86400000;
  const clock = timestamp => put(vm, "BLOCK_KEY", koinos.protocol.block.encode({ header: { timestamp } }).finish());
  clock(DAY); calls(vm, [await amount("100000")]);
  const opened = await run(vm, "rewards", "open_epoch"); assert.equal(opened.epoch.budget, "5000");
  const { build } = require("../../../core/lib/koin-network/merkle");
  const provider = utils.encodeBase58(addr(8));
  const tree = build({ chainId: b64(chain), contract: utils.encodeBase58(addr(3)), epoch: 1, version: 1 },
    [{ address: provider, availability: "1000", work: "500" }, { address: utils.encodeBase58(addr(9)), availability: "500", work: "0" }]);
  const wire = n => ({ ...n, hash: b64(Buffer.from(n.hash, "hex")) });
  clock(2 * DAY); authority(vm, addr(5));
  calls(vm, [Buffer.alloc(0), await serializer.serialize({ amount: "1000" }, "koin.Result"), await amount("100000"), await amount("100000")]);
  await run(vm, "rewards", "propose_root", { epoch: "1", root: wire(tree.root) });
  clock(3 * DAY); calls(vm, [await amount("100000"), await amount("100000")]);
  await run(vm, "rewards", "finalize_root", { epoch: "1" });
  const claim = tree.claims.find(x => x.address === provider);
  const request = { epoch: "1", account: b64(addr(8)), availability: claim.availability, work: claim.work, proof: claim.proof.map(wire) };
  calls(vm, [await serializer.serialize({ amount: "1000" }, "koin.Result"), await amount("100000"), Buffer.alloc(0), await amount("98500"), await amount("98500"), await amount("98500")]);
  const paid = await run(vm, "rewards", "claim", request);
  assert.equal(paid.liabilities, "500");
  await assert.rejects(run(vm, "rewards", "claim", request), /duplicate claim/);
});
