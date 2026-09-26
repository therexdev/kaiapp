"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("events");
const { Signer, Serializer, Transaction, utils } = require("koilib");
const { KoinChain, encodedAddress } = require("../lib/koin-network/chain");
const { createFundingReview } = require("../../electron/koin-funding-review");
const native = new Serializer(utils.tokenAbi.types);
const signer = Signer.fromSeed("funding-bundle-owner-fixture"), owner = signer.getAddress();
const addr = n => Signer.fromSeed("funding-bundle-fixture-" + n).getAddress();
function fixture(kind = "credits") {
  const d = { schema: 1, network: "mainnet", decimals: 8, rpc: ["https://example.invalid"],
    chainId: utils.encodeBase64url(Buffer.from("1220" + "7".repeat(64), "hex")) };
  for (const k of ["token", "credits", "rewards", "admin", "verifier", "mining", "operations"]) d[k] = addr(k);
  for (const k of ["token", "credits", "rewards"]) d[k + "Hash"] = "0x1220" + "1".repeat(64);
  const config = { chain_id: d.chainId, token: encodedAddress(d.token), credits: encodedAddress(d.credits),
    treasury: encodedAddress(d.rewards), admin: encodedAddress(d.admin), verifier: encodedAddress(d.verifier),
    mining: encodedAddress(d.mining), operations: encodedAddress(d.operations), version: "1", reward_bps: 6000 };
  const state = { paused: false, nonce: "KAE=", submissions: [] };
  const provider = {
    getChainId: async () => d.chainId,
    getNextNonce: async a => { assert.equal(a, owner); return state.nonce; },
    invokeGetContractAddress: async () => ({ value: { address: d.token } }),
    invokeGetContractMetadata: async () => ({ value: { hash: d.tokenHash } }),
    readContract: async () => ({ result: utils.encodeBase64url(await client.serializer.serialize({ config, paused: state.paused }, "koin.Result")) }),
    call: async (method, body) => { assert.equal(method, "chain.submit_transaction"); state.submissions.push(body.transaction); return { receipt: {} }; },
  };
  const client = new KoinChain(d, provider), request = { kind, method: kind === "credits" ? "purchase" : "fund",
    args: { account: encodedAddress(owner), amount: "9007199254740993" }, actor: owner, rcLimit: "10000000" };
  return { client, d, provider, config, state, request, intent: { ...request, maxRc: request.rcLimit } };
}
const prepare = f => f.client.prepare(f.request.kind, f.request.method, f.request.args, f.request);
function windowFixture() {
  const w = new EventEmitter(); Object.assign(w, { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false });
  w.webContents = new EventEmitter(); return w;
}

test("purchase and reward funding bind native approval and custody deposit with full uint64 precision", async () => {
  for (const kind of ["credits", "rewards"]) {
    const f = fixture(kind), tx = await prepare(f);
    assert.equal(tx.operations.length, 2); assert.deepEqual(tx.signatures, []);
    const [approval, deposit] = tx.operations.map(x => x.call_contract);
    assert.equal(approval.contract_id, f.d.token); assert.equal(approval.entry_point, 0x74e21680);
    assert.deepEqual(await native.deserialize(approval.args, "token.approve_args"),
      { owner, spender: f.d[kind], value: f.request.args.amount });
    const args = await f.client.serializer.deserialize(deposit.args, "koin.Request");
    assert.equal(args.account, encodedAddress(owner)); assert.equal(args.amount, f.request.args.amount);
    assert.equal(deposit.contract_id, f.d[kind]);
    assert.equal(await f.client.verifyTransaction(tx, f.intent), true);
    const sponsored = await f.client.prepare(kind, f.request.method, f.request.args, { ...f.request, payer: addr("sponsor") });
    assert.equal(sponsored.header.payee, owner);
    assert.equal(await f.client.verifyTransaction(sponsored, { ...f.intent, payer: addr("sponsor") }), true);
    await assert.rejects(f.client.verifyTransaction(sponsored, f.intent), /scope/);
  }
  const f = fixture();
  const refund = await f.client.prepare("credits", "refund", { account: encodedAddress(owner), amount: "1" }, f.request);
  assert.equal(refund.operations.length, 1, "refunds never grant a token allowance");
});

