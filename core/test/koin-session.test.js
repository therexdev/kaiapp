"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), os = require("os"), { EventEmitter } = require("events");
const { Signer, utils } = require("koilib");
const P = require("../lib/koin-network/job-protocol"), D = require("../lib/koin-network/session-delegation");
const { FundedSessionClient } = require("../../electron/koin-session-client");
const { createSessionReview, registerSessionReviewIPC } = require("../../electron/koin-session-review");
const signer = Signer.fromSeed("session-client-owner"), owner = signer.getAddress();
function tariff() {
  return Object.fromEntries(Object.entries({ model: "fixture", version: 1, inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "2000000",
    modelHash: P.hash("model"), tokenizerHash: P.hash("tokenizer"), templateHash: P.hash("template"), maxOutputTokens: 64,
    contextTokens: 4096, maxLatencyMs: 5000 }).sort(([a], [b]) => a.localeCompare(b)));
}
function config() {
  return { schedulerUrl: "http://127.0.0.1:1234/scheduler", session: P.hash("session"), model: "fixture", version: 1,
    maxOutput: 16, amount: "500", perJob: "100", maxJobs: 3, expires: 50000,
    target: { chainId: utils.encodeBase64url(Buffer.from("1220" + P.hash("chain"), "hex")), credits: signer.getAddress(),
      creditsHash: "0x1220" + P.hash("wasm"), domain: "shadow:session-client", policyHash: P.hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", tariff()])) } };
}
function terms() {
  const { schedulerUrl, ...c } = config();
  return D.terms({ schema: 1, mode: "funded-rehearsal", ...c, owner, accountId: "acc_fixture", grantId: "grant_fixture", issuedAt: 1000, nonce: P.hash("nonce") });
}
const auth = { sessionToken: "private-fixture-session-token", owner, accountId: "acc_fixture", grantId: "grant_fixture" };
function windowFixture() {
  const w = new EventEmitter(); Object.assign(w, { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false });
  w.webContents = new EventEmitter(); w.webContents.mainFrame = { url: "http://127.0.0.1:9999/" }; return w;
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-session-")), file = path.join(dir, "approval.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = []; let signs = 0, lost = false, dropped = false, accepted = false, state = "active", change = null;
  const status = () => ({ id: D.id(terms()), session: config().session, owner, state,
    amount: "500", perJob: "100", maxJobs: 3, expires: 50000, model: "fixture", version: 1, maxOutput: 16,
    held: "0", spent: "0", available: "500", remainingJobs: 3, unexpectedPrivateField: auth.sessionToken });
  const options = { config: config(), file, clock: () => 1000, authorize: async () => ({ ...auth }),
    sign: async bytes => { signs++; return Buffer.from(await signer.signHash(bytes)).toString("base64"); },
    fetchImpl: async (url, request) => {
      assert.equal(request.redirect, "error"); const action = url.split("/").pop(), b = JSON.parse(request.body); calls.push({ action, body: b });
      assert.equal(b.sessionToken, auth.sessionToken);
      let result;
      if (action === "observe") result = { observationId: P.hash("observation"), state: "observed" };
      else if (action === "review") result = { terms: terms(), tariffs: [tariff()], delegationId: D.id(terms()) };
      else if (action === "authorize") {
        D.verify(b.terms, b.signature);
        if (dropped) { dropped = false; throw Error("Request never arrived"); }
        accepted = true; result = status();
        if (lost) { lost = false; throw Error("Lost acknowledgment"); }
      } else if (action === "revoke") { state = "revoked"; result = status(); }
      else {
        if (!accepted) return Response.json({ ok: false, error: "Session delegation is unavailable" }, { status: 400 });
        result = status();
      }
      result = { ok: true, mode: "funded-rehearsal", paymentsEnabled: false, ...result };
      if (change) change(action, result); return Response.json(result);
    } };
  const open = extra => new FundedSessionClient({ ...options, ...extra });
  return { file, calls, options, open, signs: () => signs, lose: () => { lost = true; }, drop: () => { dropped = true; }, change: fn => { change = fn; } };
}

test("one session signature survives a lost acknowledgment and restart without minting another approval", async t => {
  const f = await fixture(t), client = f.open(); f.lose();
  const review = await client.prepare(); await assert.rejects(client.approve(review), /Lost acknowledgment/);
  assert.equal(f.signs(), 1); const saved = JSON.parse(fs.readFileSync(f.file)); assert.equal(saved.phase, "pending");
  assert.ok(!JSON.stringify(saved).includes(auth.sessionToken));
  const restarted = f.open(), result = await restarted.retry(); assert.equal(result.state, "active");
  assert.equal(f.signs(), 1); assert.ok(!JSON.stringify(result).includes(auth.sessionToken));
  const sends = f.calls.filter(c => c.action === "authorize"); assert.equal(sends.length, 1, "read existing authorization before retrying a write");
  await assert.rejects(restarted.prepare(), /saved session/);
  assert.equal((await restarted.revoke()).state, "revoked");
  assert.equal((await f.open().retry()).state, "revoked"); assert.equal(f.signs(), 1);
});

test("an approval that never arrived is retransmitted with exactly the same signed terms", async t => {
  const f = await fixture(t), client = f.open(); f.drop();
  const review = await client.prepare(); await assert.rejects(client.approve(review), /never arrived/);
  assert.equal((await f.open().retry()).state, "active"); assert.equal(f.signs(), 1);
  const sends = f.calls.filter(c => c.action === "authorize"); assert.deepEqual(sends[0].body, sends[1].body);
});

test("failed approval persistence prevents any authorization request", async t => {
  const f = await fixture(t), client = f.open(), review = await client.prepare();
  fs.mkdirSync(f.file);
  await assert.rejects(client.approve(review));
  assert.equal(f.calls.filter(c => c.action === "authorize").length, 0);
});

test("changed model, limits, owner, account and deployment cannot reach the signer", async t => {
  for (const mutate of [
    x => { x.amount = "501"; }, x => { x.model = "other"; }, x => { x.maxOutput++; },
    x => { x.owner = Signer.fromSeed("other").getAddress(); }, x => { x.accountId = "acc_other"; },
    x => { x.target.creditsHash = "0x1220" + P.hash("other wasm"); },
  ]) {
    const f = await fixture(t); f.change((action, result) => {
      if (action === "review") { mutate(result.terms); result.delegationId = D.id(result.terms); }
    });
    await assert.rejects(f.open().prepare(), /changed/); assert.equal(f.signs(), 0);
  }
  const f = await fixture(t), client = f.open(), review = await client.prepare();
  const stopped = new AbortController(); stopped.abort(); await assert.rejects(client.approve(review, stopped.signal)); assert.equal(f.signs(), 0);
});

test("private client refuses account changes, active payments and altered saved approvals", async t => {
  const f = await fixture(t); let account = auth;
  const client = f.open({ authorize: async () => ({ ...account }) }), review = await client.prepare();
  account = { ...auth, accountId: "acc_other" }; await assert.rejects(client.approve(review), /changed/); assert.equal(f.signs(), 0);
  account = auth; f.change((action, r) => { if (action === "authorize") r.paymentsEnabled = true; });
  await assert.rejects(client.approve(review), /Invalid session rehearsal/); assert.equal(f.signs(), 1);
  const saved = JSON.parse(fs.readFileSync(f.file)); saved.terms.amount = "900"; fs.writeFileSync(f.file, JSON.stringify(saved));
  assert.throws(() => f.open(), /Signature/);
});

test("native session approval is exact, single-flight and Cancel is the default", async () => {
  const window = windowFixture(), review = { terms: terms(), tariff: tariff() }; let approvals = 0, release;
  const ready = new Promise(r => { release = r; });
  const run = createSessionReview({ client: { prepare: async () => review, approve: async () => { approvals++; return { state: "active" }; } },
    dialog: { showMessageBox: async (_window, options) => {
      assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
      for (const text of ["0.00000500 KOIN", "0.00000100 KOIN", "Maximum requests: 3", "Input price per 1M tokens: 0.01000000 KOIN", "Output price per 1M tokens: 0.02000000 KOIN", "Chain:", "Contract bytecode:", "Spending grant:", "No KOIN will be spent"]) assert.ok(options.detail.includes(text), text);
      await ready; return { response: 1 };
    } } });
  const pending = run(window, "review"); await Promise.resolve();
  assert.equal((await run(window, "review")).state, "cancelled"); release(); assert.equal((await pending).state, "active");
  assert.equal(approvals, 1); assert.equal(window.listenerCount("hide"), 0);
});

test("hide, navigation, Stop and native cancellation cannot sign a session approval", async () => {
  for (const action of ["hide", "minimize", "closed", "navigation", "stop", "cancel"]) {
    const window = windowFixture(); let approvals = 0, controller;
    const run = createSessionReview({ track: c => { controller = c; return () => {}; },
      client: { prepare: async () => ({ terms: terms(), tariff: tariff() }), approve: async () => { approvals++; } },
      dialog: { showMessageBox: async () => {
        if (action === "navigation") window.webContents.emit("did-start-navigation", {}, "https://other.invalid", false, true);
        else if (action === "stop") controller.abort(); else if (action !== "cancel") window.emit(action);
        return { response: action === "cancel" ? 0 : 1 };
      } } });
    assert.equal((await run(window, "review")).state, "cancelled"); assert.equal(approvals, 0);
  }
});

test("funded session IPC stays private to the exact main document and accepts no supplied terms", async () => {
  const handlers = new Map(), window = windowFixture();
  registerSessionReviewIPC({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, dialog: {}, core: {},
    getMainWindow: () => window, origin: "http://127.0.0.1:9999", configPath: "" });
  const valid = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  assert.equal(handlers.size, 4);
  for (const handler of handlers.values()) {
    assert.equal((await handler(valid)).enabled, false);
    await assert.rejects(handler(valid, terms()), /no arguments/);
    await assert.rejects(handler({ ...valid, senderFrame: { url: "http://127.0.0.1:9999/" } }), /access denied/);
    window.webContents.mainFrame.url = "http://127.0.0.1:9999/mascot.html";
    await assert.rejects(handler(valid), /access denied/); window.webContents.mainFrame.url = "http://127.0.0.1:9999/";
  }
});

test("closing after a saved approval was sent reports uncertainty instead of claiming cancellation", async () => {
  const window = windowFixture();
  const run = createSessionReview({ client: { prepare: async () => ({ terms: terms(), tariff: tariff() }), hasSavedApproval: () => true,
    approve: async () => { window.emit("hide"); throw Error("response lost"); } }, dialog: { showMessageBox: async () => ({ response: 1 }) } });
  assert.equal((await run(window, "review")).state, "uncertain");
});

test("displayed token prices must match the committed policy before any approval", async t => {
  const f = await fixture(t);
  f.change((action, r) => { if (action === "review") r.tariffs[0].inputAtomsPerMillion = "1"; });
  await assert.rejects(f.open().prepare(), /tariff differs/); assert.equal(f.signs(), 0);
});
