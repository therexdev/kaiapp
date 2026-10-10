"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
const { configuration } = require("../../electron/koin-test-config");
const { TestPayments } = require("../../electron/koin-test-payments");
const { FundedSessionClient } = require("../../electron/koin-session-client");
const { createSessionReview } = require("../../electron/koin-session-review");
const { assertPaymentMode, testDomain } = require("../lib/koin-network/payment-mode");
const { protocol } = require("../lib/koin-network/payment-network"), D = require("../lib/koin-network/session-delegation"), P = require("../lib/koin-network/job-protocol");
const { Worker } = require("../lib/worker");
const window = () => Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false, isVisible: () => true, isMinimized: () => false });
function setup(t, answer = 1) {
  const f = fixture(t, { mainnet: true }), reviews = [], config = configuration({ schema: 1, mode: "mainnet-pilot", deployment: f.d,
    owner: f.signer.getAddress(), schedulerUrl: "https://mainnet-test.example/scheduler", policyHash: P.hash("mainnet-tariff"), version: 1,
    model: "koinos-fast", maxOutput: 128, maxRcPerTransaction: "10000000", maxRcPerDay: "20000000",
    limits: { amount: "500000000", perJob: "1000000", maxJobs: 10, durationMs: 3600000 } });
  f.provider.getAccountRc = async () => "1000000000";
  f.state.simulations = [];
  f.provider.call = async (_, { transaction, broadcast }) => {
    if (broadcast === false) {
      f.state.simulations.push(structuredClone(transaction));
      return { receipt: { id: transaction.id, payer: config.owner, rc_used: "1000" } };
    }
    f.state.submissions.push(structuredClone(transaction)); throw Error("lost acknowledgment");
  };
  const wallet = { address: config.owner, signer: f.signer }, dialog = { showMessageBox: async (_w, r) => { reviews.push(r); return { response: answer }; } };
  const controller = new TestPayments({ config, client: f.client, journal: f.journal, wallet, dialog, authorizeHost: async () => ({ granted: true }), clock: () => f.state.now });
  return { ...f, config, controller, wallet, dialog, reviews };
}
test("mainnet requires explicit config, exact pins, host lease and real-funds status", async t => {
  const f = setup(t);
  assert.equal((await f.controller.status()).mainnetPaymentsEnabled, true);
  assert.throws(() => configuration({ ...f.config, mode: "test-deployment" }));
  assert.throws(() => assertPaymentMode("isolated-rehearsal", f.client));
  assert.throws(() => new TestPayments({ config: f.config, client: f.client, journal: f.journal, wallet: f.wallet, dialog: f.dialog }), /host lease/);
  const target = { chainId: f.d.chainId, credits: f.d.credits, creditsHash: f.d.creditsHash, policyHash: f.config.policyHash, domain: testDomain(f.d, f.config.schedulerUrl) };
  assert.equal(protocol(target).mode, "mainnet-pilot"); assert.throws(() => D.target({ ...target, domain: "shadow:rehearsal" }));
  const session = { target, schedulerUrl: f.config.schedulerUrl, session: P.hash("session"), model: "koinos-fast", version: 1,
    maxOutput: 128, maxJobs: 10, amount: "100", perJob: "10", expires: Date.now() + 60000 };
  assert.throws(() => new FundedSessionClient({ config: session, file: f.dir + "/session.json" }), /explicit private Test/);
});
test("real mainnet deposits disclose exact amounts, cancel by default and recover original bytes", async t => {
  const f = setup(t), w = window();
  const first = await f.controller.run(w, "purchase", "1");
  assert.equal(first.paymentsEnabled, true); assert.equal(f.state.submissions.length, 1);
  assert.deepEqual(f.state.simulations, f.state.submissions);
  assert.match(f.reviews[0].detail, /MAINNET.*real KOIN/); assert.match(f.reviews[0].detail, /1\.00000000 KOIN/);
  assert.equal(f.reviews[0].defaultId, 0); assert.equal(f.reviews[0].cancelId, 0); assert.equal(f.reviews[0].buttons[1], "Send real KOIN");
  const id = first.deposit.id, tx = structuredClone(f.state.submissions[0]);
  f.state.now += 1001; await f.controller.run(w, "resume", id);
  assert.deepEqual(f.state.submissions[1], tx); assert.equal(f.reviews[1].buttons[1], "Resume saved deposit");
});
test("a mainnet deposit rejected by Mana simulation remains saved without broadcast", async t => {
  const f = setup(t);
  f.provider.call = async (_, { broadcast }) => { assert.equal(broadcast, false); throw Error("insufficient rc"); };
  const result = await f.controller.run(window(), "purchase", "1");
  assert.equal(result.reason, "funding_insufficient_rc");
  assert.equal(f.state.submissions.length, 0); assert.equal(result.deposit.state, "unknown");
  assert.ok(f.journal.nonceCoordinator.envelope(result.deposit.id));
});
test("cancelled mainnet funding never signs; refunds also identify real KOIN", async t => {
  const f = setup(t, 0); await f.controller.run(window(), "purchase", "1");
  assert.equal(f.state.submissions.length, 0); assert.equal(f.journal.list().length, 0);
  f.state.available = "200000000";
  await f.controller.run(window(), "refund", "1");
  assert.match(f.reviews.at(-1).detail, /MAINNET: real KOIN/); assert.match(f.reviews.at(-1).message, /mainnet refund/);
  assert.equal(f.state.submissions.length, 0);
});
test("old rehearsal native review cannot approve a mainnet certificate", async () => {
  let signed = 0, dialogs = 0;
  const client = { prepare: async () => ({ terms: { mode: "mainnet-pilot" } }), approve: async () => { signed++; } };
  const run = createSessionReview({ client, dialog: { showMessageBox: async () => { dialogs++; return { response: 1 }; } }, testDeployment: true });
  assert.equal((await run(window(), "review")).state, "unavailable"); assert.equal(signed, 0); assert.equal(dialogs, 0);
});
test("mainnet worker requires its explicit target and rejects another custody deployment before inference", async t => {
  const f = setup(t), target = D.target({ chainId: f.d.chainId, credits: f.d.credits, creditsHash: f.d.creditsHash,
    domain: testDomain(f.d, f.config.schedulerUrl), policyHash: f.config.policyHash });
  assert.throws(() => new Worker({ koinMainnetPilotJobs: true }), /deployment/);
  const worker = new Worker({ schedulerUrl: f.config.schedulerUrl, wallet: f.wallet, koinMainnetPilotJobs: true, koinMainnetTarget: target, fundedOnly: true });
  await assert.rejects(worker._execute({ type: "koin-mainnet-pilot-chat", target: { ...target, creditsHash: "0x1220" + P.hash("other") } }), /differs/);
  const ordinary = new Worker({ schedulerUrl: f.config.schedulerUrl, wallet: f.wallet });
  await assert.rejects(ordinary._execute({ type: "koin-mainnet-pilot-chat", target }), /differs/);
});