test("even recomputed transaction IDs cannot authorize wider, redirected, reordered or partial funding", async () => {
  const f = fixture(), tx = await prepare(f);
  const approval = async (t, change) => {
    const args = await native.deserialize(t.operations[0].call_contract.args, "token.approve_args"); change(args);
    t.operations[0].call_contract.args = utils.encodeBase64url(await native.serialize(args, "token.approve_args"));
  };
  for (const mutate of [
    t => approval(t, a => { a.value = "18446744073709551615"; }),
    t => approval(t, a => { a.value = "1"; }),
    t => approval(t, a => { a.owner = addr("thief"); }),
    t => approval(t, a => { a.spender = f.d.rewards; }),
    t => { t.operations[0].call_contract.contract_id = addr("fake-token"); },
    t => { t.operations[0].call_contract.entry_point = 0x27f576ca; },
    t => { t.operations[1].call_contract.contract_id = f.d.rewards; },
    t => { t.operations[1].call_contract.args = ""; },
    t => { t.operations.reverse(); }, t => { t.operations.pop(); }, t => { t.operations.shift(); },
    t => { t.operations.push(t.operations[0]); },
    t => { t.operations[0].call_contract.extra = "ignored by protobuf"; },
    t => { t.operations[1].call_contract.args += "IAA="; },
    t => { t.header.payer = addr("unexpected-payer"); },
    t => { t.header.payee = addr("unexpected-owner"); },
    t => { t.header.rc_limit = "10000001"; },
    t => { t.header.chain_id = utils.encodeBase64url(Buffer.from("1220" + "8".repeat(64), "hex")); },
  ]) {
    const modified = structuredClone(tx); await mutate(modified);
    const committed = await Transaction.prepareTransaction(modified);
    await assert.rejects(f.client.verifyTransaction(committed, f.intent), /scope|differs/);
  }
  for (const mutate of [
    t => { t.extra = true; }, t => { t.header.extra = true; },
    t => { t.operations[0].upload_contract = {}; }, t => { t.id = "0x1220" + "0".repeat(64); },
    t => { t.header.nonce = "KAI="; },
  ]) {
    const changed = structuredClone(tx); mutate(changed);
    await assert.rejects(f.client.verifyTransaction(changed, f.intent));
  }
});

test("funding refuses imprecise amounts, unrelated fields, another owner, paused state and counterfeit testnet tokens", async () => {
  const f = fixture();
  for (const amount of ["0", "01", "-1", "1.5", "1e8", 100, 1n, "18446744073709551616", null])
    await assert.rejects(f.client.prepare("credits", "purchase", { ...f.request.args, amount }, f.request));
  for (const args of [{ ...f.request.args, account: encodedAddress(addr("other")) },
    { ...f.request.args, paused: false }, { ...f.request.args, epoch: "0" }, { ...f.request.args, extra: null }])
    await assert.rejects(f.client.prepare("credits", "purchase", args, f.request));
  f.state.paused = true; await assert.rejects(prepare(f), /paused/); f.state.paused = false;
  const tx = await prepare(f); await signer.signTransaction(tx);
  f.state.paused = true; await assert.rejects(f.client.submit(tx, f.intent), /paused/);
  assert.equal(f.state.submissions.length, 0);
  const testnet = new KoinChain({ ...f.d, network: "foundation-testnet" }, f.provider);
  f.provider.invokeGetContractAddress = async () => ({ value: { address: addr("counterfeit") } });
  await assert.rejects(testnet.verify(), /canonical native/);
  assert.throws(() => new KoinChain({ ...f.d, token: f.d.credits }, f.provider), /Separate custody/);
  assert.throws(() => new KoinChain({ ...f.d, network: "isolated" }, f.provider), /loopback/);
  assert.throws(() => new KoinChain({ ...f.d, network: "isolated", rpc: ["http://127.0.0.1:48080"] }), /injected provider/);
  for (const rcLimit of ["0", "-1", 100, 1n, "18446744073709551616"])
    await assert.rejects(f.client.prepare("credits", "purchase", f.request.args, { ...f.request, rcLimit }));
});

