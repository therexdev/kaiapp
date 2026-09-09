"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { Signer, utils } = require("koilib");
const { JsonStore } = require("../lib/store");
const { DEFAULT_SETTINGS, NETWORKS } = require("../lib/koinos/constants");
const { ChainService } = require("../lib/koinos/chain");
const { NodeManager } = require("../lib/koinos/node-manager");
const { RewardEngine } = require("../lib/koinos/rewards");
const { ProducerCustody } = require("../lib/koinos/producer-custody");
const { buildChannels } = require("../lib/koinos-node");
const { inspect } = require("../../scripts/sign-producer-transaction");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cold-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = new JsonStore(path.join(dir, "settings.json"), DEFAULT_SETTINGS), state = new JsonStore(path.join(dir, "state.json"));
  const owner = Signer.fromSeed("cold test owner"), local = Signer.fromSeed("unrelated earning wallet");
  const wallet = { address: local.getAddress(), status: () => ({ exists: true, unlocked: true, address: local.getAddress() }), get signer() { throw new Error("LOCAL SIGNER ACCESSED"); }, signerFor() { throw new Error("LOCAL SIGNER ACCESSED"); } };
  const chain = new ChainService(settings), calls = [];
  const provider = { getAccountRc: async () => "10000000000", getChainId: async () => utils.encodeBase64url(new Uint8Array(34).fill(1)), getNextNonce: async () => "KAE=", sendTransaction: async tx => { calls.push(tx); return { transaction: tx, receipt: {} }; } };
  chain.provider = () => provider; chain.resolveContracts = async () => NETWORKS.mainnet.contracts;
  chain._isAllowanceToken = async () => true;
  chain.balances = async () => ({ koin: "10000000000", vhp: "10000000000", mana: "10000000000" });
  let registered = null;
  chain.registeredPublicKey = async () => registered;
  const nodeMgr = new NodeManager({ dataRoot: dir, templateRoot: path.join(__dirname, "../../vendor/koinos") });
  nodeMgr.status = async () => ({ docker: { ok: true }, isRunning: false }); nodeMgr.dockerInfo = async () => ({ ok: true });
  nodeMgr.start = async (network, address) => ({ network, address });
  const rewards = new RewardEngine({ settings, state, chain, wallet, stats: { refresh() { throw new Error("REWARD READ IN COLD MODE"); } } });
  t.after(() => rewards.stop());
  const args = { settings, state, chain, wallet, nodeMgr, rewards };
  const custody = new ProducerCustody(args);
  const channels = buildChannels({ ...args, setup: { optimizeWslMemory: async () => {} }, stats: {}, userData: dir, appVersion: "test" });
  return { ...args, dir, owner, custody, channels, provider, calls, registered: value => { registered = value; } };
}
test("external producer setup, restart, rotation and host files never need the cold private key", async t => {
  const f = fixture(t), address = f.owner.getAddress();
  await f.custody.configure({ mode: "external", address });
  const made = await f.custody.key();
  assert.equal(f.custody.config().localWalletAddress, f.wallet.address);
  assert.notEqual(address, f.wallet.address);
  await assert.rejects(f.channels.get("node:start")({ produce: true }), /registration/);
  f.registered(made.publicKey);
  assert.equal((await f.channels.get("node:start")({ produce: true })).address, address);
  const restarted = new ProducerCustody({ ...f, settings: new JsonStore(path.join(f.dir, "settings.json")), state: new JsonStore(path.join(f.dir, "state.json")) });
  assert.equal((await restarted.status()).matches, true);
  assert.equal((await restarted.key()).publicKey, made.publicKey);
  const rotated = await restarted.key({ rotate: true, confirm: true });
  assert.notEqual(rotated.publicKey, made.publicKey);
  assert.ok(fs.existsSync(path.join(rotated.backupDirectory, "private.key")));
  assert.equal((await restarted.status()).matches, false);
  await assert.rejects(f.channels.get("node:start")({ produce: true }), /registration/);
  f.registered(rotated.publicKey);
  assert.equal((await restarted.status()).matches, true);
  for (const file of fs.readdirSync(f.dir, { recursive: true }).map(p => path.join(f.dir, p)).filter(p => fs.statSync(p).isFile())) {
    const content = fs.readFileSync(file, "utf8");
    assert.ok(!content.includes(f.owner.getPrivateKey("wif")) && !content.includes(f.owner.getPrivateKey()), file);
  }
});
test("cold producer refuses local signing and disables even previously configured automatic funds operations", async t => {
  const f = fixture(t);
  await f.custody.configure({ mode: "external", address: f.owner.getAddress() });
  for (const channel of ["chain:burn", "chain:send", "producer:register", "rewards:runNow"]) await assert.rejects(async () => f.channels.get(channel)({ amount: "1", token: "koin", to: f.wallet.address }), /External producer/);
  assert.throws(() => f.rewards.configure({ enabled: true }), /disabled/);
  f.settings.set("rewards.enabled", true); f.rewards.start();
  assert.equal(f.rewards.status().running, false);
  assert.equal((await f.rewards.tick("manual")).last.outcome, "external-wallet");
  await assert.rejects(f.custody.configure({ mode: "external", address: f.wallet.address }), /already has a private key/);
  f.nodeMgr._desiredRunning = true;
  await assert.rejects(f.custody.key({ rotate: true, confirm: true }), /Stop the node/);
  f.nodeMgr._desiredRunning = false;
  f.nodeMgr.status = async () => ({ docker: { ok: true }, isRunning: true });
  await assert.rejects(f.custody.key({ rotate: true, confirm: true }), /Stop the node/);
});
test("external registration, KCS-4 burn and KOIN/VHP transfers prepare, decode, sign offline and broadcast only exact producer-signed drafts", async t => {
  const f = fixture(t); await f.custody.configure({ mode: "external", address: f.owner.getAddress() }); await f.custody.key();
  for (const input of [{ action: "register" }, { action: "burn", amount: "1" }, { action: "transfer", token: "koin", amount: "1", to: f.wallet.address }, { action: "transfer", token: "vhp", amount: "1", to: f.wallet.address }]) {
    const draft = await f.custody.prepare(input);
    assert.equal(f.calls.length, 0);
    const review = await inspect(draft);
    assert.equal(review.payer, f.owner.getAddress());
    assert.equal(review.operations.length, input.action === "burn" ? 2 : 1);
    const signed = await f.owner.signTransaction(structuredClone(draft.transaction));
    const mutated = structuredClone(signed); mutated.header.rc_limit = "1";
    await assert.rejects(f.custody.broadcast({ transaction: mutated, confirm: true }), /differs/);
    await assert.rejects(f.custody.broadcast({ transaction: signed, confirm: false }), /confirm/);
    const wrong = await Signer.fromSeed("wrong key").signTransaction(structuredClone(draft.transaction));
    await assert.rejects(f.custody.broadcast({ transaction: wrong, confirm: true }), /does not belong/);
    const result = await f.custody.broadcast({ transaction: signed, confirm: true });
    assert.equal(result.txId, signed.id); assert.equal(f.calls.length, 1); f.calls.length = 0;
    await assert.rejects(f.custody.broadcast({ transaction: signed, confirm: true }), /expired/);
  }
});
test("failed chain reads, changed nonce, expiry and changed network never authorize external production or broadcast", async t => {
  const f = fixture(t); await f.custody.configure({ mode: "external", address: f.owner.getAddress() }); await f.custody.key();
  f.chain.registeredPublicKey = async () => { throw new Error("RPC unavailable"); };
  assert.match((await f.custody.status()).verificationError, /Could not verify/);
  await assert.rejects(f.channels.get("node:start")({ produce: true }), /Could not verify/);
  const d = await f.custody.prepare({ action: "register" }), signed = await f.owner.signTransaction(structuredClone(d.transaction));
  f.provider.getNextNonce = async () => "KAI=";
  await assert.rejects(f.custody.broadcast({ transaction: signed, confirm: true }), /nonce changed/);
  f.state.set("producerDraft.expiresAt", 1);
  await assert.rejects(f.custody.broadcast({ transaction: signed, confirm: true }), /expired/);
  assert.equal(f.calls.length, 0);
});

