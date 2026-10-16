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
const amount = async value => serializer.serialize(value === "0" ? {} : { value }, "koin.Amount");
async function run(vm, kind, method, args = {}, raw) {
  const a = require("../abi/" + kind + ".json");
  put(vm, "ENTRY_POINT_KEY", koinos.chain.value_type.encode({ int32_value: (a.methods[method] || abi.methods[method]).entry_point }).finish());
  put(vm, "CONTRACT_ARGUMENTS_KEY", raw || await serializer.serialize(normalize(serializer.root.lookupType("koin.Request"), args), "koin.Request"));
  const imports = vm.getImports(), invoke = imports.invoke_system_call;
  imports.invoke_system_call = (id, rp, rl, ap, al, size) => {
    const result = invoke(id, rp, rl, ap, al, size);
    if (new DataView(vm.memory.buffer).getUint32(size, true) > rl) throw Error("VM return buffer overflow");
    // Native Koinos omits an empty call_result.value. MockVM/protobufjs emits
    // a length-zero field, masking sdk-as null-result traps on zero balances.
    if (id === koinos.chain.system_call_id.call && result === 0) {
      const sizeView = new DataView(vm.memory.buffer), length = sizeView.getUint32(size, true);
      const value = koinos.chain.call_result.decode(new Uint8Array(vm.memory.buffer, rp, length)).value;
      if (!value?.length) sizeView.setUint32(size, 0, true);
    }
    return result;
  };
  const module = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, "../build/release", kind + ".wasm")));
  const instance = new WebAssembly.Instance(module, { env: imports }); vm.setInstance(instance); vm.db.commitTransaction();
  try { instance.exports._start(); assert.fail("WASM never entered the contract"); } catch (e) { if (e.code !== 0) throw e; }
  return serializer.deserialize(vm.db.getObject(C.METADATA_SPACE, C.CONTRACT_RESULT_KEY).value, "koin.Result");
}
async function initialized(kind, policy = config) {
  const vm = new MockVM(true), id = kind === "rewards" ? addr(3) : addr(2);
  // MockVM 1.0 stores views into WASM memory. The chain stores owned bytes;
  // copy writes so allocator reuse cannot mutate persisted records in tests.
  const write = vm.db.putObject.bind(vm.db);
  vm.db.putObject = (space, key, value) => write(space, key, Uint8Array.from(value));
  put(vm, "CONTRACT_ID_KEY", id); put(vm, "CHAIN_ID_KEY", chain); authority(vm, id);
  calls(vm, [Uint8Array.from([8, 8])]); // native-token decimals()
  await run(vm, kind, "initialize", { config: policy }); return vm;
}
for (const kind of ["credits", "rewards"]) test(kind + " shipped WASM initializes, dispatches reads, rejects noncanonical and oversized requests", async () => {
  const vm = await initialized(kind), result = await run(vm, kind, "config");
  assert.equal(result.config.token, config.token); assert.equal(result.config.version, "1");
  calls(vm, [await amount("0")]);
  const empty = await run(vm, kind, "balances", kind === "credits" ? { account: b64(addr(8)) } : {});
  assert.equal(empty.liquid ?? "0", "0"); assert.equal(empty.liabilities ?? "0", "0");
  await assert.rejects(run(vm, kind, "config", {}, Buffer.from([32, 0])), /noncanonical/);
  await assert.rejects(run(vm, kind, "config", {}, Buffer.alloc(16385)), /request too large/);
});
test("only the configured rewards contract can seal a closed paid-work day", async () => {
  const vm = await initialized("credits"), DAY = 86400000;
  put(vm, "BLOCK_KEY", koinos.protocol.block.encode({ header: { timestamp: 2 * DAY } }).finish());
  authority(vm, addr(3)); // A key signature cannot impersonate the contract caller.
  const caller = account => put(vm, "CALLER_KEY", koinos.chain.caller_data.encode({ caller: account, caller_privilege: koinos.chain.privilege.user_mode }).finish());
  caller(addr(8)); await assert.rejects(run(vm, "credits", "seal_day", { epoch: "1" }), /treasury caller required/);
  caller(addr(3)); await run(vm, "credits", "seal_day", { epoch: "1" });
  await assert.rejects(run(vm, "credits", "seal_day", { epoch: "2" }), /current charge period/);
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
  calls(vm, [await amount("50"), Buffer.alloc(0), await amount("0"), await amount("0"), await amount("0")]);
  const empty = await run(vm, "credits", "refund", { account, amount: "50" });
  assert.equal(empty.balance.available, "0"); assert.equal(empty.liabilities, "0");
});
test("JavaScript Merkle-sum allocation settles through compiled rewards WASM and cannot be claimed twice", async () => {
  const vm = await initialized("rewards"), DAY = 86400000;
  const clock = timestamp => put(vm, "BLOCK_KEY", koinos.protocol.block.encode({ header: { timestamp } }).finish());
  clock(DAY);
  await assert.rejects(run(vm, "rewards", "open_epoch", { epoch: "2" }), /reward day changed/);
  await assert.rejects(run(vm, "rewards", "open_epoch"), /reward day changed/);
  calls(vm, [await amount("100000")]);
  const opened = await run(vm, "rewards", "open_epoch", { epoch: "1" }); assert.equal(opened.epoch.budget, "5000");
  const { build } = require("../../../core/lib/koin-network/merkle");
  const provider = utils.encodeBase58(addr(8));
  const tree = build({ chainId: b64(chain), contract: utils.encodeBase58(addr(3)), epoch: 1, version: 1 },
    [{ address: provider, availability: "1000", work: "500" }, { address: utils.encodeBase58(addr(9)), availability: "500", work: "0" }]);
  const wire = n => ({ ...n, hash: b64(Buffer.from(n.hash, "hex")) });
  clock(2 * DAY); authority(vm, addr(5));
  calls(vm, [Buffer.alloc(0), await serializer.serialize({ amount: "1000" }, "koin.Result"), await amount("100000"), await amount("100000")]);
  await run(vm, "rewards", "propose_root", { epoch: "1", root: wire(tree.root) });
  clock(3 * DAY);
  await assert.rejects(run(vm, "rewards", "open_epoch", { epoch: "2" }), /reward day changed/);
  await assert.rejects(run(vm, "rewards", "finalize_root", { epoch: "1" }), /expected root required/);
  await assert.rejects(run(vm, "rewards", "finalize_root", { epoch: "1", root: { ...wire(tree.root), availability: "1501" } }), /reward root changed/);
  calls(vm, [await amount("100000"), await amount("100000")]);
  await run(vm, "rewards", "finalize_root", { epoch: "1", root: wire(tree.root) });
  const claim = tree.claims.find(x => x.address === provider);
  const request = { epoch: "1", account: b64(addr(8)), availability: claim.availability, work: claim.work, proof: claim.proof.map(wire) };
  calls(vm, [await serializer.serialize({ amount: "1000" }, "koin.Result"), await amount("100000"), Buffer.alloc(0), await amount("98500"), await amount("98500"), await amount("98500")]);
  const paid = await run(vm, "rewards", "claim", request);
  assert.equal(paid.liabilities, "500");
  await assert.rejects(run(vm, "rewards", "claim", request), /duplicate claim/);
});
test("compiled rewards finalize a work-only root with multiple open days and a budget above uint32", async () => {
  const vm = await initialized("rewards"), DAY = 86400000, liquid = "100000000000";
  const clock = timestamp => put(vm, "BLOCK_KEY", koinos.protocol.block.encode({ header: { timestamp } }).finish());
  clock(DAY + 10000); calls(vm, [await amount(liquid)]);
  const opened = await run(vm, "rewards", "open_epoch", { epoch: "1" });
  assert.ok(BigInt(opened.epoch.budget) > 4294967295n);
  const { build } = require("../../../core/lib/koin-network/merkle");
  const tree = build({ chainId: b64(chain), contract: utils.encodeBase58(addr(3)), epoch: 1, version: 1 }, [{ address: utils.encodeBase58(addr(8)), availability: "0", work: "30" }]);
  const root = { hash: b64(Buffer.from(tree.root.hash, "hex")), work: "30" };
  clock(2 * DAY + 10000); authority(vm, addr(5));
  calls(vm, [Buffer.alloc(0), await serializer.serialize({ amount: "38" }, "koin.Result"), await amount(liquid), await amount(liquid)]);
  await run(vm, "rewards", "propose_root", { epoch: "1", root });
  calls(vm, [await amount(liquid)]); await run(vm, "rewards", "open_epoch", { epoch: "2" });
  clock(3 * DAY + 10001); calls(vm, [await amount(liquid)]); await run(vm, "rewards", "open_epoch", { epoch: "3" });
  calls(vm, [await amount(liquid), await amount(liquid)]);
  await run(vm, "rewards", "finalize_root", { epoch: "1", root });
  assert.equal((await run(vm, "rewards", "get_epoch", { epoch: "1" })).epoch.finalized, true);
});