test("native mainnet session approval displays the real budget and requires the explicit accept button", async t => {
  const f = setup(t), reviews = []; let approved = 0;
  const terms = { mode: "mainnet-pilot", model: "koinos-fast", version: 1, maxOutput: 128, amount: "100000000", perJob: "1000000",
    maxJobs: 10, expires: Date.now() + 60000, owner: f.config.owner, accountId: "test_owner", grantId: "grant_owner", session: P.hash("session"),
    target: { chainId: f.d.chainId, credits: f.d.credits, creditsHash: f.d.creditsHash, policyHash: f.config.policyHash } };
  const review = { terms, tariff: { inputAtomsPerMillion: "100", outputAtomsPerMillion: "200" } };
  const client = { prepare: async () => review, approve: async actual => { assert.deepEqual(actual, review); approved++; return { state: "active" }; } };
  let answer = 0;
  const run = createSessionReview({ client, mainnetPilot: true, dialog: { showMessageBox: async (_w, r) => { reviews.push(r); return { response: answer }; } } });
  assert.equal((await run(window(), "review")).state, "cancelled"); assert.equal(approved, 0);
  answer = 1; assert.equal((await run(window(), "review")).state, "active"); assert.equal(approved, 1);
  assert.equal(reviews[1].defaultId, 0); assert.match(reviews[1].detail, /MAINNET.*real KOIN/);
  assert.match(reviews[1].detail, /Session total limit: 1(?:\.0+)? KOIN/); assert.equal(reviews[1].buttons[1], "Approve real KOIN spending");
});