test("preparation and submission retain their original snapshot across asynchronous deployment reads", async () => {
  const f = fixture();
  const pending = prepare(f); f.request.args.amount = "1";
  const tx = await pending;
  assert.equal((await native.deserialize(tx.operations[0].call_contract.args, "token.approve_args")).value, "9007199254740993");
  const intent = { ...f.intent, args: { account: encodedAddress(owner), amount: "9007199254740993" } };
  await signer.signTransaction(tx);
  const submitted = f.client.submit(tx, intent);
  tx.operations.reverse(); intent.args.amount = "1";
  assert.equal((await submitted).state, "submitted");
  assert.equal(f.state.submissions[0].operations[0].call_contract.entry_point, 0x74e21680);
});

test("native funding preview shows exact purpose and two-operation scope without signing or broadcasting", async () => {
  for (const kind of ["credits", "rewards"]) {
    const f = fixture(kind), w = windowFixture(); let shown;
    const review = createFundingReview({ client: f.client, clock: () => 1000, dialog: { async showMessageBox(_w, options) {
      shown = options; return { response: 1 };
    } } });
    const result = await review.review(w, () => f.request);
    assert.equal(result.status, "reviewed"); assert.equal(result.paymentsEnabled, false);
    assert.deepEqual(Object.keys(result).sort(), ["mode", "paymentsEnabled", "status", "txId"]);
    for (const text of ["90071992.54740993 KOIN", owner, f.d[kind], f.d.token, f.d.chainId,
      "10000000", result.txId, "One transaction", "rolls back", "No KOIN will be spent"])
      assert.ok(shown.detail.includes(text), text);
    assert.ok(shown.detail.includes(kind === "credits" ? "refundable usage credits" : "does not create customer credits"));
    assert.equal(shown.defaultId, 0); assert.equal(shown.cancelId, 0);
    assert.deepEqual(shown.buttons, ["Cancel", "Mark preview reviewed"]);
    assert.equal(f.state.submissions.length, 0); assert.equal(w.listenerCount("hide"), 0);
    assert.equal(w.webContents.listenerCount("did-start-navigation"), 0);
  }
});

test("funding preview rejects changed wallet, amount, purpose, payer, Mana, policy, nonce, clock and deployment", async () => {
  for (const change of [
    f => { f.request.args.amount = "1"; },
    f => { f.request.actor = addr("new-owner"); f.request.args.account = encodedAddress(f.request.actor); },
    f => { f.request.kind = "rewards"; f.request.method = "fund"; },
    f => { f.request.payer = addr("sponsor"); }, f => { f.request.rcLimit = "20000000"; },
    f => { f.config.reward_bps = 5000; }, f => { f.state.nonce = "KAI="; },
    f => { f.state.paused = true; },
    f => { f.provider.invokeGetContractMetadata = async () => ({ value: { hash: "0x1220" + "2".repeat(64) } }); },
    (f, c) => { c.now += 180000; }, (f, c) => { c.now--; },
  ]) {
    const f = fixture(), clock = { now: 1000 };
    const review = createFundingReview({ client: f.client, clock: () => clock.now, dialog: { async showMessageBox() {
      change(f, clock); return { response: 1 };
    } } });
    assert.notEqual((await review.review(windowFixture(), () => f.request)).status, "reviewed");
    assert.equal(f.state.submissions.length, 0);
  }
});

test("funding previews cancel on window lifecycle, Stop and concurrent review; errors release the lock", async () => {
  for (const event of ["hide", "minimize", "closed", "navigation", "crash", "stop", "dialog-error", "cancel"]) {
    const f = fixture(), w = windowFixture(); let review;
    review = createFundingReview({ client: f.client, dialog: { async showMessageBox() {
      assert.equal((await review.review(w, () => f.request)).status, "cancelled");
      if (event === "navigation") w.webContents.emit("did-start-navigation", {}, "about:blank", false, true);
      else if (event === "crash") w.webContents.emit("render-process-gone");
      else if (event === "stop") review.cancel();
      else if (event === "dialog-error") throw Error("closed dialog");
      else if (event !== "cancel") w.emit(event);
      return { response: event === "cancel" ? 0 : 1 };
    } } });
    for (let i = 0; i < 2; i++) assert.notEqual((await review.review(w, () => f.request)).status, "reviewed");
    assert.equal(w.listenerCount("hide"), 0); assert.equal(f.state.submissions.length, 0);
  }
});