const USD = require("../../../core/lib/koin-network/purchase-quote");
const usdConfig = { ...config, reward_basis: 1, master_node: b64(addr(10)) };
const usdDeployment = { product: "prepaid-usd-v1", chainId: b64(chain), credits: utils.encodeBase58(addr(2)),
  masterNode: utils.encodeBase58(addr(10)), verifier: utils.encodeBase58(addr(5)) };
const usdQuote = (overrides = {}) => USD.issue({ deployment: usdDeployment, signer: Signer.fromSeed("koin-wasm-fixture-5"),
  account: utils.encodeBase58(addr(8)), amount: "200000000", usdPerKoin: "25000000", version: 1, now: 86400000, ...overrides });
const clockUsd = (vm, timestamp) => put(vm, "BLOCK_KEY", koinos.protocol.block.encode({ header: { timestamp } }).finish());
async function usdVm() { const vm = await initialized("prepaid-usd", usdConfig); clockUsd(vm, 86400000); authority(vm, addr(8)); return vm; }
async function usdBuy(vm, args) {
  calls(vm, [await amount("100"), Buffer.alloc(0), await amount(String(100n + BigInt(args.amount))), await amount("0")]);
  return run(vm, "prepaid-usd", "purchase", args);
}
test("USD WASM verifies a real signed price, pays Master Node and records fixed USD credits once", async () => {
  const vm = await usdVm(), args = await usdQuote(), purchased = await usdBuy(vm, args);
  assert.equal(purchased.balance.available, "50000000"); // 2 KOIN at $0.25 buys $0.50 / 500 credits.
  assert.equal(purchased.liquid, "0"); assert.equal(purchased.liabilities, "0");
  assert.equal((await run(vm, "prepaid-usd", "config")).product_version, 2);
  const stored = (await run(vm, "prepaid-usd", "get_purchase", { id: args.purchase_quote.id })).purchase;
  assert.deepEqual(stored, args.purchase_quote);
  await assert.rejects(usdBuy(vm, args), /already credited/);
  const cheaper = await usdQuote({ usdPerKoin: "12500000" });
  assert.equal((await usdBuy(vm, cheaper)).balance.available, "75000000", "A new price cannot revalue earlier credits");
  clockUsd(vm, 90 * 86400000); authority(vm, addr(5)); calls(vm, [await amount("0")]);
  const usage = { account: args.account, charge: { id: b64(Buffer.alloc(32, 31)), receipt_hash: b64(Buffer.alloc(32, 32)),
    policy_hash: b64(Buffer.alloc(32, 33)), provider: b64(addr(9)), amount: "10000000" } };
  const settled = await run(vm, "prepaid-usd", "settle_usage", usage);
  assert.equal(settled.balance.available, "65000000"); assert.equal(settled.prepaid.consumed, "10000000");
  assert.equal(settled.liquid, "0"); assert.equal(settled.liabilities, "0");
  assert.equal((await run(vm, "prepaid-usd", "get_spend", { epoch: "90", account: b64(addr(9)) })).amount, "10000000");
  await assert.rejects(run(vm, "prepaid-usd", "settle_usage", usage), /duplicate/);
  await assert.rejects(run(vm, "prepaid-usd", "refund", { account: args.account, amount: "1" }), /unknown prepaid/);
});
test("USD WASM rejects forged, expired, cross-account, cross-contract and cross-Master price quotes", async () => {
  for (const alter of [
    a => { a.purchase_quote.credits = "50000001"; },
    a => { a.purchase_quote.usd_per_koin = "25000001"; a.purchase_quote.credits = "50000002"; },
    a => { a.account = a.purchase_quote.account = b64(addr(9)); },
    a => { a.price_signature = b64(Buffer.alloc(65, 1)); },
    a => { a.purchase_quote.policy_version = "2"; },
  ]) {
    const vm = await usdVm(), args = await usdQuote(); alter(args);
    await assert.rejects(usdBuy(vm, args));
  }
  for (const delta of [{ credits: utils.encodeBase58(addr(11)) }, { masterNode: utils.encodeBase58(addr(11)) }, { chainId: b64(Buffer.from([18,32,...new Array(32).fill(8)])) }]) {
    const vm = await usdVm(), args = await usdQuote({ deployment: { ...usdDeployment, ...delta } });
    await assert.rejects(usdBuy(vm, args), /invalid price signer/);
  }
  const vm = await usdVm(), args = await usdQuote(); clockUsd(vm, 86400000 + 300001);
  await assert.rejects(usdBuy(vm, args), /expired/);
});
test("failed Master Node payment leaves no USD credits or used quote; conversion handles uint64 products", async () => {
  const vm = await usdVm(), args = await usdQuote(); calls(vm, [await amount("100"), Buffer.alloc(0), await amount("100")]);
  await assert.rejects(run(vm, "prepaid-usd", "purchase", args), /payment mismatch/);
  assert.equal((await run(vm, "prepaid-usd", "get_purchase", { id: args.purchase_quote.id })).purchase ?? null, null);
  assert.equal((await usdBuy(vm, args)).balance.available, "50000000");
  const largeVm = await usdVm(), large = await usdQuote({ amount: "1000000000000", usdPerKoin: "500000000" });
  assert.equal((await usdBuy(largeVm, large)).balance.available, "5000000000000");
});
test("USD reward pool budgets 5% of 10,000 KOIN and pays proportionally to USD work without a cross-currency cap", async () => {
  const vm = await initialized("rewards", usdConfig), DAY = 86400000, liquid = "1000000000000";
  clockUsd(vm, DAY); calls(vm, [await amount(liquid)]);
  const opened = (await run(vm, "rewards", "open_epoch", { epoch: "1" })).epoch;
  assert.equal(opened.budget, "50000000000"); assert.equal(opened.work_budget, "15000000000"); assert.equal(opened.reward_basis, 1);
  const { build } = require("../../../core/lib/koin-network/merkle"), provider = utils.encodeBase58(addr(8));
  const tree = build({ chainId: b64(chain), contract: utils.encodeBase58(addr(3)), epoch: 1, version: 1 },
    [{ address: provider, availability: "35000000000", work: "15000000000" }]);
  const root = { ...tree.root, hash: b64(Buffer.from(tree.root.hash, "hex")) };
  clockUsd(vm, 2 * DAY); authority(vm, addr(5));
  const spent = await serializer.serialize({ amount: "100" }, "koin.Result");
  calls(vm, [Buffer.alloc(0), spent, await amount(liquid), await amount(liquid)]);
  await run(vm, "rewards", "propose_root", { epoch: "1", root });
  clockUsd(vm, 3 * DAY); calls(vm, [await amount(liquid), await amount(liquid)]);
  await run(vm, "rewards", "finalize_root", { epoch: "1", root });
  const request = { epoch: "1", account: b64(addr(8)), availability: root.availability, work: root.work };
  calls(vm, [await serializer.serialize({ amount: "50" }, "koin.Result"), spent]);
  await assert.rejects(run(vm, "rewards", "claim", request), /work exceeds/);
  calls(vm, [spent, spent, await amount(liquid), Buffer.alloc(0), await amount("950000000000"), await amount("950000000000"), await amount("950000000000")]);
  const paid = await run(vm, "rewards", "claim", request); assert.equal(paid.liabilities, "0");
  await assert.rejects(run(vm, "rewards", "claim", request), /duplicate/);
});