test("producer UI configures cold custody without a local wallet, generates a key and prepares external registration", { skip: !fs.existsSync(process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium"), timeout: 45000 }, async t => {
  const f = fixture(t); f.wallet.address = null; f.wallet.status = () => ({ exists: false, unlocked: false, address: null });
  const { startMascotServer } = require("./fixtures/mascot-server");
  const server = await startMascotServer(f.dir);
  const browser = await require("playwright-core").chromium.launch({ executablePath: process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } }), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/core/koinos/rpc", async route => {
    const { channel, payload } = route.request().postDataJSON();
    let result;
    try { result = { ok: true, data: await f.channels.get(channel)(payload || {}) }; }
    catch (e) { result = { ok: false, error: e.message }; }
    await route.fulfill({ json: result });
  });
  await page.goto(server.origin + "/knode/index.html");
  await page.locator('[data-view="node"]').click();
  await page.selectOption("#pc-mode", "external"); await page.fill("#pc-address", f.owner.getAddress());
  await page.click("#pc-save");
  await page.waitForFunction(() => document.querySelector("#pc-result").textContent.includes("Custody saved"));
  await page.click("#pc-key");
  await page.waitForFunction(() => document.querySelector("#pc-public").value.length > 20);
  assert.equal(await page.locator("#n-register").isDisabled(), true);
  await page.locator("summary").filter({ hasText: "External signing:" }).click();
  await page.click("#pc-prepare");
  await page.waitForFunction(() => document.querySelector("#pc-unsigned").value.includes("kai-producer-transaction-v1"));
  const draft = JSON.parse(await page.inputValue("#pc-unsigned"));
  const signed = await f.owner.signTransaction(draft.transaction);
  await page.fill("#pc-signed", JSON.stringify(signed)); await page.check("#pc-confirm"); await page.click("#pc-broadcast");
  await page.waitForFunction(() => document.querySelector("#pc-result").textContent.includes("Submitted"));
  assert.equal(f.calls.length, 1);
  f.registered(await page.inputValue("#pc-public"));
  await page.click("#pc-verify");
  await page.waitForFunction(() => document.querySelector("#pc-result").textContent.includes("matches this node"));
  assert.equal((await f.channels.get("node:start")({ produce: true })).address, f.owner.getAddress());
  await page.locator('[data-view="returns"]').click();
  assert.match(await page.locator("#view-returns").textContent(), /Automatic burns and transfers are disabled/);
  assert.deepEqual(errors, []);
});
